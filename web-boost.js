// ================================================================================
// web-boost.js — Recherche web renforcée, SANS CLÉ API, pour Luba
// HIKLON TECHNOLOGIES · module autonome (aucune dépendance npm)
// ================================================================================
// Ce module règle le cas « je n'ai pas pu accéder au site / aucun résultat exploitable » :
//
//  1. MOTEURS supplémentaires branchés dans net.js (invisibles pour le LLM → 0 jeton de prompt en plus)
//       bing (RSS officiel) · wikipedia-en · searxng (si SEARXNG_URL) · europepmc (science)
//       stackexchange · github · hackernews (sujets techniques)
//  2. LECTURE DE SECOURS quand une page est vide / protégée / en JavaScript (sites React, Vue, Firebase…) :
//       a) rendu JavaScript distant via Jina Reader (gratuit, sans clé) → le serveur ne fait AUCUN rendu
//       b) copie archivée via Internet Archive (Wayback Machine)
//  3. OUTILS open data (sans clé) : search_wikipedia · wikidata_lookup · search_biomedical (PubMed/Europe PMC)
//       search_stackexchange · search_github · wayback_lookup
//
// POURQUOI C'EST LÉGER POUR LE SERVEUR
//   • plafond de requêtes simultanées (BOOST_MAX_CONCURRENCY, défaut 6) + file d'attente bornée
//   • disjoncteur par source : après 3 échecs la source est suspendue (30 s → 10 min) au lieu d'attendre un timeout à chaque question
//   • cache LRU + fusion des requêtes identiques en vol (2 utilisateurs, 1 seul appel réseau)
//   • lecture des réponses en flux avec plafond d'octets (jamais 3 Mo en mémoire pour rien)
//   • aucun navigateur headless, aucune dépendance : le rendu JS est délégué à un service externe
//
// VARIABLES D'ENVIRONNEMENT (toutes facultatives)
//   DISABLE_WEB_BOOST=1        coupe tout le module
//   WEB_RENDER_FALLBACK=off    n'envoie JAMAIS d'URL à Jina Reader (confidentialité stricte) ; l'archive reste active
//   WEB_ARCHIVE_FALLBACK=off   désactive le repli Wayback
//   BOOST_PROVIDERS=a,b        moteurs à activer (défaut : tous)  ex. bing,wikipedia-en,europepmc
//   BOOST_TOOLS=a,b            outils LLM à activer (défaut : tous) → moins d'outils = prompt plus léger
//   BOOST_MAX_CONCURRENCY=6    requêtes sortantes simultanées max
//   BOOST_TIMEOUT_MS=5000      délai par requête de recherche
//   SEARXNG_URL=http://searxng:8080   instance SearXNG auto-hébergée (meilleure option « type Google », sans clé)
//   CONTACT_EMAIL / JINA_API_KEY / GITHUB_TOKEN   facultatifs (limites plus larges), jamais requis
//
// SearXNG auto-hébergé (facultatif, ~150 Mo de RAM, mettre un plafond mémoire) :
//   services:
//     searxng:
//       image: searxng/searxng
//       mem_limit: 384m
//       environment: [SEARXNG_LIMITER=false]
//       volumes: ["./searxng:/etc/searxng"]   # settings.yml → search.formats: [html, json]
// ================================================================================

"use strict";

// ---------------------------------------------------------------------------------
// §1 — Constantes et utilitaires
// ---------------------------------------------------------------------------------
const ENV = process.env;
const envInt = (k, d, lo, hi) => { const n = parseInt(ENV[k], 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const isOff = (k) => /^(0|false|no|off)$/i.test(ENV[k] || "");
const isOn = (k) => /^(1|true|yes|on)$/i.test(ENV[k] || "");
const CONTACT = ENV.CONTACT_EMAIL || "";
const UA = `LubaBot/1.0 (+https://luba.web.app${CONTACT ? `; ${CONTACT}` : ""})`;
const MAX_CONC = envInt("BOOST_MAX_CONCURRENCY", 6, 1, 32);
const TIMEOUT = envInt("BOOST_TIMEOUT_MS", 5000, 1000, 20000);
const SEARXNG = (ENV.SEARXNG_URL || "").replace(/\/+$/, "");
const RENDER_ON = !isOff("WEB_RENDER_FALLBACK");
const ARCHIVE_ON = !isOff("WEB_ARCHIVE_FALLBACK");

const SOURCES = {
  europepmc: ["Europe PMC / PubMed", "https://europepmc.org"],
  stackexchange: ["Stack Exchange", "https://stackexchange.com"],
  github: ["GitHub", "https://github.com"],
  wikidata: ["Wikidata", "https://www.wikidata.org"],
  wayback: ["Internet Archive", "https://archive.org"]
  // « wikipedia » existe déjà dans les libellés de index.js
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const cut = (s, max = 400) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) && t > 631152000000 ? new Date(t).toISOString() : null; };
const uniq = (a) => [...new Set(a)];

class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };
class BoostError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = "BoostError"; this.code = code; this.status = status; }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»" };
const decode = (s) => String(s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
  .replace(/&#(\d+);/g, (m, d) => { const n = parseInt(d, 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
  .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
const stripHtml = (s) => decode(decode(String(s ?? "").replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();
const xmlBlocks = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"))].map((m) => m[0]);
const xmlText = (xml, tag) => { const m = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]).trim() : ""; };

// ---------------------------------------------------------------------------------
// §2 — Couche réseau : plafond de concurrence, disjoncteur, cache, flux borné
// ---------------------------------------------------------------------------------
let doFetch = (...a) => globalThis.fetch(...a);

function makeLimiter(max, maxQueue = 60) {
  let active = 0; const queue = [];
  const pump = () => { while (active < max && queue.length) { const job = queue.shift(); clearTimeout(job.timer); active++; job.run(); } };
  return (fn, waitMs = 8000) => new Promise((resolve, reject) => {
    if (queue.length >= maxQueue) return reject(new BoostError("busy", "trop de requêtes en attente"));
    const job = {
      run: () => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); }),
      timer: setTimeout(() => { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i, 1); reject(new BoostError("busy", "file d'attente saturée")); } }, waitMs)
    };
    queue.push(job); pump();
  });
}
let limit = makeLimiter(MAX_CONC);

