# Architecture

```
+----------------------------------------------------------------------------------+
|                               EXTENSION NAVIGATEUR                               |
|                                                                                  |
|  Onglet vidéo (youtube / udemy / coursera)                                       |
|  +-------------------------------------------+                                   |
|  | Content script (src/content)              |   runtime.sendMessage             |
|  |  - VideoController : <video>, temps, seek | --------------------+             |
|  |  - Overlay (Shadow DOM) : HUD, toasts,    |                     v             |
|  |    flash, marqueur de progression         |   +----------------------------+  |
|  |  - Drawer : conteneur + <iframe> panneau  |   | Service worker             |  |
|  |  - Capture <canvas>                       |   | (src/background)           |  |
|  |  - Raccourcis de secours dans la page     |   |  - chrome.commands         |  |
|  +-------------------------------------------+   |  - routage lecteur actif   |  |
|        ^  port (chrome.tabs.connect)             |  - NoteStore (storage)     |  |
|        v                                         |  - export / téléchargement |  |
|  +-------------------------------------------+   |  - DesktopSync (WebSocket) |  |
|  | Panneau (src/panel, page d’extension)     |   +----------------------------+  |
|  |  iframe du drawer OU fenêtre pop-out      | ---- note:save / get ---^   |     |
|  |  - éditeur CodeMirror 6                   |                             |     |
|  |  - badge sync, export, pin, pop-out       |                             |     |
|  +-------------------------------------------+                             |     |
+----------------------------------------------------------------------------|-----+
                                                  WebSocket ws://localhost:43117
                                                                             v
                                                        +-----------------------------+
                                                        |     APPLICATION DESKTOP     |
                                                        |  (Stockage / Notion Sync)   |
                                                        +-----------------------------+
```

## Rôles

| Contexte | Fichier d’entrée | Responsabilités |
| --- | --- | --- |
| **Service worker** | `src/background/index.ts` | Reçoit les raccourcis globaux (`chrome.commands`) et le clic sur l’icône ; choisit le lecteur cible ; seul écrivain du stockage (`NoteStore`) ; captures de repli (`captureVisibleTab`) ; export `.md` ; fenêtre pop-out ; synchronisation Desktop (`DesktopSync`). |
| **Script de contenu** | `src/content/index.ts` | Adaptateur de plateforme, détection de la vidéo et des navigations SPA, HUD / toasts / flash / marqueur, drawer, capture de frame, exécution des commandes. |
| **Panneau** | `src/panel/index.ts` | Éditeur de notes ; tourne soit dans l’iframe du drawer, soit dans la fenêtre pop-out. Communique avec le script de contenu de l’onglet vidéo par un *port*. |
| **Options** | `src/options/index.ts` | Réglages (`chrome.storage.sync`), état des raccourcis, état de la synchronisation, données. |

La logique pure est dans `src/shared/` et couverte par les tests unitaires.

## Pourquoi un `<iframe>` pour l’éditeur

- **Clavier isolé** : les frappes dans l’éditeur ne remontent jamais à la page. Sans cela, taper
  « k » ou « f » dans une note déclencherait lecture / plein écran sur YouTube.
- **Confidentialité** : la page (cross-origin) ne peut pas lire le contenu des notes.
- **Styles isolés** et réutilisation de la même page pour la fenêtre pop-out.

Le HUD, les toasts et le marqueur restent dans le script de contenu (Shadow DOM, `pointer-events:
none` sauf sur le HUD) car ils doivent suivre la géométrie du lecteur à chaque frame.

## Flows

### Flow 1 — prise de note rapide

```
Alt+Shift+N ─► chrome.commands ─► SW.runCommand ─► tabs.sendMessage(command)
                                                      │
Content script : drawer.open() + iframe.focus() ◄─────┘
Panneau        : hello ─► init (contexte, titre, lecture) ─► note:get ─► éditeur
Frappe         : 1er caractère d’une ligne vide ─► "[MM:SS] " + caractère  (temps extrapolé)
               : 400 ms après la dernière modif ─► note:save ─► storage.local ─► outbox ─► Desktop
Échap          : panneau non épinglé ─► fermeture ; épinglé ─► focus rendu au lecteur
```

