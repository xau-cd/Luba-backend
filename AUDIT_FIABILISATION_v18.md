# Audit senior et fiabilisation de Luba AI Pro v18.0.0

*Travail réalisé sur une branche `audit-fiabilisation` (git) à partir de la livraison Luba Engine v1.0.0 ; sauvegarde de ton `index.js` d'origine : `index.original.js`. Rien n'a été déployé.*

## 1. Chemin réel d'une requête (d'après le code)
**Texte** : client → Express (helmet, CORS, compression, `X-Request-Id`, limites IP) → `auth` (Firebase Admin ou REST) → `POST /api/chat` (HMAC optionnel, validation) → `chat.start` (propriété de la conversation, restauration cloud si inconnue, idempotence `client_msg_id`, quota, **écriture du message en transaction SQLite**) → `RunManager` (files par voie) → `orchestrate` → boucle `callLLM` (classement par santé, pools de clés, nouvel essai borné, bascule, disjoncteur, surveillance premier-jeton/inactivité/total) + tours d'outils via `executeTool` → écriture de la réponse + file miroir (Firestore/Supabase) → SSE vers le client.
**Voix** : `/live` (WebSocket) → module hérité (`handleLiveFrame`) → STT → `handleChat` → `legacyChatBridge` → **le même** `chat.start`/run que le texte → TTS par phrase → trames binaires. `/ws` (synchronisation) et `/live` sont deux `WebSocketServer` en `noServer` derrière **un seul** gestionnaire `upgrade` : pas de conflit de routes (testé).
**Existant réutilisable et conservé** : registre d'outils + `executeTool`, `RunManager` (file, annulation), `ProviderHealth` (disjoncteur), `KeyPool`, mémoire SQLite + miroir. Aucun second orchestrateur n'a été créé.

## 2. Problèmes, par gravité, avec preuves

