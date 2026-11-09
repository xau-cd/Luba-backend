"use strict";
// ================================================================================
// luba-upload.js — Téléversement de fichiers pour LUBA (flux sur disque, morceaux reprenables)
//
// Contrat HTTP (identique à Luba.html, section « [LUBA UPLOAD] ») :
//   GET    /api/uploads/config                       → { maxBytes, chunkBytes, allowedExtensions, ... }
//   POST   /api/uploads            {name,size,conversationId,mime} → { uploadId, chunkBytes, offset }
//   GET    /api/uploads/:uploadId                    → { offset, size, name }      (reprise)
//   PUT    /api/uploads/:uploadId  (octet-stream, Content-Range: bytes a-b/total)
//                                                    → { offset, complete, file? } | 409 { offset }
//   DELETE /api/uploads/:uploadId                    (annulation)
//   GET    /api/conversations/:cid/files             → liste des fichiers de l'utilisateur pour cette conversation
//   DELETE /api/conversations/:cid/files/:fileId     (suppression)
//
// Sécurité : tout est cloisonné par utilisateur (dossier = hash de l'uid, jamais l'uid brut, jamais d'id fourni
// par le client pour désigner l'utilisateur) ; identifiants validés par regex (pas de traversée de chemin) ;
// nom de fichier nettoyé ; extension en liste blanche ; signature (« magic bytes ») vérifiée à la fin du transfert ;
// taille bornée à chaque morceau ET au total ; aucun fichier n'est exécuté ; fichiers temporaires purgés.
// Aucune dépendance externe (Node >= 18).
// ================================================================================

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const HEX_RE = /^[a-f0-9]{24}$/;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "log", "env.example",
  "html", "htm", "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "java", "c", "h", "cpp", "hpp", "cc",
  "cs", "go", "rs", "php", "rb", "sh", "bash", "bat", "ps1", "sql", "kt", "swift", "dart", "lua", "r", "vue", "svelte", "svg",
]);
const BINARY_EXT = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  pdf: "pdf", docx: "zip", xlsx: "zip", pptx: "zip", zip: "zip", doc: "ole", xls: "ole", ppt: "ole",
};
const DANGEROUS_EXT = new Set(["exe", "dll", "msi", "scr", "com", "apk", "jar", "app", "dmg", "vbs", "wsf", "lnk", "pif", "cpl", "msc", "hta"]);

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

