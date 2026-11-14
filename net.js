'use strict';
/**
 * net.js — cœur UNIQUE du moteur de recherche web de Luba.
 *
 * Rôle : planifier la recherche, interroger les fournisseurs, normaliser / dédupliquer / classer les résultats,
 * OUVRIR réellement les pages (via l'extracteur injecté — loadPage d'index.js, qui porte les protections SSRF),
 * en extraire les passages utiles, recouper les sources et produire un résultat vérifiable.
 *
 * Règles non négociables :
 *  • `opened === true` UNIQUEMENT si openPage() a réussi ET a renvoyé un texte exploitable. Un titre, un lien ou
 *    un extrait de moteur n'est jamais une page consultée.
 *  • un fournisseur n'est déclaré « interrogé » (providersQueried) que si son appel a abouti ; sinon il est dans providersFailed.
 *  • aucune URL, date, auteur ou citation n'est inventée : champ absent => null.
 *  • les contrôles d'URL ci-dessous sont un PRÉ-FILTRE ; la connexion elle-même (DNS épinglé, redirections revalidées)
 *    reste assurée par index.js (httpGet / safeLookup / assertPublicUrl).
 */

const { URL } = require('node:url');

class NetError extends Error {
  constructor(code, message, options = {}) { super(message); this.name = 'NetError'; this.code = code; this.status = options.status || 502; }
}

