"use strict";
/**
 * luba-upload.js — Upload de fichiers volumineux pour LUBA (sans dépendance externe).
 *
 * Principes :
 *  - Aucun fichier n'est conservé en RAM : le corps de la requête est écrit en flux sur disque.
 *  - Upload par morceaux reprenables : POST (init) -> PUT (morceaux, Content-Range) -> finalisation automatique.
 *  - Limites configurables par variables d'environnement (voir CFG).
 *  - Le type réel est vérifié par signature (octets magiques) ; le MIME déclaré n'est jamais cru seul.
 *  - Isolation par utilisateur : le répertoire dépend du hash de l'identifiant utilisateur.
 *  - Nettoyage : morceaux abandonnés (TTL), annulation, erreur => fichier partiel supprimé.
 *
 * Utilisation avec Express (voir index.js) : app.use(createUploadRouter(...)) — ou directement
 * les fonctions exportées avec http natif (utilisé par test/upload.test.js).
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const MB = 1024 * 1024;
const envInt = (k, d) => { const v = parseInt(process.env[k] || "", 10); return Number.isFinite(v) && v > 0 ? v : d; };

function buildConfig(overrides = {}) {
  return Object.freeze({
    DIR: process.env.UPLOAD_DIR || path.join(process.env.DATA_DIR || os.tmpdir(), "luba-uploads"),
    MAX_FILE_BYTES: envInt("UPLOAD_MAX_MB", 100) * MB,          // taille max d'un fichier
    MAX_USER_BYTES: envInt("UPLOAD_MAX_USER_MB", 1024) * MB,    // quota total par utilisateur
    MAX_FILES_PER_CONV: envInt("UPLOAD_MAX_FILES_PER_CONV", 50),
    CHUNK_BYTES: envInt("UPLOAD_CHUNK_KB", 1024) * 1024,        // taille de morceau conseillée au client
    MAX_ACTIVE_PER_USER: envInt("UPLOAD_MAX_ACTIVE_PER_USER", 6),
    PARTIAL_TTL_MS: envInt("UPLOAD_PARTIAL_TTL_MIN", 120) * 60 * 1000,
    READ_TEXT_MAX_BYTES: envInt("UPLOAD_READ_TEXT_MAX_KB", 512) * 1024,
    ...overrides,
  });
}

// ---- Types autorisés : extension -> { kind, mimes } ; "kind" pilote la vérification par signature ----
const TYPES = {
  pdf:  { kind: "pdf",  mime: "application/pdf" },
  png:  { kind: "png",  mime: "image/png" },
  jpg:  { kind: "jpeg", mime: "image/jpeg" },
  jpeg: { kind: "jpeg", mime: "image/jpeg" },
  gif:  { kind: "gif",  mime: "image/gif" },
  webp: { kind: "webp", mime: "image/webp" },
  zip:  { kind: "zip",  mime: "application/zip" },
  docx: { kind: "zip",  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { kind: "zip",  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { kind: "zip",  mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
for (const e of ["txt", "md", "csv", "tsv", "json", "xml", "html", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php", "sh", "sql", "yml", "yaml", "toml", "ini", "log", "env.example"]) {
  TYPES[e] = { kind: "text", mime: "text/plain" };
}
const TEXT_KINDS = new Set(["text"]);

function sniffKind(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) ) return "zip";
  // Exécutables / scripts binaires refusés explicitement
  if (buf.length >= 4 && buf.slice(0, 2).toString("latin1") === "MZ") return "exe";
  if (buf.length >= 4 && buf.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
  // Texte : pas d'octet NUL et UTF-8 valide sur l'échantillon
  if (buf.length === 0) return "text";
  if (buf.includes(0)) return "binary";
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return "text"; } catch { /* peut être coupé au milieu d'un caractère */ }
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf.slice(0, Math.max(0, buf.length - 3))); return "text"; } catch { return "binary"; }
}