function createUploadService(opts = {}) {
  const CFG = {
    DIR: path.resolve(opts.DIR || process.env.UPLOAD_DIR || path.join(process.cwd(), "luba-uploads")),
    MAX_FILE_BYTES: int(process.env.UPLOAD_MAX_FILE_MB, 50) * 1048576,
    CHUNK_BYTES: int(process.env.UPLOAD_CHUNK_KB, 1024) * 1024,
    MAX_PENDING_PER_USER: int(process.env.UPLOAD_MAX_PENDING, 10),
    MAX_USER_BYTES: int(process.env.UPLOAD_USER_QUOTA_MB, 500) * 1048576,
    PENDING_TTL_MS: int(process.env.UPLOAD_PENDING_TTL_HOURS, 24) * 3600e3,
    FILE_TTL_MS: int(process.env.UPLOAD_FILE_TTL_DAYS, 30) * 86400e3,
    SWEEP_MS: 15 * 60e3,
    CHUNK_TIMEOUT_MS: int(process.env.UPLOAD_CHUNK_TIMEOUT_S, 120) * 1000,
  };
  const pendingDir = path.join(CFG.DIR, "pending");
  const filesDir = path.join(CFG.DIR, "files");
  const busy = new Set();            // uploadId en cours d'écriture (un seul PUT à la fois par envoi)
  let sweeper = null;

  const userKey = (uid) => crypto.createHash("sha256").update(String(uid || "")).digest("hex").slice(0, 24);
  const err = (status, code, reply, extra) => Object.assign(new Error(reply), { status, code, reply, ...extra });

  function cleanName(name) {
    let n = String(name || "fichier").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "");
    n = n.split(/[\\/]/).pop().replace(/[<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
    if (n.length > 120) { const e = path.extname(n).slice(0, 12); n = n.slice(0, 120 - e.length) + e; }
    return n || "fichier";
  }
  const extOf = (n) => path.extname(n).slice(1).toLowerCase();

  async function ensureDirs() { await fsp.mkdir(pendingDir, { recursive: true }); await fsp.mkdir(filesDir, { recursive: true }); }

  async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; } }
  const writeJson = (p, o) => fsp.writeFile(p, JSON.stringify(o));

  async function userUsage(uk) {
    let total = 0;
    const base = path.join(filesDir, uk);
    let convs = []; try { convs = await fsp.readdir(base); } catch { return 0; }
    for (const c of convs) {
      let fl = []; try { fl = await fsp.readdir(path.join(base, c)); } catch { continue; }
      for (const f of fl) if (f.endsWith(".meta")) { const m = await readJson(path.join(base, c, f)); if (m) total += m.size || 0; }
    }
    return total;
  }

  async function countPending(uk) {
    let n = 0, fl = []; try { fl = await fsp.readdir(pendingDir); } catch { return 0; }
    for (const f of fl) if (f.endsWith(".json") && f.startsWith(uk + "_")) n++;
    return n;
  }

  // ---------- Démarrage d'un envoi ----------
  async function init(userId, { name, size, conversationId, mime }) {
    await ensureDirs();
    const clean = cleanName(name);
    const ext = extOf(clean);
    size = Number(size);
    if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(size)) throw err(400, "INVALID_SIZE", "Taille de fichier invalide ou fichier vide.");
    if (size > CFG.MAX_FILE_BYTES) throw err(413, "FILE_TOO_LARGE", `Fichier trop volumineux (maximum ${Math.round(CFG.MAX_FILE_BYTES / 1048576)} Mo).`);
    if (DANGEROUS_EXT.has(ext)) throw err(415, "UNSUPPORTED_TYPE", `Les fichiers « .${ext} » (exécutables) ne sont pas acceptés.`);
    if (!ext || !(TEXT_EXT.has(ext) || BINARY_EXT[ext])) throw err(415, "UNSUPPORTED_TYPE", `Format « .${ext || "?"} » non pris en charge. Formats acceptés : ${allowedExtensions().join(", ")}.`);
    const convId = String(conversationId || "");
    if (!ID_RE.test(convId)) throw err(400, "INVALID_CONVERSATION_ID", "Identifiant de conversation invalide.");
    const uk = userKey(userId);
    if ((await countPending(uk)) >= CFG.MAX_PENDING_PER_USER) throw err(429, "TOO_MANY_UPLOADS", "Trop d'envois en cours. Attendez la fin des précédents.");
    if ((await userUsage(uk)) + size > CFG.MAX_USER_BYTES) throw err(413, "QUOTA_EXCEEDED", "Espace de stockage de fichiers atteint. Supprimez d'anciens fichiers.");
    const uploadId = crypto.randomBytes(12).toString("hex");
    const rec = { uploadId, uk, name: clean, ext, size, convId, mime: String(mime || "").slice(0, 100), createdAt: Date.now() };
    await writeJson(path.join(pendingDir, `${uk}_${uploadId}.json`), rec);
    await fsp.writeFile(path.join(pendingDir, `${uk}_${uploadId}.part`), "");
    return { uploadId, chunkBytes: CFG.CHUNK_BYTES, offset: 0, name: clean, size };
  }

  async function loadPending(userId, uploadId) {
    if (!HEX_RE.test(String(uploadId))) throw err(404, "UPLOAD_NOT_FOUND", "Envoi introuvable ou expiré.");
    const uk = userKey(userId);
    const rec = await readJson(path.join(pendingDir, `${uk}_${uploadId}.json`));
    if (!rec) throw err(404, "UPLOAD_NOT_FOUND", "Envoi introuvable ou expiré.");
    const partPath = path.join(pendingDir, `${uk}_${uploadId}.part`);
    let offset = 0; try { offset = (await fsp.stat(partPath)).size; } catch { throw err(404, "UPLOAD_NOT_FOUND", "Envoi introuvable ou expiré."); }
    return { rec, partPath, metaPath: path.join(pendingDir, `${uk}_${uploadId}.json`), offset };
  }

  async function status(userId, uploadId) {
    const { rec, offset } = await loadPending(userId, uploadId);
    return { uploadId, offset, size: rec.size, name: rec.name, chunkBytes: CFG.CHUNK_BYTES };
  }

  function parseRange(h, size) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(h || "").trim());
    if (!m) return null;
    const a = +m[1], b = +m[2], t = +m[3];
    if (t !== size || a > b || b >= size) return null;
    return { start: a, end: b, len: b - a + 1 };
  }

  // ---------- Réception d'un morceau (flux → disque, jamais tout en mémoire) ----------
  async function append(userId, uploadId, req) {
    const { rec, partPath, metaPath, offset } = await loadPending(userId, uploadId);
    const range = parseRange(req.headers["content-range"], rec.size);
    if (!range) throw err(400, "INVALID_RANGE", "En-tête Content-Range invalide.");
    if (range.len > CFG.CHUNK_BYTES * 2) throw err(413, "CHUNK_TOO_LARGE", "Morceau trop volumineux.");
    if (range.start !== offset) { req.resume(); throw err(409, "OFFSET_MISMATCH", "Décalage inattendu, resynchronisation.", { offset }); }
    if (busy.has(uploadId)) { req.resume(); throw err(409, "UPLOAD_BUSY", "Un morceau est déjà en cours pour cet envoi.", { offset }); }
    busy.add(uploadId);
    try {
      let received = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partPath, { flags: "a" });
        let finished = false;
        const fail = (e) => { if (finished) return; finished = true; clearTimeout(timer); out.destroy(); reject(e); };
        const timer = setTimeout(() => { req.destroy(); fail(err(408, "CHUNK_TIMEOUT", "Délai dépassé pendant l'envoi du morceau.")); }, CFG.CHUNK_TIMEOUT_MS);
        req.on("data", (c) => {
          received += c.length;
          if (received > range.len) { req.unpipe(out); fail(err(400, "BODY_TOO_LARGE", "Corps plus grand que la plage annoncée.")); }
        });
        req.on("aborted", () => fail(err(499, "CLIENT_ABORTED", "Envoi interrompu.")));
        req.on("error", fail);
        out.on("error", fail);
        out.on("finish", () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); });
        req.pipe(out);
      }).catch(async (e) => {
        // On tronque à l'offset connu : le client pourra reprendre proprement.
        try { await fsp.truncate(partPath, offset); } catch {}
        throw e;
      });
      if (received !== range.len) {
        try { await fsp.truncate(partPath, offset); } catch {}
        throw err(400, "LENGTH_MISMATCH", "Taille du morceau différente de la plage annoncée.");
      }
      const newOffset = offset + received;
      if (newOffset < rec.size) return { offset: newOffset, complete: false };
      const file = await finalize(rec, partPath, metaPath);
      return { offset: newOffset, complete: true, file };
    } finally { busy.delete(uploadId); }
  }

  // ---------- Vérification de signature ----------
  async function sniff(p, n = 16) { const fh = await fsp.open(p, "r"); try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); } }
  async function looksText(p, size) {
    const fh = await fsp.open(p, "r");
    try {
      const len = Math.min(size, 8192), b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, 0);
      for (let i = 0; i < bytesRead; i++) if (b[i] === 0) return false;
      return true;
    } finally { await fh.close(); }
  }
  async function checkSignature(ext, p, size) {
    const kind = BINARY_EXT[ext];
    if (!kind) return looksText(p, size);
    const h = await sniff(p, 12);
    if (kind === "image") {
      if (ext === "png") return h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (ext === "jpg" || ext === "jpeg") return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
      if (ext === "gif") return /^GIF8[79]a/.test(h.toString("latin1", 0, 6));
      if (ext === "webp") return h.toString("latin1", 0, 4) === "RIFF" && h.toString("latin1", 8, 12) === "WEBP";
    }
    if (kind === "pdf") return h.toString("latin1", 0, 5) === "%PDF-";
    if (kind === "zip") return h[0] === 0x50 && h[1] === 0x4b && (h[2] === 3 || h[2] === 5);
    if (kind === "ole") return h.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    return false;
  }

  async function finalize(rec, partPath, metaPath) {
    const ok = await checkSignature(rec.ext, partPath, rec.size).catch(() => false);
    if (!ok) {
      await Promise.all([fsp.unlink(partPath).catch(() => {}), fsp.unlink(metaPath).catch(() => {})]);
      throw err(415, "SIGNATURE_MISMATCH", `Le contenu de « ${rec.name} » ne correspond pas au format .${rec.ext}.`);
    }
    const fileId = crypto.randomBytes(12).toString("hex");
    const dir = path.join(filesDir, rec.uk, rec.convId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(partPath, path.join(dir, `${fileId}.bin`));
    const meta = { fileId, name: rec.name, ext: rec.ext, size: rec.size, mime: rec.mime, createdAt: Date.now() };
    await writeJson(path.join(dir, `${fileId}.meta`), meta);
    await fsp.unlink(metaPath).catch(() => {});
    return { fileId, name: meta.name, size: meta.size, mime: meta.mime, ext: meta.ext };
  }

  async function abort(userId, uploadId) {
    if (!HEX_RE.test(String(uploadId))) return false;
    const uk = userKey(userId);
    await fsp.unlink(path.join(pendingDir, `${uk}_${uploadId}.part`)).catch(() => {});
    await fsp.unlink(path.join(pendingDir, `${uk}_${uploadId}.json`)).catch(() => {});
    return true;
  }

  // ---------- Fichiers terminés ----------
  function filePaths(userId, convId, fileId) {
    if (!ID_RE.test(String(convId)) || !HEX_RE.test(String(fileId))) throw err(404, "FILE_NOT_FOUND", "Fichier introuvable.");
    const dir = path.join(filesDir, userKey(userId), String(convId));
    return { meta: path.join(dir, `${fileId}.meta`), bin: path.join(dir, `${fileId}.bin`), dir };
  }
  async function getMeta(userId, convId, fileId) {
    const p = filePaths(userId, convId, fileId);
    const m = await readJson(p.meta);
    if (!m) throw err(404, "FILE_NOT_FOUND", "Fichier introuvable.");
    return { meta: m, paths: p };
  }
  async function listFiles(userId, convId) {
    if (!ID_RE.test(String(convId))) throw err(400, "INVALID_CONVERSATION_ID", "Identifiant de conversation invalide.");
    const dir = path.join(filesDir, userKey(userId), String(convId));
    let fl = []; try { fl = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const f of fl) if (f.endsWith(".meta")) { const m = await readJson(path.join(dir, f)); if (m) out.push({ fileId: m.fileId, name: m.name, size: m.size, mime: m.mime, ext: m.ext, createdAt: m.createdAt }); }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  async function deleteFile(userId, convId, fileId) {
    const { paths } = await getMeta(userId, convId, fileId);
    await fsp.unlink(paths.bin).catch(() => {});
    await fsp.unlink(paths.meta).catch(() => {});
    return true;
  }
  async function deleteConversationFiles(userId, convId) {
    if (!ID_RE.test(String(convId))) return;
    await fsp.rm(path.join(filesDir, userKey(userId), String(convId)), { recursive: true, force: true });
  }
  async function deleteAllUserFiles(userId) {
    const uk = userKey(userId);
    await fsp.rm(path.join(filesDir, uk), { recursive: true, force: true });
    let fl = []; try { fl = await fsp.readdir(pendingDir); } catch {}
    for (const f of fl) if (f.startsWith(uk + "_")) await fsp.unlink(path.join(pendingDir, f)).catch(() => {});
  }

  // ---------- Lecture texte bornée (pour l'IA) ----------
  function zipEntry(buf, wanted) {
    // Parcours du répertoire central ZIP (sans dépendance).
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
    for (let k = 0; k < count && p + 46 <= buf.length; k++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nlen);
      if (name === wanted) {
        if (usize > 25e6) return null;
        const ln = buf.readUInt16LE(lho + 26), le = buf.readUInt16LE(lho + 28), ds = lho + 30 + ln + le;
        const data = buf.subarray(ds, ds + csize);
        return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 25e6 }) : null;
      }
      p += 46 + nlen + elen + clen;
    }
    return null;
  }
  function docxToText(buf) {
    const x = zipEntry(buf, "word/document.xml");
    if (!x) return null;
    return x.toString("utf8")
      .replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n").trim();
  }

  async function readText(userId, convId, fileId, { maxBytes = 100000 } = {}) {
    const { meta, paths } = await getMeta(userId, convId, fileId);
    if (TEXT_EXT.has(meta.ext)) {
      const fh = await fsp.open(paths.bin, "r");
      try {
        const len = Math.min(meta.size, maxBytes), b = Buffer.alloc(len);
        const { bytesRead } = await fh.read(b, 0, len, 0);
        return { name: meta.name, size: meta.size, text: b.toString("utf8", 0, bytesRead), truncated: meta.size > maxBytes };
      } finally { await fh.close(); }
    }
    if (meta.ext === "docx" && meta.size <= 25e6) {
      const t = docxToText(await fsp.readFile(paths.bin));
      if (t != null) return { name: meta.name, size: meta.size, text: t.slice(0, maxBytes), truncated: t.length > maxBytes };
    }
    throw err(422, "NOT_TEXT", "Contenu non lisible en texte.");
  }

  // ---------- Nettoyage périodique ----------
  async function sweep() {
    const now = Date.now();
    try {
      for (const f of await fsp.readdir(pendingDir)) {
        const p = path.join(pendingDir, f);
        const st = await fsp.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > CFG.PENDING_TTL_MS) await fsp.unlink(p).catch(() => {});
      }
    } catch {}
    try {
      for (const uk of await fsp.readdir(filesDir)) {
        for (const c of await fsp.readdir(path.join(filesDir, uk)).catch(() => [])) {
          const dir = path.join(filesDir, uk, c);
          for (const f of await fsp.readdir(dir).catch(() => [])) {
            const p = path.join(dir, f); const st = await fsp.stat(p).catch(() => null);
            if (st && now - st.mtimeMs > CFG.FILE_TTL_MS) await fsp.unlink(p).catch(() => {});
          }
          if (!(await fsp.readdir(dir).catch(() => [1])).length) await fsp.rmdir(dir).catch(() => {});
        }
      }
    } catch {}
  }
  function startSweeper() { if (sweeper) return; ensureDirs().catch(() => {}); sweeper = setInterval(() => sweep().catch(() => {}), CFG.SWEEP_MS); sweeper.unref(); sweep().catch(() => {}); }
  function stopSweeper() { if (sweeper) clearInterval(sweeper); sweeper = null; }

  function allowedExtensions() { return [...TEXT_EXT, ...Object.keys(BINARY_EXT)].sort(); }

  return { CFG, init, status, append, abort, listFiles, deleteFile, deleteConversationFiles, deleteAllUserFiles, readText, sweep, startSweeper, stopSweeper, allowedExtensions, cleanName };
}

