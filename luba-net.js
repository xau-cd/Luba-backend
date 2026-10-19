'use strict';

const { URL } = require('node:url');

class NetError extends Error {
  constructor(code, message, options = {}) { super(message); this.name = 'NetError'; this.code = code; this.status = options.status || 502; }
}

function createLubaNet(options = {}) {
  const providers = (options.providers || []).filter(p => p && typeof p.search === 'function');
  const openPage = typeof options.openPage === 'function' ? options.openPage : null;
  const timeoutMs = bounded(options.timeoutMs, 8000, 500, 30000);
  const maxSources = bounded(options.maxSources, 12, 1, 30);
  const maxQueries = bounded(options.maxQueries, 5, 1, 10);
  const cacheTtlMs = bounded(options.cacheTtlMs, 60000, 0, 3600000);
  const cache = new Map();

  async function search(query, opts = {}) {
    const q = cleanQuery(query);
    if (!q) throw new NetError('EMPTY_QUERY', 'La requête de recherche est vide.', { status: 400 });
    const queries = [...new Set([q, ...(Array.isArray(opts.followUpQueries) ? opts.followUpQueries : [])].map(cleanQuery).filter(Boolean))].slice(0, maxQueries);
    const topic = opts.topic === 'news' ? 'news' : 'general';
    const all = [];
    const providerStatus = [];
    for (const subquery of queries) {
      if (opts.signal?.aborted) throw new NetError('ABORTED', 'Recherche annulée.', { status: 499 });
      const tasks = providers.map(async p => {
        const cacheKey = `${p.name || 'provider'}:${topic}:${subquery}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return { provider: p.name || 'provider', results: cached.results, cached: true };
        try {
          const raw = await timed(Promise.resolve(p.search(subquery, { ...opts, topic, signal: opts.signal, maxResults: Math.min(maxSources, opts.maxResults || 6) })), timeoutMs, opts.signal);
          const rows = normalizeResults(raw, p.name || 'provider', subquery);
          if (cacheTtlMs) { cache.set(cacheKey, { results: rows, expiresAt: Date.now() + cacheTtlMs }); trimCache(cache, 500); }
          return { provider: p.name || 'provider', results: rows, cached: false };
        } catch (e) { return { provider: p.name || 'provider', results: [], error: safeError(e) }; }
      });
      const results = await Promise.all(tasks);
      for (const r of results) { providerStatus.push({ query: subquery, provider: r.provider, count: r.results.length, ...(r.error ? { error: r.error } : {}), cached: Boolean(r.cached) }); all.push(...r.results); }
    }
    const unique = dedupe(all).slice(0, maxSources);
    return {
      query: q, topic, searchedAt: new Date().toISOString(), providers: [...new Set(providers.map(p => p.name || 'provider'))],
      providerStatus, sources: unique, facts: extractEvidence(unique), contradictions: findContradictions(unique),
      limitations: providers.length ? (unique.length ? [] : ['Aucun fournisseur n’a renvoyé de résultat exploitable.']) : ['Aucun fournisseur de recherche n’est configuré.'],
      status: unique.length ? 'results' : 'no_results'
    };
  }

  async function open(url, opts = {}) {
    if (!openPage) throw new NetError('OPEN_UNAVAILABLE', 'Aucun extracteur de page n’est configuré.', { status: 503 });
    const checked = validatePublicHttpUrl(url);
    return timed(Promise.resolve(openPage(checked.toString(), opts)), timeoutMs, opts.signal);
  }

  async function research(query, opts = {}) {
    const first = await search(query, opts);
    if (!opts.deep || !openPage || !first.sources.length) return first;
    const selected = first.sources.slice(0, bounded(opts.openTop, 3, 1, 5));
    const pages = await Promise.all(selected.map(async s => {
      try {
        const page = await open(s.url, opts);
        return { ...s, page: normalizePage(page, s.url) };
      } catch (e) { return { ...s, openError: safeError(e) }; }
    }));
    const openedSources = pages.filter(p => p.page).map(p => ({ ...p, snippet: p.page.text.slice(0, 1000) || p.snippet }));
    const sources = dedupe([...openedSources, ...first.sources]).slice(0, maxSources);
    return { ...first, sources, openedPages: pages.filter(p => p.page).length, limitations: [...first.limitations, ...(pages.some(p => p.openError) ? ['Certaines pages n’ont pas pu être ouvertes.'] : [])] };
  }

  return { search, research, open, clearCache: () => cache.clear(), providers: providers.map(p => p.name || 'provider') };
}

function normalizeResults(raw, provider, query) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.sources) ? raw.sources : [];
  return rows.map(r => {
    let url; try { url = canonicalUrl(validatePublicHttpUrl(r.url || r.link || r.href).toString()); } catch { return null; }
    const title = String(r.title || r.name || '').trim().slice(0, 300);
    if (!title) return null;
    return { title, url, domain: new URL(url).hostname.toLowerCase(), snippet: String(r.snippet || r.content || r.description || '').slice(0, 1200), publishedAt: normalizeDate(r.publishedAt || r.publishedDate || r.date || r.published_date), provider, query, retrievedAt: new Date().toISOString() };
  }).filter(Boolean);
}
function normalizePage(page, fallbackUrl) { return { url: safeUrl(page?.url || fallbackUrl), title: String(page?.title || '').slice(0, 300), text: String(page?.text || page?.content || '').slice(0, 12000), publishedAt: normalizeDate(page?.publishedAt || page?.date) }; }
function validatePublicHttpUrl(value) {
  let u; try { u = new URL(String(value)); } catch { throw new NetError('INVALID_URL', 'URL invalide.', { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new NetError('URL_NOT_ALLOWED', 'Seules les URL HTTP(S) publiques sont autorisées.', { status: 400 });
  if ((u.port && !['80', '443'].includes(u.port)) || (u.protocol === 'http:' && u.port === '443') || (u.protocol === 'https:' && u.port === '80')) throw new NetError('URL_NOT_ALLOWED', 'Port réseau non standard interdit.', { status: 403 });
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'metadata.google.internal' || h === 'metadata' || isPrivateV4(h) || isPrivateV6(h)) throw new NetError('PRIVATE_URL_BLOCKED', 'Les adresses locales, privées et de métadonnées sont interdites.', { status: 403 });
  return u;
}
function isPrivateV4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); if (!m) return false;
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4]; if ([a,b,c,d].some(n => n > 255)) return true;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(h) { return h === '::' || h === '::1' || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h) || h.startsWith('::ffff:127.') || h.startsWith('::ffff:10.') || h.startsWith('::ffff:192.168.'); }
function dedupe(rows) { const seen = new Set(); return rows.filter(r => { const k = canonicalUrl(r.url); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
function canonicalUrl(v) { try { const u = new URL(v); u.hash = ''; u.hostname = u.hostname.toLowerCase(); if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k); return u.toString().replace(/\/$/, ''); } catch { return null; } }
function extractEvidence(sources) { return sources.filter(s => s.snippet).map(s => ({ claim: s.snippet.slice(0, 500), source: s.url, title: s.title, publishedAt: s.publishedAt, confidence: s.publishedAt ? 'source_metadata_available' : 'publication_date_unverified' })); }
function findContradictions(sources) { const dated = sources.filter(s => s.publishedAt); const domains = new Set(dated.map(s => s.domain)); return domains.size > 1 && dated.length > 1 ? [{ type: 'potential_conflict', note: 'Les résultats proviennent de plusieurs domaines ; les contradictions doivent être vérifiées dans le contenu des pages.', sources: dated.map(s => s.url) }] : []; }
function normalizeDate(v) { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function cleanQuery(q) { return String(q || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 400); }
function safeError(e) { return String(e?.code || e?.message || 'provider_error').replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[REDACTED]').slice(0, 180); }
function safeUrl(v) { try { return validatePublicHttpUrl(v).toString(); } catch { return ''; } }
function bounded(v, fallback, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function trimCache(m, max) { while (m.size > max) m.delete(m.keys().next().value); }
function timed(promise, ms, signal) { return new Promise((resolve, reject) => { let done = false; const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(v); }; const timer = setTimeout(() => finish(reject, new NetError('TIMEOUT', 'La source web a dépassé son délai.', { status: 504 })), ms); const abort = () => finish(reject, new NetError('ABORTED', 'Opération annulée.', { status: 499 })); if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e)); }); }

module.exports = { createLubaNet, NetError, validatePublicHttpUrl, normalizeResults, dedupe, canonicalUrl, extractEvidence, findContradictions };
