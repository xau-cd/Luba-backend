# Protocole d'exécution distante (Luba Engine ⇄ service d'exécution isolé)

**Pourquoi** : sur Render Free, aucune isolation forte n'est disponible (voir `AUDIT_FIABILISATION_v18.md` §4) et Luba Engine **refuse** d'exécuter du code non fiable dans le processus du backend. Si tu veux malgré tout une exécution de code, la seule voie sûre est un **service séparé**, hébergé sur une infrastructure qui fournit elle-même l'isolation.

**Ce qui est livré** : le **client** (dans `luba-engine.js`) et son contrat, testés contre un service **simulé** (`test/helpers/fake-exec-service.js`).
**Ce qui n'est PAS livré** : le service isolé lui-même. Son isolation ne peut pas être vérifiée depuis Luba ; elle relève de l'hébergeur (machine virtuelle dédiée, gVisor/Firecracker, conteneur sans privilèges avec bwrap/nsjail, etc.).

## Configuration côté Luba (variables Render)
`ENGINE_ALLOW_EXEC=true` · `ENGINE_REMOTE_EXEC_URL=https://…` · `ENGINE_REMOTE_EXEC_SECRET=<openssl rand -hex 32>` · (`ENGINE_EXEC_ROLES=ADMIN` par défaut). Le secret n'est **jamais** envoyé, journalisé ni renvoyé ; il sert seulement à signer.

## Requête (Luba → service) — `POST ENGINE_REMOTE_EXEC_URL`
En-têtes : `Content-Type: application/json`, `X-Luba-Timestamp` (secondes Unix), `X-Luba-Nonce` (24 hex, unique), `X-Luba-Signature`.
Signature : `hex( HMAC-SHA256( secret, timestamp + "." + nonce + "." + hex(SHA256(corps_brut)) ) )`.
Corps : `{ "v":1, "id":"<hex>", "language":"python|javascript|c|cpp", "code":"…", "stdin":"…", "limits":{ "timeout_ms":10000, "mem_mb":256, "output_bytes":262144 } }`

## Ce que le service DOIT faire
1. Recalculer la signature (comparaison à temps constant), refuser si absente/fausse (**401**).
2. Refuser si `|now − timestamp| > 60 s` (**401**) et mémoriser les nonces vus pendant au moins 2 min (rejeu → **409**).
3. Exécuter dans une isolation réelle : pas de réseau, système de fichiers éphémère et vide, aucun secret, utilisateur sans privilège, limites CPU/mémoire/temps/processus/taille de sortie **imposées par le service** (ne pas se fier aux `limits` seuls), nettoyage après chaque exécution.
4. Répondre **200** avec `{ "exitCode":int|null, "stdout":"…", "stderr":"…", "timedOut":bool, "outputTruncated":bool, "isolation":"<description libre>" }`.

## Réponse (service → Luba)
En-tête `X-Luba-Signature` = `hex( HMAC-SHA256( secret, timestamp + "." + nonce + "." + hex(SHA256(corps_de_réponse)) ) )` avec **le même** timestamp et nonce que la requête. Luba rejette toute réponse non signée, mal signée, mal formée, trop grande, ou arrivée après `execTimeout + 5 s`.

## Garanties côté Luba (testées)
Signature de réponse vérifiée · https obligatoire (hors localhost) · aucune redirection suivie · réponse plafonnée · annulation propagée (AbortSignal) · rôle vérifié avant tout appel · aucune sortie d'un service non authentifié n'est jamais présentée comme un résultat.
**Non garanti** : l'isolation du service. Luba l'affiche honnêtement : « isolation non vérifiable depuis ce serveur ».