// ---------- Routeur Express ----------
function createUploadRouter(express, authenticate, svc, { limiter } = {}) {
  const router = express.Router();
  const lim = limiter || ((req, res, next) => next());
  const send = (res, e) => {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error("[luba-upload]", e && e.stack || e);
    const body = { success: false, error: true, reply: e && e.reply ? e.reply : "Erreur interne lors du téléversement.", code: (e && e.code) || "UPLOAD_ERROR" };
    if (e && typeof e.offset === "number") body.offset = e.offset;
    if (!res.headersSent) res.status(status).json(body);
  };
  const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => send(res, e));
  const uid = (req) => { if (!req.userId) throw Object.assign(new Error("Authentification requise."), { status: 401, code: "AUTH_REQUIRED", reply: "Authentification requise." }); return req.userId; };

  router.get("/api/uploads/config", authenticate, lim, h(async (req, res) => {
    uid(req);
    res.json({ success: true, maxBytes: svc.CFG.MAX_FILE_BYTES, chunkBytes: svc.CFG.CHUNK_BYTES, allowedExtensions: svc.allowedExtensions() });
  }));
  router.post("/api/uploads", authenticate, lim, h(async (req, res) => {
    const b = req.body || {};
    res.status(201).json({ success: true, ...(await svc.init(uid(req), b)) });
  }));
  router.get("/api/uploads/:uploadId", authenticate, lim, h(async (req, res) => {
    res.json({ success: true, ...(await svc.status(uid(req), req.params.uploadId)) });
  }));
  // PUT : pas de limiteur par requête (plusieurs morceaux par fichier) — bornes par morceau, par fichier et par utilisateur.
  router.put("/api/uploads/:uploadId", authenticate, h(async (req, res) => {
    res.json({ success: true, ...(await svc.append(uid(req), req.params.uploadId, req)) });
  }));
  router.delete("/api/uploads/:uploadId", authenticate, lim, h(async (req, res) => {
    await svc.abort(uid(req), req.params.uploadId); res.json({ success: true });
  }));
  router.get("/api/conversations/:cid/files", authenticate, lim, h(async (req, res) => {
    res.json({ success: true, files: await svc.listFiles(uid(req), req.params.cid) });
  }));
  router.delete("/api/conversations/:cid/files/:fileId", authenticate, lim, h(async (req, res) => {
    await svc.deleteFile(uid(req), req.params.cid, req.params.fileId); res.json({ success: true });
  }));
  return router;
}

module.exports = { createUploadService, createUploadRouter };