const breakers = new Map();
const countable = (e) => e instanceof BoostError && (["timeout", "network", "rate_limited", "bad_payload"].includes(e.code) || (e.code === "http" && (e.status >= 500 || [401, 403].includes(e.status))));
function breakerAllow(key) { const b = breakers.get(key); return !b || b.openUntil <= Date.now(); }
function breakerOk(key) { breakers.delete(key); }
function breakerOpen(key, ms) { const b = breakers.get(key) || { fails: 0, lvl: 0, openUntil: 0 }; b.openUntil = Date.now() + ms; breakers.set(key, b); }
function breakerFail(key, e) {
  if (!countable(e)) return;
  const b = breakers.get(key) || { fails: 0, lvl: 0, openUntil: 0 };
  b.fails++;
  if (e.code === "rate_limited") { b.lvl = Math.min(b.lvl + 1, 5); b.openUntil = Date.now() + 30000 * 2 ** (b.lvl - 1); b.fails = 0; }
  else if (b.fails >= 3) { b.lvl = Math.min(b.lvl + 1, 5); b.openUntil = Date.now() + Math.min(30000 * 2 ** (b.lvl - 1), 600000); b.fails = 0; }
  breakers.set(key, b);
}

const gateLast = new Map(), gateChain = new Map();
function gate(key, gapMs) {
  if (!gapMs) return Promise.resolve();
  const prev = gateChain.get(key) || Promise.resolve();
  const mine = prev.then(async () => { const wait = (gateLast.get(key) || 0) + gapMs - Date.now(); if (wait > 0) await sleep(wait); gateLast.set(key, Date.now()); });
  gateChain.set(key, mine.catch(() => {}));
  return mine;
}

/** GET/POST borné : délai total, lecture en flux avec plafond d'octets, erreurs typées. */
async function fetchCapped(url, { method = "GET", headers = {}, body, timeoutMs = TIMEOUT, maxBytes = 400000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method, body, redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, "Accept-Language": "fr,en;q=0.8", ...headers } });
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* ignoré */ }
      throw new BoostError(res.status === 429 ? "rate_limited" : "http", `HTTP ${res.status}`, res.status);
    }
    const type = String(res.headers?.get?.("content-type") || "").toLowerCase();
    const reader = res.body?.getReader?.();
    if (!reader) { const t = await res.text(); return { text: t.slice(0, maxBytes), url: res.url || url, type, truncated: t.length > maxBytes }; }
    const chunks = []; let size = 0, truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { chunks.push(value.subarray(0, value.length - (size - maxBytes))); truncated = true; try { await reader.cancel(); } catch { /* ignoré */ } break; }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), url: res.url || url, type, truncated };
  } catch (e) {
    if (e instanceof BoostError) throw e;
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw new BoostError("timeout", "délai dépassé");
    throw new BoostError("network", String(e?.cause?.code || e?.message || "erreur réseau").slice(0, 120));
  } finally { clearTimeout(timer); }
}

/** Appel protégé : disjoncteur par source + espacement + plafond de concurrence. as: json | text | raw */
async function http(key, url, { as = "json", gapMs = 0, ...opts } = {}) {
  if (!breakerAllow(key)) throw new BoostError("circuit_open", `source « ${key} » suspendue quelques instants après des échecs répétés`);
  try {
    await gate(key, gapMs);
    const r = await limit(() => fetchCapped(url, opts));
    let out = r;
    if (as === "json") { try { out = JSON.parse(r.text); } catch { throw new BoostError("bad_payload", `${key} : réponse non JSON (blocage ou page d'erreur)`); } }
    else if (as === "text") out = r.text;
    breakerOk(key);
    return out;
  } catch (e) { breakerFail(key, e); throw e; }
}

