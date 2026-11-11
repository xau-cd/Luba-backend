"use strict";
// ================================================================================
// admin/admin.js — LUBA ADMIN : API de supervision (lecture seule, sauf 2 actions documentées)
//
// Montage (une seule ligne dans index.js, comme luba-engine / luba-upload) :
//   adminMod.mount(app, { express, auth, requireRole, rateLimit, wrap, Errors, db, repo, logger, CONFIG, ... })
//
// Principes :
//  - AUCUNE écriture dans les tables existantes, sauf : DELETE blocked_ips (déblocage IP) et l'audit security_logs.
//  - Seules des routes NOUVELLES sont ajoutées (/api/admin/analytics|users|conversations|runs|security|system|auth,
//    et /admin-ui). Les routes existantes (/api/admin/set-role, /api/admin/self-heal/*, /api/auth/check) sont réutilisées
//    telles quelles par le frontend.
//  - Aucune donnée inventée : tout vient de SQLite (users, sessions, messages, runs, security_logs, blocked_ips, attachments…).
//  - Le contenu des messages n'est JAMAIS exposé (métadonnées uniquement).
//  - Contrat complet : ADMIN_API_CONTRACT.md
// ================================================================================

const fs = require("fs");
const path = require("path");

const VERSION = "1.0.0";
const HOUR = 3600e3;
const DAY = 86400e3;
const RANGES = {
  "24h": { buckets: 24, bucketMs: HOUR, unit: "hour" },
  "7d": { buckets: 7, bucketMs: DAY, unit: "day" },
  "30d": { buckets: 30, bucketMs: DAY, unit: "day" },
  "90d": { buckets: 90, bucketMs: DAY, unit: "day" }
};
const USER_ID_RE = /^[A-Za-z0-9_:.@-]{1,128}$/;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
const ROLES = ["FREE", "PREMIUM", "ADMIN"];
const CACHE_TTL_MS = 30000;
const UI_FILE = path.join(__dirname, "public", "index.html");

const UI_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self' https://milo-backend-sa1y.onrender.com",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join("; ");

