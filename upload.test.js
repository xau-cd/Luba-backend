"use strict";
// Tests réels du module luba-upload.js avec http natif (aucune dépendance externe).
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createUploadService, UploadError, sniffKind } = require("../luba-upload.js");

const MB = 1024 * 1024;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luba-up-test-"));
const svc = createUploadService({ DIR, MAX_FILE_BYTES: 30 * MB, MAX_USER_BYTES: 200 * MB, PARTIAL_TTL_MS: 50 });
let server, port;

const send = (res, e) => { const st = e instanceof UploadError ? (e.status === 499 ? 400 : e.status) : 500; res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify({ code: e.code || "ERR", message: e.message, ...(e.extra || {}) })); };
test.before(async () => {
  server = http.createServer(async (req, res) => {
    const user = req.headers["x-user"] || "u1";
    try {
      const u = new URL(req.url, "http://x");
      let out;
      if (req.method === "POST" && u.pathname === "/up") { let b = ""; for await (const c of req) b += c; out = await svc.init(user, JSON.parse(b)); res.statusCode = 201; }
      else if (req.method === "PUT") out = await svc.appendChunk(user, u.pathname.split("/")[2], req);
      else if (req.method === "GET" && u.pathname.startsWith("/up/")) out = await svc.status(user, u.pathname.split("/")[2]);
      else if (req.method === "DELETE") out = await svc.cancel(user, u.pathname.split("/")[2]);
      else if (req.method === "GET" && u.pathname === "/files") out = await svc.list(user, u.searchParams.get("c"));
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out));
    } catch (e) { try { send(res, e); } catch {} }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port;
});
test.after(() => { server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

function call(method, p, { body, headers = {}, user } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(user ? { "x-user": user } : {}), ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const pdfBuf = (n) => Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(n - 9)]);
const CONV = "conv_abcdef";

async function uploadWhole(buf, name, { chunk = 1 * MB, user = "u1", conv = CONV } = {}) {
  const i = await call("POST", "/up", { body: JSON.stringify({ name, size: buf.length, conversationId: conv }), user, headers: { "content-type": "application/json" } });
  if (i.status !== 201) return { init: i };
  const id = i.json.uploadId; let off = 0, last;
  while (off < buf.length) {
    const end = Math.min(off + chunk, buf.length);
    last = await call("PUT", "/up/" + id, { body: buf.slice(off, end), user, headers: { "content-range": `bytes ${off}-${end - 1}/${buf.length}`, "content-length": end - off } });
    assert.equal(last.status, 200, JSON.stringify(last.json)); off = last.json.offset;
  }
  return { init: i, last };
}

for (const mb of [2, 5, 10, 25]) {
  test(`fichier de ${mb} Mo : reçu entier, empreinte identique`, async () => {
    const buf = pdfBuf(mb * MB);
    const { last } = await uploadWhole(buf, `doc${mb}.pdf`);
    assert.equal(last.json.complete, true);
    assert.equal(last.json.file.size, buf.length);
    assert.equal(last.json.file.sha256, crypto.createHash("sha256").update(buf).digest("hex"));
    const list = await call("GET", "/files?c=" + CONV);
    assert.ok(list.json.some((f) => f.fileId === last.json.file.fileId));
  });
}

test("25 Mo en UNE seule requête (flux) sans saturer la mémoire", async () => {
  const buf = pdfBuf(25 * MB);
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "one.pdf", size: buf.length, conversationId: CONV }), headers: { "content-type": "application/json" } });
  global.gc?.(); const before = process.memoryUsage().rss;
  const r = await call("PUT", "/up/" + i.json.uploadId, { body: buf, headers: { "content-length": buf.length } });
  const grow = (process.memoryUsage().rss - before) / MB;
  assert.equal(r.json.complete, true);
  console.log(`   rss +${grow.toFixed(1)} Mo pour un fichier de 25 Mo (buffer client de test inclus)`);
});

test("fichier au-dessus de la limite configurée (30 Mo) : refus clair 413", async () => {
  const r = await call("POST", "/up", { body: JSON.stringify({ name: "big.pdf", size: 31 * MB, conversationId: CONV }), headers: { "content-type": "application/json" } });
  assert.equal(r.status, 413); assert.equal(r.json.code, "FILE_TOO_LARGE"); assert.match(r.json.message, /Maximum : 30 Mo/);
});

test("flux qui dépasse la taille annoncée : coupé et nettoyé", async () => {
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "lie.pdf", size: 1 * MB, conversationId: CONV }), headers: { "content-type": "application/json" } });
  const r = await call("PUT", "/up/" + i.json.uploadId, { body: pdfBuf(3 * MB) });
  assert.ok([413, 400].includes(r.status), "status=" + r.status);
  const st = await call("GET", "/up/" + i.json.uploadId);
  assert.equal(st.json.offset, 0);
});

test("upload interrompu puis REPRIS à l'offset exact, résultat identique", async () => {
  const buf = pdfBuf(6 * MB);
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "resume.pdf", size: buf.length, conversationId: CONV }), headers: { "content-type": "application/json" } });
  const id = i.json.uploadId;
  await call("PUT", "/up/" + id, { body: buf.slice(0, 2 * MB), headers: { "content-range": `bytes 0-${2 * MB - 1}/${buf.length}` } });
  // coupure en plein morceau : le client envoie 1 Mo puis détruit la socket
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: "/up/" + id, headers: { "content-range": `bytes ${2 * MB}-${4 * MB - 1}/${buf.length}`, "content-length": 2 * MB } });
    req.on("error", () => {}); req.write(buf.slice(2 * MB, 3 * MB)); setTimeout(() => { req.destroy(); setTimeout(resolve, 150); }, 100);
  });
  const st = await call("GET", "/up/" + id);
  assert.ok(st.json.offset >= 2 * MB && st.json.offset < 4 * MB, "offset=" + st.json.offset);
  const r = await call("PUT", "/up/" + id, { body: buf.slice(st.json.offset), headers: { "content-range": `bytes ${st.json.offset}-${buf.length - 1}/${buf.length}` } });
  assert.equal(r.json.complete, true);
  assert.equal(r.json.file.sha256, crypto.createHash("sha256").update(buf).digest("hex"), "données perdues ou corrompues après reprise");
});