function makeMemo(max) {
  const store = new Map(), pending = new Map();
  return (key, ttlMs, fn) => {
    const hit = store.get(key);
    if (hit && hit.exp > Date.now()) { store.delete(key); store.set(key, hit); return Promise.resolve(hit.v); }
    if (pending.has(key)) return pending.get(key);                 // requêtes identiques en vol : un seul appel réseau
    const p = Promise.resolve().then(fn).then((v) => {
      store.set(key, { v, exp: Date.now() + ttlMs });
      while (store.size > max) store.delete(store.keys().next().value);
      return v;
    }).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}
const memo = makeMemo(300);          // résultats de recherche (petits)
const memoPages = makeMemo(24);      // pages de secours (plus lourdes)

// ---------------------------------------------------------------------------------
// §3 — Moteurs de recherche (lignes { title, url, snippet, publishedAt, author })
// ---------------------------------------------------------------------------------
const wikiUA = { "Api-User-Agent": UA };

/** Bing renvoie parfois un lien de suivi bing.com/ck/a?…&u=a1<base64url> : on retrouve l'URL réelle. */
function unwrapBing(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)bing\.com$/i.test(x.hostname) || !x.pathname.startsWith("/ck/")) return u;
    const v = x.searchParams.get("u") || "";
    if (!v.startsWith("a1")) return u;
    const real = Buffer.from(v.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(real) ? real : u;
  } catch { return u; }
}

