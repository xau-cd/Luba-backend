"use strict";
// Tests de LUBA PROGRAMMER — exécuter : node --no-warnings test_programmer.js
// Base : node:sqlite (même dialecte SQLite que la base de LUBA). Service Push : faux expéditeur (les vrais envois nécessitent VAPID + un navigateur).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const P = require("../programmer.js");

// ---------- Adaptateur : même interface que la classe Database de index.js (write / transaction / get / all / run) ----------
class TestDb {
  constructor(file) { this.raw = new DatabaseSync(file); this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;"); this.tail = Promise.resolve(); this.w = {
    run: async (s, p = []) => { const r = this.raw.prepare(s).run(...p.map((v) => (v === undefined ? null : v))); return { changes: Number(r.changes), lastID: Number(r.lastInsertRowid) }; },
    get: async (s, p = []) => this.raw.prepare(s).get(...p.map((v) => (v === undefined ? null : v))),
    all: async (s, p = []) => this.raw.prepare(s).all(...p.map((v) => (v === undefined ? null : v))),
    exec: async (s) => this.raw.exec(s) }; }
  write(fn) { const r = this.tail.then(() => fn(this.w)); this.tail = r.then(() => {}, () => {}); return r; }
  async transaction(fn) { return this.write(async (w) => { await w.exec("BEGIN IMMEDIATE"); try { const r = await fn(w); await w.exec("COMMIT"); return r; } catch (e) { try { await w.exec("ROLLBACK"); } catch {} throw e; } }); }
  get(s, p) { return this.w.get(s, p); } all(s, p) { return this.w.all(s, p); } run(s, p) { return this.write((w) => w.run(s, p)); }
  close() { this.raw.close(); }
}
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let clock = Date.UTC(2026, 10, 11, 8, 0, 0);          // 11 nov. 2026 08:00 UTC = 09:00 à Kinshasa/Paris(hiver)… (modifiable)
const NOW = () => clock;
const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e]); } };

function fakeSender(script = []) {
  const calls = [];
  const f = async (sub, payload, opts) => { calls.push({ sub, payload: JSON.parse(payload), opts }); const step = script.shift(); return step || { ok: true, status: 201 }; };
  f.calls = calls; return f;
}
const b64u = (b) => b.toString("base64url");
function realisticSub(n = 1) {
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/test-endpoint-${n}-${crypto.randomBytes(4).toString("hex")}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
}
async function mk({ file, sender, tzUser = "Africa/Kinshasa" } = {}) {
  const f = file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prg-")), "luba.db");
  const db = new TestDb(f);
  await db.write((w) => w.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT)"));
  await db.run("INSERT OR IGNORE INTO users (id, display_name, email) VALUES ('u1','Damien Kalala','a@x.cd'), ('u2','Grace Mbuyi','b@x.cd')");
  const prg = P.createProgrammer({ db, logger: silent, sender, now: NOW });
  await prg.start(); prg.stop();
  if (tzUser) { await prg.saveSettings("u1", { timezone: tzUser }); await prg.saveSettings("u2", { timezone: tzUser }); }
  return { db, prg, file: f };
}
const chat = (prg, message, user = "u1", ch = "web") => prg.handleChatMessage({ userId: user, convId: "conv_test1", message, channel: ch });
const ymdStr = (ms, tz) => { const l = P.localParts(ms, tz); return `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")} ${String(l.h).padStart(2, "0")}:${String(l.mi).padStart(2, "0")}`; };