Le temps courant est poussé au panneau sur chaque événement média (`play`, `pause`, `seeked`,
`ratechange`…) et toutes les 2 s ; entre deux, le panneau l’extrapole (`time + Δt × rate`).

### Flow 2 — capture

```
Alt+Shift+S ─► content script :
  1. probeFrame(video) sur une vignette 32×18 : lisible ? (canvas non « tainted », pas noir)
  2. drawImage(video) sur un <canvas> détaché à videoWidth × videoHeight   (instant exact)
  3. flash 100 ms sur la zone image de la vidéo (letterbox exclu)
  4. toBlob() asynchrone ─► asset:save ─► storage.local  "assets/<note>-<MM-SS>-<id>.jpg"
  5. ligne "[04:15] ![Capture 04:15](assets/…)" ─► éditeur ouvert (au curseur) ou ajout en fin de note
  6. toast "04:15 - Capture sauvegardée"
Repli : source cross-origin sans CORS ─► capture:visible-tab (onglet recadré sur la vidéo)
```

## Routage multi-onglets (« un seul lecteur actif »)

Le SW tient dans `chrome.storage.session` la liste des onglets lecteurs et l’**onglet actif** : le
dernier ayant reçu une interaction (clic, touche, ouverture de vidéo). Une commande est envoyée à :

1. la vidéo de la fenêtre pop-out, si la pop-out a le focus ;
2. l’onglet courant s’il affiche une vidéo prise en charge ;
3. sinon le lecteur actif (capture / saut arrière sans changer d’onglet ; ouverture des notes,
   horodatage et Smart Pause ramènent l’onglet au premier plan).

Le lecteur actif est aussi annoncé à l’application Desktop (`player.active`).

## Raccourcis

`chrome.commands` fournit des raccourcis globaux configurables. Chrome limite les raccourcis par
défaut à quatre et ignore ceux qui entrent en conflit avec les siens. `src/shared/shortcuts.ts`
calcule les raccourcis par défaut **non enregistrés** et les gère dans la page et dans le panneau
(`matchesCombo` compare la touche physique ou la lettre produite, pour les dispositions AZERTY /
macOS Option).

## Stockage (`chrome.storage.local`, local-first)

| Clé | Contenu |
| --- | --- |
| `note:<noteId>` | `{ id, platform, url, title, markdown, createdAt, updatedAt, rev, lastWriter }` |
| `asset:<path>` | capture (data URL), dimensions, temps vidéo |
| `notes:index` | résumé de chaque note (page d’options) |
| `sync:outbox` | `{ noteId: rev }` en attente d’acquittement Desktop |
| `sync:assets` | captures déjà envoyées |

`noteId` : `youtube:<id>`, `udemy:<cours>/<leçon>`, `coursera:<cours>/<item>` — une note par vidéo.
Les écritures passent toutes par le SW et sont sérialisées ; `rev` croît à chaque sauvegarde, ce
qui permet à un second éditeur (pop-out) d’ignorer ses propres échos et d’appliquer les autres.

`chrome.storage.session` : état de routage (lecteurs, onglet actif, pop-outs) et statut de
synchronisation lu par le badge. `chrome.storage.sync` : réglages.

## Sécurité

- Le port du panneau n’est accepté que depuis l’extension elle-même (`sender.id`).
- Les pages ne peuvent pas envoyer de messages à l’extension (`externally_connectable` absent).
- Le panneau n’est *web accessible* que sur les trois plateformes.
- L’adresse Desktop est limitée à `localhost` / `127.0.0.1` ; jeton d’appairage ; l’application doit
  vérifier l’en-tête `Origin: chrome-extension://…` (voir [PROTOCOL.md](PROTOCOL.md)).
- Les icônes sont construites en DOM (pas d’`innerHTML`), compatible Trusted Types (YouTube).