const bingRss = (q, n) => memo(`bing|${n}|${q}`, 5 * 60e3, async () => {
  const xml = await http("bing", `https://www.bing.com/search?format=rss&q=${enc(q)}&count=${Math.min(n, 15)}&setlang=fr&cc=fr`, { as: "text", maxBytes: 300000, headers: { Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.5" } });
  const rows = xmlBlocks(xml, "item").slice(0, n).map((b) => ({ title: stripHtml(xmlText(b, "title")), url: unwrapBing(xmlText(b, "link")), snippet: cut(stripHtml(xmlText(b, "description")), 300), publishedAt: iso(xmlText(b, "pubDate")) }))
    .filter((r) => r.title && /^https?:\/\//i.test(r.url));
  if (!rows.length && !/<rss[\s>]/i.test(xml)) throw new BoostError("bad_payload", "Bing : réponse inattendue (blocage ?)");
  return rows;
});

const searxng = (q, n) => memo(`searx|${n}|${q}`, 5 * 60e3, async () => {
  const d = await http("searxng", `${SEARXNG}/search?q=${enc(q)}&format=json&language=fr&safesearch=1`, { timeoutMs: 8000, maxBytes: 600000 });
  return (d.results || []).slice(0, n).map((r) => ({ title: cut(r.title, 200), url: r.url, snippet: cut(r.content, 300), publishedAt: iso(r.publishedDate) })).filter((r) => r.title && /^https?:\/\//i.test(r.url));
});

const wikiSearch = (q, n, lang = "fr") => {
  lang = /^[a-z]{2,3}$/.test(lang) ? lang : "fr";
  return memo(`wiki|${lang}|${n}|${q}`, 3600e3, async () => {
    const d = await http(`wikipedia-${lang}`, `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch=${enc(q)}&gsrlimit=${n}&gsrnamespace=0&prop=extracts%7Cinfo&exintro=1&explaintext=1&exsentences=3&exlimit=max&inprop=url`, { headers: wikiUA });
    return (d.query?.pages || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((p) => ({ title: p.title, url: p.canonicalurl || p.fullurl, snippet: cut(p.extract, 500) })).filter((r) => r.url);
  });
};

const pmUrl = (r) => (r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : r.doi ? `https://doi.org/${r.doi}` : r.id && r.source ? `https://europepmc.org/article/${r.source}/${r.id}` : null);
const europePmc = (q, n, { sort = "relevance", openAccess = false } = {}) => memo(`pmc|${n}|${sort}|${openAccess}|${q}`, 3600e3, async () => {
  const sortParam = sort === "date" ? "&sort=P_PDATE_D%20desc" : sort === "cited" ? "&sort=CITED%20desc" : "";
  const query = openAccess ? `(${q}) AND OPEN_ACCESS:y` : q;
  const d = await http("europepmc", `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(query)}&format=json&pageSize=${n}&resultType=core${sortParam}`, { maxBytes: 900000 });
  return (d.resultList?.result || []).map((r) => ({
    title: cut(stripHtml(r.title), 250), url: pmUrl(r), publishedAt: iso(r.firstPublicationDate),
    snippet: cut([r.abstractText ? stripHtml(r.abstractText) : "", r.journalTitle ? `Revue : ${r.journalTitle}` : "", r.pubYear ? `Année : ${r.pubYear}` : "", r.citedByCount ? `Citations : ${r.citedByCount}` : "", r.isOpenAccess === "Y" ? "Accès libre" : ""].filter(Boolean).join(" — "), 600),
    author: cut(r.authorString, 120) || null, _doi: r.doi || null, _journal: r.journalTitle || null, _year: r.pubYear || null, _cited: r.citedByCount ?? null, _open: r.isOpenAccess === "Y", _pmid: r.pmid || null
  })).filter((r) => r.title && r.url);
});

const SE_SITES = ["stackoverflow", "superuser", "serverfault", "askubuntu", "math", "stats", "unix", "security", "softwareengineering", "dba", "webmasters", "electronics", "physics", "chemistry", "biology", "english", "french", "economics", "money"];
async function stackQuestions(q, n, site = "stackoverflow") {
  site = SE_SITES.includes(site) ? site : "stackoverflow";
  return memo(`se|${site}|${n}|${q}`, 3600e3, async () => {
    const d = await http("stackexchange", `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${enc(q)}&site=${site}&pagesize=${n}`, { headers: wikiUA });
    if (d.backoff) breakerOpen("stackexchange", Math.min(300, d.backoff) * 1000);
    return (d.items || []).map((i) => ({
      title: cut(stripHtml(i.title), 220), url: i.link,
      snippet: cut([`Score ${i.score}`, `${i.answer_count} réponse(s)`, i.accepted_answer_id ? "réponse acceptée" : i.is_answered ? "répondue" : "sans réponse", (i.tags || []).slice(0, 5).join(", ")].join(" · "), 200),
      publishedAt: i.creation_date ? new Date(i.creation_date * 1000).toISOString() : null,
      _qid: i.question_id, _accepted: i.accepted_answer_id || null, _score: i.score, _answers: i.answer_count, _tags: (i.tags || []).slice(0, 6), _site: site
    })).filter((r) => r.url);
  });
}
async function stackTopAnswers(site, ids) {
  if (!ids.length) return new Map();
  const d = await memo(`se-ans|${site}|${ids.join(";")}`, 3600e3, () => http("stackexchange", `https://api.stackexchange.com/2.3/answers/${ids.join(";")}?order=desc&sort=votes&site=${site}&filter=withbody`, { headers: wikiUA, maxBytes: 600000 }));
  return new Map((d.items || []).map((a) => [a.answer_id, { score: a.score, text: cut(stripHtml(a.body), 700) }]));
}

const ghHeaders = () => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(ENV.GITHUB_TOKEN ? { Authorization: `Bearer ${ENV.GITHUB_TOKEN}` } : {}) });
const githubRepos = (q, n, { sort = "stars", language = "" } = {}) => memo(`gh|r|${n}|${sort}|${language}|${q}`, 15 * 60e3, async () => {
  const lang = /^[A-Za-z0-9+#.\- ]{1,30}$/.test(language) ? ` language:"${language}"` : "";
  const s = sort === "updated" ? "&sort=updated&order=desc" : sort === "best-match" ? "" : "&sort=stars&order=desc";
  const d = await http("github", `https://api.github.com/search/repositories?q=${enc(q + lang)}${s}&per_page=${n}`, { headers: ghHeaders(), gapMs: 1500 });
  return (d.items || []).map((r) => ({
    title: r.full_name, url: r.html_url, publishedAt: iso(r.pushed_at),
    snippet: cut([r.description, `★ ${r.stargazers_count}`, r.language, r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? `licence ${r.license.spdx_id}` : "", r.archived ? "archivé" : ""].filter(Boolean).join(" · "), 300),
    _stars: r.stargazers_count, _forks: r.forks_count, _lang: r.language || null, _topics: (r.topics || []).slice(0, 6)
  }));
});
const githubIssues = (q, n) => memo(`gh|i|${n}|${q}`, 15 * 60e3, async () => {
  const d = await http("github", `https://api.github.com/search/issues?q=${enc(q)}&per_page=${n}`, { headers: ghHeaders(), gapMs: 1500 });
  return (d.items || []).map((i) => ({
    title: cut(i.title, 200), url: i.html_url, publishedAt: iso(i.created_at),
    snippet: cut([i.pull_request ? "PR" : "issue", i.state, `${i.comments} commentaire(s)`, (i.repository_url || "").replace("https://api.github.com/repos/", ""), stripHtml(i.body || "")].filter(Boolean).join(" · "), 350)
  }));
});

const hackerNews = (q, n) => memo(`hn|${n}|${q}`, 5 * 60e3, async () => {
  const d = await http("hackernews", `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=${n}`);
  return (d.hits || []).map((h) => ({
    title: cut(h.title, 200), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, publishedAt: iso(h.created_at), author: h.author || null,
    snippet: `${h.points ?? 0} points · ${h.num_comments ?? 0} commentaires — discussion : https://news.ycombinator.com/item?id=${h.objectID}`
  })).filter((r) => r.title);
});

// ---------------------------------------------------------------------------------
// §4 — Wikidata : faits structurés (naissance, population, capitale, dirigeant…)
// ---------------------------------------------------------------------------------
const WD_PROPS = {
  P31: "nature", P279: "sous-classe de", P17: "pays", P131: "situé dans", P569: "naissance", P570: "décès", P19: "lieu de naissance", P27: "nationalité", P106: "profession",
  P571: "création", P159: "siège", P169: "directeur général", P112: "fondateur", P856: "site officiel", P1082: "population", P2046: "superficie (km²)", P36: "capitale",
  P35: "chef de l'État", P6: "chef du gouvernement", P37: "langue officielle", P38: "monnaie", P452: "secteur", P749: "organisation mère", P1128: "employés", P625: "coordonnées"
};
function wdValue(v, labels) {
  if (!v) return null;
  switch (v.type) {
    case "wikibase-entityid": return labels.get(v.value?.id) || v.value?.id || null;
    case "time": {
      const t = String(v.value?.time || "").match(/^([+-])(\d{4,})-(\d\d)-(\d\d)/); if (!t) return null;
      const p = v.value?.precision ?? 11, y = `${t[1] === "-" ? "-" : ""}${parseInt(t[2], 10)}`;
      return p >= 11 ? `${y}-${t[3]}-${t[4]}` : p === 10 ? `${y}-${t[3]}` : y;
    }
    case "quantity": { const a = Number(v.value?.amount); return Number.isFinite(a) ? a : null; }
    case "globecoordinate": return `${Number(v.value?.latitude).toFixed(4)}, ${Number(v.value?.longitude).toFixed(4)}`;
    case "monolingualtext": return v.value?.text || null;
    case "string": return v.value ?? null;
    default: return typeof v.value === "string" ? v.value : null;
  }
}
const wikidata = (q, limitN, lang) => memo(`wd|${lang}|${limitN}|${q}`, 24 * 3600e3, async () => {
  const s = await http("wikidata", `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${enc(q)}&language=${lang}&uselang=${lang}&limit=${limitN}&format=json&type=item`, { headers: wikiUA });
  const hits = (s.search || []).slice(0, limitN);
  if (!hits.length) return [];
  const top = hits[0].id;
  const e = await http("wikidata", `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${top}&props=claims&format=json`, { headers: wikiUA, maxBytes: 3000000, timeoutMs: 8000 });
  const claims = e.entities?.[top]?.claims || {};
  const picked = {}; const qids = new Set();
  for (const [pid] of Object.entries(WD_PROPS)) {
    const list = (claims[pid] || []).filter((c) => c.rank !== "deprecated" && c.mainsnak?.snaktype === "value").sort((a, b) => (b.rank === "preferred") - (a.rank === "preferred")).slice(0, 3);
    if (!list.length) continue;
    picked[pid] = list.map((c) => c.mainsnak.datavalue);
    for (const dv of picked[pid]) if (dv?.type === "wikibase-entityid" && dv.value?.id) qids.add(dv.value.id);
  }
  const labels = new Map();
  const ids = [...qids].slice(0, 50);
  if (ids.length) {
    const l = await http("wikidata", `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=${lang}%7Cen&format=json`, { headers: wikiUA, maxBytes: 600000 });
    for (const [id, ent] of Object.entries(l.entities || {})) labels.set(id, ent.labels?.[lang]?.value || ent.labels?.en?.value || id);
  }
  const facts = {};
  for (const [pid, dvs] of Object.entries(picked)) { const vals = dvs.map((dv) => wdValue(dv, labels)).filter((x) => x !== null && x !== ""); if (vals.length) facts[WD_PROPS[pid]] = vals; }
  return hits.map((h, i) => ({ id: h.id, label: h.label || h.display?.label?.value || h.id, description: h.description || null, url: `https://www.wikidata.org/wiki/${h.id}`, ...(i === 0 ? { facts } : {}) }));
});

// ---------------------------------------------------------------------------------
// §5 — Lecture de secours : rendu JavaScript distant (Jina Reader) puis archive (Wayback)
// ---------------------------------------------------------------------------------
let netMod = null; try { netMod = require("./net.js"); } catch { /* facultatif */ }
function publicUrl(u) {
  if (netMod?.validatePublicHttpUrl) return netMod.validatePublicHttpUrl(u).toString();
  const x = new URL(String(u));
  if (!/^https?:$/.test(x.protocol) || !x.hostname.includes(".") || /^(localhost|\d+\.\d+\.\d+\.\d+)$/i.test(x.hostname)) throw new Error("URL non publique");
  return x.toString();
}

const BOT_WALL = /(just a moment|checking your browser|verify you are (?:a )?human|are you a robot|captcha|access denied|attention required)/i;
function mdLinks(text, max = 80) {
  const out = [], seen = new Set();
  for (const m of String(text).matchAll(/\[([^\]\n]{1,100})\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (seen.has(m[2]) || out.length >= max) continue;
    seen.add(m[2]); out.push({ id: `L${out.length + 1}`, text: cut(m[1], 100), url: m[2] });
  }
  return out;
}
function parseJina(raw, target) {
  const i = raw.indexOf("Markdown Content:");
  const head = i >= 0 ? raw.slice(0, i) : "";
  let body = i >= 0 ? raw.slice(i + "Markdown Content:".length) : raw;
  const err = head.match(/Target URL returned error (\d{3})/);
  if (err && Number(err[1]) >= 400) throw new BoostError("render_failed", `le site répond « HTTP ${err[1]} » même au rendu distant`);
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length < 80) throw new BoostError("empty", "aucun texte même après rendu JavaScript");
  if (body.length < 1500 && BOT_WALL.test(body)) throw new BoostError("blocked", "page protégée (anti-bot) même au rendu distant");
  return { kind: "text", via: "jina", title: cut((head.match(/^Title:\s*(.*)$/m) || [])[1] || "", 200), text: body.slice(0, 60000), links: mdLinks(body), publishedAt: iso((head.match(/^Published Time:\s*(.*)$/m) || [])[1]), finalUrl: target, warning: "Contenu obtenu via un rendu JavaScript distant (Jina Reader) : la page est dynamique ou bloque les robots simples." };
}
async function viaJina(target) {
  const headers = { Accept: "text/plain", "X-Timeout": "12", "X-Return-Format": "markdown", ...(ENV.JINA_API_KEY ? { Authorization: `Bearer ${ENV.JINA_API_KEY}` } : {}) };
  const r = await http("jina", `https://r.jina.ai/${target}`, { as: "raw", timeoutMs: 16000, maxBytes: 700000, headers });
  return parseJina(r.text, target);
}
async function viaWayback(target) {
  const j = await http("wayback", `https://archive.org/wayback/available?url=${enc(target)}`, { timeoutMs: 6000, headers: wikiUA });
  const c = j.archived_snapshots?.closest;
  if (!c?.available || !c.timestamp) throw new BoostError("not_archived", "aucune copie archivée");
  const r = await http("wayback", `https://web.archive.org/web/${c.timestamp}id_/${target}`, { as: "raw", timeoutMs: 10000, maxBytes: 1500000, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.3" } });
  if (r.type && !/html|xml|text\//.test(r.type)) throw new BoostError("not_html", "copie archivée non textuelle");
  const when = iso(c.timestamp.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d).*$/, "$1-$2-$3T$4:$5:$6Z"));
  return { kind: "html", via: "wayback", html: r.text, finalUrl: target, snapshotAt: when, warning: `Copie archivée (Internet Archive)${when ? ` du ${when.slice(0, 10)}` : ""} : le contenu peut différer de la page actuelle.` };
}

/** Lecture de secours d'une URL publique : { kind:'text'|'html', via, title?, text?|html?, links?, warning } — lève une erreur lisible sinon. */
function readable(url) {
  let target; try { target = publicUrl(url); } catch (e) { return Promise.reject(new BoostError("bad_url", e.message || "URL non autorisée")); }
  return memoPages(`read|${target}`, 10 * 60e3, async () => {
    const errors = [];
    if (RENDER_ON) { try { return await viaJina(target); } catch (e) { errors.push(`rendu : ${e.message}`); } }
    if (ARCHIVE_ON) { try { return await viaWayback(target); } catch (e) { errors.push(`archive : ${e.message}`); } }
    throw new BoostError("unreadable", errors.join(" ; ") || "aucun mode de lecture de secours actif");
  });
}
const FALLBACK_RE = /Contenu vide|Page protégée|HTTP (?:401|403|429|451|5\d\d)|Délai dépassé|Trop de redirections|Type de contenu non supporté|ECONNRESET|ETIMEDOUT|socket hang up|certificat|certificate/i;
const canFallback = (err) => (RENDER_ON || ARCHIVE_ON) && FALLBACK_RE.test(String(err?.message || err));

/** URLs présentes dans un texte libre (https://…, www.… ou domaine nu à TLD courant). */
function extractUrls(text, max = 3) {
  const s = String(text || "").slice(0, 2000);
  const found = [];
  const push = (raw) => {
    let u = raw.replace(/[)\]}>.,;:!?'"»”]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try { const x = new URL(u); if (x.hostname.includes(".") && !found.includes(x.href)) found.push(x.href); } catch { /* ignoré */ }
  };
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) push(m[0]);
  for (const m of s.matchAll(/(?<![@\w/.-])(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*)?/gi)) push(m[0]);
  for (const m of s.matchAll(/(?<![@\w/.:-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|fr|cd|be|ch|ca|co|info|ai|tech|site|online|xyz|me|tv|gov|edu|africa)(?:\/[^\s<>"'`]*)?(?![\w@-])/gi)) push(m[0]);
  const hosts = new Set(); const out = [];
  for (const u of found) { const h = new URL(u).hostname.replace(/^www\./, ""); const key = `${h}${new URL(u).pathname}`; if (hosts.has(key)) continue; hosts.add(key); out.push(u); }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------------
// §6 — Moteurs exposés à net.js (priorité : plus petit = interrogé d'abord en mode rapide)
// ---------------------------------------------------------------------------------
const PROVIDERS = {
  searxng: { topics: ["general"], priority: 10, enabled: () => Boolean(SEARXNG), run: searxng },
  bing: { topics: ["general"], priority: 20, run: bingRss },
  "wikipedia-en": { topics: ["general"], priority: 85, run: (q, n) => wikiSearch(q, n, "en") },
  europepmc: { topics: ["academic"], priority: 50, run: (q, n) => europePmc(q, n) },
  stackexchange: { topics: ["tech"], priority: 50, run: (q, n) => stackQuestions(q, n) },
  github: { topics: ["tech"], priority: 60, run: (q, n) => githubRepos(q, n) },
  hackernews: { topics: ["tech"], priority: 70, run: hackerNews }
};
const listEnv = (k) => (ENV[k] || "").split(",").map((s) => s.trim()).filter(Boolean);
function webProviders() {
  const only = listEnv("BOOST_PROVIDERS");
  return Object.entries(PROVIDERS).filter(([n, p]) => (!only.length || only.includes(n)) && (!p.enabled || p.enabled())).map(([name, p]) => ({
    name, topics: p.topics, priority: p.priority,
    async search(q, o = {}) { return p.run(String(q), clampInt(o.maxResults, 6, 1, 10)); }
  }));
}

// ---------------------------------------------------------------------------------
// §7 — Outils LLM (format function calling)
// ---------------------------------------------------------------------------------
const TOOLS = {};
function defTool(name, description, properties, required, source, exec) {
  TOOLS[name] = { source, exec, schema: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } } };
}
const Q = (d = "Termes de recherche") => ({ type: "string", description: d });
const LIM = (max, def) => ({ type: "integer", description: `Nombre de résultats (1-${max}, défaut ${def})` });
const need = (v, label = "requête") => { const t = cut(v, 250); if (!t) fail(`Paramètre « ${label} » manquant.`); return t; };
const publicRows = (rows) => rows.map(({ _doi, _journal, _year, _cited, _open, _pmid, _qid, _accepted, _score, _answers, _tags, _site, _stars, _forks, _lang, _topics, ...r }) => r);

defTool("search_wikipedia", "Wikipédia (toutes langues) : introduction des articles les plus pertinents, avec lien. Idéal pour « qui est / qu'est-ce que / histoire de ».",
  { query: Q("Sujet, personne, lieu, notion"), lang: { type: "string", description: "Code langue : fr (défaut), en, es, pt, sw, ln…" }, limit: LIM(5, 3) }, ["query"], "wikipedia",
  async (a) => {
    const q = need(a.query), lang = /^[a-z]{2,3}$/i.test(a.lang || "") ? a.lang.toLowerCase() : "fr";
    const rows = await wikiSearch(q, clampInt(a.limit, 3, 1, 5), lang);
    return { success: true, query: q, lang, count: rows.length, articles: rows.map((r) => ({ title: r.title, url: r.url, extract: r.snippet })) };
  });

defTool("wikidata_lookup", "Wikidata (base de connaissances ouverte) : faits structurés sur une personne, un lieu, une organisation — naissance, population, capitale, dirigeant, site officiel…",
  { query: Q("Nom de l'entité, ex. « République démocratique du Congo », « Moïse Katumbi »"), lang: { type: "string", description: "Langue des libellés (fr par défaut)" }, limit: LIM(3, 2) }, ["query"], "wikidata",
  async (a) => {
    const q = need(a.query), lang = /^[a-z]{2,3}$/i.test(a.lang || "") ? a.lang.toLowerCase() : "fr";
    const entities = await wikidata(q, clampInt(a.limit, 2, 1, 3), lang);
    return { success: true, query: q, count: entities.length, entities, note: entities.length ? "Faits issus de Wikidata (contributif) : à recouper pour une information sensible. `facts` ne concerne que la 1re entité." : undefined };
  });

defTool("search_biomedical", "Littérature médicale et biomédicale (PubMed / Europe PMC, 40 M+ références) : titre, auteurs, revue, résumé, citations, accès libre.",
  { query: Q("Sujet médical (anglais de préférence)"), sort: { type: "string", enum: ["relevance", "date", "cited"], description: "Tri (défaut relevance)" }, open_access: { type: "boolean", description: "Uniquement les textes en accès libre" }, limit: LIM(8, 5) }, ["query"], "europepmc",
  async (a) => {
    const q = need(a.query);
    const rows = await europePmc(q, clampInt(a.limit, 5, 1, 8), { sort: ["relevance", "date", "cited"].includes(a.sort) ? a.sort : "relevance", openAccess: a.open_access === true });
    return { success: true, query: q, count: rows.length, articles: rows.map((r) => ({ title: r.title, url: r.url, authors: r.author, journal: r._journal, year: r._year, citations: r._cited, openAccess: r._open, doi: r._doi, abstract: r.snippet.split(" — ")[0] })) };
  });

defTool("search_stackexchange", "Questions/réponses techniques (Stack Overflow, Super User, Server Fault, Ask Ubuntu, Math…) avec la meilleure réponse. Pour erreurs, bugs, commandes, configuration.",
  { query: Q("Message d'erreur ou question technique"), site: { type: "string", enum: SE_SITES, description: "Site (défaut stackoverflow)" }, limit: LIM(5, 3) }, ["query"], "stackexchange",
  async (a) => {
    const q = need(a.query), site = SE_SITES.includes(a.site) ? a.site : "stackoverflow";
    const rows = await stackQuestions(q, clampInt(a.limit, 3, 1, 5), site);
    const answers = await stackTopAnswers(site, rows.map((r) => r._accepted).filter(Boolean).slice(0, 3)).catch(() => new Map());
    return { success: true, query: q, site, count: rows.length, questions: rows.map((r) => ({ title: r.title, url: r.url, score: r._score, answers: r._answers, tags: r._tags, createdAt: r.publishedAt, acceptedAnswer: answers.get(r._accepted) || null })), note: "Réponses de la communauté : vérifier la version du logiciel et la date avant d'appliquer." };
  });

defTool("search_github", "GitHub : dépôts open source (étoiles, langage, licence, dernière activité) ou issues/PR. Pour trouver une bibliothèque, un outil, un bug connu.",
  { query: Q("Mots-clés"), type: { type: "string", enum: ["repositories", "issues"], description: "Dépôts (défaut) ou issues/PR" }, sort: { type: "string", enum: ["stars", "updated", "best-match"], description: "Tri des dépôts (défaut stars)" }, language: { type: "string", description: "Langage de programmation (dépôts)" }, limit: LIM(8, 5) }, ["query"], "github",
  async (a) => {
    const q = need(a.query), n = clampInt(a.limit, 5, 1, 8);
    if (a.type === "issues") { const rows = await githubIssues(q, n); return { success: true, query: q, type: "issues", count: rows.length, items: publicRows(rows) }; }
    const rows = await githubRepos(q, n, { sort: a.sort, language: cut(a.language || "", 30) });
    return { success: true, query: q, type: "repositories", count: rows.length, repositories: rows.map((r) => ({ name: r.title, url: r.url, description: r.snippet, stars: r._stars, forks: r._forks, language: r._lang, topics: r._topics, lastPush: r.publishedAt })) };
  });

defTool("wayback_lookup", "Internet Archive (Wayback Machine) : retrouve la copie archivée d'une page supprimée, inaccessible ou modifiée. Renvoie l'URL de la copie, à lire ensuite avec web_open.",
  { url: { type: "string", description: "URL de la page" }, date: { type: "string", description: "Date souhaitée AAAAMMJJ (facultatif, copie la plus proche)" } }, ["url"], "wayback",
  async (a) => {
    let target; try { target = publicUrl(String(a.url || "").trim()); } catch { fail("URL invalide ou non publique."); }
    const ts = /^\d{4,14}$/.test(a.date || "") ? `&timestamp=${a.date}` : "";
    const j = await memo(`wb|${target}|${ts}`, 3600e3, () => http("wayback", `https://archive.org/wayback/available?url=${enc(target)}${ts}`, { timeoutMs: 6000, headers: wikiUA }));
    const c = j.archived_snapshots?.closest;
    if (!c?.available) return { success: true, count: 0, url: target, note: "Aucune copie archivée trouvée." };
    const at = iso(String(c.timestamp).replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d).*$/, "$1-$2-$3T$4:$5:$6Z"));
    return { success: true, count: 1, url: target, snapshotUrl: `https://web.archive.org/web/${c.timestamp}/${target}`, snapshotAt: at, status: c.status || null, note: "Copie archivée : peut différer de la page actuelle. Lis-la avec web_open(snapshotUrl)." };
  });

// ---------------------------------------------------------------------------------
// §8 — API publique (même contrat que free-sources.js)
// ---------------------------------------------------------------------------------
const enabledTools = () => { const only = listEnv("BOOST_TOOLS"); return new Set(only.length ? only.filter((n) => TOOLS[n]) : Object.keys(TOOLS)); };
const schemas = () => { const on = enabledTools(); return Object.keys(TOOLS).filter((n) => on.has(n)).map((n) => TOOLS[n].schema); };
const has = (name) => Boolean(TOOLS[name]) && enabledTools().has(name);

function friendly(e) {
  if (e instanceof UserError) return e.message;
  if (e instanceof BoostError) {
    if (e.code === "timeout") return "La source n'a pas répondu à temps. Réessaie dans un instant.";
    if (e.code === "rate_limited" || e.status === 429) return "La source limite les requêtes pour le moment. Réessaie dans quelques secondes.";
    if (e.code === "circuit_open" || e.code === "busy") return "Source momentanément suspendue pour protéger le serveur. Réessaie dans un instant.";
    if (e.code === "http") return e.status === 403 ? "La source a refusé la requête (HTTP 403)." : `La source a répondu HTTP ${e.status}.`;
  }
  return "Impossible de joindre la source pour le moment.";
}
/** Ne lève jamais : { result, sourceKeys }. */
async function execute(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool || !enabledTools().has(name)) return { result: { success: false, error: "Outil indisponible." }, sourceKeys: [] };
  try {
    const result = await tool.exec(args && typeof args === "object" ? args : {});
    return { result, sourceKeys: result?.success && result.count !== 0 ? [tool.source] : [] };
  } catch (e) { return { result: { success: false, error: friendly(e) }, sourceKeys: [] }; }
}

function stats() {
  const now = Date.now();
  return { providers: webProviders().map((p) => p.name), suspended: [...breakers.entries()].filter(([, b]) => b.openUntil > now).map(([k, b]) => ({ source: k, secondsLeft: Math.ceil((b.openUntil - now) / 1000) })), renderFallback: RENDER_ON, archiveFallback: ARCHIVE_ON, searxng: Boolean(SEARXNG) };
}

module.exports = {
  VERSION: "1.0.0", SOURCES, TOOLS, schemas, has, execute, webProviders, readable, canFallback, extractUrls, stats,
  names: () => Object.keys(TOOLS),
  // — réservé aux tests —
  __setFetch: (fn) => { doFetch = fn || ((...a) => globalThis.fetch(...a)); },
  __reset: () => { breakers.clear(); gateLast.clear(); limit = makeLimiter(MAX_CONC); },
  __internals: { parseJina, unwrapBing, mdLinks, wdValue, makeLimiter, fetchCapped, breakers }
};
