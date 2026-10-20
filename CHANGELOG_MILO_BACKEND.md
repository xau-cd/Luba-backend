# Journal des changements — Milo Backend / LUBA AI PRO

Base : archive de livraison `luba-ai-pro-fiabilisation-livraison.zip` issue de `luba-fiabilisation.zip`. Aucune nouvelle archive distincte n'était jointe au dernier message ; le travail continue donc sur cette dernière base disponible.

## Ajouts

- `worker.js` : coordinateur de tâches à états explicites, dépendances, budget temporel, annulation, erreurs normalisées et progression calculée depuis les étapes terminées.
- `net.js` : interface de recherche multi-fournisseurs injectables, normalisation, déduplication URL canonique, cache borné, extraction de preuves, statut d'absence de résultats, ouverture facultative et garde-fous URL.
- `luba-llm-gestionnaire.js` : interface normalisée de routage et de secours avec limites de générations et de durée, classification d'erreurs, filtrage de capacités et préservation des réponses partielles.
- `package.json` : manifeste CommonJS reconstitué depuis les imports du code car le ZIP source n'avait ni manifeste npm ni lockfile.
- `.env.example`, `.gitignore`, `README.md`, `ARCHITECTURE_MODULAIRE.md` et tests des nouveaux modules.

## Modifications

- `index.js` : import des trois nouveaux modules ; export de fabriques/adaptateurs `createLubaNetService`, `createLubaLlmManager`, `createLubaCognitiveWorker`. L'orchestrateur historique `callLLM` reste l'autorité en intégration Milo pour éviter un deuxième pool de clés ou un deuxième système de reprises.
- `llm-operation-budget.js` : prise en charge de plafonds demandés par les fabriques, sans pouvoir dépasser la limite codée en dur de 5 générations / 300000 ms ni les limites de configuration plus restrictives.
- `worker.js` : un plan vide est bloqué plutôt que marqué réussi ; la progression est issue des étapes réellement terminées.
- `net.js` : URL canonisées avant déduplication ; ports non standard refusés.
- `test/modular-architecture.test.js` : tests de planification, annulation, sources, SSRF, failover simulé, budget, chargement des modules et liaison effective des fabriques Milo.
- `test/luba-engine.milo.test.js` : liste blanche du test de régression mise à jour pour documenter les lignes modifiées par les correctifs de budget et les adaptateurs modulaires. La comparaison manuelle montre 38 lignes de l'original modifiées, toutes couvertes par cette liste blanche.

## Non modifié intentionnellement

- `luba-engine.js` et `luba_worker.py` : le moteur existant a été conservé, avec ses permissions minimales et son refus d'exécuter du code sans isolation validée.
- Les routes existantes ne sont pas volontairement retirées. Leur validation de démarrage complète reste bloquée tant que les dépendances ne sont pas installées.
- Pas de `package-lock.json` fabriqué : la génération hors ligne a échoué parce que les métadonnées du registre npm ne sont pas en cache.