const safeJson = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };
const esc = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function createAdminRouter(express, ctx) {
  const { auth, requireRole, rateLimit, wrap, Errors, db, repo, logger, CONFIG } = ctx;
  const router = express.Router();
  const guard = [auth, requireRole("ADMIN"), rateLimit("API")];
  const cache = new Map();

  // ---------- utilitaires ----------
  const cached = async (key, req, producer) => {
    const hit = cache.get(key);
    if (!req.query.refresh && hit && hit.exp > Date.now()) return { ...hit.value, cached: true };
    const value = await producer();
    cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
    if (cache.size > 200) for (const [k, e] of cache) if (e.exp < Date.now()) cache.delete(k);
    return { ...value, cached: false };
  };

  function windowOf(req) {
    const name = String(req.query.range || "7d");
    const r = RANGES[name];
    if (!r) throw Errors.badRequest("INVALID_RANGE", `range invalide (attendu : ${Object.keys(RANGES).join(", ")}).`);
    const to = Date.now();
    const lastB = Math.floor(to / r.bucketMs);
    const firstB = lastB - r.buckets + 1;
    const from = firstB * r.bucketMs;
    const prevFrom = from - (to - from);
    return { name, ...r, to, from, prevFrom, firstB, lastB };
  }

  function paging(req, def = 25) {
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || def));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    return { page, pageSize, offset: (page - 1) * pageSize };
  }
  const pageMeta = (p, total) => ({ page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) });

  function fill(rows, w, key = "v") {
    const m = new Map(rows.map((r) => [Number(r.b), r[key]]));
    const out = [];
    for (let b = w.firstB; b <= w.lastB; b++) out.push(m.has(b) ? m.get(b) : null);
    return out;
  }
  const zeros = (a) => a.map((v) => (v === null ? 0 : Number(v)));
  const audit = (req, type, details) => ctx.logSecurity?.(req.userId, type, details, req.ip, req.headers["user-agent"] || null);

  // ---------- Authentification (connexion dédiée à la console) ----------
  async function firebaseCall(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
  const apiKey = () => ctx.FIREBASE_CONFIG?.apiKey || null;

  router.post("/api/admin/auth/login", rateLimit("STRICT", { by: "ip" }), wrap(async (req, res) => {
    const email = String(req.body?.email || "").trim().slice(0, 254);
    const password = String(req.body?.password || "").slice(0, 512);
    if (!email || !password) throw Errors.badRequest("MISSING_CREDENTIALS", "E-mail et mot de passe requis.");
    if (!apiKey()) throw Object.assign(Errors.busy("Connexion par mot de passe indisponible : FIREBASE_API_KEY n'est pas défini sur le serveur. Utilisez un jeton Firebase.", 0), { code: "LOGIN_UNAVAILABLE", retryable: false });
    const { res: r, data } = await firebaseCall(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey()}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    if (!r.ok) {
      const msg = String(data?.error?.message || "");
      audit({ userId: null, ip: req.ip, headers: req.headers }, "ADMIN_LOGIN_FAILED", { email: email.replace(/^(.).*(@.*)$/, "$1***$2"), reason: msg.split(" ")[0] });
      if (/USER_DISABLED/.test(msg)) throw Errors.forbidden("USER_DISABLED", "Compte désactivé.");
      if (/TOO_MANY_ATTEMPTS/.test(msg)) throw Errors.tooMany("TOO_MANY_ATTEMPTS", "Trop de tentatives, réessayez plus tard.", 60000);
      if (r.status >= 500) throw Errors.busy("Service d'authentification momentanément indisponible.", 3000);
      throw Errors.unauthorized("INVALID_CREDENTIALS", "Identifiants invalides.");
    }
    res.json({ success: true, idToken: data.idToken, refreshToken: data.refreshToken, expiresIn: parseInt(data.expiresIn, 10) || 3600, userId: data.localId, email: data.email });
  }));

  router.post("/api/admin/auth/refresh", rateLimit("STRICT", { by: "ip" }), wrap(async (req, res) => {
    const refreshToken = String(req.body?.refreshToken || "").slice(0, 2048);
    if (!refreshToken) throw Errors.badRequest("MISSING_REFRESH_TOKEN", "refreshToken requis.");
    if (!apiKey()) throw Errors.busy("Renouvellement indisponible (FIREBASE_API_KEY absent).", 0);
    const { res: r, data } = await firebaseCall(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString()
    });
    if (!r.ok) {
      if (r.status >= 500) throw Errors.busy("Service d'authentification momentanément indisponible.", 3000);
      throw Errors.unauthorized("INVALID_REFRESH_TOKEN", "Session expirée, reconnectez-vous.");
    }
    res.json({ success: true, idToken: data.id_token, refreshToken: data.refresh_token, expiresIn: parseInt(data.expires_in, 10) || 3600 });
  }));

  // ---------- Vue d'ensemble ----------
  router.get("/api/admin/analytics/overview", ...guard, wrap(async (req, res) => {
    const w = windowOf(req);
    res.json(await cached(`overview:${w.name}`, req, async () => {
      const win = async (a, b) => {
        const [nu, au, um, am, cv, rn, tk] = await Promise.all([
          db.get("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?", [a, b]),
          db.get("SELECT COUNT(DISTINCT user_id) AS n FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?", [a, b]),
          db.get("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?", [a, b]),
          db.get("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at >= ? AND created_at < ?", [a, b]),
          db.get("SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ? AND created_at < ?", [a, b]),
          db.get(`SELECT COUNT(*) AS total,
                    SUM(status = 'done') AS done, SUM(status IN ('failed','interrupted')) AS failed, SUM(status = 'cancelled') AS cancelled,
                    AVG(CASE WHEN status = 'done' THEN ttft_ms END) AS ttft, AVG(CASE WHEN status = 'done' THEN queue_ms END) AS queue,
                    SUM(COALESCE(tokens_out, 0)) AS tokens
                  FROM runs WHERE queued_at >= ? AND queued_at < ?`, [a, b]),
          db.get("SELECT COUNT(*) AS n FROM security_logs WHERE created_at >= ? AND created_at < ?", [a, b])
        ]);
        const done = num(rn.done), failed = num(rn.failed);
        return {
          newUsers: num(nu.n), activeUsers: num(au.n), messages: num(um.n), replies: num(am.n), conversations: num(cv.n),
          runs: num(rn.total), runsDone: done, errors: failed, cancelled: num(rn.cancelled),
          successRate: done + failed > 0 ? Math.round((done / (done + failed)) * 1000) / 10 : null,
          avgTtftMs: rn.ttft === null ? null : Math.round(rn.ttft), avgQueueMs: rn.queue === null ? null : Math.round(rn.queue),
          tokensOut: num(rn.tokens), securityEvents: num(tk.n)
        };
      };
      const [cur, prev, totals, roles, live] = await Promise.all([
        win(w.from, w.to + 1), win(w.prevFrom, w.from),
        Promise.all([
          db.get("SELECT COUNT(*) AS n FROM users"), db.get("SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL"),
          db.get("SELECT COUNT(*) AS n FROM messages"), db.get("SELECT COUNT(*) AS n FROM attachments")
        ]),
        db.all("SELECT COALESCE(role, 'FREE') AS role, COUNT(*) AS n FROM users GROUP BY COALESCE(role, 'FREE')"),
        db.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running') AND queued_at > ?", [Date.now() - 600000])
      ]);
      return {
        success: true, range: w.name, from: w.from, to: w.to, previousFrom: w.prevFrom, generatedAt: Date.now(),
        current: cur, previous: prev,
        totals: { users: num(totals[0].n), conversations: num(totals[1].n), messages: num(totals[2].n), attachments: num(totals[3].n) },
        roles: Object.fromEntries(ROLES.map((r) => [r, num(roles.find((x) => x.role === r)?.n)])),
        liveRuns: num(live.n)
      };
    }));
  }));

  // ---------- Séries temporelles ----------
  router.get("/api/admin/analytics/timeseries", ...guard, wrap(async (req, res) => {
    const w = windowOf(req);
    res.json(await cached(`ts:${w.name}`, req, async () => {
      const q = (sql, extra = []) => db.all(sql, [w.bucketMs, ...extra, w.from]);
      const [nu, au, ms, rn, er, tk, tt] = await Promise.all([
        q("SELECT CAST(created_at / ? AS INTEGER) AS b, COUNT(*) AS v FROM users WHERE created_at >= ? GROUP BY b"),
        q("SELECT CAST(created_at / ? AS INTEGER) AS b, COUNT(DISTINCT user_id) AS v FROM messages WHERE role = 'user' AND created_at >= ? GROUP BY b"),
        q("SELECT CAST(created_at / ? AS INTEGER) AS b, COUNT(*) AS v FROM messages WHERE role = 'user' AND created_at >= ? GROUP BY b"),
        q("SELECT CAST(queued_at / ? AS INTEGER) AS b, COUNT(*) AS v FROM runs WHERE queued_at >= ? GROUP BY b"),
        q("SELECT CAST(queued_at / ? AS INTEGER) AS b, COUNT(*) AS v FROM runs WHERE status IN ('failed','interrupted') AND queued_at >= ? GROUP BY b"),
        q("SELECT CAST(queued_at / ? AS INTEGER) AS b, SUM(COALESCE(tokens_out, 0)) AS v FROM runs WHERE queued_at >= ? GROUP BY b"),
        q("SELECT CAST(queued_at / ? AS INTEGER) AS b, AVG(ttft_ms) AS v FROM runs WHERE status = 'done' AND ttft_ms IS NOT NULL AND queued_at >= ? GROUP BY b")
      ]);
      const buckets = [];
      for (let b = w.firstB; b <= w.lastB; b++) buckets.push(b * w.bucketMs);
      return {
        success: true, range: w.name, unit: w.unit, bucketMs: w.bucketMs, generatedAt: Date.now(), buckets,
        series: {
          newUsers: zeros(fill(nu, w)), activeUsers: zeros(fill(au, w)), messages: zeros(fill(ms, w)),
          runs: zeros(fill(rn, w)), errors: zeros(fill(er, w)), tokensOut: zeros(fill(tk, w)),
          avgTtftMs: fill(tt, w).map((v) => (v === null ? null : Math.round(v)))
        }
      };
    }));
  }));

  // ---------- Répartitions ----------
  router.get("/api/admin/analytics/breakdown", ...guard, wrap(async (req, res) => {
    const w = windowOf(req);
    res.json(await cached(`bd:${w.name}`, req, async () => {
      const [status, providers, tiers, errors, hours, files, sec] = await Promise.all([
        db.all("SELECT status, COUNT(*) AS n FROM runs WHERE queued_at >= ? GROUP BY status ORDER BY n DESC", [w.from]),
        db.all(`SELECT provider, model, COUNT(*) AS runs, AVG(ttft_ms) AS ttft, SUM(COALESCE(tokens_out, 0)) AS tokens
                FROM runs WHERE status = 'done' AND provider IS NOT NULL AND queued_at >= ? GROUP BY provider, model ORDER BY runs DESC LIMIT 20`, [w.from]),
        db.all("SELECT COALESCE(tier, 'inconnu') AS tier, COUNT(*) AS n FROM runs WHERE queued_at >= ? GROUP BY COALESCE(tier, 'inconnu') ORDER BY n DESC", [w.from]),
        db.all("SELECT error_code AS code, COUNT(*) AS n FROM runs WHERE error_code IS NOT NULL AND queued_at >= ? GROUP BY error_code ORDER BY n DESC LIMIT 10", [w.from]),
        db.all("SELECT CAST((created_at / 3600000) % 24 AS INTEGER) AS h, COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ? GROUP BY h", [w.from]),
        db.all("SELECT COALESCE(kind, 'autre') AS kind, COUNT(*) AS n, SUM(COALESCE(chars, 0)) AS chars FROM attachments WHERE created_at >= ? GROUP BY COALESCE(kind, 'autre') ORDER BY n DESC", [w.from]),
        db.all("SELECT event_type AS type, COUNT(*) AS n FROM security_logs WHERE created_at >= ? GROUP BY event_type ORDER BY n DESC LIMIT 12", [w.from])
      ]);
      const hourly = Array(24).fill(0);
      for (const r of hours) hourly[Number(r.h)] = num(r.n);
      return {
        success: true, range: w.name, generatedAt: Date.now(),
        runStatus: status.map((r) => ({ status: r.status, count: num(r.n) })),
        providers: providers.map((r) => ({ provider: r.provider, model: r.model, runs: num(r.runs), avgTtftMs: r.ttft === null ? null : Math.round(r.ttft), tokensOut: num(r.tokens) })),
        tiers: tiers.map((r) => ({ tier: r.tier, count: num(r.n) })),
        errorCodes: errors.map((r) => ({ code: r.code, count: num(r.n) })),
        hourlyUtc: hourly,
        attachments: files.map((r) => ({ kind: r.kind, count: num(r.n), chars: num(r.chars) })),
        securityEvents: sec.map((r) => ({ type: r.type, count: num(r.n) }))
      };
    }));
  }));

  // ---------- Utilisateurs ----------
  const USER_SORT = { created_at: "u.created_at", last_seen_at: "u.last_seen_at", email: "u.email", messages: "messages", conversations: "conversations" };

  router.get("/api/admin/users", ...guard, wrap(async (req, res) => {
    const p = paging(req);
    const where = [], args = [];
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q) { where.push("(u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.id = ?)"); args.push(`%${esc(q)}%`, `%${esc(q)}%`, q); }
    const role = String(req.query.role || "").toUpperCase();
    if (role) { if (!ROLES.includes(role)) throw Errors.badRequest("INVALID_ROLE", "role invalide."); where.push("COALESCE(u.role, 'FREE') = ?"); args.push(role); }
    const sort = USER_SORT[req.query.sort] || USER_SORT.created_at;
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [total, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM users u ${W}`, args),
      db.all(`SELECT u.id, u.email, u.display_name, COALESCE(u.role, 'FREE') AS role, u.email_verified, u.whatsapp_connected, u.last_seen_at, u.created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.role = 'user') AS messages,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.deleted_at IS NULL) AS conversations
              FROM users u ${W} ORDER BY ${sort} ${dir}, u.id LIMIT ? OFFSET ?`, [...args, p.pageSize, p.offset])
    ]);
    res.json({
      success: true, ...pageMeta(p, num(total.n)),
      users: rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, role: r.role, emailVerified: !!r.email_verified, whatsappConnected: !!r.whatsapp_connected, lastSeenAt: r.last_seen_at, createdAt: r.created_at, messages: num(r.messages), conversations: num(r.conversations) }))
    });
  }));

  router.get("/api/admin/users/:userId", ...guard, wrap(async (req, res) => {
    const id = req.params.userId;
    if (!USER_ID_RE.test(id)) throw Errors.badRequest("INVALID_USER_ID", "Identifiant invalide.");
    const u = await db.get("SELECT id, email, display_name, COALESCE(role, 'FREE') AS role, email_verified, whatsapp_connected, preferred_language, last_seen_at, created_at FROM users WHERE id = ?", [id]);
    if (!u) throw Errors.notFound("USER_NOT_FOUND", "Utilisateur introuvable.");
    const since = Date.now() - 14 * DAY;
    const [quota, c, m, daily, sessions, runs, sec] = await Promise.all([
      repo.getQuota(id),
      db.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND deleted_at IS NULL", [id]),
      db.get("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user'", [id]),
      db.all("SELECT CAST(created_at / 86400000 AS INTEGER) AS b, COUNT(*) AS v FROM messages WHERE user_id = ? AND role = 'user' AND created_at >= ? GROUP BY b", [id, since]),
      db.all("SELECT session_id, title, msg_count, created_at, updated_at, deleted_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10", [id]),
      db.all("SELECT run_id, status, tier, provider, model, error_code, queued_at, ttft_ms, tokens_out FROM runs WHERE user_id = ? ORDER BY queued_at DESC LIMIT 10", [id]),
      db.all("SELECT event_type, ip_address, created_at FROM security_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", [id])
    ]);
    const lastB = Math.floor(Date.now() / DAY);
    const dm = new Map(daily.map((r) => [Number(r.b), num(r.v)]));
    const days = Array.from({ length: 14 }, (_, i) => ({ day: (lastB - 13 + i) * DAY, messages: dm.get(lastB - 13 + i) || 0 }));
    res.json({
      success: true,
      user: { id: u.id, email: u.email, displayName: u.display_name, role: u.role, emailVerified: !!u.email_verified, whatsappConnected: !!u.whatsapp_connected, language: u.preferred_language, lastSeenAt: u.last_seen_at, createdAt: u.created_at },
      counts: { conversations: num(c.n), messages: num(m.n) },
      quotaToday: { messages: num(quota.messages_count), images: num(quota.images_count), whatsapp: num(quota.whatsapp_count), emails: num(quota.emails_count) },
      limits: ctx.USER_QUOTAS?.[u.role] || null,
      messagesByDay: days,
      recentConversations: sessions.map((s) => ({ id: s.session_id, title: s.title, messages: num(s.msg_count), createdAt: s.created_at, updatedAt: s.updated_at, deleted: !!s.deleted_at })),
      recentRuns: runs.map((r) => ({ id: r.run_id, status: r.status, tier: r.tier, provider: r.provider, model: r.model, errorCode: r.error_code, queuedAt: r.queued_at, ttftMs: r.ttft_ms, tokensOut: num(r.tokens_out) })),
      recentSecurity: sec.map((s) => ({ type: s.event_type, ip: s.ip_address, at: s.created_at }))
    });
  }));

  // ---------- Conversations (métadonnées seulement) ----------
  router.get("/api/admin/conversations", ...guard, wrap(async (req, res) => {
    const p = paging(req);
    const where = [], args = [];
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q) { where.push("(s.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR s.user_id = ?)"); args.push(`%${esc(q)}%`, `%${esc(q)}%`, q); }
    if (req.query.deleted === "1") where.push("s.deleted_at IS NOT NULL"); else if (req.query.deleted === "0") where.push("s.deleted_at IS NULL");
    const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [total, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM sessions s LEFT JOIN users u ON u.id = s.user_id ${W}`, args),
      db.all(`SELECT s.session_id, s.title, s.user_id, u.email, s.msg_count, s.pinned, s.created_at, s.updated_at, s.deleted_at
              FROM sessions s LEFT JOIN users u ON u.id = s.user_id ${W} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, [...args, p.pageSize, p.offset])
    ]);
    res.json({
      success: true, ...pageMeta(p, num(total.n)),
      conversations: rows.map((r) => ({ id: r.session_id, title: r.title, userId: r.user_id, email: r.email, messages: num(r.msg_count), pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted_at }))
    });
  }));

  // ---------- Exécutions IA ----------
  router.get("/api/admin/runs", ...guard, wrap(async (req, res) => {
    const p = paging(req);
    const where = [], args = [];
    const status = String(req.query.status || "");
    if (status) { if (!["queued", "running", "done", "failed", "cancelled", "interrupted"].includes(status)) throw Errors.badRequest("INVALID_STATUS", "status invalide."); where.push("r.status = ?"); args.push(status); }
    const provider = String(req.query.provider || "").slice(0, 60);
    if (provider) { where.push("r.provider = ?"); args.push(provider); }
    if (RANGES[req.query.range]) { const w = windowOf(req); where.push("r.queued_at >= ?"); args.push(w.from); }
    const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [total, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM runs r ${W}`, args),
      db.all(`SELECT r.run_id, r.user_id, u.email, r.tier, r.lane, r.status, r.error_code, r.provider, r.model, r.queued_at, r.started_at, r.finished_at, r.ttft_ms, r.queue_ms, r.tokens_out
              FROM runs r LEFT JOIN users u ON u.id = r.user_id ${W} ORDER BY r.queued_at DESC LIMIT ? OFFSET ?`, [...args, p.pageSize, p.offset])
    ]);
    res.json({
      success: true, ...pageMeta(p, num(total.n)),
      runs: rows.map((r) => ({ id: r.run_id, userId: r.user_id, email: r.email, tier: r.tier, lane: r.lane, status: r.status, errorCode: r.error_code, provider: r.provider, model: r.model, queuedAt: r.queued_at, durationMs: r.finished_at && r.started_at ? r.finished_at - r.started_at : null, ttftMs: r.ttft_ms, queueMs: r.queue_ms, tokensOut: num(r.tokens_out) }))
    });
  }));

  // ---------- Sécurité ----------
  router.get("/api/admin/security", ...guard, wrap(async (req, res) => {
    const p = paging(req);
    const w = windowOf(req);
    const where = ["l.created_at >= ?"], args = [w.from];
    const type = String(req.query.type || "").slice(0, 60);
    if (type) { where.push("l.event_type = ?"); args.push(type); }
    const W = `WHERE ${where.join(" AND ")}`;
    const [total, rows, types, blocked] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM security_logs l ${W}`, args),
      db.all(`SELECT l.id, l.event_type, l.user_id, u.email, l.ip_address, l.details, l.created_at
              FROM security_logs l LEFT JOIN users u ON u.id = l.user_id ${W} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`, [...args, p.pageSize, p.offset]),
      db.all("SELECT event_type AS type, COUNT(*) AS n FROM security_logs WHERE created_at >= ? GROUP BY event_type ORDER BY n DESC", [w.from]),
      db.all("SELECT ip_address, reason, strike_count, blocked_until, created_at FROM blocked_ips WHERE blocked_until > ? ORDER BY blocked_until DESC LIMIT 100", [Date.now()])
    ]);
    res.json({
      success: true, range: w.name, ...pageMeta(p, num(total.n)),
      events: rows.map((r) => ({ id: r.id, type: r.event_type, userId: r.user_id, email: r.email, ip: r.ip_address, details: String(r.details || "").slice(0, 400) ? safeJson(String(r.details).slice(0, 400), String(r.details).slice(0, 400)) : null, at: r.created_at })),
      types: types.map((t) => ({ type: t.type, count: num(t.n) })),
      blockedIps: blocked.map((b) => ({ ip: b.ip_address, reason: b.reason, strikes: num(b.strike_count), blockedUntil: b.blocked_until, createdAt: b.created_at }))
    });
  }));

  router.post("/api/admin/security/unblock", auth, requireRole("ADMIN"), rateLimit("STRICT"), wrap(async (req, res) => {
    const ip = String(req.body?.ip || "").trim();
    if (!IP_RE.test(ip)) throw Errors.badRequest("INVALID_IP", "Adresse IP invalide.");
    const r = await db.run("DELETE FROM blocked_ips WHERE ip_address = ?", [ip]);
    ctx.blockedIps?.delete(ip);
    ctx.authFails?.delete(ip);
    audit(req, "ADMIN_IP_UNBLOCKED", { ip });
    cache.clear();
    res.json({ success: true, removed: num(r?.changes) });
  }));

  // ---------- Système ----------
  router.get("/api/admin/system", ...guard, wrap(async (req, res) => {
    const tables = ["users", "sessions", "messages", "runs", "attachments", "security_logs", "sync_log"];
    const [dbHealth, counts, mirror] = await Promise.all([
      db.health().then((h) => ({ ok: true, ...(h && typeof h === "object" ? h : {}) })).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) })),
      Promise.all(tables.map((t) => db.get(`SELECT COUNT(*) AS n FROM ${t}`).then((r) => [t, num(r.n)]))),
      db.all("SELECT status, COUNT(*) AS n FROM mirror_queue GROUP BY status")
    ]);
    let dbBytes = null;
    try { dbBytes = fs.statSync(CONFIG.PATHS.DB).size; } catch { /* base introuvable : valeur nulle assumée */ }
    const d = ctx.diagnostics();
    res.json({
      success: true, generatedAt: Date.now(), adminModule: VERSION,
      server: { version: d.version, instance: d.instance, uptimeS: d.uptimeS, node: d.node, env: CONFIG.ENV, memoryMb: d.memoryMb, load: d.load },
      queue: d.queue, sync: d.sync, providers: d.providers, keys: d.keys, mirrors: d.mirrors, recentLlmErrors: d.recentLlmErrors,
      database: { health: dbHealth, writeQueue: d.db?.writeQueue ?? null, driver: d.db?.driver ?? null, bytes: dbBytes, rows: Object.fromEntries(counts) },
      mirrorQueue: mirror.map((m) => ({ status: m.status, count: num(m.n) }))
    });
  }));

  // ---------- Interface (fichier unique) ----------
  const serveUi = (_req, res) => {
    if (!fs.existsSync(UI_FILE)) return res.status(404).json({ success: false, error: true, code: "UI_NOT_FOUND", message: "admin/public/index.html introuvable." });
    res.setHeader("Content-Security-Policy", UI_CSP);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Frame-Options", "DENY");
    return res.sendFile(UI_FILE);
  };
  router.get("/admin-ui", serveUi);
  router.get("/admin-ui/", serveUi);

  return router;
}

/** Index SQL idempotents (aucune modification de schéma) : exécutés en arrière-plan, jamais bloquants. */
function applyMigrations(ctx) {
  const dir = path.join(__dirname, "migrations");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(); } catch { return; }
  (async () => {
    for (const f of files) {
      for (const stmt of fs.readFileSync(path.join(dir, f), "utf8").split(";").map((s) => s.trim()).filter(Boolean)) {
        try { await ctx.db.run(stmt); } catch (e) { ctx.logger.warn({ err: e.message, file: f }, "LUBA ADMIN : migration ignorée"); }
      }
    }
    ctx.logger.info({ files }, "LUBA ADMIN : index appliqués");
  })().catch(() => {});
}

function mount(app, ctx) {
  app.use(createAdminRouter(ctx.express, ctx));
  applyMigrations(ctx);
  ctx.logger.info({ version: VERSION }, "LUBA ADMIN monté (/api/admin/*, /admin-ui)");
}

module.exports = { VERSION, mount, createAdminRouter, RANGES };