/** Vide le corps restant d'une requête refusée (évite ECONNRESET côté client, borné pour ne pas servir de vecteur d'abus). */
function drain(req, maxBytes = 64 * MB, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let n = 0; const t = setTimeout(done, timeoutMs);
    function done() { clearTimeout(t); req.removeAllListeners("data"); resolve(); }
    req.on("data", (c) => { n += c.length; if (n > maxBytes) { req.destroy(); done(); } });
    req.on("end", done); req.on("close", done); req.on("error", done); req.resume();
  });
}

class UploadError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

function safeName(name) {
  let n = String(name || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "");
  n = path.basename(n.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ \-()]/gu, "_").replace(/^\.+/, "").trim();
  if (n.length > 120) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 120 - ext.length) + ext; }
  return n;
}
const extOf = (n) => path.extname(n).slice(1).toLowerCase();
const ID_RE = /^[a-f0-9]{32}$/;
const CONV_RE = /^[a-zA-Z0-9_-]{6,80}$/;
const userKey = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
const newId = () => crypto.randomBytes(16).toString("hex");

function createUploadService(overrides = {}) {
  const CFG = buildConfig(overrides);
  const active = new Map();           // uploadId -> { writing:boolean } (verrou local par upload)
  const activeByUser = new Map();     // userKey -> nombre d'uploads en cours d'écriture

  const udir = (uk) => path.join(CFG.DIR, uk);
  const partDir = (uk) => path.join(udir(uk), "partial");
  const fileDir = (uk, conv) => path.join(udir(uk), "files", conv);
  const metaPath = (dir, id) => path.join(dir, id + ".json");

  async function ensureDirs(uk, conv) {
    await fsp.mkdir(partDir(uk), { recursive: true, mode: 0o700 });
    await fsp.mkdir(fileDir(uk, conv), { recursive: true, mode: 0o700 });
  }
  async function writeJsonAtomic(p, obj) {
    const tmp = p + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
    await fsp.rename(tmp, p);
  }
  const readJson = async (p) => JSON.parse(await fsp.readFile(p, "utf8"));

  async function userUsage(uk) {
    let total = 0;
    const root = path.join(udir(uk), "files");
    let convs = [];
    try { convs = await fsp.readdir(root); } catch { return 0; }
    for (const c of convs) {
      let names = []; try { names = await fsp.readdir(path.join(root, c)); } catch { continue; }
      for (const n of names) if (n.endsWith(".json")) { try { total += (await readJson(path.join(root, c, n))).size || 0; } catch { /* ignoré */ } }
    }
    let parts = []; try { parts = await fsp.readdir(partDir(uk)); } catch { /* aucun */ }
    for (const n of parts) if (n.endsWith(".json")) { try { total += (await readJson(path.join(partDir(uk), n))).size || 0; } catch { /* ignoré */ } }
    return total;
  }

  // ---- 1. Initialisation ----
  async function init(userId, { name, size, conversationId, mime }) {
    if (!userId) throw new UploadError(401, "UNAUTHENTICATED", "Authentification requise.");
    if (!CONV_RE.test(String(conversationId || ""))) throw new UploadError(400, "INVALID_CONVERSATION_ID", "Identifiant de conversation invalide.");
    const clean = safeName(name);
    if (!clean) throw new UploadError(400, "INVALID_NAME", "Nom de fichier invalide.");
    const ext = extOf(clean);
    const t = TYPES[ext];
    if (!t) throw new UploadError(415, "TYPE_NOT_ALLOWED", `Extension « .${ext || "?"} » non autorisée.`, { allowed: Object.keys(TYPES) });
    const sz = Number(size);
    if (!Number.isInteger(sz) || sz <= 0) throw new UploadError(400, "INVALID_SIZE", "Taille de fichier invalide.");
    if (sz > CFG.MAX_FILE_BYTES) throw new UploadError(413, "FILE_TOO_LARGE", `Fichier trop volumineux (${(sz / MB).toFixed(1)} Mo). Maximum : ${CFG.MAX_FILE_BYTES / MB} Mo.`, { maxBytes: CFG.MAX_FILE_BYTES });
    const uk = userKey(userId);
    await ensureDirs(uk, conversationId);
    const existing = (await fsp.readdir(fileDir(uk, conversationId))).filter((n) => n.endsWith(".json")).length;
    if (existing >= CFG.MAX_FILES_PER_CONV) throw new UploadError(409, "TOO_MANY_FILES", `Maximum ${CFG.MAX_FILES_PER_CONV} fichiers par conversation.`);
    const used = await userUsage(uk);
    if (used + sz > CFG.MAX_USER_BYTES) throw new UploadError(413, "USER_QUOTA_EXCEEDED", "Quota de stockage atteint.", { usedBytes: used, maxBytes: CFG.MAX_USER_BYTES });
    const uploadId = newId();
    const meta = { uploadId, userKey: uk, conversationId, name: clean, ext, declaredMime: String(mime || "").slice(0, 100), size: sz, offset: 0, createdAt: Date.now(), updatedAt: Date.now() };
    await fsp.writeFile(path.join(partDir(uk), uploadId + ".part"), "", { mode: 0o600 });
    await writeJsonAtomic(metaPath(partDir(uk), uploadId), meta);
    return { uploadId, offset: 0, size: sz, chunkBytes: CFG.CHUNK_BYTES, maxBytes: CFG.MAX_FILE_BYTES };
  }

  async function loadPartial(userId, uploadId) {
    if (!ID_RE.test(String(uploadId || ""))) throw new UploadError(400, "INVALID_UPLOAD_ID", "Identifiant d'upload invalide.");
    const uk = userKey(userId);
    try { return { uk, meta: await readJson(metaPath(partDir(uk), uploadId)) }; }
    catch { throw new UploadError(404, "UPLOAD_NOT_FOUND", "Upload introuvable ou expiré."); }
  }

  async function status(userId, uploadId) {
    const { uk, meta } = await loadPartial(userId, uploadId);
    const st = await fsp.stat(path.join(partDir(uk), uploadId + ".part")).catch(() => ({ size: 0 }));
    return { uploadId, size: meta.size, offset: st.size, name: meta.name };
  }

  function parseContentRange(h, total) {
    if (!h) return null;
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(h).trim());
    if (!m) throw new UploadError(400, "INVALID_CONTENT_RANGE", "En-tête Content-Range invalide.");
    const start = +m[1], end = +m[2];
    if (end < start || (m[3] !== "*" && +m[3] !== total)) throw new UploadError(400, "INVALID_CONTENT_RANGE", "Content-Range incohérent avec la taille annoncée.");
    return { start, end };
  }

  // ---- 2. Réception d'un morceau (flux) ----
  async function appendChunk(userId, uploadId, req) {
    let ctx;
    try { ctx = await loadPartialAndCheck(userId, uploadId, req); } catch (e) { if (e instanceof UploadError && e.status !== 404) await drain(req); throw e; }
    return appendChunkChecked(ctx, userId, uploadId, req);
  }

  async function loadPartialAndCheck(userId, uploadId, req) {
    const { uk, meta } = await loadPartial(userId, uploadId);
    if (active.has(uploadId)) throw new UploadError(409, "UPLOAD_BUSY", "Un morceau est déjà en cours d'écriture pour cet upload.");
    const n = activeByUser.get(uk) || 0;
    if (n >= CFG.MAX_ACTIVE_PER_USER) throw new UploadError(429, "TOO_MANY_ACTIVE_UPLOADS", "Trop d'uploads simultanés.");
    const partPath = path.join(partDir(uk), uploadId + ".part");
    const cur = (await fsp.stat(partPath).catch(() => ({ size: 0 }))).size;
    const range = parseContentRange(req.headers["content-range"], meta.size);
    const start = range ? range.start : 0;
    if (start !== cur) throw new UploadError(409, "OFFSET_MISMATCH", "Décalage inattendu : reprenez à l'offset indiqué.", { offset: cur });
    const declared = req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) : null;
    const room = meta.size - cur;
    if (declared !== null && (!Number.isFinite(declared) || declared > room)) {
      throw new UploadError(413, "CHUNK_EXCEEDS_DECLARED_SIZE", "Le morceau dépasse la taille annoncée.", { offset: cur });
    }
    if (range && declared !== null && range.end - range.start + 1 !== declared) throw new UploadError(400, "INVALID_CONTENT_RANGE", "Content-Range et Content-Length incohérents.");
    return { uk, meta, n, partPath, cur, room };
  }

  async function appendChunkChecked({ uk, meta, n, partPath, cur, room }, userId, uploadId, req) {
    active.set(uploadId, { at: Date.now() });
    activeByUser.set(uk, n + 1);
    let written = 0;
    const out = fs.createWriteStream(partPath, { flags: "a", mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        let done = false;
        const fail = (e) => { if (!done) { done = true; out.destroy(); reject(e); } };
        req.on("data", (c) => {
          written += c.length;
          if (written > room) { req.unpipe(out); fail(new UploadError(413, "FILE_TOO_LARGE", "Le flux dépasse la taille annoncée.", { offset: cur })); return; }
        });
        req.on("aborted", () => fail(new UploadError(499, "CLIENT_ABORTED", "Upload interrompu par le client.")));
        req.on("error", fail);
        out.on("error", fail);
        out.on("finish", () => { if (!done) { done = true; resolve(); } });
        req.pipe(out);
      });
    } catch (e) {
      // On tronque au dernier offset sûr pour que la reprise reste cohérente.
      await fsp.truncate(partPath, cur + (e.code === "CLIENT_ABORTED" ? Math.min(written, room) : 0)).catch(() => {});
      if (e.code === "FILE_TOO_LARGE" || e.code === "CHUNK_EXCEEDS_DECLARED_SIZE") { await fsp.truncate(partPath, cur).catch(() => {}); await drain(req); }
      throw e;
    } finally {
      active.delete(uploadId);
      activeByUser.set(uk, Math.max(0, (activeByUser.get(uk) || 1) - 1));
    }
    const newOffset = (await fsp.stat(partPath)).size;
    meta.updatedAt = Date.now(); meta.offset = newOffset;
    await writeJsonAtomic(metaPath(partDir(uk), uploadId), meta);
    if (newOffset < meta.size) return { uploadId, offset: newOffset, size: meta.size, complete: false };
    const file = await finalize(uk, meta);
    return { uploadId, offset: newOffset, size: meta.size, complete: true, file };
  }

  // ---- 3. Finalisation : vérification de la taille réelle, de la signature et empreinte SHA-256 ----
  async function finalize(uk, meta) {
    const partPath = path.join(partDir(uk), meta.uploadId + ".part");
    const reject = async (err) => { await discard(uk, meta.uploadId); throw err; };
    const st = await fsp.stat(partPath);
    if (st.size !== meta.size) return reject(new UploadError(422, "SIZE_MISMATCH", "Taille reçue différente de la taille annoncée."));
    const fh = await fsp.open(partPath, "r");
    let head;
    try { const b = Buffer.alloc(Math.min(8192, st.size)); const { bytesRead } = await fh.read(b, 0, b.length, 0); head = b.slice(0, bytesRead); } finally { await fh.close(); }
    const real = sniffKind(head);
    const want = TYPES[meta.ext].kind;
    if (real === "exe" || real === "elf") return reject(new UploadError(415, "EXECUTABLE_REFUSED", "Les exécutables sont refusés."));
    if (want !== real) return reject(new UploadError(415, "TYPE_MISMATCH", `Le contenu réel (${real}) ne correspond pas à l'extension .${meta.ext}.`));
    const hash = crypto.createHash("sha256");
    await new Promise((res, rej) => fs.createReadStream(partPath).on("data", (c) => hash.update(c)).on("end", res).on("error", rej));
    const fileId = newId();
    const dir = fileDir(uk, meta.conversationId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, fileId + ".bin");
    await fsp.rename(partPath, dest);
    const record = { fileId, conversationId: meta.conversationId, name: meta.name, ext: meta.ext, mime: TYPES[meta.ext].mime, kind: want, size: meta.size, sha256: hash.digest("hex"), createdAt: Date.now() };
    await writeJsonAtomic(metaPath(dir, fileId), record);
    await fsp.unlink(metaPath(partDir(uk), meta.uploadId)).catch(() => {});
    return record;
  }

  async function discard(uk, uploadId) {
    await fsp.unlink(path.join(partDir(uk), uploadId + ".part")).catch(() => {});
    await fsp.unlink(metaPath(partDir(uk), uploadId)).catch(() => {});
  }
  async function cancel(userId, uploadId) { const { uk } = await loadPartial(userId, uploadId); await discard(uk, uploadId); return { cancelled: true }; }

  // ---- 4. Lecture / liste / suppression ----
  async function list(userId, conversationId) {
    if (!CONV_RE.test(String(conversationId || ""))) throw new UploadError(400, "INVALID_CONVERSATION_ID", "Identifiant de conversation invalide.");
    const dir = fileDir(userKey(userId), conversationId);
    let names = []; try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) if (n.endsWith(".json")) { try { out.push(await readJson(path.join(dir, n))); } catch { /* ignoré */ } }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function locate(userId, conversationId, fileId) {
    if (!ID_RE.test(String(fileId || ""))) throw new UploadError(400, "INVALID_FILE_ID", "Identifiant de fichier invalide.");
    if (!CONV_RE.test(String(conversationId || ""))) throw new UploadError(400, "INVALID_CONVERSATION_ID", "Identifiant de conversation invalide.");
    const dir = fileDir(userKey(userId), conversationId);
    try { return { meta: await readJson(metaPath(dir, fileId)), bin: path.join(dir, fileId + ".bin"), dir }; }
    catch { throw new UploadError(404, "FILE_NOT_FOUND", "Fichier introuvable."); }
  }

  async function remove(userId, conversationId, fileId) {
    const { dir } = await locate(userId, conversationId, fileId);
    await fsp.unlink(path.join(dir, fileId + ".bin")).catch(() => {});
    await fsp.unlink(metaPath(dir, fileId)).catch(() => {});
    return { deleted: true };
  }

  async function openDownload(userId, conversationId, fileId) {
    const { meta, bin } = await locate(userId, conversationId, fileId);
    return { meta, stream: fs.createReadStream(bin) };
  }

  /** Lecture bornée du texte d'un fichier (pour que Luba analyse sans charger un gros fichier entier). */
  async function readText(userId, conversationId, fileId, { offset = 0, maxBytes } = {}) {
    const { meta, bin } = await locate(userId, conversationId, fileId);
    if (!TEXT_KINDS.has(meta.kind)) throw new UploadError(415, "NOT_TEXT", `Lecture texte indisponible pour .${meta.ext} (aucun extracteur ${meta.kind} installé).`);
    const cap = Math.min(maxBytes || CFG.READ_TEXT_MAX_BYTES, CFG.READ_TEXT_MAX_BYTES);
    const off = Math.max(0, Math.min(offset, meta.size));
    const fh = await fsp.open(bin, "r");
    try {
      const b = Buffer.alloc(Math.min(cap, meta.size - off));
      const { bytesRead } = await fh.read(b, 0, b.length, off);
      return { name: meta.name, size: meta.size, offset: off, bytesRead, truncated: off + bytesRead < meta.size, nextOffset: off + bytesRead, text: b.slice(0, bytesRead).toString("utf8") };
    } finally { await fh.close(); }
  }

  // ---- 5. Nettoyage des uploads abandonnés ----
  async function sweep(now = Date.now()) {
    let removed = 0;
    let users = []; try { users = await fsp.readdir(CFG.DIR); } catch { return 0; }
    for (const uk of users) {
      let names = []; try { names = await fsp.readdir(partDir(uk)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const id = n.slice(0, -5);
        if (active.has(id)) continue;
        try { const m = await readJson(path.join(partDir(uk), n)); if (now - (m.updatedAt || 0) > CFG.PARTIAL_TTL_MS) { await discard(uk, id); removed++; } }
        catch { await fsp.unlink(path.join(partDir(uk), n)).catch(() => {}); }
      }
      for (const n of names) { // .part orphelins
        if (n.endsWith(".part") && !names.includes(n.slice(0, -5) + ".json")) { await fsp.unlink(path.join(partDir(uk), n)).catch(() => {}); removed++; }
      }
    }
    return removed;
  }
  let timer = null;
  const startSweeper = (everyMs = 10 * 60 * 1000) => { if (!timer) { timer = setInterval(() => sweep().catch(() => {}), everyMs); timer.unref?.(); } };
  const stopSweeper = () => { if (timer) { clearInterval(timer); timer = null; } };

  return { CFG, init, status, appendChunk, cancel, list, openDownload, readText, remove, sweep, startSweeper, stopSweeper, _activeCount: () => active.size };
}

