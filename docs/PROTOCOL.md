# Protocole extension ↔ application Desktop (v1)

Transport : **WebSocket local**, messages **JSON** (un objet par message, champ `type`).
Adresse par défaut : `ws://localhost:43117` (modifiable dans les options, boucle locale uniquement).
Implémentation côté application : [`desktop/src/core/server.ts`](../desktop/src/core/server.ts)
(Boo Notes Desktop). Un mock minimal sert aux tests de l’extension :
[`tools/mock-desktop/server.mjs`](../tools/mock-desktop/server.mjs).

## Sécurité côté application

1. N’écouter que sur `127.0.0.1`.
2. Refuser les connexions dont l’en-tête `Origin` n’est pas `chrome-extension://<id>` (une page web
   ne peut pas falsifier cet en-tête).
3. Exiger le **jeton d’appairage** affiché par l’application et saisi dans les options de
   l’extension ; en cas d’échec répondre `error/unauthorized` puis fermer.

## Poignée de main

```jsonc
// extension → app
{ "type": "hello", "protocol": 1, "client": { "name": "boo-notes-extension", "version": "0.1.0" }, "token": "…" }
// app → extension
{ "type": "welcome", "protocol": 1, "app": { "name": "Boo Desktop", "version": "1.2.0" } }
// ou
{ "type": "error", "code": "unauthorized", "message": "Jeton invalide" }
```

Sans `welcome` sous 5 s, l’extension ferme et réessaie (1 s, 2 s, 5 s, 10 s, 30 s, puis 60 s ; plus une
alarme par minute tant que des notes attendent).

## Messages extension → application

| type | Champs | Réponse attendue |
| --- | --- | --- |
| `asset.put` | `path` (`assets/…`), `noteId`, `mime`, `width`, `height`, `time` (s), `data` (base64) | `asset.ack { path }` |
| `note.upsert` | `note` (`id`, `platform`, `kind`, `url`, `title`, `markdown`, `createdAt`, `updatedAt`, `rev`), `portableMarkdown` | `ack { noteId, rev }` |
| `media.progress` | `noteId`, `kind`, `title`, `url`, `platform`, `position` (s), `duration` (s), `updatedAt` | — |
| `export` | `requestId`, `noteId`, `target`: `"local"` \| `"notion"` | `export.result { requestId, ok, message }` |
| `player.active` | `player`: `{ noteId, title, url }` ou `null` | — |
| `ping` | — (toutes les 20 s) | `pong` |

- `note.id` : `youtube:<id>`, `udemy:<cours>/<leçon>`, `coursera:<cours>/<leçon>`,
  `notion:<id de page>` (vidéo / audio déposé dans une page Notion) ou `web:<hôte><chemin>` (tout
  autre site activé). `platform` : `youtube` \| `udemy` \| `coursera` \| `notion` \| `web` ;
  `kind` : `video` \| `audio` (absent = `video`, versions antérieures).
- `media.progress` n’est envoyé que pour un média **qui a une note** : à la pause, à la fin, après
  un saut et toutes les 15 s pendant la lecture. Il n’attend pas de réponse ; la dernière position
  enregistrée hors-ligne est renvoyée à la connexion suivante (après les notes). L’application peut
  recevoir la progression avant la note correspondante et doit alors la conserver.
- `export` vers `notion` : l’application synchronise la page Notion du cours ; si l’opération dure,
  elle répond `ok: true` avec « Envoi vers Notion en cours… » et termine en arrière-plan. En cas
  d’échec (Notion non connecté, jeton refusé…), `ok: false` et un `message` affichable.
- Les captures d’une note sont toujours envoyées **avant** la note qui les référence.
- `portableMarkdown` est la version prête à écrire sur disque : front matter YAML (`title`,
  `source`, `platform`, `created`, `updated`) et horodatages transformés en liens
  `[04:15](URL#t=255)`. Les images restent relatives (`assets/…`).
- Une note n’est retirée de la file d’envoi que lorsque l’`ack` porte un `rev` ≥ au `rev` envoyé.
  Sans réponse sous 10 s, la connexion est fermée et la file rejouée plus tard : les messages
  doivent donc être **idempotents** côté application (dernier `rev` gagnant).

## Messages application → extension

| type | Effet |
| --- | --- |
| `asset.request { path }` | L’extension renvoie la capture (`asset.put`). |
| `resync` | L’extension remet toutes ses notes en file et renvoie tout (envoyé par l’application après un changement de dossier de notes). |
| `error { code, message, requestId? }` | `unauthorized` : jeton refusé (affiché dans le badge). Avec `requestId` : échec d’un export. |

## Exemple de session

```
→ hello
← welcome
→ asset.put  assets/youtube-dQw4w9WgXcQ-04-15-k3j2.jpg
← asset.ack
→ note.upsert  youtube:dQw4w9WgXcQ rev 7
← ack rev 7
→ media.progress  youtube:dQw4w9WgXcQ 255 / 612 s
→ export  { target: "notion", requestId: "exp-…" }
← export.result { ok: true, message: "Envoyé vers Notion" }
```
