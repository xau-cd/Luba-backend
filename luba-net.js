'use strict';
/**
 * luba-net.js — adaptateur d'intégration entre l'orchestrateur (index.js) et le cœur de recherche (net.js).
 * Il n'ajoute AUCUNE logique de recherche concurrente : il assemble les fournisseurs (moteurs d'index.js +
 * sources spécialisées de free-sources.js) et l'extracteur de pages (loadPage d'index.js, protégé contre le SSRF),
 * puis délègue tout à net.js (planification, déduplication, classement, ouverture réelle, recoupement).
 *
 * Rétro-compatible : `require('./luba-net.js')` expose toujours l'API de net.js.
 */
const core = require('./net.js');

/** Transforme une fonction `(q, n) => Promise<résultats>` en fournisseur net.js. `topics` : general | news | academic | official. */
function wrapEngine(name, fn, { topics = ['general'], priority } = {}) {
  return { name, topics, priority, search: async (q, o = {}) => {
    const out = await fn(q, o.maxResults || 6);
    const rows = Array.isArray(out) ? out : out?.results;
    if (!Array.isArray(rows)) throw new Error('réponse fournisseur invalide');
    if (!rows.length && out?.error) throw new Error(out.error);     // « 0 résultat + erreur » = échec, pas une réponse vide
    return rows;
  } };
}

/**
 * @param {object} deps
 * @param {Function|Array} deps.engines  fournisseurs d'index.js (ou fonction qui les renvoie à chaque appel : la configuration .env peut changer)
 * @param {object} [deps.freeSources]    module free-sources.js (fournit webProviders() : Google News, OpenAlex, Crossref, arXiv)
 * @param {Function} [deps.openPage]     (url, opts) => page ; par défaut fournie à chaque appel de research()
 */
function createWebResearch(deps = {}) {
  const { engines, freeSources, openPage, ...opts } = deps;
  const providers = () => [
    ...((typeof engines === 'function' ? engines() : engines) || []),
    ...(freeSources && typeof freeSources.webProviders === 'function' ? freeSources.webProviders() : [])
  ];
  return core.createLubaNet({ ...opts, providers, openPage });
}

module.exports = { ...core, wrapEngine, createWebResearch };
