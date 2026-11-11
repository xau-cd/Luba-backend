# Correctif Web Research Engine (Luba / milo-backend)

## Architecture (une seule)
- `web_fast`, `web_slow`, `web_open`, `web_click` = **outils internes d'index.js (§11b)**, pas des fichiers. Aucun faux fichier créé.
- `net.js` = cœur unique : planification, fournisseurs, normalisation, déduplication, classement, ouverture réelle, extraction, recoupement.
- `luba-net.js` = adaptateur (était un simple `require('./net.js')`) : assemble moteurs d'index.js + sources de free-sources.js.
- `free-sources.js` = ajoute `webProviders()` (Google News, OpenAlex, Crossref, arXiv). GDELT reste dans index.js et est branché comme fournisseur « actualités ».
- SSRF : `assertPublicUrl` / `safeLookup` / redirections revalidées d'index.js inchangés ; net.js ajoute un pré-filtre au moins aussi strict.

## Corrections principales
1. `opened` vrai **uniquement** après téléchargement + texte exploitable (≥ 80 car.). Page vide, mur anti-bot, HTTP ≥ 400, redirection finale interdite → `opened:false` + `open_error`, et remplacement par la source suivante.
2. `web_fast` ouvre maintenant les 1-2 meilleures pages (param `read`, 0 = liens seuls). `web_slow` : plusieurs requêtes (`queries`), plusieurs moteurs selon le sujet (actualités / science), 3-5 pages de domaines distincts, recoupement, seconde recherche si peu de pages / pas de source récente / contradiction.
3. Les résultats trouvés mais non lus ne sont plus présentés comme « Sources » : `sources` = pages ouvertes ; `additional_sources` = non ouvertes. Les vidéos YouTube/TikTok trouvées ne comptent plus comme pages consultées.
4. Un fournisseur en échec/timeout n'est jamais déclaré interrogé (`providers_queried` / `providers_failed`).
5. Bug corrigé : l'URL à ouvrir perdait son `www.` (risque de 404) — seule la clé de déduplication l'ignore désormais.
6. Métadonnées par page : title, url (finale), domain, provider, published_at, retrieved_at, author, extracted_content, opened, reliability, verification_status, + numéro `cite` [n] identique entre texte, outils et pied « Sources ».
7. Classement : official / scientific / reference / media / unverified (par domaine, jamais une preuve de véracité).
8. `web_click` : `<base href>`, liens relatifs résolus, recherche insensible aux accents, refus des boucles, limite de clics (8) par réponse.
9. Prompt système : méthode, honnêteté et format Réponse / Analyse / Sources consultées / Sources supplémentaires / Fiabilité.
10. Brave Search : optionnel (`BRAVE_API_KEY`).

## Compatibilité à connaître
- Routes API inchangées ; `/api/web/run` renvoie en plus `additional_sources` et `opened_count`. L'événement SSE `sources` porte en plus `additional_sources`. Frontend non modifié.
- Tiers renommés : arxiv/nature/ncbi/openalex/crossref passent de `reference` à `scientific`.
- `web_fast` est un peu plus lent (≤ ~5 s de lecture parallèle) puisqu'il lit réellement les pages.

## Variables .env (toutes optionnelles)
`BRAVE_API_KEY`, `WEB_FAST_BUDGET_MS=12000`, `WEB_DEEP_BUDGET_MS=30000`, `WEB_MAX_CLICKS=8`, `WEB_SEARCH_CACHE_MS=60000`.

## Tests
- `npm run check` (+ `node --check` index.js, free-sources.js, net.js, luba-net.js).
- `npm run test:web` → `test/web-research.test.js` : 27 tests (unitaires, intégration, bout en bout en réseau simulé).
- `node test/web-live.e2e.js "question"` : test réel sur Internet (codes : 0 réussi, 1 échec, 2 bloqué par l'environnement).

## Déploiement
1. Copier index.js, net.js, luba-net.js, free-sources.js, package.json, env.example, test/ à leur place.
2. Ajouter les variables .env souhaitées.
3. `npm run check && npm run test:web`, puis `node test/web-live.e2e.js` sur le serveur (réseau réel).
4. Redémarrer le service.