(async () => {
  const TZ = "Africa/Kinshasa";                                       // UTC+1 sans heure d'été ; mercredi 11 nov. 2026, 09:00 locale
  // ================= ANALYSE : les 5 exemples du cahier des charges =================
  await test("Parse : « rappelle-moi demain à 8 h de préparer mon exposé »", async () => {
    const p = P.parseReminder("LUBA, rappelle-moi demain à 8 h de préparer mon exposé.");
    assert.strictEqual(p.intent, "reminder"); assert.strictEqual(p.title, "Préparer mon exposé"); assert.deepStrictEqual(p.time, { h: 8, mi: 0 }); assert.strictEqual(p.date.days, 1); assert.strictEqual(p.icon, "study");
  });
  await test("Parse : « dans trois heures de vérifier mon serveur »", async () => {
    const p = P.parseReminder("Rappelle-moi dans trois heures de vérifier mon serveur"); assert.strictEqual(p.rel.minutes, 180); assert.strictEqual(p.title, "Vérifier mon serveur"); assert.strictEqual(p.icon, "server");
  });
  await test("Parse : « Programme une réunion vendredi prochain à 14 h »", async () => {
    const p = P.parseReminder("Programme une réunion vendredi prochain à 14 h"); assert.strictEqual(p.title, "Réunion"); assert.strictEqual(p.date.dow, 5); assert.strictEqual(p.date.strict, true); assert.deepStrictEqual(p.time, { h: 14, mi: 0 }); assert.strictEqual(p.icon, "meeting");
  });
  await test("Parse : « Chaque lundi à 7 h, rappelle-moi de réviser »", async () => {
    const p = P.parseReminder("Chaque lundi à 7 h, rappelle-moi de réviser"); assert.deepStrictEqual(p.rec, { freq: "weekly", interval: 1, byday: [1] }); assert.strictEqual(p.title, "Réviser"); assert.deepStrictEqual(p.time, { h: 7, mi: 0 });
  });
  await test("Parse : « Le 20 décembre, rappelle-moi de participer à la conférence » (heure manquante)", async () => {
    const p = P.parseReminder("Le 20 décembre, rappelle-moi de participer à la conférence."); assert.strictEqual(p.date.d, 20); assert.strictEqual(p.date.mo, 12); assert.strictEqual(p.time, null); assert.strictEqual(p.title, "Participer à la conférence");
  });
  await test("Parse : pas d'intention → aucune création (activités simplement mentionnées)", async () => {
    for (const t of ["Demain j'ai une réunion à 14 h, je suis stressé", "Comment programmer en Python une boucle ?", "Comment faire un rappel en JavaScript ?", "Il m'a rappelé hier à 8 h", "Je vais réviser lundi à 7 h", "Programme un cours de python pour débutants", "```js\nconst x = 'rappelle-moi demain'```"]) assert.strictEqual(P.parseReminder(t).intent, "none", t);
  });
  await test("Parse : formes d'heure variées", async () => {
    const f = (t) => P.parseReminder(`rappelle-moi ${t} de x`).time;
    assert.deepStrictEqual(f("demain à 8h30"), { h: 8, mi: 30 }); assert.deepStrictEqual(f("demain à 14:05"), { h: 14, mi: 5 }); assert.deepStrictEqual(f("demain à midi"), { h: 12, mi: 0 });
    assert.deepStrictEqual(f("demain à 8 h du soir"), { h: 20, mi: 0 }); assert.deepStrictEqual(f("demain à huit heures"), { h: 8, mi: 0 }); assert.deepStrictEqual(f("demain à 7pm"), { h: 19, mi: 0 });
  });
  await test("Parse : « pendant 2 heures » n'est pas une heure", async () => {
    const p = P.parseReminder("Rappelle-moi demain à 8 h de réviser pendant 2 heures"); assert.deepStrictEqual(p.time, { h: 8, mi: 0 }); assert.ok(/pendant 2 heures/.test(p.title));
  });

  // ================= CHAT : création réelle, clarification, listage =================
  const { db, prg, file } = await mk();
  const users = new Set();
  await test("Chat : création « demain à 8 h » → ligne réellement enregistrée + confirmation", async () => {
    const r = await chat(prg, "LUBA, rappelle-moi demain à 8 h de préparer mon exposé.");
    assert.strictEqual(r.action, "created"); assert.ok(/C'est programmé ! Je te rappellerai demain à 8 h de préparer ton exposé\./.test(r.reply), r.reply);
    const row = await db.get("SELECT * FROM programmer_reminders WHERE id = ?", [r.reminder.id]);
    assert.ok(row); assert.strictEqual(row.user_id, "u1"); assert.strictEqual(ymdStr(row.next_run_at, TZ), "2026-11-12 08:00"); assert.strictEqual(row.source, "chat"); assert.strictEqual(row.conv_id, "conv_test1");
  });
  await test("Chat : doublon (même message rejoué) → pas de 2e ligne", async () => {
    const before = (await db.get("SELECT COUNT(*) n FROM programmer_reminders")).n;
    const r = await chat(prg, "LUBA, rappelle-moi demain à 8 h de préparer mon exposé."); assert.strictEqual(r.duplicate, true);
    assert.strictEqual((await db.get("SELECT COUNT(*) n FROM programmer_reminders")).n, before);
  });
  await test("Chat : message ordinaire → null (le LLM répond)", async () => { assert.strictEqual(await chat(prg, "Explique-moi la photosynthèse"), null); });
  await test("Chat : relatif « dans trois heures » (Live) → source live, heure exacte", async () => {
    const r = await chat(prg, "Rappelle-moi dans trois heures de vérifier mon serveur", "u1", "live-ws");
    assert.strictEqual(r.action, "created"); assert.strictEqual(r.reminder.source, "live"); assert.strictEqual(Date.parse(r.reminder.nextRunAt), clock + 3 * 3600000); assert.strictEqual(r.reminder.icon, "server");
    assert.ok(/aujourd'hui à 12 h/.test(r.reply), r.reply);
  });
  await test("Chat : clarification (heure manquante) puis création sur la réponse « à 14 h »", async () => {
    const q = await chat(prg, "Le 20 décembre, rappelle-moi de participer à la conférence.");
    assert.strictEqual(q.action, "clarify"); assert.ok(/À quelle heure/.test(q.reply));
    assert.strictEqual((await db.get("SELECT COUNT(*) n FROM programmer_reminders WHERE title LIKE 'Participer%'")).n, 0);     // rien enregistré avant la réponse
    const r = await chat(prg, "à 14 h");
    assert.strictEqual(r.action, "created"); assert.strictEqual(ymdStr(Date.parse(r.reminder.nextRunAt), TZ), "2026-12-20 14:00"); assert.strictEqual(r.reminder.icon, "conference");
  });
  await test("Chat : clarification « quoi ? » puis annulation", async () => {
    const q = await chat(prg, "rappelle-moi demain à 9 h"); assert.strictEqual(q.action, "clarify"); assert.ok(/Que veux-tu/.test(q.reply));
    const c = await chat(prg, "non, laisse tomber"); assert.strictEqual(c.action, "cancelled");
  });
  await test("Chat : question de clarification puis message sans rapport → pending abandonné, LLM reprend", async () => {
    await chat(prg, "rappelle-moi demain de payer le loyer"); const r = await chat(prg, "Au fait, quelle est la capitale de la France et pourquoi est-elle si célèbre dans le monde entier ?");
    assert.strictEqual(r, null); assert.strictEqual(await db.get("SELECT * FROM programmer_pending WHERE user_id='u1'"), undefined);
  });
  await test("Chat : date passée → on redemande, rien d'enregistré", async () => {
    const n = (await db.get("SELECT COUNT(*) n FROM programmer_reminders")).n;
    const r = await chat(prg, "Rappelle-moi le 3 novembre 2026 à 8 h de payer"); assert.strictEqual(r.action, "clarify"); assert.ok(/déjà passée/.test(r.reply));
    assert.strictEqual((await db.get("SELECT COUNT(*) n FROM programmer_reminders")).n, n); await chat(prg, "non");
  });
  await test("Chat : récurrence hebdomadaire « chaque lundi à 7 h »", async () => {
    const r = await chat(prg, "Chaque lundi à 7 h, rappelle-moi de réviser");
    assert.strictEqual(r.action, "created"); assert.strictEqual(ymdStr(Date.parse(r.reminder.nextRunAt), TZ), "2026-11-16 07:00"); assert.deepStrictEqual(r.reminder.recurrence, { freq: "weekly", interval: 1, byday: [1] }); assert.ok(/chaque lundi à 7 h/.test(r.reply), r.reply);
  });
  await test("Chat : listage réel des rappels", async () => { const r = await chat(prg, "Quels sont mes rappels ?"); assert.strictEqual(r.action, "listed"); assert.ok(/préparer mon exposé/i.test(r.reply)); });
  await test("Chat : « programme une réunion vendredi prochain à 14 h »", async () => {
    const r = await chat(prg, "Programme une réunion vendredi prochain à 14 h"); assert.strictEqual(ymdStr(Date.parse(r.reminder.nextRunAt), TZ), "2026-11-13 14:00"); assert.ok(/« Réunion » est prévu après-demain à 14 h/.test(r.reply), r.reply);
  });
  await test("Chat : rappel anticipé « 15 minutes avant »", async () => {
    const r = await chat(prg, "Rappelle-moi le 25 novembre à 10 h de passer l'examen, préviens-moi 15 minutes avant");
    assert.deepStrictEqual(r.reminder.leadMinutes, [0, 15]); assert.ok(/15 minutes avant/.test(r.reply));
  });

  // ================= CRUD API (couche service) =================
  let rid;
  await test("Création UI + validation des entrées", async () => {
    const out = await prg.createReminder("u1", { title: "Appel client", date: "2026-11-20", time: "10:30", leadMinutes: [10, 60] }, { source: "ui" });
    rid = out.reminder.id; assert.deepStrictEqual(out.reminder.leadMinutes, [0, 10, 60]); assert.strictEqual(out.reminder.icon, "call");
    for (const bad of [{ title: "", date: "2026-11-20", time: "10:30" }, { title: "x", date: "2026-02-31", time: "10:30" }, { title: "x", date: "2026-11-20", time: "25:00" }, { title: "x", date: "2020-01-01", time: "10:00" }, { title: "x", date: "2026-11-20", time: "10:00", timezone: "Mars/Olympus" }, { title: "x", date: "2026-11-20", time: "10:00", recurrence: { freq: "hourly" } }, { title: "x", date: "2026-11-20", time: "10:00", leadMinutes: [-5] }])
      await assert.rejects(() => prg.createReminder("u1", bad), (e) => e.status === 400, JSON.stringify(bad));
  });
  await test("Modification : horaire changé → notifications en attente de l'ancien horaire supprimées", async () => {
    clock += 0; const r = await prg.updateReminder("u1", rid, { time: "11:00", title: "Appel client Alpha" });
    assert.strictEqual(r.time, "11:00"); assert.strictEqual(r.title, "Appel client Alpha"); assert.strictEqual(ymdStr(Date.parse(r.nextRunAt), TZ), "2026-11-20 11:00");
  });
  await test("Marquer comme terminé (ponctuel) puis liste Terminés", async () => {
    const r = await prg.completeReminder("u1", rid); assert.strictEqual(r.status, "done"); assert.ok(r.completedAt);
    assert.ok((await prg.listReminders("u1", { status: "done" })).some((x) => x.id === rid));
  });
  await test("Suppression", async () => { await prg.deleteReminder("u1", rid); await assert.rejects(() => prg.getDetails("u1", rid), (e) => e.status === 404); });

  // ================= PROTECTION ENTRE COMPTES =================
  await test("Isolation : u2 ne peut ni lire, ni modifier, ni terminer, ni supprimer les rappels de u1", async () => {
    const mine = (await prg.createReminder("u1", { title: "Secret u1", date: "2026-12-01", time: "09:00" })).reminder.id;
    await assert.rejects(() => prg.getDetails("u2", mine), (e) => e.status === 404);
    await assert.rejects(() => prg.updateReminder("u2", mine, { title: "piraté" }), (e) => e.status === 404);
    await assert.rejects(() => prg.completeReminder("u2", mine), (e) => e.status === 404);
    await assert.rejects(() => prg.deleteReminder("u2", mine), (e) => e.status === 404);
    assert.ok(!(await prg.listReminders("u2")).some((x) => x.id === mine));
    assert.strictEqual((await prg.getDetails("u1", mine)).title, "Secret u1");
    assert.strictEqual(await prg.contextBlock("u2"), "");
  });

  // ================= RÉCURRENCES & FUSEAUX HORAIRES =================
  await test("Récurrence quotidienne", async () => {
    const rule = P.normRule({ freq: "daily" }, { y: 2026, mo: 11, d: 11 }); let t = Date.UTC(2026, 10, 11, 7, 0); const seen = [];
    for (let i = 0; i < 3; i++) { t = P.nextAfter(rule, { y: 2026, mo: 11, d: 11 }, TZ, 8, 0, t); seen.push(ymdStr(t, TZ)); }
    assert.deepStrictEqual(seen, ["2026-11-12 08:00", "2026-11-13 08:00", "2026-11-14 08:00"]);
  });
  await test("Récurrence hebdomadaire multi-jours + intervalle 2 semaines", async () => {
    const a = { y: 2026, mo: 11, d: 9 };                                                  // lundi 9
    const r = P.normRule({ freq: "weekly", byday: [1, 4], interval: 2 }, a); let t = Date.UTC(2026, 10, 9, 0, 0); const seen = [];
    for (let i = 0; i < 4; i++) { t = P.nextAfter(r, a, TZ, 7, 0, t); seen.push(ymdStr(t, TZ)); }
    assert.deepStrictEqual(seen, ["2026-11-09 07:00", "2026-11-12 07:00", "2026-11-23 07:00", "2026-11-26 07:00"]);
  });
  await test("Récurrence mensuelle : le 31 → dernier jour du mois (28/29 février)", async () => {
    const a = { y: 2027, mo: 1, d: 31 }; const r = P.normRule({ freq: "monthly" }, a); let t = Date.UTC(2027, 0, 1); const seen = [];
    for (let i = 0; i < 3; i++) { t = P.nextAfter(r, a, TZ, 9, 0, t); seen.push(ymdStr(t, TZ)); }
    assert.deepStrictEqual(seen, ["2027-01-31 09:00", "2027-02-28 09:00", "2027-03-31 09:00"]);
  });
  await test("Récurrence : « until » termine la série", async () => {
    const a = { y: 2026, mo: 11, d: 11 }; const r = P.normRule({ freq: "daily", until: "2026-11-13" }, a);
    assert.ok(P.nextAfter(r, a, TZ, 8, 0, Date.UTC(2026, 10, 12, 12)) !== null); assert.strictEqual(P.nextAfter(r, a, TZ, 8, 0, Date.UTC(2026, 10, 13, 12)), null);
  });
  await test("Heure d'été Europe/Paris : 07:00 reste 07:00 locale (26→29 mars 2026) ; heure inexistante décalée", async () => {
    const a = { y: 2026, mo: 3, d: 27 }; const r = P.normRule({ freq: "daily" }, a); let t = Date.UTC(2026, 2, 27, 0, 0); const utc = [], loc = [];
    for (let i = 0; i < 3; i++) { t = P.nextAfter(r, a, "Europe/Paris", 7, 0, t); utc.push(new Date(t).toISOString().slice(11, 16)); loc.push(ymdStr(t, "Europe/Paris")); }
    assert.deepStrictEqual(loc, ["2026-03-27 07:00", "2026-03-28 07:00", "2026-03-29 07:00"]); assert.deepStrictEqual(utc, ["06:00", "06:00", "05:00"]);       // l'heure UTC change, l'heure locale non
    assert.strictEqual(ymdStr(P.zonedToUtc(2026, 3, 29, 2, 30, "Europe/Paris"), "Europe/Paris"), "2026-03-29 03:30");
  });
  await test("Fuseaux : même rappel 08:00 à Kinshasa, New York et Tokyo → instants UTC distincts", async () => {
    const d = [["Africa/Kinshasa", "07:00"], ["America/New_York", "13:00"], ["Asia/Tokyo", "23:00"]].map(([tz]) => new Date(P.zonedToUtc(2026, 11, 20, 8, 0, tz)).toISOString().slice(11, 16));
    assert.deepStrictEqual(d, ["07:00", "13:00", "23:00"]);
  });
  await test("Changement de fuseau de l'utilisateur : applyToExisting recalcule en conservant l'heure murale", async () => {
    const r = (await prg.createReminder("u2", { title: "Appeler la banque", date: "2026-11-25", time: "09:00", timezone: "Africa/Kinshasa" })).reminder;
    assert.strictEqual(r.nextRunAt, "2026-11-25T08:00:00.000Z");
    assert.strictEqual(await prg.applyTimezoneToReminders("u2", "America/New_York"), 1);
    assert.strictEqual((await prg.getDetails("u2", r.id)).nextRunAt, "2026-11-25T14:00:00.000Z");
  });
  await test("Agenda : récurrences dépliées sur un mois, jours/semaines/mois", async () => {
    const occ = await prg.agenda("u1", Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)); const mondays = occ.filter((o) => o.title === "Réviser");
    assert.deepStrictEqual(mondays.map((o) => ymdStr(Date.parse(o.at), TZ)), ["2026-11-16 07:00", "2026-11-23 07:00", "2026-11-30 07:00"]);
    await assert.rejects(() => prg.agenda("u1", 0, 200 * 86400000), (e) => e.status === 400);
  });

  // ================= SCHEDULER : envoi unique, idempotence, relances, expirés, manqués, redémarrage =================
  const sd = fakeSender(); const S = await mk({ sender: sd });
  const sub1 = realisticSub(1), sub2 = realisticSub(2);
  await test("Abonnement Push : validation stricte (HTTPS public, clés p256dh/auth)", async () => {
    for (const bad of [null, {}, { endpoint: "http://fcm.googleapis.com/x/yyyyyyyyyyyy", keys: sub1.keys }, { endpoint: "https://localhost/xxxxxxxxxxxxxxxxx", keys: sub1.keys }, { endpoint: "https://127.0.0.1/xxxxxxxxxxxxxxxxx", keys: sub1.keys }, { endpoint: sub1.endpoint, keys: { p256dh: "abc", auth: sub1.keys.auth } }, { endpoint: sub1.endpoint, keys: { p256dh: sub1.keys.p256dh, auth: "!!" } }])
      assert.throws(() => P.validateSubscription(bad), /./, JSON.stringify(bad));
    await S.prg.saveSubscription("u1", sub1, "UA-test"); await S.prg.saveSubscription("u1", sub2, "UA-test2");
    assert.strictEqual((await S.prg.pushStatus("u1")).activeSubscriptions, 2);
    await S.prg.saveSubscription("u2", sub1);                                            // même endpoint ré-associé à u2 (changement de compte sur l'appareil)
    assert.strictEqual((await S.prg.pushStatus("u1")).activeSubscriptions, 1);
    await S.prg.saveSubscription("u1", sub1);
  });
  const SC = { clock0: 0 };
  await test("Scheduler : rien n'est envoyé avant l'heure ; une seule notification à l'heure ; pas de doublon sur ticks répétés/concurrents", async () => {
    S.prg.state.senderReady = true;
    clock = Date.UTC(2026, 10, 11, 8, 0, 0);
    const r = (await S.prg.createReminder("u1", { title: "Vérifier le serveur", date: "2026-11-11", time: "10:00", leadMinutes: [15] })).reminder; SC.id = r.id;
    sd.calls.length = 0; await S.prg.tick(); assert.strictEqual(sd.calls.length, 0);                   // 09:00 locale < 09:45
    clock = Date.UTC(2026, 10, 11, 8, 46, 0);                                            // 09:46 locale → rappel anticipé -15 min dû
    await Promise.all([S.prg.tick(), S.prg.tick(), S.prg.tick()]); await S.prg.tick();
    assert.strictEqual(sd.calls.length, 2, "1 envoi anticipé × 2 abonnements");            assert.ok(/Dans 15 minutes/.test(sd.calls[0].payload.title));
    clock = Date.UTC(2026, 10, 11, 9, 0, 30);
    await Promise.all([S.prg.tick(), S.prg.tick()]); await S.prg.tick(); await S.prg.tick();
    assert.strictEqual(sd.calls.length, 4, "+1 envoi à l'heure × 2 abonnements"); assert.strictEqual(sd.calls[2].payload.body, "Vérifier le serveur");
    const rows = await S.db.all("SELECT lead_minutes, status, attempts, accepted_count FROM programmer_notifications WHERE reminder_id = ? ORDER BY lead_minutes", [r.id]);
    assert.deepStrictEqual(rows.map((x) => [x.lead_minutes, x.status, x.attempts, x.accepted_count]), [[0, "sent", 1, 2], [15, "sent", 1, 2]]);
    assert.strictEqual((await S.prg.getDetails("u1", r.id)).status, "overdue");           // passé et non terminé
  });
  await test("Scheduler : le rappel d'un autre compte n'est jamais envoyé aux abonnements de u1", async () => {
    sd.calls.length = 0; clock = Date.UTC(2026, 10, 12, 8, 0, 0); await S.prg.saveSubscription("u2", realisticSub(9));
    await S.prg.createReminder("u2", { title: "Pour u2 seulement", date: "2026-11-12", time: "09:30" }); clock = Date.UTC(2026, 10, 12, 8, 31, 0);
    await S.prg.tick(); const subs = await S.db.all("SELECT endpoint FROM programmer_push_subscriptions WHERE user_id='u2'");
    assert.strictEqual(sd.calls.length, 1); assert.ok(subs.some((s) => s.endpoint === sd.calls[0].sub.endpoint));
  });
  await test("Scheduler : erreur 503 → nouvelle tentative avec délai, puis succès (1 seul envoi réussi)", async () => {
    const sd2 = fakeSender([{ ok: false, status: 503, error: "busy" }]); const T = await mk({ sender: sd2 });
    await T.prg.saveSubscription("u1", realisticSub(3)); clock = Date.UTC(2026, 10, 13, 8, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Test relance", date: "2026-11-13", time: "09:05" })).reminder; clock = Date.UTC(2026, 10, 13, 8, 5, 10);
    await T.prg.tick(); let n = await T.db.get("SELECT * FROM programmer_notifications WHERE reminder_id = ?", [r.id]);
    assert.strictEqual(n.status, "pending"); assert.strictEqual(n.attempts, 1); assert.ok(/503/.test(n.last_error)); assert.ok(n.next_attempt_at > clock);
    await T.prg.tick(); assert.strictEqual(sd2.calls.length, 1, "pas de nouvel essai avant le délai");
    clock += 31000; await T.prg.tick(); n = await T.db.get("SELECT * FROM programmer_notifications WHERE reminder_id = ?", [r.id]);
    assert.strictEqual(n.status, "sent"); assert.strictEqual(n.attempts, 2); assert.strictEqual(sd2.calls.length, 2);
  });
  await test("Scheduler : échecs répétés → « failed » après le maximum d'essais (jamais présumé envoyé)", async () => {
    const sd3 = fakeSender(Array(10).fill({ ok: false, status: 500, error: "down" })); const T = await mk({ sender: sd3 });
    await T.prg.saveSubscription("u1", realisticSub(4)); clock = Date.UTC(2026, 10, 14, 8, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Toujours en panne", date: "2026-11-14", time: "09:05" })).reminder; clock = Date.UTC(2026, 10, 14, 8, 5, 5);
    for (let i = 0; i < 8; i++) { await T.prg.tick(); clock += 16 * 60000; }
    const n = await T.db.get("SELECT * FROM programmer_notifications WHERE reminder_id = ?", [r.id]);
    assert.strictEqual(n.status, "failed"); assert.strictEqual(n.attempts, 5); assert.strictEqual(n.accepted_count, 0);
  });
  await test("Scheduler : abonnement expiré (410) marqué « expired » ; sans abonnement → « undelivered »", async () => {
    const sd4 = fakeSender([{ ok: false, status: 410, error: "gone" }]); const T = await mk({ sender: sd4 });
    const s = realisticSub(5); await T.prg.saveSubscription("u1", s); clock = Date.UTC(2026, 10, 15, 8, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Abo expiré", date: "2026-11-15", time: "09:05" })).reminder; clock = Date.UTC(2026, 10, 15, 8, 5, 5); await T.prg.tick();
    assert.strictEqual((await T.db.get("SELECT status FROM programmer_push_subscriptions WHERE endpoint = ?", [s.endpoint])).status, "expired");
    assert.strictEqual((await T.db.get("SELECT status, last_error FROM programmer_notifications WHERE reminder_id = ?", [r.id])).status, "failed");
    const r2 = (await T.prg.createReminder("u1", { title: "Sans abonnement actif", date: "2026-11-15", time: "09:20" })).reminder; clock = Date.UTC(2026, 10, 15, 8, 20, 5); await T.prg.tick();
    const n2 = await T.db.get("SELECT status, last_error FROM programmer_notifications WHERE reminder_id = ?", [r2.id]); assert.deepStrictEqual([n2.status, n2.last_error], ["undelivered", "NO_SUBSCRIPTION"]);
  });
  await test("Scheduler : Push non configuré (pas d'expéditeur) → « undelivered/PUSH_NOT_CONFIGURED », pas de faux envoi", async () => {
    const T = await mk({ sender: null }); await T.prg.saveSubscription("u1", realisticSub(6)); clock = Date.UTC(2026, 10, 16, 8, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Sans VAPID", date: "2026-11-16", time: "09:05" })).reminder; clock = Date.UTC(2026, 10, 16, 8, 5, 5); await T.prg.tick();
    const n = await T.db.get("SELECT status, last_error FROM programmer_notifications WHERE reminder_id = ?", [r.id]); assert.deepStrictEqual([n.status, n.last_error], ["undelivered", "PUSH_NOT_CONFIGURED"]);
    const c = await T.prg.handleChatMessage({ userId: "u1", message: "rappelle-moi demain à 9 h de tester", channel: "web" }); assert.ok(/pas encore activées sur ce serveur/.test(c.reply));
  });
  await test("Rappels manqués : interruption longue → hors tolérance « missed » (non envoyés), dans la tolérance envoyés en retard", async () => {
    const sd5 = fakeSender(); const T = await mk({ sender: sd5 }); await T.prg.saveSubscription("u1", realisticSub(7)); clock = Date.UTC(2026, 10, 17, 6, 0, 0);
    const old = (await T.prg.createReminder("u1", { title: "Très ancien", date: "2026-11-17", time: "08:00" })).reminder;
    const recent = (await T.prg.createReminder("u1", { title: "Récent", date: "2026-11-17", time: "10:30" })).reminder;
    clock = Date.UTC(2026, 10, 17, 11, 0, 0);                                           // 12:00 locale : 4 h après l'un, 1 h 30 après l'autre (tolérance 2 h)
    await T.prg.tick();
    assert.strictEqual((await T.db.get("SELECT status FROM programmer_notifications WHERE reminder_id = ?", [old.id])).status, "missed");
    assert.strictEqual((await T.db.get("SELECT status FROM programmer_notifications WHERE reminder_id = ?", [recent.id])).status, "sent");
    assert.ok(/prévu à 10 h 30/.test(sd5.calls[0].payload.body), sd5.calls[0].payload.body);
    assert.strictEqual((await T.prg.getDetails("u1", old.id)).status, "overdue");
  });
  await test("Récurrent manqué plusieurs jours : une seule notification (la plus récente), le reste « missed », prochaine occurrence future", async () => {
    const sd6 = fakeSender(); const T = await mk({ sender: sd6 }); await T.prg.saveSubscription("u1", realisticSub(8)); clock = Date.UTC(2026, 10, 18, 5, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Boire de l'eau", date: "2026-11-18", time: "08:00", recurrence: { freq: "daily" } })).reminder;
    clock = Date.UTC(2026, 10, 22, 7, 30, 0);                                           // 4 jours d'interruption, 08:30 locale le 22
    await T.prg.tick(); await T.prg.tick();
    const st = await T.db.all("SELECT status, COUNT(*) n FROM programmer_notifications WHERE reminder_id = ? GROUP BY status", [r.id]);
    const by = Object.fromEntries(st.map((x) => [x.status, x.n])); assert.strictEqual(by.sent, 1); assert.strictEqual(by.missed, 4); assert.strictEqual(sd6.calls.length, 1);
    const cur = await T.prg.getDetails("u1", r.id); assert.strictEqual(cur.status, "scheduled"); assert.strictEqual(ymdStr(Date.parse(cur.nextRunAt), TZ), "2026-11-23 08:00");
  });
  await test("Récurrent : « terminé » avance à la prochaine occurrence sans fermer la série", async () => {
    const T = await mk({ sender: fakeSender() }); clock = Date.UTC(2026, 10, 11, 5, 0, 0);
    const r = (await T.prg.createReminder("u1", { title: "Faire du sport", date: "2026-11-11", time: "07:00", recurrence: { freq: "weekly", byday: [3, 6] } })).reminder;
    const c = await T.prg.completeReminder("u1", r.id); assert.strictEqual(c.status, "scheduled"); assert.strictEqual(ymdStr(Date.parse(c.nextRunAt), TZ), "2026-11-14 07:00"); assert.strictEqual(c.completedCount, 1);
  });
  await test("Redémarrage : nouvelle instance sur le même fichier → rappels conservés, aucun doublon d'envoi, reprise des envois « sending » orphelins", async () => {
    const sd7 = fakeSender(); const A = await mk({ sender: sd7 }); await A.prg.saveSubscription("u1", realisticSub(10)); clock = Date.UTC(2026, 10, 19, 8, 0, 0);
    const r = (await A.prg.createReminder("u1", { title: "Survit au redémarrage", date: "2026-11-19", time: "09:10" })).reminder;
    clock = Date.UTC(2026, 10, 19, 8, 10, 5); await A.db.run("UPDATE programmer_reminders SET updated_at = updated_at");           // aucun envoi encore
    // simule un crash en plein envoi : la ligne est « sending » avec un verrou expiré
    await A.prg.tick(); await A.db.run("UPDATE programmer_notifications SET status='sending', locked_until=?, accepted_count=0, sent_at=NULL WHERE reminder_id=?", [clock - 1000, r.id]); const before = sd7.calls.length;
    A.db.close(); const sd8 = fakeSender(); const B = await mk({ file: A.file, sender: sd8, tzUser: null });
    assert.strictEqual((await B.prg.getDetails("u1", r.id)).title, "Survit au redémarrage");
    await B.prg.tick(); await B.prg.tick(); assert.strictEqual(sd8.calls.length, 1, "le verrou expiré est repris UNE fois"); assert.ok(before >= 1);
    assert.strictEqual((await B.db.get("SELECT status FROM programmer_notifications WHERE reminder_id = ?", [r.id])).status, "sent");
  });
  await test("Persistance : migration idempotente (relancer start() ne casse rien) + tables créées", async () => {
    await prg.migrate(); await prg.migrate();
    const t = (await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'programmer_%'")).map((x) => x.name).sort();
    assert.deepStrictEqual(t, ["programmer_notifications", "programmer_pending", "programmer_push_subscriptions", "programmer_reminders", "programmer_settings"]);
    assert.strictEqual((await db.get("SELECT COUNT(*) n FROM schema_migrations WHERE id = ?", [P.MIGRATION_ID])).n, 1);
  });
  await test("Suppression d'un rappel : l'historique de notifications est supprimé en cascade", async () => {
    const n0 = (await S.db.get("SELECT COUNT(*) n FROM programmer_notifications WHERE reminder_id = ?", [SC.id])).n; assert.ok(n0 > 0);
    await S.prg.deleteReminder("u1", SC.id); assert.strictEqual((await S.db.get("SELECT COUNT(*) n FROM programmer_notifications WHERE reminder_id = ?", [SC.id])).n, 0);
  });

  // ================= CONTEXTE DE CONVERSATION =================
  await test("Contexte : prénom lu depuis le profil (jamais codé en dur), rappel proche seulement, discret (pas répété sous 2 h), confidentiel", async () => {
    const C = await mk({ sender: fakeSender() }); clock = Date.UTC(2026, 10, 20, 6, 0, 0);
    await C.prg.createReminder("u1", { title: "Conférence sur les énergies renouvelables", date: "2026-11-20", time: "12:00" });
    await C.prg.createReminder("u1", { title: "Dans trois jours", date: "2026-11-23", time: "12:00" });
    const b1 = await C.prg.contextBlock("u1"); assert.ok(/prénom : Damien/.test(b1)); assert.ok(/Conférence sur les énergies renouvelables — aujourd'hui à 12 h/.test(b1)); assert.ok(!/Dans trois jours/.test(b1)); assert.ok(/CONFIDENTIELLES/.test(b1));
    assert.strictEqual(await C.prg.contextBlock("u1"), "", "pas de répétition à chaque réponse");
    assert.strictEqual(await C.prg.contextBlock("u2"), "", "rien pour un autre compte");
    clock += 3 * 3600000; await C.db.run("UPDATE users SET display_name = 'Josué Tshala' WHERE id='u1'"); assert.ok(/prénom : Josué/.test(await C.prg.contextBlock("u1")));
  });
  await test("Pont create_task : une tâche LLM avec échéance crée un vrai rappel (source llm), sans échéance → rien", async () => {
    clock = Date.UTC(2026, 10, 11, 8, 0, 0); const r = await prg.createFromTask("u1", { title: "Acheter du pain", notes: "boulangerie", dueAtMs: clock + 2 * 3600000 });
    assert.strictEqual(r.source, "llm"); assert.strictEqual(await prg.createFromTask("u1", { title: "x", dueAtMs: NaN }), null);
  });

  // ================= ROUTES HTTP (faux Express : mêmes middlewares que index.js, auth simulée par l'en-tête x-test-user) =================
  const routes = [];
  const fakeApp = {}; for (const m of ["get", "post", "put", "patch", "delete"]) fakeApp[m] = (p, ...h) => routes.push({ m, p, h });
  const Err = { badRequest: (c, m) => Object.assign(new Error(m), { code: c, status: 400 }), notFound: (c, m) => Object.assign(new Error(m), { code: c, status: 404 }), forbidden: (c, m) => Object.assign(new Error(m), { code: c, status: 403 }), tooMany: (c, m) => Object.assign(new Error(m), { code: c, status: 429 }) };
  const H = await mk({ sender: fakeSender() });
  const hp = P.createProgrammer({ db: H.db, logger: silent, sender: fakeSender(), now: NOW, Errors: Err }); await hp.start(); hp.stop();
  process.env.PROGRAMMER_CRON_SECRET = "s3cret-value";                                           // lu à la création → recréer pour la route interne
  const hp2 = P.createProgrammer({ db: H.db, logger: silent, sender: fakeSender(), now: NOW, Errors: Err }); await hp2.start(); hp2.stop(); delete process.env.PROGRAMMER_CRON_SECRET;
  const auth = (req, res, next) => { const u = req.headers["x-test-user"]; if (!u) return res.status(401).json({ error: true, code: "INVALID_TOKEN" }); req.userId = u; next(); };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => res.status(e.status || 500).json({ success: false, error: true, code: e.code, message: e.message }));
  hp.mount(fakeApp, { auth, rateLimit: () => (req, res, next) => next(), wrap }); const sec = []; const secApp = {}; for (const m of ["get", "post", "put", "patch", "delete"]) secApp[m] = (p, ...h) => sec.push({ m, p, h }); hp2.mount(secApp, { auth, rateLimit: () => (req, res, next) => next(), wrap });
  const call = (table, m, p, { user, body, query, headers } = {}) => new Promise((resolve) => {
    const route = table.find((r) => r.m === m && r.p.replace(/:\w+/g, "([^/]+)").replace(/^/, "^").concat("$") && new RegExp(r.p.replace(/:\w+/g, "([^/]+)").replace(/^/, "^") + "$").test(p)); if (!route) return resolve({ status: 404 });
    const params = {}; const names = [...route.p.matchAll(/:(\w+)/g)].map((x) => x[1]); const mm = new RegExp(route.p.replace(/:\w+/g, "([^/]+)").replace(/^/, "^") + "$").exec(p); names.forEach((n, i) => { params[n] = mm[i + 1]; });
    const req = { headers: { ...(user ? { "x-test-user": user } : {}), ...(headers || {}) }, body, query: query || {}, params }; let code = 200;
    const res = { status(c) { code = c; return this; }, json(b) { resolve({ status: code, body: b }); return this; } };
    let i = 0; const next = (e) => { if (e) return resolve({ status: 500, body: { message: e.message } }); const h = route.h[i++]; if (h) h(req, res, next); }; next();
  });
  await test("HTTP : authentification obligatoire sur toutes les routes /api/programmer", async () => {
    for (const r of routes.filter((x) => !x.p.includes("internal"))) { const p = r.p.replace(":id", "rem_x"); const out = await call(routes, r.m, p, { body: {} }); assert.strictEqual(out.status, 401, `${r.m} ${r.p}`); }
  });
  await test("HTTP : création → lecture → modification → complétion → suppression ; isolation entre comptes (404, pas 403)", async () => {
    const c = await call(routes, "post", "/api/programmer/reminders", { user: "u1", body: { title: "Via API", date: "2026-12-05", time: "08:00", notify: { leadMinutes: [30] } } });
    assert.strictEqual(c.status, 201); const id = c.body.reminder.id; assert.deepStrictEqual(c.body.reminder.leadMinutes, [0, 30]);
    assert.strictEqual((await call(routes, "get", `/api/programmer/reminders/${id}`, { user: "u2" })).status, 404);
    assert.strictEqual((await call(routes, "patch", `/api/programmer/reminders/${id}`, { user: "u2", body: { title: "x" } })).status, 404);
    assert.strictEqual((await call(routes, "delete", `/api/programmer/reminders/${id}`, { user: "u2" })).status, 404);
    assert.ok(!(await call(routes, "get", "/api/programmer/reminders", { user: "u2" })).body.reminders.some((x) => x.id === id));
    assert.strictEqual((await call(routes, "patch", `/api/programmer/reminders/${id}`, { user: "u1", body: { title: "Modifié" } })).body.reminder.title, "Modifié");
    assert.strictEqual((await call(routes, "post", `/api/programmer/reminders/${id}/complete`, { user: "u1" })).body.reminder.status, "done");
    assert.strictEqual((await call(routes, "delete", `/api/programmer/reminders/${id}`, { user: "u1" })).status, 200);
    assert.strictEqual((await call(routes, "get", `/api/programmer/reminders/${id}`, { user: "u1" })).status, 404);
    assert.strictEqual((await call(routes, "post", "/api/programmer/reminders", { user: "u1", body: { title: "", date: "2026-12-05", time: "08:00" } })).status, 400);
  });
  await test("HTTP : synchronisation entre appareils (même compte, 2 « appareils » lisent les mêmes données après redémarrage)", async () => {
    await call(routes, "post", "/api/programmer/reminders", { user: "u1", body: { title: "Sync", date: "2026-12-06", time: "08:00" } });
    const a = (await call(routes, "get", "/api/programmer/reminders", { user: "u1" })).body.reminders.map((r) => r.id).sort();
    const b = (await call(routes, "get", "/api/programmer/reminders", { user: "u1", headers: { "x-timezone": "Europe/Paris" } })).body.reminders.map((r) => r.id).sort(); assert.deepStrictEqual(a, b);
    const st = await call(routes, "get", "/api/programmer/status", { user: "u1", headers: { "x-timezone": "Europe/Paris" } }); assert.strictEqual(st.body.settings.timezone, "Africa/Kinshasa");                 // fuseau explicite conservé
  });
  await test("HTTP : abonnement Push — validation, enregistrement, test réel (rapport par abonnement), désabonnement", async () => {
    assert.strictEqual((await call(routes, "post", "/api/programmer/push/subscribe", { user: "u1", body: { subscription: { endpoint: "http://x.com/a", keys: {} } } })).status, 400);
    const s = realisticSub(20); const ok = await call(routes, "post", "/api/programmer/push/subscribe", { user: "u1", body: { subscription: s } }); assert.strictEqual(ok.status, 201); assert.strictEqual(ok.body.push.activeSubscriptions, 1);
    const t = await call(routes, "post", "/api/programmer/push/test", { user: "u1" }); assert.strictEqual(t.body.success, true); assert.strictEqual(t.body.accepted, 1);
    assert.strictEqual((await call(routes, "post", "/api/programmer/push/unsubscribe", { user: "u1", body: { endpoint: s.endpoint } })).body.removed, true);
    assert.strictEqual((await call(routes, "post", "/api/programmer/push/test", { user: "u1" })).body.result, "NO_SUBSCRIPTION");
  });
  await test("HTTP : réglages — fuseau invalide refusé, valide enregistré", async () => {
    assert.strictEqual((await call(routes, "put", "/api/programmer/settings", { user: "u1", body: { timezone: "Nope/Zone" } })).status, 400);
    assert.strictEqual((await call(routes, "put", "/api/programmer/settings", { user: "u1", body: { timezone: "Europe/Paris", defaultLeadMinutes: [5] } })).body.settings.defaultLeadMinutes.join(), "0,5"); // lead défaut normalisé côté création
  });
  await test("HTTP : déclencheur externe /internal/tick — secret obligatoire (comparaison à temps constant)", async () => {
    assert.strictEqual((await call(routes, "post", "/api/programmer/internal/tick", {})).status, 404, "désactivé sans PROGRAMMER_CRON_SECRET");
    assert.strictEqual((await call(sec, "post", "/api/programmer/internal/tick", {})).status, 401);
    assert.strictEqual((await call(sec, "post", "/api/programmer/internal/tick", { headers: { "x-cron-secret": "mauvais" } })).status, 401);
    const ok = await call(sec, "post", "/api/programmer/internal/tick", { headers: { "x-cron-secret": "s3cret-value" } }); assert.strictEqual(ok.status, 200); assert.ok("sent" in ok.body.stats);
  });
  await test("Sécurité : titres hostiles nettoyés (caractères de contrôle) ; limite de rappels actifs", async () => {
    const r = (await prg.createReminder("u1", { title: "  <img onerror=x>\u0007\u202E  ", date: "2026-12-08", time: "08:00" })).reminder; assert.ok(!/[\u0007\u202E]/.test(r.title));
    const L = await mk({ sender: fakeSender() }); L.prg.CFG.MAX_REMINDERS = 2;
    await L.prg.createReminder("u1", { title: "a", date: "2026-12-08", time: "08:00" }); await L.prg.createReminder("u1", { title: "b", date: "2026-12-08", time: "08:00" });
    await assert.rejects(() => L.prg.createReminder("u1", { title: "c", date: "2026-12-08", time: "08:00" }), (e) => e.code === "LIMIT_REACHED");
  });

  // ---------- Rapport ----------
  let failed = 0;
  for (const [ok, name, err] of results) { if (!ok) failed++; console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : "\n      → " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n        ") : err)}`); }
  console.log(`\n${results.length - failed}/${results.length} tests réussis`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERREUR FATALE", e); process.exit(2); });