test("mauvais offset : 409 avec l'offset attendu", async () => {
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "off.pdf", size: 2 * MB, conversationId: CONV }), headers: { "content-type": "application/json" } });
  const r = await call("PUT", "/up/" + i.json.uploadId, { body: pdfBuf(1 * MB), headers: { "content-range": `bytes 500-${1 * MB + 499}/${2 * MB}` } });
  assert.equal(r.status, 409); assert.equal(r.json.offset, 0);
});

test("fichiers invalides : exe déguisé en pdf, contenu texte binaire, extension interdite, nom piégé", async () => {
  const exe = Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(5000)]);
    const i1 = await call("POST", "/up", { body: JSON.stringify({ name: "x.pdf", size: exe.length, conversationId: CONV }), headers: { "content-type": "application/json" } });
  const p = await call("PUT", "/up/" + i1.json.uploadId, { body: exe }); assert.equal(p.status, 415); assert.equal(p.json.code, "EXECUTABLE_REFUSED");
  assert.equal((await call("GET", "/up/" + i1.json.uploadId)).status, 404, "le fichier refusé doit être supprimé");
  const i2 = await call("POST", "/up", { body: JSON.stringify({ name: "notes.txt", size: 3000, conversationId: CONV }), headers: { "content-type": "application/json" } });
  const p2 = await call("PUT", "/up/" + i2.json.uploadId, { body: crypto.randomBytes(3000) }); assert.equal(p2.status, 415); assert.equal(p2.json.code, "TYPE_MISMATCH");
  const bad = await call("POST", "/up", { body: JSON.stringify({ name: "run.exe", size: 100, conversationId: CONV }), headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 415);
  const trav = await call("POST", "/up", { body: JSON.stringify({ name: "../../etc/passwd.txt", size: 10, conversationId: CONV }), headers: { "content-type": "application/json" } });
  assert.equal(trav.status, 201); assert.equal((await call("GET", "/up/" + trav.json.uploadId)).json.name, "passwd.txt");
  const badConv = await call("POST", "/up", { body: JSON.stringify({ name: "a.txt", size: 10, conversationId: "../x" }), headers: { "content-type": "application/json" } });
  assert.equal(badConv.status, 400);
});

test("8 fichiers simultanés (4 utilisateurs) sans perte ni mélange", async () => {
  const jobs = [];
  for (let k = 0; k < 8; k++) { const buf = pdfBuf((3 + k) * MB); jobs.push(uploadWhole(buf, `par${k}.pdf`, { user: "multi" + (k % 4), conv: "conv_par" + k }).then((r) => ({ r, buf }))); }
  const res = await Promise.all(jobs);
  for (const { r, buf } of res) { assert.equal(r.last.json.complete, true); assert.equal(r.last.json.file.sha256, crypto.createHash("sha256").update(buf).digest("hex")); }
});

test("isolation entre utilisateurs : u2 ne voit ni ne reprend les uploads de u1", async () => {
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "priv.pdf", size: 1 * MB, conversationId: CONV }), user: "u1", headers: { "content-type": "application/json" } });
  assert.equal((await call("GET", "/up/" + i.json.uploadId, { user: "u2" })).status, 404);
  assert.equal((await call("PUT", "/up/" + i.json.uploadId, { user: "u2", body: pdfBuf(1 * MB) })).status, 404);
  assert.deepEqual((await call("GET", "/files?c=" + CONV, { user: "u2" })).json, []);
});

test("annulation supprime les données ; sweep supprime les uploads abandonnés ; lecture texte bornée", async () => {
  const i = await call("POST", "/up", { body: JSON.stringify({ name: "c.pdf", size: 1 * MB, conversationId: CONV }), headers: { "content-type": "application/json" } });
  assert.equal((await call("DELETE", "/up/" + i.json.uploadId)).status, 200);
  assert.equal((await call("GET", "/up/" + i.json.uploadId)).status, 404);
  const j = await call("POST", "/up", { body: JSON.stringify({ name: "abandon.pdf", size: 1 * MB, conversationId: CONV }), headers: { "content-type": "application/json" } });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok((await svc.sweep()) >= 1);
  assert.equal((await call("GET", "/up/" + j.json.uploadId)).status, 404);
  const txt = Buffer.from("ligne é\n".repeat(200000)); // ~1,8 Mo
  const t = await uploadWhole(txt, "gros.txt");
  const rd = await svc.readText("u1", CONV, t.last.json.file.fileId, { maxBytes: 1000 });
  assert.equal(rd.bytesRead, 1000); assert.equal(rd.truncated, true);
  const pf = (await uploadWhole(pdfBuf(100000), "p.pdf")).last.json.file.fileId;
  await assert.rejects(() => svc.readText("u1", CONV, pf), /Lecture texte indisponible/);
});

test("sniffKind", () => { assert.equal(sniffKind(Buffer.from("%PDF-1")), "pdf"); assert.equal(sniffKind(Buffer.from("hello")), "text"); assert.equal(sniffKind(Buffer.from([0, 1, 2])), "binary"); });
