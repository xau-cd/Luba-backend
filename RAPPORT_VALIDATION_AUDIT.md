# Rapport de validation — audit de fiabilisation (17/10/2026)
Node v22.22.2 · Python 3.12.3 · g++/gcc, `unshare`, `prlimit` présents · `bwrap` absent · **réseau coupé**.
Commande : `TEST_EXTRA_NODE_PATH=<dossier contenant pino et ws> node --test --test-concurrency=1 --test-force-exit "test/*.test.js"` (130 s).

## Résultat : 142 tests · **141 réussis · 0 échoué · 1 non exécuté**
Tests **existants** du dépôt : `selftest-free-sources.js` 18/18 avant et après ; `node --check` et chargement `FAKE_LLM=1` OK avant et après.

| Domaine (fichier) | Réussi | Détail |
|---|---|---|
| Pannes fournisseurs LLM (`providers`) | 18/18 | clé invalide 401 · quota 429 (+2ᵉ clé) · 500 (nouvel essai borné) · réseau coupé · délai (watchdog) · réponse vide · flux mal formé · lent mais valide · flux **interrompu** (texte conservé sans doublon, suite demandée au suivant ; sinon `partial:true`) · tous HS (erreur typée, appels bornés) · annulation propagée au fournisseur · disjoncteur ouvert → demi-ouvert → fermé · **récupération après panne (rouge→vert)** · secours honnête au niveau conversation · diagnostic isolé |
| Démarrage / Pino / Firebase (`startup`) | 10/10 | pino **réel** (clé invalide ⇒ ÉCHEC `auth`, clé valide ⇒ OK, aucune clé dans les journaux) · garde statique anti-appel détaché · Firebase cœur + hérité dans l'ordre réel · SDK ≥ 14 · garde contre la réécriture CI de `metrics()` |
| Voix (`voice`) | 10/10 | annulation de bout en bout · routeur `/ws` `/live` (`ws` réel) · 8 déconnexions brutales · codec de trames · `cancelLiveRun` |
| Santé (`health`) | 5/5 | serveur ≠ fournisseurs · `/ready` 200 malgré panne · alerte unique/minute · pas de fuite de clé |
| Mémoire (`memory`) | 11/11 | persistance, ordre, idempotence, concurrence, cloisonnement, durabilité, panne écriture/lecture Firestore |
| Luba Engine renforcé (`reliability.engine`) | 18/18 | validation d'arguments · TOOL_TIMEOUT · permissions/rôles · exposition de `engine_run_code` · exécution distante signée (11 cas dont service hostile) · diagnostic d'isolation · détecté ≠ testé |
| Luba Engine (suite d'origine) | 63/63 + 1 non exécuté | ZIP, formats, sécurité, pipeline, HTTP |
| Intégration Milo + régression | 7/7 | 40/40 routes et 27/27 outils conservés ; **liste blanche** des 13 lignes d'origine modifiées ; Milo démarre moteur désactivé / en échec / sans Python |

## Rouge → vert (défauts reproduits avant correction)
Pino détaché (pino 8.21 réel) · Firebase `duplicate-app` · récupération du fournisseur prioritaire · workflow CI (rejeu des `sed`).

## NON EXÉCUTÉ / BLOQUÉ PAR L'ENVIRONNEMENT / NON VÉRIFIÉ EN PRODUCTION
* **Non exécuté** : upload `multipart` réel (`multer` absent) ; `npm audit`, `npm ci`, `pip install` (réseau coupé) ; arrêt propre sur `SIGTERM` ; métriques Prometheus (`prom-client` absent).
* **Bloqué par l'environnement** : module hérité complet (sqlite3 natif et ~15 paquets absents) → ses fonctions ont été testées **extraites**, pas en service ; `bwrap` (isolation réelle) ; STT/TTS ; Firebase/Supabase réels.
* **Simulé, pas réel** : tous les fournisseurs LLM (faux serveur HTTP local), Firestore (simulé), `firebase-admin` (simulé fidèlement au comportement documenté), service d'exécution distant (simulé). Ces tests prouvent **la logique de Milo**, pas le comportement de Groq, OpenRouter, Firebase ou d'un service réel.
* **Non vérifié en production** : toutes les corrections ; la validité réelle de tes clés API ; la présence de `python3`/`g++`/`prlimit` et la raison exacte de `isolation: null` sur Render (désormais journalisée) ; le comportement du parcours vocal avec le client réel ; la latence de bascule sur de vrais fournisseurs (en simulation, ~6 s pour épuiser ~8 modèles en panne — à mesurer en réel).
