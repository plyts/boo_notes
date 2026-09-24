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
| `note.upsert` | `note` (`id`, `platform`, `kind`, `url`, `title`, `markdown`, `createdAt`, `updatedAt`, `rev`, `notion?`, `course?`, `chapter?`, `placedAt?`), `portableMarkdown` | `ack { noteId, rev }` |
| `media.progress` | `noteId`, `kind`, `title`, `url`, `platform`, `position` (s), `duration` (s), `updatedAt` | — |
| `export` | `requestId`, `noteId`, `target`: `"local"` \| `"notion"` | `export.result { requestId, ok, message }` |
| `player.active` | `player`: `{ noteId, title, url }` ou `null` | — |
| `open` | `title` : titre d’une note (clic sur un `[[lien]]` dans le navigateur) | — (l’application s’affiche sur la note, en créant la fiche si besoin) |
| `transcript.put` | `transcript` : `{ noteId, lang, label, source, target, complete, covered, duration, cues: [{ id, start, end, text, tr?, note? }], updatedAt, rev }` | `transcript.ack { noteId, rev }` |
| `media.chunk` | `path` (`media/…`), `index` (0, 1, 2…), `data` (base64, 1 Mo par morceau) | — |
| `media.put` | `path`, `noteId`, `kind` : `"passage"` \| `"audio"` \| `"file"`, `mime`, `start` (s), `end` (s), `name` (fichier collé), `chunks` (nombre de morceaux) | `media.ack { path }` |
| `ping` | — (toutes les 20 s) | `pong` |

- `note.id` : `youtube:<id>`, `udemy:<cours>/<leçon>`, `coursera:<cours>/<leçon>`,
  `notion:<id de page>` (vidéo / audio déposé dans une page Notion) ou `web:<hôte><chemin>` (tout
  autre site activé). `platform` : `youtube` \| `udemy` \| `coursera` \| `notion` \| `web` ;
  `kind` : `video` \| `audio` \| `page` (page lue sans média, notes = citations liées par
  fragment de texte `URL#:~:text=…`) ; absent = `video` (versions antérieures).
- `note.notion` (facultatif) : correspondance Notion de la note quand l’extension l’a écrite
  elle-même dans Notion (application fermée) — `{ pageId, url, blocks: [{ id, hash }], syncedAt,
  syncedRev }`. L’application garde la plus récente (`syncedAt`) : les deux côtés mettent à jour la
  même page au lieu d’en créer une seconde. Une note dont seule la correspondance a changé est
  renvoyée avec le même `rev`.
- `note.course` / `note.chapter` (facultatifs) : titres du **cours** et du **chapitre** choisis dans
  le panneau de l’extension ; `placedAt` : date de ce classement (ms). L’application range la note
  dans ce cours › chapitre (créés s’ils n’existent pas, titres comparés sans accents ni casse) si
  ce classement est plus récent que le sien. `placedAt` sans `course` : la note a été **retirée** de
  son cours dans le navigateur (elle devient « non classée »).
- `transcript.put` : sous-titres horodatés collectés pendant la lecture (voir
  [TRANSCRIPTION.md](TRANSCRIPTION.md)), envoyés après les notes quand ils changent. `source` :
  `track` (pistes du lecteur), `platform` (liste de sous-titres de la plateforme), `live` (capture
  des sous-titres affichés), `file` (fichier `.vtt` / `.srt`). L’application écrit
  `transcripts/<note>.json`, `.md`, `.vtt` (et `.fr.vtt` quand des traductions existent), et garde
  sa copie si elle est plus récente (`updatedAt`, `rev`).
- `media.chunk` puis `media.put` : un **extrait de passage** enregistré (image et son, ou son
  seul), un segment du **son du cours** conservé ou une **vidéo / un audio collé** dans la note
  (`kind: "file"`, avec son `name`), écrit dans `media/` (chemin vérifié :
  `media/<nom>` uniquement). Les morceaux sont envoyés sans attendre, `media.put` en donne le
  nombre ; l’application répond `media.ack` une fois le fichier écrit.
- Pour une page lue (`kind: "page"`), `media.progress` porte le **pourcentage lu** : `position`
  0–100, `duration` 100 (point le plus loin atteint).
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
| `notion.config { config, connected }` | Envoyé après `welcome` et à chaque changement. `connected` : l’application écrit elle-même dans Notion (l’extension lui laisse alors cette tâche). `config` : connexion partagée `{ token, databaseId, databaseUrl, parentId, workspace }` pour que l’extension écrive dans Notion quand l’application est fermée, ou `null` (partage désactivé ou Notion déconnecté). Sans ce message (application plus ancienne), l’extension considère que l’application gère Notion. |
| `notion.link { noteId, link }` | Correspondance Notion d’une note de l’extension, après une synchronisation par l’application (même forme que `note.notion`). |
| `library.titles { titles }` | Titres de la bibliothèque (fiches, PDF, textes…), proposés par l’extension après `[[` ; renvoyé quand ils changent. |
| `library.courses { courses }` | Cours de la bibliothèque et leurs chapitres, `[{ title, emoji, chapters: [titre…] }]`, pour ranger une note depuis le panneau de l’extension ; envoyé après `welcome` et quand ils changent. |
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
← notion.config { connected: true, config: { token: "…", databaseId: "…" } }
← library.titles { titles: ["useEffect", "Probabilités — Chapitre 3"] }
← library.courses { courses: [{ title: "React", emoji: "⚛️", chapters: ["Hooks", "Contexte"] }] }
→ note.upsert  youtube:dQw4w9WgXcQ rev 8 { course: "React", chapter: "Hooks", placedAt: 1727… }
← ack rev 8
→ transcript.put  youtube:dQw4w9WgXcQ rev 12 (312 répliques, anglais → français)
← transcript.ack rev 12
→ media.chunk  media/youtube-dQw4w9WgXcQ-passage-02-05-k3j.webm #0, #1, #2
→ media.put    media/youtube-dQw4w9WgXcQ-passage-02-05-k3j.webm { kind: "passage", start: 125, end: 367, chunks: 3 }
← media.ack
→ export  { target: "notion", requestId: "exp-…" }
← export.result { ok: true, message: "Envoyé vers Notion" }
← notion.link  youtube:dQw4w9WgXcQ { pageId: "…", syncedRev: 7 }
→ open  { title: "useEffect" }
```
