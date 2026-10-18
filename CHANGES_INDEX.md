# Résumé des modifications

## index.js (base : ton `index.js` v18.0.0 chargé séparément, 15 984 lignes ; plus récent que celui du ZIP, qui a `metrics.registry.metrics` sans parenthèses)

**33 lignes ajoutées, 2 lignes d'origine étendues, 0 supprimée.** Diff exact : `index.patch`. Chaque point est repéré par `[LUBA ENGINE]`.

| # | Endroit | Changement |
|---|---|---|
| 1 | en-tête | commentaire (3 lignes) |
| 2 | §1 imports | `const lubaEngine = … tryRequire("./luba-engine.js")` (nul si `ENGINE_ENABLED=false`) |
| 3 | `getToolSchemas()` | + schémas du moteur (**2 lignes d'origine étendues** : `taken` et `return`) |
| 4 | `TOOL_ROUTES` | + 1 règle de routage `/^engine_/` |
| 5 | `executeTool()` | + 1 ligne : `lubaEngine.has(...) → lubaEngine.execute(...)` |
| 6 | avant « Prompt système » | + `lubaEngineLlm` : adaptateur vers `callLLM` / `tierChain` existants |
| 7 | `buildApp()` | + montage des routes `/api/engine/*` (try/catch, non bloquant) |
| 8 | `bootstrap()` | + `lubaEngine.init(...)` (try/catch, non bloquant) avant `buildApp()` |
| 9 | `shutdown()` | + `lubaEngine.shutdown()` |
| 10 | `validateEnvironment()` | + 2 lignes de journal |
| 11 | exports | + `lubaEngine, lubaEngineLlm` |

**Préservé** (vérifié par test de régression) : les 40 routes d’origine et les 27 outils d’origine visibles en mode test (le faux LLM désactive les outils hérités v16.5 ; avec de vraies clés ils restent chargés, car le code qui les charge n’est pas modifié) ; middlewares, auth, file de runs, SSE, sync, module héritage v16.5, `CONFIG`, version (`18.0.0`).
**Non modifié** : `package.json`, `Dockerfile`, `free-sources.js`, `processUploads`, prompt système.

## Fichiers créés
`luba-engine.js`, `luba_worker.py`, `requirements.txt`, `.env.engine.example`, `LUBA_ENGINE.md`, `RAPPORT_VALIDATION.md`, `CHANGES_INDEX.md`, `index.patch`, `index.original.js` (sauvegarde), `test/luba-engine.test.js`, `test/luba-engine.milo.test.js`, `test/milo-probe.js`.