| # | Gravité | Problème | Preuve | État |
|---|---|---|---|---|
| 1 | **Haute** | Le workflow `.github/workflows/fix.yml` réécrit `index.js` **et le pousse sur `main` à chaque push**. Son `sed 's/\bmetrics()/metrics/g'` transforme `await metrics.registry.metrics()` (méthode prom-client) en `metrics.registry.metrics` → `/metrics` cassé ; `node --check` ne le voit pas. | Rejeu exact des commandes sur une copie (une ligne corrompue, syntaxe valide). C'est l'écart que j'avais observé entre le `index.js` du ZIP et le tien. | **Corrigé** : déclenchement manuel seulement, `sed` supprimé, test de garde. |
| 2 | **Haute** | `(x.ok ? logger.info : logger.error)(x, …)` détache la méthode de pino (`this` perdu) → `Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')` → « auto-diagnostic LLM impossible ». Pire : **le résultat du diagnostic n'était jamais journalisé**. | **Reproduit avec le vrai pino 8.21** : message identique à ta production. Mon logger de repli masquait le défaut dans les tests précédents. | **Corrigé** + test avec pino réel + garde statique. |
| 3 | **Haute** | Module hérité : `initializeApp()` sans test d'existence alors que le cœur a déjà créé l'app → `app/duplicate-app` → « Init Firebase Admin échouée » ; le Firestore **du module hérité** est désactivé. | Fonction extraite telle quelle de `index.js`, exécutée avec un SDK simulé respectant le comportement documenté : même message, `duplicateErrors: 1`. | **Corrigé** (réutilise l'app existante). |
| 4 | **Haute** | Dépendances non reproductibles : `package.json` demande `firebase-admin ^13` / `pino ^9`, le **lock** fige `12.7.0` / `10.3.1` et ignore `multer` ; le `node_modules` fourni contient `firebase-admin 14.2.0` (API modulaire : **plus de `credential`/`apps`/`firestore()`**) ; `youtubei.js` et `pdfjs-dist` sont en `latest` ; le `Dockerfile` ne copie pas le lock. | Lecture de `package.json`, `package-lock.json`, `node_modules/firebase-admin/package.json`. Avec la v14 l'init échouait en `reading 'cert'`. | **Garde ajoutée** (message explicite) ; **dépendances non modifiées** (voir §6). |
| 5 | Moyenne | Santé des fournisseurs : un fournisseur rétrogradé après 2 échecs n'était **plus jamais réessayé** tant que l'autre répondait (échantillons purgés par nombre, pas par temps). | Test **rouge** avant correctif, vert après. | **Corrigé** (`HEALTH_SAMPLE_TTL_MS`, défaut 120 s). |
| 6 | Moyenne | `DATA_DIR` ne déplace pas la base : elle suit **`DB_PATH`**. Un disque persistant monté via `DATA_DIR` ne protège donc pas l'historique. | Mes tests écrivaient dans la base du dépôt malgré `DATA_DIR`. | **Avertissement au démarrage** ; comportement inchangé (déplacer une base existante serait risqué). |
| 7 | Moyenne | Voix : fermeture du WebSocket ou `BARGE_IN` ne stoppait pas la génération (quota consommé pour personne). | Lecture du code + test de la chaîne réelle `legacyChatBridge → chat.start → fournisseur`. | **Corrigé** (annulation via `runManager.cancel`, `LIVE_CANCEL_ON_CLOSE`). |
| 8 | Moyenne | `/api/health` ne disait rien des fournisseurs externes (visible seulement derrière un jeton de debug) ; aucune alerte quand tout est HS. | Lecture du code. | **Ajouté** : `llm: ok/degraded/down/unknown`, alerte `LLM_ALL_PROVIDERS_OPEN` (≤ 1/min). Le serveur reste « ok » et `/ready` reste 200 même si les fournisseurs sont HS. |
| 9 | Moyenne | Luba Engine : exécution exposée sans contrôle de rôle fin ; arguments d'outil non validés. | Lecture + tests. | **Durci** (§4). |
| 10 | Info | Voix, non corrigé (non testable ici) : après un `BARGE_IN`, `interrupted` reste `true` et l'audio suivant est ignoré jusqu'au prochain tour ; deux `TEXT_IN` rapprochés lancent deux générations simultanées. | Lecture du code uniquement. | **Non modifié** : nécessite le client réel (voir §5). |

## 3. Tes messages de journal Render, un par un
| Message | Verdict |
|---|---|
| `Init Firebase Admin échouée` (module hérité) | Cause prouvée : `duplicate-app` (#3). Corrigé. Le cœur, lui, fonctionnait. |
| `Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')` / `auto-diagnostic LLM impossible` | Cause prouvée : appel pino détaché (#2). Corrigé ; **au prochain démarrage le diagnostic dira enfin si chaque clé est valide** (ne suppose pas qu'elles le sont). |
| `Redis non configuré — cache L2 désactivé` | **Informatif, pas un défaut.** Redis ne sert qu'au cache L2 et au bus multi-instances. Une seule instance : inutile. Ne pas en ajouter. |
| `HMAC_SECRET absent` | **Ne le définis pas** sauf si ton client signe chaque requête : `/api/chat` rejette alors tout message non signé (`INVALID_SIGNATURE`). Un secret embarqué dans un client web/mobile public n'est pas un secret. Utile seulement entre deux services serveur que tu contrôles. |
| `python: true`, `gcc`/`g++` détectés, `isolation: null`, `exec: false` | `exec: false` est le **choix par défaut voulu** (`ENGINE_ALLOW_EXEC` non défini). `isolation: null` = ni `bwrap` ni `unshare` utilisables dans le conteneur Render. La **raison exacte** n'était pas journalisée : elle l'est maintenant (`isolation_probe`, `exec_reason`). Voir §4. |
| SQLite initialisé, port 10000 | Normal. |

## 4. Luba Engine : ce qui est réellement possible sur Render Free
Matrice (capacités distinguées : **détecté** · **testé** (un vrai programme trivial est compilé au démarrage) · **autorisé** · **exécutable**) : visible via `GET /api/engine/capabilities`.
Sur ton hébergement actuel, **l'exécution de code n'est pas possible de façon sûre** : pas d'isolation du système de fichiers. Luba Engine continue d'offrir ce qui est sûr et utile : analyse de fichiers/ZIP, contrôles de syntaxe réels, correction sur copie avec vérification, création de fichiers. Options réalistes :
1. **Rester ainsi** (recommandé tant que tu n'as pas besoin d'exécuter du code) ;
2. **Service d'exécution distant isolé** : client livré et testé ; le service reste à déployer sur une infra qui isole (`PROTOCOLE_EXECUTION_DISTANTE.md`) ;
3. Outil existant `run_code` de Milo (sandbox distante tierce) : **non audité ni testé ici** (statut du service à vérifier).
Durcissements livrés : rôle vérifié à chaque appel (défaut `ADMIN`), opt-in `ENGINE_EXPOSE_RUN_TOOL`, validation des arguments par schéma, délai par outil, enveloppe de résultat avec preuve (`outil réel`, durée, permissions), exécution distante signée HMAC.

## 5. Voix : ce qui est prouvé et ce qui ne l'est pas
**Testé** : routage `/ws` // `/live` avec la vraie bibliothèque `ws` ; 8 déconnexions brutales sans connexion résiduelle ; annulation de bout en bout jusqu'au fournisseur ; panne de fournisseur → erreur honnête sans blocage ; codec de trames face aux trames tronquées/gigantesques.
**Non testé (bloqué par l'environnement)** : STT, TTS, authentification vocale Firebase, client audio réel, et le module hérité complet (il charge `sqlite3` natif et ~15 paquets absents ici). Les points du §2-#10 sont des **hypothèses de lecture** à confirmer avec le client avant correction.

## 6. Dépendances (sans `npm audit fix --force`)
`npm audit` n'a pas pu être exécuté (réseau coupé) : **aucune vulnérabilité n'est affirmée**. Actions recommandées, à faire sur ta machine : (1) `npm install` puis **commiter un `package-lock.json` cohérent** ; (2) utiliser `npm ci` au build ; (3) remplacer `latest` par une version exacte pour `youtubei.js` et `pdfjs-dist` ; (4) exécuter `npm audit`, lire chaque alerte, ne mettre à jour qu'après test ; (5) ne **pas** passer à `firebase-admin` ≥ 14 sans migrer vers l'API modulaire.

## 7. Render et disponibilité
D'après la documentation Render telle que rapportée par plusieurs sources (juillet–août 2026) : instance Free = 512 Mo / 0,1 CPU ; **mise en veille après 15 min sans trafic**, ~1 min de redémarrage ; 750 h d'instance partagées par mois ; disque **éphémère**. Conséquences : premier message lent après inactivité ; historique SQLite perdu au redémarrage **et restauré depuis Firestore** (c'est ce qui rend ta mémoire fiable : ne pas désactiver le miroir) ; tâches Engine perdues au redémarrage. Je n'ai **pas** ajouté de ping artificiel (contraire à l'esprit du plan gratuit et à ta consigne). Stratégie adaptée : accepter la veille et afficher « réveil du serveur » côté client, ou passer à l'instance Starter (7 $/mois, sans mise en veille, 0,5 CPU).
L'arrêt propre (drainage des runs, arrêt du miroir, arrêt du moteur), les identifiants `X-Request-Id`, les métriques Prometheus et le disjoncteur existaient déjà ; je ne les ai pas réécrits. Testés : disjoncteur, `X-Request-Id`, santé/`ready`. **Non testés ici** : l'arrêt propre complet sur `SIGTERM` et les métriques Prometheus (`prom-client` absent).

## 8. Mémoire
Non remplacée. Invariants testés : message + réponse persistés et numérotés, idempotence (pas de doublon ni de second run, y compris envois simultanés), cloisonnement entre utilisateurs, durabilité sur disque, panne **d'écriture** Firestore (la conversation continue, le miroir est mis en attente puis rattrapé), panne de **lecture** Firestore (conversation inconnue localement → refus réessayable `SERVER_BUSY` pour ne pas écraser un historique cloud ; le client officiel envoie `knownNew` et n'est pas bloqué ; conversation déjà locale → service continu).

## 9. Variables d'environnement
Voir `.env.engine.example` (nouveaux : `ENGINE_EXEC_ROLES`, `ENGINE_EXPOSE_RUN_TOOL`, `ENGINE_TOOL_TIMEOUT_MS`, `ENGINE_REMOTE_EXEC_URL/SECRET`, `HEALTH_SAMPLE_TTL_MS`, `LIVE_CANCEL_ON_CLOSE`, rappel `DB_PATH`). Secrets manquants à connaître : `HMAC_SECRET` (à laisser vide), `REDIS_URL` (inutile). Aucun secret n'a été ajouté au dépôt ; **le fichier ` (1).env` du ZIP** ressemble à une vraie configuration et n'est pas ignoré par `.gitignore` : à retirer de Git et à régénérer s'il a été poussé.

## 10. Déploiement (rien n'est déployé sans ton accord)
1. Relire `audit.patch` (index.js, luba-engine.js, workflow). 2. Copier `index.js`, `luba-engine.js`, `luba_worker.py`, `.github/workflows/fix.yml`, `test/`. 3. Régénérer et commiter `package-lock.json`. 4. Définir `DB_PATH` si disque persistant. 5. Déployer sur un **service de préproduction** d'abord ; vérifier les journaux : `Firebase Admin initialisé` (une seule fois, sans « échouée »), `auto-diagnostic LLM : OK/ÉCHEC` par modèle (c'est ici que tu sauras quelles clés sont réellement valides), `luba-engine : prêt` avec `isolation_probe`. 6. `GET /api/health` → `llm.status`.
