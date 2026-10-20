# Milo Backend — LUBA AI PRO

Backend CommonJS Node.js avec orchestration LLM existante, mémoire et persistance, routes HTTP, Luba Live/WebSocket, outils web et Luba Engine. Les nouveaux modules (`worker.js`, `luba-net.js`, `luba-llm-gestionnaire.js`) sont des adaptateurs testables ; `luba-engine.js` est le moteur existant conservé.

## Prérequis

- Node.js 22.13 ou plus récent (le code utilise des fonctionnalités récentes de Node et peut utiliser `node:sqlite`).
- Python 3.10+ facultatif pour les opérations prises en charge par `luba_worker.py`.
- Dépendances système de `sqlite3`/`sharp` selon la plateforme de déploiement.
- Sandbox d'exécution ou service distant authentifié si l'on veut autoriser l'exécution de code. Elle reste désactivée par défaut.

## Installation

```sh
cp .env.example .env
# Remplacer les valeurs fictives par des secrets propres à l'environnement.
npm install
python3 -m pip install -r requirements.txt  # facultatif, formats documentaires supplémentaires
npm run check
npm run test:modules
npm start
```

Le `package.json` a été reconstitué à partir des imports visibles dans le code fourni, car l'archive source ne contenait ni `package.json` ni `package-lock.json`. Les plages de versions doivent être comparées au manifeste de déploiement d'origine avant une mise à jour de production. Aucun lockfile n'est inclus tant qu'il n'a pas pu être généré par npm dans un environnement disposant des paquets approuvés.

## Modules

- `index.js` : point d'entrée, routes, authentification, persistance, LLM, outils et WebSocket. Il reste l'autorité de l'orchestration fournisseur.
- `luba-llm-gestionnaire.js` : interface normalisée et testable ; en mode Milo, délègue à `callLLM` afin d'éviter un second orchestrateur.
- `net.js` : interface multi-fournisseurs injectable, normalisation, déduplication, cache borné, collecte de preuves et garde-fous URL.
- `worker.js` : coordinateur de tâches à état explicite, dépendances, délai global, annulation et rapport d'exécution.
- `luba-engine.js` + `luba_worker.py` : moteur existant de traitement de fichiers et d'exécution contrôlée.
- `llm-operation-budget.js` : plafond global des générations (1–5) et du temps (1–300000 ms), configurable vers le bas.

## Tests

```sh
npm run check
npm run check:python
npm run test:modules
npm test
```

Les tests unitaires des modules n'exigent aucune clé API. Les tests de routes et d'intégration dépendent des paquets présents et doivent être exécutés dans l'environnement CI/préproduction. Les appels réels aux fournisseurs ne sont pas lancés automatiquement par les tests.

## Déploiement prudent

1. Comparer ce manifeste aux dépendances et versions du déploiement actuel.
2. Installer dans une branche de préproduction et conserver le ZIP précédent.
3. Définir les variables d'environnement côté hébergeur, jamais dans le dépôt.
4. Exécuter `npm run check`, `npm run test:modules`, puis la suite complète.
5. Vérifier `/ready`, `/api/health`, chat, mémoire, SSE/WebSocket, outils et tâches Engine avec les tests de régression du projet.
6. Ne pas activer `ENGINE_ALLOW_EXEC` sans validation de la sandbox ou du service d'exécution distant.

## Retour arrière

Restaurer ensemble les versions précédentes de `index.js`, `luba-engine.js` et `.env.engine.example`; supprimer les imports/exportations des trois modules ajoutés si l'on retire ceux-ci. Restaurer aussi le manifeste npm de l'environnement d'origine. Redémarrer en préproduction et valider les routes avant de rebascule le trafic.


## Recherche Web multi-source

Le backend conserve les moteurs existants (OpenSERP, Serper/Google SERP, Tavily, DuckDuckGo, Wikipedia) et peut activer Google Custom Search JSON API (`GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID`) et Perplexity Sonar (`PERPLEXITY_API_KEY`). Les moteurs optionnels ne sont activés que si leurs variables sont définies. Les résultats peuvent être incomplets ou indisponibles selon quotas, régions et politiques fournisseurs ; la recherche ne doit pas être décrite comme vérifiée si aucune page n'a pu être ouverte.

`worker.js` est un coordinateur de tâches local au processus, pas une file distribuée. Pour une file durable multi-instance, connecter une queue Redis/BullMQ ou Render Workflows.