const MIN_PAGE_TEXT = 80;          // en dessous : page considérée vide / inutilisable
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------
// Fabrique principale
// ---------------------------------------------------------------------------------------------
function createLubaNet(options = {}) {
  const getProviders = () => {
    const list = typeof options.providers === 'function' ? options.providers() : options.providers;
    return (Array.isArray(list) ? list : []).filter(p => p && typeof p.search === 'function');
  };
  const defaultOpenPage = typeof options.openPage === 'function' ? options.openPage : null;
  const timeoutMs = bounded(options.timeoutMs, 8000, 500, 30000);
  const maxSources = bounded(options.maxSources, 12, 1, 30);
  const maxQueries = bounded(options.maxQueries, 4, 1, 10);
  const cacheTtlMs = bounded(options.cacheTtlMs, 60000, 0, 3600000);
  const hedgeMs = bounded(options.hedgeMs, 1200, 0, 10000);   // mode rapide : si le 1er moteur tarde au-delà, le suivant démarre en parallèle (0 = séquentiel)
  const cache = new Map();

  // ---------- recherche ----------
  async function search(query, opts = {}) {
    const q = cleanQuery(query);
    if (!q) throw new NetError('EMPTY_QUERY', 'La requête de recherche est vide.', { status: 400 });
    const plan = opts.plan || planResearch(q, { mode: opts.mode === 'fast' ? 'fast' : 'deep', maxQueries, now: opts.now });
    const extra = (Array.isArray(opts.followUpQueries) ? opts.followUpQueries : []).map(cleanQuery).filter(Boolean);
    const queries = uniq([q, ...extra, ...plan.queries.filter(x => x !== q)]).slice(0, opts.mode === 'fast' ? 1 : maxQueries);
    const topics = opts.topic === 'news' ? uniq([...plan.topics, 'news']) : plan.topics;
    const strategy = opts.strategy || (opts.mode === 'fast' ? 'fallback' : 'all');
    const all = getProviders();
    const selected = pickProviders(all, { strategy, topics });
    const providerStatus = [];
    const rows = [];
    const perProviderMax = Math.min(maxSources, bounded(opts.maxResults, 6, 1, 20));

    const callProvider = async (p, subquery) => {
      const name = p.name || 'provider';
      const cacheKey = `${name}:${perProviderMax}:${subquery}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return { provider: name, ok: true, results: hit.results, cached: true };
      try {
        const raw = await timed(Promise.resolve(p.search(subquery, { ...opts, topic: topics.includes('news') ? 'news' : 'general', signal: opts.signal, maxResults: perProviderMax })), bounded(opts.providerTimeoutMs, timeoutMs, 500, 30000), opts.signal);
        const res = normalizeResults(raw, name, subquery);
        if (cacheTtlMs) { cache.set(cacheKey, { results: res, expiresAt: Date.now() + cacheTtlMs }); trimCache(cache, 500); }
        return { provider: name, ok: true, results: res };
      } catch (e) { return { provider: name, ok: false, results: [], error: safeError(e) }; }
    };
    const record = (r, subquery) => {
      providerStatus.push({ query: subquery, provider: r.provider, ok: r.ok, count: r.results.length, cached: Boolean(r.cached), ...(r.error ? { error: r.error } : {}) });
      rows.push(...r.results);
    };

    if (!selected.length) {
      return finishSearch({ q, plan, queries, providerStatus, rows: [], all, selected, strategy, opts });
    }

    if (strategy === 'fallback') {
      // faible latence : premier fournisseur qui renvoie des résultats ; s'il tarde (> hedgeMs) ou échoue, le suivant prend le relais
      const done = await hedgedFallback(selected, p => callProvider(p, queries[0]), bounded(opts.hedgeMs, hedgeMs, 0, 10000), opts.signal);
      done.forEach(r => record(r, queries[0]));
    } else {
      // 1re requête : tous les fournisseurs retenus ; requêtes suivantes : 2 fournisseurs généraux qui ont répondu (pas d'appels inutiles)
      const first = await Promise.all(selected.map(p => callProvider(p, queries[0])));
      first.forEach(r => record(r, queries[0]));
      const healthy = first.filter(r => r.ok).map(r => r.provider);
      const followProviders = selected.filter(p => healthy.includes(p.name || 'provider') && (!p.topics || p.topics.includes('general'))).slice(0, 2);
      const topicalHealthy = selected.filter(p => healthy.includes(p.name || 'provider') && p.topics && !p.topics.includes('general')).slice(0, 1);
      for (const sub of queries.slice(1)) {
        if (opts.signal?.aborted) throw new NetError('ABORTED', 'Recherche annulée.', { status: 499 });
        const res = await Promise.all([...followProviders, ...topicalHealthy].map(p => callProvider(p, sub)));
        res.forEach(r => record(r, sub));
      }
    }
    return finishSearch({ q, plan, queries, providerStatus, rows, all, selected, strategy, opts });
  }

  function finishSearch({ q, plan, queries, providerStatus, rows, all, selected, strategy, opts }) {
    const ranked = rankSources(dedupe(rows), plan, opts.now).slice(0, maxSources);
    const okNames = uniq(providerStatus.filter(s => s.ok).map(s => s.provider));
    const failed = uniq(providerStatus.filter(s => !s.ok).map(s => s.provider)).filter(n => !okNames.includes(n) || true)
      .map(n => ({ provider: n, error: (providerStatus.find(s => s.provider === n && !s.ok) || {}).error || 'provider_error' }))
      .filter(f => !providerStatus.some(s => s.provider === f.provider && s.ok));
    const limitations = [];
    if (!all.length) limitations.push('Aucun fournisseur de recherche n’est configuré.');
    else if (!ranked.length) limitations.push('Aucun fournisseur n’a renvoyé de résultat exploitable.');
    for (const f of failed) limitations.push(`Fournisseur « ${f.provider} » en échec (${f.error}) : il n’a PAS été interrogé avec succès.`);
    return {
      query: q, mode: opts.mode || 'deep', plan, queries, strategy, searchedAt: new Date().toISOString(),
      providersConfigured: all.map(p => p.name || 'provider'), providersQueried: okNames, providersFailed: failed,
      providerStatus, sources: ranked, limitations,
      status: !all.length ? 'no_provider' : (ranked.length ? 'results' : 'no_results')
    };
  }

  // ---------- ouverture d'une page ----------
  async function open(url, opts = {}) {
    const openPage = opts.openPage || defaultOpenPage;
    if (!openPage) throw new NetError('OPEN_UNAVAILABLE', 'Aucun extracteur de page n’est configuré.', { status: 503 });
    const checked = validatePublicHttpUrl(url);
    const raw = await timed(Promise.resolve(openPage(checked.toString(), opts)), bounded(opts.pageTimeoutMs, timeoutMs, 500, 60000), opts.signal);
    const page = normalizePage(raw, checked.toString());
    if (!page.url) throw new NetError('FINAL_URL_BLOCKED', 'L’URL finale après redirection n’est pas autorisée.', { status: 403 });
    if (!isUsableText(page.text)) throw new NetError('EMPTY_CONTENT', 'Contenu vide ou inutilisable (page dynamique, protégée ou sans texte).', { status: 422 });
    return { ...page, opened: true };
  }

  // ---------- pipeline complet : chercher -> classer -> OUVRIR -> extraire -> recouper ----------
  async function research(query, opts = {}) {
    const t0 = Date.now();
    const mode = opts.mode === 'fast' ? 'fast' : 'deep';
    const q = cleanQuery(query);
    if (!q) throw new NetError('EMPTY_QUERY', 'La requête de recherche est vide.', { status: 400 });
    const now = opts.now || new Date();
    const plan = planResearch(q, { mode, maxQueries, now });
    const budgetMs = bounded(opts.budgetMs, mode === 'fast' ? 12000 : 30000, 2000, 120000);
    const deadline = t0 + budgetMs;
    const target = opts.openTop === undefined || opts.openTop === null
      ? (mode === 'fast' ? (plan.complexity === 'simple' ? 1 : 2) : plan.openTarget)
      : bounded(opts.openTop, 0, 0, 6);
    const pageTimeoutMs = bounded(opts.pageTimeoutMs, mode === 'fast' ? 5000 : 9000, 500, 60000);
    const openPage = opts.openPage || defaultOpenPage;

    const first = await search(q, { ...opts, mode, plan, now });
    let sources = first.sources.map(s => ({ ...s, opened: false }));
    const providerStatus = [...first.providerStatus];
    const limitations = [...first.limitations];
    const attempted = new Set();
    const openErrors = [];
    const openedRecords = [];
    const texts = new Map();           // url -> texte complet (interne, sert au recoupement)

    const openWave = async (cands, want) => {
      if (!openPage || want <= 0) return;
      let pool = diversify(cands.filter(c => !attempted.has(c.url)), 1);
      let guard = 0;
      while (openedRecords.length < want && pool.length && guard++ < 3 && Date.now() < deadline) {
        const need = want - openedRecords.length;
        const batch = pool.splice(0, need);
        batch.forEach(c => attempted.add(c.url));
        const outcomes = await Promise.all(batch.map(async c => {
          try {
            const page = await open(c.url, { ...opts, openPage, pageTimeoutMs, signal: opts.signal });
            return { c, page };
          } catch (e) { return { c, error: safeError(e) }; }
        }));
        for (const o of outcomes) {
          if (o.error) { openErrors.push({ url: o.c.url, domain: o.c.domain, provider: o.c.provider, error: o.error }); continue; }
          const retrievedAt = o.page.retrievedAt || new Date().toISOString();
          const domain = hostOf(o.page.url) || o.c.domain;
          const rec = {
            title: o.page.title || o.c.title, url: o.page.url, requested_url: o.c.url, domain, provider: o.c.provider, engines: o.c.engines || [o.c.provider],
            published_at: o.page.publishedAt || o.c.publishedAt || null, retrieved_at: retrievedAt, author: o.page.author || null,
            extracted_content: extractRelevantExcerpt(o.page.text, q, bounded(opts.excerptChars, mode === 'fast' ? 900 : 1400, 200, 6000)),
            opened: true, reliability: classifySource(domain), page_id: o.page.id || null, snippet: o.c.snippet || '',
            ...(o.page.warnings && o.page.warnings.length ? { warnings: o.page.warnings } : {}), ...(o.page.truncated ? { page_truncated: true } : {})
          };
          openedRecords.push(rec);
          texts.set(rec.url, o.page.text);
        }
      }
    };

    if (!openPage && target > 0) limitations.push('Aucun extracteur de page configuré : aucune page n’a été ouverte.');
    await openWave(sources, target);

    let cross = crossCheck(openedRecords, texts, q);
    let refined = false; const refineReasons = [];
    if (mode === 'deep' && openPage && sources.length && Date.now() < t0 + budgetMs * 0.6) {
      if (openedRecords.length < Math.min(2, target)) refineReasons.push('peu de pages ouvertes');
      if (plan.needsRecent && !openedRecords.some(r => freshnessOf(r.published_at, now) === 'recent')) refineReasons.push('aucune source récente confirmée');
      if (cross.contradictions.length) refineReasons.push('contradiction détectée entre sources');
      if (refineReasons.length) {
        refined = true;
        const followUps = plan.refineQueries.filter(x => !first.queries.includes(x)).slice(0, 2);
        if (followUps.length) {
          const second = await search(q, { ...opts, mode: 'deep', plan: { ...plan, queries: followUps }, followUpQueries: followUps, now, maxResults: 6 });
          providerStatus.push(...second.providerStatus.map(s => ({ ...s, refine: true })));
          const have = new Set(sources.map(s => s.url));
          const fresh = second.sources.filter(s => !have.has(s.url)).map(s => ({ ...s, opened: false }));
          sources = dedupe([...sources, ...fresh]);
          await openWave(fresh.length ? fresh : sources, Math.min(openedRecords.length + 2, 6));
          cross = crossCheck(openedRecords, texts, q);
        }
      }
    }

    // statut de vérification par source ouverte
    const inSet = (arr, url) => arr.some(x => (x.sources || x.claims?.map(c => c.source) || []).includes(url));
    for (const r of openedRecords) {
      r.verification_status = inSet(cross.contradictions, r.url) ? 'contradicted' : inSet(cross.corroborations, r.url) ? 'corroborated' : 'not_cross_checked';
      r.freshness = freshnessOf(r.published_at, now);
    }
    // état final des sources (opened vrai uniquement pour les pages réellement lues)
    const openedUrls = new Map(openedRecords.map(r => [normKey(r.requested_url), r]));
    const finalSources = sources.map(s => {
      const rec = openedUrls.get(normKey(s.url));
      if (rec) return { ...s, ...rec };
      const err = openErrors.find(e => normKey(e.url) === normKey(s.url));
      return { ...s, published_at: s.publishedAt || null, retrieved_at: s.retrievedAt, author: null, extracted_content: null, opened: false, reliability: classifySource(s.domain), verification_status: 'unverified_snippet_only', ...(err ? { open_error: err.error } : {}) };
    });
    const notOpened = finalSources.filter(s => !s.opened);
    const okProviders = uniq(providerStatus.filter(s => s.ok).map(s => s.provider));
    const failed = uniq(providerStatus.filter(s => !s.ok).map(s => s.provider)).filter(n => !okProviders.includes(n))
      .map(n => ({ provider: n, error: (providerStatus.find(s => s.provider === n && !s.ok) || {}).error || 'provider_error' }));

    if (openErrors.length) limitations.push(`${openErrors.length} page(s) inaccessible(s) ou inexploitable(s) : ${openErrors.slice(0, 4).map(e => `${e.domain || e.url} (${e.error})`).join(' ; ')}.`);
    if (finalSources.length && !openedRecords.length && openPage && target > 0) limitations.push('AUCUNE page n’a pu être ouverte : toute information ci-dessous repose uniquement sur des extraits de moteurs de recherche, non vérifiés.');
    if (target === 0 && finalSources.length) limitations.push('Lecture des pages désactivée pour cette requête : seuls des extraits de moteurs sont disponibles.');
    if (cross.contradictions.length) limitations.push('Des valeurs divergentes ont été détectées entre sources (détection heuristique) : voir « contradictions ».');
    const stale = openedRecords.filter(r => plan.needsRecent && r.freshness === 'dated');
    if (stale.length) limitations.push(`${stale.length} source(s) ouverte(s) semblent anciennes alors que la question demande des informations récentes.`);
    if (openedRecords.length === 1) limitations.push('Une seule page ouverte : information non recoupée par une seconde source indépendante.');
    const noDate = openedRecords.filter(r => !r.published_at).length;
    if (noDate) limitations.push(`${noDate} page(s) ouverte(s) sans date de publication fiable.`);

    const status = !first.providersConfigured.length ? 'no_provider' : !finalSources.length ? 'no_results' : openedRecords.length ? (openedRecords.length >= Math.min(target, 2) || target === 1 ? 'ok' : 'partial') : (target === 0 ? 'results_only' : 'no_pages_opened');
    return {
      query: q, mode, plan: { complexity: plan.complexity, topics: plan.topics, queries: first.queries, needsRecent: plan.needsRecent, refined, refineReasons },
      searchedAt: first.searchedAt, providersConfigured: first.providersConfigured, providersQueried: okProviders, providersFailed: failed, providerStatus,
      sources: finalSources, opened: openedRecords, notOpened, openErrors, openedCount: openedRecords.length, targetOpen: target,
      facts: extractEvidence(finalSources), corroborations: cross.corroborations, contradictions: cross.contradictions,
      limitations, status, elapsedMs: Date.now() - t0
    };
  }

  return { search, research, open, getProviders: () => getProviders().map(p => p.name || 'provider'), clearCache: () => cache.clear(), providers: getProviders().map(p => p.name || 'provider') };
}

// ---------------------------------------------------------------------------------------------
// Planification (profondeur adaptée à la question) — heuristique locale, sans appel réseau ni LLM
// ---------------------------------------------------------------------------------------------
// Les regex s'appliquent au texte SANS accents (norm) : \b ne fonctionne pas avec « é » en JavaScript.
const RE_RECENT = /\b(dernier|derniere|dernieres|derniers|recent|recente|recents|recentes|aujourd'?hui|actuel|actuelle|actuellement|en ce moment|maintenant|cette semaine|ce mois|nouveau|nouvelle|nouveautes?|actualites?|breaking|latest|current|currently|today|this week|this month|news|20(2[4-9]|3\d))\b/;
const RE_NEWS = /\b(actualites?|news|breaking|dernieres? (?:nouvelles|infos?|informations?)|aujourd'?hui|cette semaine|hier|elections?|guerre|accord|sommet|annonce[rd]?)\b/;
const RE_ACADEMIC = /\b(etudes?|recherches?|scientifiques?|science|article|papers?|publications?|arxiv|doi|journal|revue|meta-?analyses?|clinique|essais? cliniques?|peer[- ]review|preuves?|evidence|these)\b/;
const RE_OFFICIAL = /\b(officiel|officielle|loi|decret|reglement|reglementation|gouvernement|ministere|rapport|statistiques?|oms|onu|banque mondiale|fmi|official|regulation|law|government|report|statistics)\b/;
const RE_TECH = /\b(code|bug|erreur|error|exception|stack ?overflow|github|npm|pip|python|javascript|typescript|nodejs|node\.js|react|vue|api|sql|docker|linux|kubernetes|framework|librairie|library|bibliotheque|compiler|regex|css|html|rust|golang|php|android|flutter|firebase|programmation|programming|open ?source)\b/;
const RE_COMPARE = /\b(vs\.?|versus|comparer|comparaison|compare|differences?|mieux que|plutot que|difference between)\b/;
const RE_VERIFY = /\b(verifier|verifie|verification|est-ce vrai|vrai ou faux|fiable|controversee?|contradiction|fake|rumeur|fact-?check|confirmer|confirme|confirmation)\b/;

function planResearch(query, opts = {}) {
  const q = cleanQuery(query);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const maxQ = bounded(opts.maxQueries, 4, 1, 10);
  const nq = norm(q);
  const words = q.split(/\s+/).filter(Boolean);
  const questionMarks = (q.match(/\?/g) || []).length;
  let score = 0;
  if (words.length > 14) score += 1;
  if (words.length > 28) score += 1;
  if (questionMarks > 1 || /\b(et aussi|ainsi que|d'une part|puis|and also)\b/.test(nq)) score += 1;
  if (RE_COMPARE.test(nq)) score += 2;
  if (RE_VERIFY.test(nq)) score += 2;
  if (RE_ACADEMIC.test(nq)) score += 1;
  if (RE_OFFICIAL.test(nq) && RE_RECENT.test(nq)) score += 1;
  const complexity = score >= 3 ? 'complex' : score >= 1 ? 'moderate' : 'simple';
  const needsRecent = RE_RECENT.test(nq);
  const topics = ['general'];
  if (RE_NEWS.test(nq)) topics.push('news');
  if (RE_ACADEMIC.test(nq)) topics.push('academic');
  if (RE_OFFICIAL.test(nq)) topics.push('official');
  if (RE_TECH.test(nq)) topics.push('tech');

  // décomposition en sous-requêtes (comparaison, questions multiples) + variantes ciblées
  const queries = [q];
  const cmp = q.match(/(?:diff[ée]rences? entre|compar(?:er|aison (?:entre|de)))\s+(.+?)\s+(?:et|and|vs\.?|versus|avec)\s+(.+?)[?.!]*$/i) || q.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)[?.!]*$/i);
  if (cmp) { queries.push(cleanQuery(cmp[1]), cleanQuery(cmp[2])); }
  if (questionMarks > 1) q.split('?').map(s => cleanQuery(s)).filter(s => s.split(' ').length >= 3).forEach(s => queries.push(s));
  if (topics.includes('academic')) queries.push(`${q} étude scientifique publication`);
  if (topics.includes('official')) queries.push(`${q} source officielle rapport`);
  if (needsRecent && !/20\d\d/.test(q)) queries.push(`${q} ${now.getUTCFullYear()}`);
  if (complexity === 'complex' && queries.length < 3) queries.push(`${q} analyse`);

  const refineQueries = uniq([
    `${q} source officielle`, needsRecent ? `${q} ${now.getUTCFullYear()} dernières informations` : `${q} explication détaillée`,
    RE_VERIFY.test(nq) || RE_COMPARE.test(nq) ? `${q} vérification sources indépendantes` : `${q} étude`
  ]);
  const openTarget = complexity === 'complex' ? 5 : complexity === 'moderate' ? 4 : 3;
  return { complexity, needsRecent, topics: uniq(topics), queries: uniq(queries).slice(0, maxQ), refineQueries, openTarget };
}

/** Exécute les fournisseurs en « relais couvert » : démarre le suivant si le courant échoue, répond vide, ou dépasse hedgeMs. S'arrête au premier résultat non vide. */
async function hedgedFallback(selected, run, hedgeMs, signal) {
  const finished = []; const inflight = new Set(); let started = 0;
  if (!selected.length) return finished;
  const start = () => { const t = run(selected[started++]).then(r => { finished.push(r); inflight.delete(t); return r; }); inflight.add(t); };
  start();
  for (;;) {
    if (signal?.aborted) throw new NetError('ABORTED', 'Recherche annulée.', { status: 499 });
    const waiters = [...inflight]; let timer = null;
    if (started < selected.length && hedgeMs > 0) waiters.push(new Promise(res => { timer = setTimeout(() => res(null), hedgeMs); }));
    const got = await Promise.race(waiters);
    clearTimeout(timer);
    if (got === null) { start(); continue; }
    if (got.ok && got.results.length) break;
    if (!inflight.size) { if (started < selected.length) start(); else break; }
  }
  return finished;
}

function pickProviders(all, { strategy, topics }) {
  // `priority` (plus petit = d'abord ; défaut 50) : en mode rapide, les moteurs fiables passent avant ceux qu'un serveur se fait souvent bloquer
  const byPriority = (a, b) => (Number.isFinite(a.priority) ? a.priority : 50) - (Number.isFinite(b.priority) ? b.priority : 50);
  const general = all.filter(p => !Array.isArray(p.topics) || p.topics.includes('general')).sort(byPriority);
  const topical = all.filter(p => Array.isArray(p.topics) && !p.topics.includes('general') && p.topics.some(t => topics.includes(t))).sort(byPriority);
  return strategy === 'fallback' ? [...topical.filter(p => p.topics.includes('news') && topics.includes('news')), ...general] : [...general, ...topical];
}

// ---------------------------------------------------------------------------------------------
// Classement des sources — RÉPUTATION DU DOMAINE ≠ PREUVE DE VÉRACITÉ
// ---------------------------------------------------------------------------------------------
const OFFICIAL_RE = /(^|\.)(gov|mil|edu|int)$|(^|\.)(gov|gouv|gob|go)\.[a-z]{2}$|(^|\.)(ac|edu)\.[a-z]{2}$|(^|\.)(europa\.eu|who\.int|un\.org|worldbank\.org|imf\.org|oecd\.org|nih\.gov|nasa\.gov|ietf\.org|w3\.org|iso\.org|unesco\.org|unicef\.org|wto\.org)$/i;
const SCIENTIFIC_RE = /(^|\.)(arxiv\.org|doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|link\.springer\.com|wiley\.com|plos\.org|cell\.com|thelancet\.com|nejm\.org|bmj\.com|jamanetwork\.com|ieee\.org|acm\.org|jstor\.org|biorxiv\.org|medrxiv\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|openalex\.org|crossref\.org|hal\.science|cairn\.info|semanticscholar\.org|researchgate\.net)$/i;
const REFERENCE_RE = /(^|\.)(wikipedia\.org|wikidata\.org|britannica\.com|developer\.mozilla\.org|rfc-editor\.org)$/i;
const MEDIA_RE = /(^|\.)(reuters\.com|apnews\.com|afp\.com|bbc\.com|bbc\.co\.uk|lemonde\.fr|lefigaro\.fr|liberation\.fr|france24\.com|rfi\.fr|theguardian\.com|nytimes\.com|washingtonpost\.com|wsj\.com|ft\.com|bloomberg\.com|economist\.com|aljazeera\.com|dw\.com|euronews\.com|lesechos\.fr|jeuneafrique\.com|radiookapi\.net|actualite\.cd|cnn\.com|npr\.org|lapresse\.ca|rts\.ch|tv5monde\.com|lexpress\.fr|lepoint\.fr)$/i;
const NOTE = 'classification par NOM DE DOMAINE : elle aide à pondérer, elle ne prouve pas que le contenu de la page est exact';
function classifySource(domain) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (OFFICIAL_RE.test(d)) return { tier: 'official', label: 'Source officielle', why: `domaine institutionnel/gouvernemental/intergouvernemental ; source primaire probable, à confirmer sur la page (${NOTE})` };
  if (SCIENTIFIC_RE.test(d)) return { tier: 'scientific', label: 'Source scientifique', why: `éditeur, dépôt ou index scientifique ; vérifier la revue, la relecture par les pairs et les sources citées (${NOTE})` };
  if (REFERENCE_RE.test(d)) return { tier: 'reference', label: 'Publication de référence', why: `ouvrage de référence collaboratif ou éditorial ; source secondaire, vérifier les références citées (${NOTE})` };
  if (MEDIA_RE.test(d)) return { tier: 'media', label: 'Média reconnu', why: `média établi ; ligne éditoriale et erreurs possibles (${NOTE})` };
  return { tier: 'unverified', label: 'Source non vérifiée', why: 'domaine non classé : aucune garantie d’indépendance, d’exactitude ni de mise à jour' };
}
const TIER_BONUS = { official: 0.012, scientific: 0.010, reference: 0.006, media: 0.005, unverified: 0 };
const REDIRECTOR_RE = /(^|\.)(news\.google\.com|t\.co|bit\.ly|facebook\.com|x\.com|twitter\.com|instagram\.com|tiktok\.com|pinterest\.[a-z.]+)$/i;

function rankSources(rows, plan, nowInput) {
  const now = nowInput instanceof Date ? nowInput : new Date();
  const terms = queryTerms(plan?.queries?.[0] || '');
  const scored = rows.map((r, i) => {
    let s = (r.ranks || [i]).reduce((a, rk) => a + 1 / (60 + rk), 0);
    s += TIER_BONUS[classifySource(r.domain).tier] || 0;
    if (terms.length) { const hay = norm(`${r.title} ${r.snippet}`); s += 0.02 * (terms.filter(t => hay.includes(t)).length / terms.length); }
    if (plan?.needsRecent && freshnessOf(r.publishedAt, now) === 'recent') s += 0.01;
    if (REDIRECTOR_RE.test(r.domain)) s -= 0.02;
    return { r, s };
  });
  return scored.sort((a, b) => b.s - a.s).map(x => x.r);
}
function diversify(rows, perDomain = 1) {
  const count = new Map(); const first = []; const rest = [];
  for (const r of rows) { const k = registrable(r.domain); const n = count.get(k) || 0; count.set(k, n + 1); (n < perDomain ? first : rest).push(r); }
  return [...first, ...rest];
}
function registrable(host) { const p = String(host || '').toLowerCase().split('.'); if (p.length <= 2) return p.join('.'); const sl = ['co', 'com', 'org', 'gov', 'ac', 'net'].includes(p[p.length - 2]) && p[p.length - 1].length === 2; return p.slice(sl ? -3 : -2).join('.'); }

// ---------------------------------------------------------------------------------------------
// Extraction : passages pertinents, preuves, recoupement
// ---------------------------------------------------------------------------------------------
const STOP = new Set('le la les un une des de du d l et ou en au aux à a ce ces cet cette son sa ses que qui quoi dont où pour par sur sous dans avec sans est sont être été fait faire plus moins très comme mais donc car ne pas se si il elle ils elles on nous vous je tu the a an of to in on for and or is are was were be been with by from at as that this it its what which who how why when where quelle quel quels quelles quand comment pourquoi combien cherche recherche trouve donne moi'.split(' '));
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function queryTerms(q) { return uniq(norm(q).split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t))); }

function extractRelevantExcerpt(text, query, maxChars = 1200) {
  const t = String(text || '').replace(/[ \t\u00a0]+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  const terms = queryTerms(query);
  const units = t.split(/\n+/).flatMap(p => (p.length > 500 ? (p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [p]) : [p])).map(s => s.trim()).filter(s => s.length >= 30);
  if (!units.length) return t.slice(0, maxChars);
  const scored = units.map((u, i) => { const n = norm(u); const hits = terms.filter(x => n.includes(x)).length; return { i, u, s: hits * 2 + (/\d/.test(u) ? 0.5 : 0) + (i === 0 ? 0.5 : 0) }; });
  const picked = []; let used = 0;
  for (const c of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (c.s <= 0.5 && picked.length) break;
    const room = maxChars - used; if (room < 60) break;
    const piece = c.u.length > room ? c.u.slice(0, room) : c.u;
    picked.push({ i: c.i, u: piece }); used += piece.length + 3;
  }
  if (!picked.length) return t.slice(0, maxChars);
  picked.sort((a, b) => a.i - b.i);
  let out = ''; let prev = -2;
  for (const p of picked) { out += (out ? (p.i === prev + 1 ? ' ' : ' […] ') : '') + p.u; prev = p.i; }
  return out.slice(0, maxChars);
}

function extractEvidence(sources) {
  return (sources || []).filter(s => s.extracted_content || s.snippet).map(s => ({
    claim: String(s.extracted_content || s.snippet).slice(0, 500), source: s.url, title: s.title,
    publishedAt: s.published_at || s.publishedAt || null,
    confidence: s.opened ? 'page_opened' : 'snippet_only_not_verified'
  }));
}

const NUM_RE = /(\d{1,3}(?:[ \u00a0.]\d{3})+|\d+)(?:[,.](\d+))?\s*(%|pour cent|milliards?|billions?|millions?|mille|k\b|km|kg|m²|€|\$|usd|eur|°c|dollars?|euros?)/gi;
function extractClaims(text) {
  const out = []; const s = String(text || '').slice(0, 60000); let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s)) && out.length < 400) {
    const intPart = m[1].replace(/[ \u00a0.]/g, ''); const val = parseFloat(`${intPart}${m[2] ? '.' + m[2] : ''}`);
    if (!Number.isFinite(val)) continue;
    let unit = norm(m[3]).replace(/s$/, ''); if (unit === 'pour cent') unit = '%'; if (unit === 'euro' || unit === 'eur') unit = '€'; if (unit === 'dollar' || unit === 'usd') unit = '$';
    const mag = { milliard: 1e9, billion: 1e9, million: 1e6, mille: 1e3, k: 1e3 }[unit]; const value = mag ? val * mag : val; const u = mag ? 'n' : unit;
    const before = s.slice(Math.max(0, m.index - 90), m.index); const after = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const ctx = uniq(norm(`${before} ${after}`).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(w => w.replace(/s$/, '')));
    if (ctx.length >= 2) out.push({ value, unit: u, raw: m[0].trim(), ctx });
  }
  return out;
}
/** Recoupement HEURISTIQUE de valeurs chiffrées entre pages de domaines différents. Aucune conclusion de véracité. */
function crossCheck(openedRecords, texts, query) {
  const qt = new Set(queryTerms(query).map(w => w.replace(/s$/, '')));
  const per = openedRecords.map(r => ({ url: r.url, domain: registrable(r.domain), claims: extractClaims(texts.get(r.url) || r.extracted_content || '') }));
  const corroborations = []; const contradictions = []; const seen = new Set();
  for (let i = 0; i < per.length; i++) for (let j = i + 1; j < per.length; j++) {
    if (per[i].domain === per[j].domain) continue;       // deux pages d'un même site ne sont pas indépendantes
    for (const a of per[i].claims) for (const b of per[j].claims) {
      if (a.unit !== b.unit) continue;
      const shared = a.ctx.filter(w => b.ctx.includes(w));
      if (shared.length < 2 || !shared.some(w => qt.has(w))) continue;
      const rel = Math.abs(a.value - b.value) / Math.max(Math.abs(a.value), Math.abs(b.value), 1e-9);
      const key = `${i}-${j}-${shared.slice(0, 3).join('.')}-${a.unit}`;
      if (seen.has(key)) continue; seen.add(key);
      if (rel <= 0.02 && corroborations.length < 5) corroborations.push({ type: 'same_value', confidence: 'heuristic', value: a.raw, context: shared.slice(0, 5), sources: [per[i].url, per[j].url] });
      else if (rel > 0.05 && contradictions.length < 5) contradictions.push({ type: 'numeric_discrepancy', confidence: 'heuristic', context: shared.slice(0, 5), claims: [{ source: per[i].url, raw: a.raw }, { source: per[j].url, raw: b.raw }], note: 'Valeurs différentes pour un contexte voisin (détection automatique) : vérifier dans les pages s’il s’agit bien de la même grandeur, de la même date et de la même définition.' });
    }
  }
  return { corroborations, contradictions };
}
/** Compatibilité : ancienne API. Ne signale plus de « conflit » sans élément de preuve. */
function findContradictions(sources, texts) { return crossCheck((sources || []).filter(s => s.opened), texts || new Map(), '').contradictions; }

function freshnessOf(published, nowInput) {
  if (!published) return 'unknown';
  const t = Date.parse(published); if (!Number.isFinite(t)) return 'unknown';
  const age = ((nowInput instanceof Date ? nowInput : new Date()).getTime() - t) / DAY;
  return age <= 90 ? 'recent' : age <= 730 ? 'moderate' : 'dated';
}

// ---------------------------------------------------------------------------------------------
// Rendu lisible : Sources consultées / supplémentaires / fiabilité (numérotation = champ `cite` ou rang)
// ---------------------------------------------------------------------------------------------
function renderSourcesMarkdown(r) {
  const L = []; const esc = t => String(t || '').replace(/[\[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  const link = u => String(u).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
  const d = v => (v ? String(v).slice(0, 10) : 'non disponible');
  L.push('**Sources consultées** (pages réellement ouvertes)');
  if (!r.opened?.length) L.push('Aucune page n’a pu être ouverte.');
  (r.opened || []).forEach((s, i) => L.push(`[${s.cite || i + 1}] [${esc(s.title) || s.domain}](${link(s.url)}) — ${s.domain} — publiée : ${d(s.published_at)} — consultée : ${d(s.retrieved_at)} — ${s.reliability?.label || 'non classée'}`));
  const extra = (r.notOpened || []).slice(0, 8);
  if (extra.length) { L.push('', '**Sources supplémentaires** (trouvées, NON ouvertes)'); extra.forEach(s => L.push(`- [${esc(s.title) || s.domain}](${link(s.url)}) — ${s.domain}${s.open_error ? ` — ouverture impossible (${s.open_error})` : ''}`)); }
  if (r.limitations?.length || r.contradictions?.length) {
    L.push('', '**Fiabilité**'); (r.limitations || []).forEach(x => L.push(`- ${x}`));
    (r.contradictions || []).forEach(c => L.push(`- Contradiction possible (${c.context.join(', ')}) : ${c.claims.map(k => `${k.raw} (${k.source})`).join(' ≠ ')}`));
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Normalisation, URL, sécurité (pré-filtre — la connexion reste protégée par index.js)
// ---------------------------------------------------------------------------------------------
function normalizeResults(raw, provider, query) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.sources) ? raw.sources : [];
  return rows.map((r, idx) => {
    if (!r || typeof r !== 'object') return null;
    let url; try { url = cleanUrl(validatePublicHttpUrl(r.url || r.link || r.href).toString()); } catch { return null; }
    if (!url) return null;
    const title = String(r.title || r.name || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) return null;
    return { title, url, domain: new URL(url).hostname.toLowerCase().replace(/^www\./, ''), snippet: String(r.snippet || r.content || r.description || r.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1200), publishedAt: normalizeDate(r.publishedAt || r.publishedDate || r.published_at || r.date || r.published_date || r.seendate || r.page_age), author: r.author ? String(r.author).slice(0, 120) : null, provider, engines: [provider], ranks: [idx], query, retrievedAt: new Date().toISOString() };
  }).filter(Boolean);
}
function normalizePage(page, fallbackUrl) {
  return {
    url: safeUrl(page?.url || fallbackUrl), title: String(page?.title || '').replace(/\s+/g, ' ').slice(0, 300),
    text: String(page?.text || page?.content || '').slice(0, 60000), publishedAt: normalizeDate(page?.publishedAt || page?.date),
    author: page?.author ? String(page.author).slice(0, 120) : null, id: page?.id || null, retrievedAt: page?.retrievedAt || null,
    warnings: Array.isArray(page?.warnings) ? page.warnings : [], truncated: Boolean(page?.truncated)
  };
}
function isUsableText(t) { return String(t || '').replace(/\s+/g, ' ').trim().length >= MIN_PAGE_TEXT; }

function validatePublicHttpUrl(value) {
  let u; try { u = new URL(String(value)); } catch { throw new NetError('INVALID_URL', 'URL invalide.', { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new NetError('URL_NOT_ALLOWED', 'Seules les URL HTTP(S) publiques sont autorisées.', { status: 400 });
  if ((u.port && !['80', '443'].includes(u.port)) || (u.protocol === 'http:' && u.port === '443') || (u.protocol === 'https:' && u.port === '80')) throw new NetError('URL_NOT_ALLOWED', 'Port réseau non standard interdit.', { status: 403 });
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|localdomain|lan|home)$/.test(h) || h === 'metadata.google.internal' || h === 'metadata'
    || (!isIp && !h.includes('.')) || isPrivateV4(h) || isPrivateV6(h)) throw new NetError('PRIVATE_URL_BLOCKED', 'Les adresses locales, privées et de métadonnées sont interdites.', { status: 403 });
  return u;
}
function isPrivateV4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); if (!m) return false;
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4]; if ([a, b, c, d].some(n => n > 255)) return true;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(h) {
  if (!h.includes(':')) return false;
  return h === '::' || h === '::1' || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h) || /^ff/i.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b') || h.startsWith('2001:db8') || !/^[0-9a-f:.]+$/i.test(h);
}
/** Résout une URL (relative, protocole-relative, avec <base>) en URL http(s) absolue sans ancre ; null sinon. */
function resolveUrl(href, base) {
  try { const u = new URL(String(href || '').trim(), base); if (!/^https?:$/.test(u.protocol)) return null; u.hash = ''; return u.href; } catch { return null; }
}
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = canonicalUrl(r.url); if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...r, engines: [...(r.engines || [r.provider])], ranks: [...(r.ranks || [])] }); continue; }
    prev.engines = uniq([...prev.engines, ...(r.engines || [r.provider])]); prev.ranks.push(...(r.ranks || []));
    if (String(r.snippet || '').length > String(prev.snippet || '').length) prev.snippet = r.snippet;
    if (!prev.publishedAt && r.publishedAt) prev.publishedAt = r.publishedAt;
    if (!prev.author && r.author) prev.author = r.author;
  }
  return [...byKey.values()];
}
/** URL à OUVRIR : on retire ancre et paramètres de suivi, mais on garde l'hôte tel quel (www. inclus) et le chemin exact. */
function cleanUrl(v) { try { const u = new URL(v); u.hash = ''; u.hostname = u.hostname.toLowerCase(); if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) u.searchParams.delete(k); let out = u.toString(); if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, ''); return out; } catch { return null; } }
/** Clé de DÉDUPLICATION uniquement (sans www., sans slash final) : jamais utilisée pour télécharger. */
function canonicalUrl(v) { try { const u = new URL(v); u.hash = ''; u.hostname = u.hostname.toLowerCase().replace(/^www\./, ''); if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) u.searchParams.delete(k); return u.toString().replace(/\/$/, ''); } catch { return null; } }
const normKey = v => canonicalUrl(v) || String(v || '');
function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function normalizeDate(v) {
  if (!v) return null; let s = String(v).trim();
  const g = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); if (g) s = `${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6]}Z`;
  const t = Date.parse(s); if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear(); if (y < 1990 || t > Date.now() + DAY) return null;
  return new Date(t).toISOString();
}
function cleanQuery(q) { return String(q || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400); }
function safeError(e) { return String(e?.code || e?.message || 'provider_error').replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{8,}|BSA[A-Za-z0-9_-]{16,})/g, '[REDACTED]').replace(/api[_-]?key=[^&\s]+/gi, 'api_key=[REDACTED]').slice(0, 180); }
function safeUrl(v) { try { return validatePublicHttpUrl(v).toString(); } catch { return ''; } }
function bounded(v, fallback, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function uniq(a) { return [...new Set(a)]; }
function trimCache(m, max) { while (m.size > max) m.delete(m.keys().next().value); }
function timed(promise, ms, signal) { return new Promise((resolve, reject) => { let done = false; const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(v); }; const timer = setTimeout(() => finish(reject, new NetError('TIMEOUT', 'La source web a dépassé son délai.', { status: 504 })), ms); const abort = () => finish(reject, new NetError('ABORTED', 'Opération annulée.', { status: 499 })); if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e)); }); }

module.exports = {
  createLubaNet, NetError, planResearch, classifySource, rankSources, diversify, registrable, extractRelevantExcerpt, extractEvidence, extractClaims, crossCheck, findContradictions,
  freshnessOf, renderSourcesMarkdown, normalizeResults, normalizePage, isUsableText, validatePublicHttpUrl, resolveUrl, dedupe, canonicalUrl, cleanUrl, normalizeDate, queryTerms, MIN_PAGE_TEXT
};