/** Routeur Express (injecté : express, authenticate). Les ids utilisateur viennent UNIQUEMENT de req.userId. */
function createUploadRouter(express, authenticate, service, { limiter } = {}) {
  const r = express.Router();
  const mwChunk = [authenticate];                                   // morceaux : pas de limiteur par requête (plafond par utilisateur dans le service)
  const mw = [authenticate].concat(limiter ? [limiter] : []);
  const send = (res, e) => {
    if (e instanceof UploadError) return res.status(e.status === 499 ? 400 : e.status).json({ success: false, error: true, code: e.code, reply: e.message, ...e.extra });
    return res.status(500).json({ success: false, error: true, code: "UPLOAD_INTERNAL", reply: "Erreur interne d'upload." });
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { if (!(e instanceof UploadError)) console.error("[luba-upload]", e); send(res, e); });

  r.get("/api/uploads/config", ...mw, (req, res) => res.json({ success: true, maxBytes: service.CFG.MAX_FILE_BYTES, chunkBytes: service.CFG.CHUNK_BYTES, allowed: Object.keys(TYPES) }));
  r.post("/api/uploads", ...mw, express.json({ limit: "16kb" }), wrap(async (req, res) => res.status(201).json({ success: true, ...(await service.init(req.userId, req.body || {})) })));
  r.get("/api/uploads/:id", ...mw, wrap(async (req, res) => res.json({ success: true, ...(await service.status(req.userId, req.params.id)) })));
  r.put("/api/uploads/:id", ...mwChunk, wrap(async (req, res) => res.json({ success: true, ...(await service.appendChunk(req.userId, req.params.id, req)) })));
  r.delete("/api/uploads/:id", ...mw, wrap(async (req, res) => res.json({ success: true, ...(await service.cancel(req.userId, req.params.id)) })));
  r.get("/api/conversations/:cid/files", ...mw, wrap(async (req, res) => res.json({ success: true, files: await service.list(req.userId, req.params.cid) })));
  r.get("/api/conversations/:cid/files/:fid/text", ...mw, wrap(async (req, res) => res.json({ success: true, ...(await service.readText(req.userId, req.params.cid, req.params.fid, { offset: +req.query.offset || 0, maxBytes: +req.query.max || undefined })) })));
  r.get("/api/conversations/:cid/files/:fid", ...mw, wrap(async (req, res) => {
    const { meta, stream } = await service.openDownload(req.userId, req.params.cid, req.params.fid);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", meta.size);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    stream.on("error", () => res.destroy()); stream.pipe(res);
  }));
  r.delete("/api/conversations/:cid/files/:fid", ...mw, wrap(async (req, res) => res.json({ success: true, ...(await service.remove(req.userId, req.params.cid, req.params.fid)) })));
  return r;
}

module.exports = { createUploadService, createUploadRouter, UploadError, sniffKind, safeName, TYPES };
