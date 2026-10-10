# Architecture

```
+----------------------------------------------------------------------------------+
|                               EXTENSION NAVIGATEUR                               |
|                                                                                  |
|  Onglet (YouTube, Udemy, Coursera, Notion, tout site activé)                     |
|  +-------------------------------------------+                                   |
|  | Content script (src/content)              |   runtime.sendMessage             |
|  |  - MediaController : page, shadow DOM,    | --------------------+             |
|  |    iframes (agents), chronomètre          |                     |             |
|  |  - PageReader : mode lecture (citations,  |                     |             |
|  |    passages surlignés, % lu)              |                     |             |
|  |  - Overlay (Shadow DOM) : HUD, toasts,    |                     v             |
|  |    flash, marqueur de progression         |   +----------------------------+  |
|  |  - Drawer : conteneur + <iframe> panneau  |   | Service worker             |  |
|  |  - Capture <canvas>                       |   | (src/background)           |  |
|  |  - Raccourcis de secours dans la page     |   |  - chrome.commands         |  |
|  +-------------------------------------------+   |  - routage lecteur actif   |  |
|  | Iframes des lecteurs : frame.js (agent) --+-->|  - relais des iframes      |  |
|  | Monde de la page : media-bridge.js        |   |    (port boo-notes-frame)  |  |
|  +-------------------------------------------+   |                            |  |
|        ^  port (chrome.tabs.connect)             |  - injection à la demande  |  |
|        v                                         |  - NoteStore (storage)     |  |
|  +-------------------------------------------+   |  - export / téléchargement |  |
|  | Panneau (src/panel, page d’extension)     |   |  - DesktopSync (WebSocket) |  |
|  |  iframe du drawer OU fenêtre pop-out      |   |  - ExtensionNotion : API   |  |
|  |  - éditeur CodeMirror 6                   |   |    Notion si app fermée    |  |
|  |  - badge sync, export, pin, pop-out       |   +----------------------------+  |
|  +-------------------------------------------+ -- note:save / get --^      |     |
+----------------------------------------------------------------------------|-----+
                                    WebSocket ws://localhost:43117 + jeton   |
                                                                             v
                      BOO NOTES DESKTOP — application séparée (hors de ce dépôt),
                      facultative : protocole décrit dans PROTOCOL.md
```

## Rôles

| Contexte | Fichier d’entrée | Responsabilités |
| --- | --- | --- |
| **Service worker** | `src/background/index.ts` | Reçoit les raccourcis globaux (`chrome.commands`) et le clic sur l’icône ; choisit le lecteur cible ; seul écrivain du stockage (`NoteStore`) ; captures de repli (`captureVisibleTab`) ; export `.md` ; fenêtre pop-out ; **côte à côte** des fenêtres (`src/background/tiling.ts` : la fenêtre de la vidéo et celle des notes se partagent la zone de travail, `chrome.windows.onBoundsChanged` garde la frontière commune, l’état d’avant est rendu à la sortie) ; synchronisation Desktop (`DesktopSync`) ; synchronisation Notion directe quand l’application est fermée (`ExtensionNotion`, `src/background/notion.ts`, même moteur que l’application : `src/shared/notion/`) ; ouverture des `[[liens]]`. |
| **Script de contenu** | `src/content/index.ts` | Adaptateur de plateforme, détection du média (vidéo ou audio) et des navigations SPA, HUD / toasts / flash / marqueur, drawer, capture de frame, progression de lecture, exécution des commandes ; **mode lecture** (`src/content/reader.ts`) pour une page sans média ; **écran partagé** (`src/content/fit.ts`) : le lecteur est réduit (`scale` / `translate`) pour que les notes ne le cachent jamais, ancrées à n’importe quel bord comme en plein écran ; **place du panneau** (`src/content/drawer.ts`, géométrie pure dans `src/shared/placement.ts`) : ancré (droite, gauche, haut, bas), flottant, Mini ; poignée, bords, zones d’ancrage ; place retenue par site (`place:<origine>` dans `chrome.storage.local`) ; **Mini épinglé** dans une fenêtre Document Picture-in-Picture (l’API demande la fenêtre de premier niveau et une activation de l’utilisateur, transmise par le clic dans l’iframe du panneau). |
| **Panneau** | `src/panel/index.ts` | Éditeur de notes ; tourne dans l’iframe du drawer, dans la fenêtre pop-out, ou (`mode=pip`) dans la fenêtre « toujours au-dessus » du Mini. Communique avec le script de contenu de l’onglet vidéo par un *port* ; le script lui dit où il se tient (message `view` : ancré / flottant, Mini, plein écran). Vue Mini : `src/panel/mini.ts` ; menu Disposition / Côte à côte : `src/panel/layout-menu.ts`. |
| **Options** | `src/options/index.ts` | Réglages (`chrome.storage.sync`), état des raccourcis, état de la synchronisation, données (dont « Télécharger en PDF » : toutes les notes, ou un cours). |
| **Diagnostic** | `src/diagnostic/index.ts` | Rapport « Diagnostic de cette page » (clic droit sur l’icône, ou aide du panneau) : le SW (`src/background/diagnostic.ts`) sonde chaque cadre lisible de l’onglet (`chrome.scripting`, monde isolé et monde de la page : cadres, médias, API SCORM, agent), interroge le script de la page et les droits ; `src/shared/diagnostic.ts` en tire un constat en clair et un texte à copier. |
| **Questions et notes libres** | `src/panel/blocks.ts`, `src/panel/answers.ts` | Le **+** au survol d’une ligne et son menu (Question, Note libre, Note normale), l’apparence et la numérotation des blocs (callouts `> [!question]` / `> [!note]`, format dans `src/shared/callouts.ts`) ; la réponse d’une question cherchée dans le cours sans toucher à la vidéo : transcription, texte du cours de l’onglet (requête `course:text` : `chrome.scripting` dans chaque cadre lisible, `src/shared/course-text.ts`), notes du cours ; classement BM25 et requête à l’IA choisie (`src/shared/qa.ts`, `src/shared/ai-client.ts`). Voir [QUESTIONS.md](QUESTIONS.md). |
| **IA (fournisseurs)** | `src/shared/ai-providers.ts`, `src/shared/ai-client.ts`, `src/shared/qa-config.ts` | Le registre : IA de Chrome (`src/shared/chrome-ai.ts`), paliers gratuits Groq, OpenRouter (modèles « :free »), Google Gemini, Mistral, Cerebras, Ollama local, Claude, adresse compatible OpenAI — adresse, clé, conditions du palier gratuit, où créer une clé, modèles suggérés, **caractères de transcription par requête** (`budget`) et **pause entre deux requêtes** (`gapMs`, le rythme du palier). Une requête « chat completions » (ou Messages pour Claude) ; un 429 attendu comme le service l’indique (`retry-after`, « try again in 7.66s », `retryDelay`), au plus 5 fois ; « trop longue » signalée (413, contexte dépassé) pour lire en parties plus petites ; les modèles listés (OpenRouter : gratuits seulement ; embeddings, voix, images écartés). Une clé par fournisseur, gardée quand on en choisit un autre ; l’ancien réglage Claude repris. |
| **Résumé** | `src/shared/summary.ts`, `src/shared/summarizer.ts`, `src/panel/summary-view.ts`, `src/panel/summary-render.ts`, `src/summary/` | **Leçon** : la transcription en répliques (`c12`, une phrase environ, son instant), lue **en entier** — en une requête si elle tient dans le `budget` du fournisseur, sinon par parties (le plan et les phrases clés de chacune), puis réunies ; problématique, objectifs, solution, plan détaillé (2 à 7 parties, chacune son `intro` et ses 3 à 5 points les plus importants : `detail`, `kind` — essentiel, une fois par partie ; définition ; exemple et son `code` ; attention ; point —, demandés par le schéma JSON et vérifiés à la lecture) ; chaque instant cité est une réplique donnée (les autres écartés) ; une réponse illisible redemandée une fois. **Cours** : chaque leçon rangée lue en entier (celles résumées d’après la même transcription gardées), puis la synthèse du cours — avec **toutes les transcriptions** quand elles tiennent en une requête (`full`), sinon d’après les résumés des leçons. Onglet « Résumé » du panneau (« Titres \| Détaillé », retenu dans `localStorage` ; ⤢ ouvre le résumé en grand), page en grand (`summary/summary.html?course=` ou `?note=` ; « Modifier » : `src/summary/edit.ts` édite une copie — textes, sortes, ajouts, déplacements, instants —, « Enregistrer » écrit les résumés changés avec `edited`, puis `summary:note` réécrit le bloc inséré dans la note ; Notion suit par `chrome.storage.onChanged`), bloc `> [!summary]` en tête de la note (`planMarkdown` : ★ / 📘 / 💡 / ⚠️), PDF du résumé seul (`summary:pdf`, `course:summary-pdf` : `lessonDocument`, sans couverture ; les étiquettes en couleur, les marques n’étant pas dans les polices du PDF), première partie du PDF du cours, section « ✨ Résumé IA » des pages Notion (`lessonSummaryBlocks`, `courseBlocks`). |
| **Document hors écran** | `src/offscreen/pdf.ts` | Mise en page des PDF (`src/shared/pdf-notes.ts`, pdf-lib) : le service worker (`src/background/pdf.ts`) rassemble les notes (pour un cours : ses leçons, dans l’ordre des chapitres, et leurs transcriptions) et leurs images, l’ouvre le temps d’un export (`chrome.offscreen`) puis télécharge le résultat. La bibliothèque PDF reste ainsi hors du service worker, que Chrome relance souvent. |

La logique pure est dans `src/shared/` et couverte par les tests unitaires. **Boo Notes Desktop**
est un projet séparé : ce dépôt ne contient que l’extension, qui lui parle par le protocole de
[PROTOCOL.md](PROTOCOL.md) (simulé par `tools/mock-desktop/` pour les tests).

## Médias et sites pris en charge

| Source | Détection | Note |
| --- | --- | --- |
| YouTube, Udemy, Coursera | URL (script déclaré dans le manifeste) | `youtube:<id>`, `udemy:<cours>/<leçon>`, `coursera:<cours>/<leçon>` |
| Page Notion avec un bloc vidéo / audio | `notion.so` / `notion.site` (script déclaré), identifiant de page dans l’URL (`?p=` pour une page ouverte en aperçu) | `notion:<id de page>` |
| Tout autre site (podcast, radio, plateforme de cours) | Injection **à la demande** : icône de l’extension ou `Alt+Shift+N` (`activeTab` + `scripting.executeScript`) ; « Toujours activer ici » demande la permission du site (`optional_host_permissions`) et enregistre un script de contenu dynamique | `web:<hôte><chemin>` (paramètres de suivi `utm_*`, `fbclid`… retirés) |

`MediaController` choisit la plus grande `<video>` visible (celle qui joue d’abord), sinon un
`<audio>` (même caché) qui joue ou a une source ; une vidéo sans image (`videoWidth = 0`) est
traitée comme un audio. Pour un audio, la capture est désactivée (message explicite) ; horodatage,
auto-pause, saut arrière et progression fonctionnent à l’identique.

### Tout flux, toute plateforme

Un lecteur peut cacher son média de quatre façons ; chacune a sa réponse
(`src/content/media-scan.ts`, `player.ts`, `frame.ts`, `media-bridge.ts`) :

| Où est le média | Comment Boo Notes le trouve et le pilote |
| --- | --- |
| Dans la page | `querySelectorAll('video, audio')` à chaque besoin (peu coûteux). |
| Dans un **shadow DOM** (lecteurs en web components), ouvert ou **fermé** | Parcours `TreeWalker` au plus toutes les 0,9 s tant qu’aucun média n’est trouvé ; les racines fermées sont ouvertes par `chrome.dom.openOrClosedShadowRoot` (réservé aux scripts de contenu). Les événements média n’étant pas « composés », un écouteur est posé dans chaque racine rencontrée. |
| **Hors page** (`new Audio()` jamais inséré : podcasts, radios, musique) | `media-bridge.js`, exécuté dans le monde JavaScript de la page (`world: MAIN`, `document_start`), enveloppe `HTMLMediaElement.prototype.play` : un média qui démarre hors du document est déplacé dans un `<boo-media-dock hidden>` — rien d’autre n’est touché, et un média ajouté au document continue de jouer. |
| **Modules de cours dans des cadres** (SCORM, LMS) | `frame.js` + `frame-reading.ts` dans chaque cadre autorisé : sélection et bulle « Citer », titre lu, passages surlignés et retrouvés (`frames:notify` → `notice`), raccourcis de page relayés, cadres imbriqués non autorisés signalés (`event: frames`, poignée de main `booNotesAgent` entre cadres). `media-bridge.js` suit l’objet `API` / `API_1484_11` du LMS (valeurs `cmi.*` : statut, progression, score, repère) et les déclarations xAPI (`/statements`) : `src/shared/scorm.ts`. |
| **Sous-titres téléchargés par le lecteur** (YouTube avec son jeton, WebVTT / SRT / TTML / JSON des lecteurs HLS, DASH, Vimeo, Wistia…) | `media-bridge.js` observe aussi les réponses `fetch` / `XMLHttpRequest` qui ressemblent à des sous-titres (adresse ou type), en lit une **copie** (le lecteur reçoit la sienne intacte) et la passe au script de contenu du même cadre (`CustomEvent` au texte JSON, `src/shared/caption-bridge.ts`) ; les derniers fichiers sont gardés pour un script qui démarre après eux. Dans un lecteur intégré, `frame.js` relaie piste, fichiers et lignes affichées à la page (message `captions`). |
| Dans une **iframe** d’un autre site (Vimeo, Kaltura, Panopto, Wistia, YouTube intégré…) | `frame.js` (agent sans interface, `all_frames`) trouve le média de l’iframe et ouvre un port `boo-notes-frame` vers le service worker, qui relaie son état (`frame:media` : lecture, position, cadre de l’image) au script de la page et lui transmet lecture / pause / saut / capture (`frame:command`). L’agent poste aussi un jeton à la page parente, qui retrouve ainsi l’élément `<iframe>` (`contentWindow === event.source`) pour dessiner le HUD et recadrer une capture de l’onglet. Plusieurs cadres de profondeur (leçon Databricks : Docebo → lanceur SCORM → pilote SCORM → contenu Articulate Rise) : chaque agent intermédiaire relaie ce « bonjour » vers le haut en y ajoutant la place du cadre enfant dans le sien (`src/shared/frame-hello.ts`), et la page place le média à travers toute la chaîne. |

Les iframes d’un site non autorisé ne peuvent pas recevoir l’agent : le script de la page repère
celles qui ressemblent à un lecteur (hôtes connus, `allowfullscreen`, `allow="autoplay…"`) et le
panneau propose **« Autoriser »** (permission facultative de l’hôte, demandée depuis le panneau —
un geste de l’utilisateur est requis) ; l’agent est alors injecté (`scripting.executeScript` avec
`allFrames`) et enregistré pour les visites suivantes (`registerContentScripts`, `allFrames`).
Les sites « toujours actifs » reçoivent aussi le pont et l’agent.

**Chronomètre.** Quand aucun script ne peut lire le flux (lecteur protégé dessiné dans un
`<canvas>`, application native, cours en salle), le panneau propose un **chronomètre** : la source
de temps devient une horloge démarrée à la main (`MediaSource = 'stopwatch'`) ; horodatages,
chronologie et saut d’un horodatage (qui recale l’horloge) fonctionnent comme pour un média. La
progression n’est alors pas enregistrée.

**Classement.** Le panneau range la note dans un cours › chapitre (`note:place`), parmi les cours de
l’application (`library.courses`) et ceux déjà utilisés dans le navigateur ; le classement voyage
avec la note (`course`, `chapter`, `placedAt`) vers l’application et Notion.

**Mode lecture.** Sur Notion et les sites génériques (`requiresMedia`), une page **sans** média est
notée comme un document (`kind: "page"`), dès que l’utilisateur ouvre les notes :

- `Alt+Shift+T` (ou la bulle « Citer » affichée près de la sélection quand les notes sont ouvertes)
  écrit `> passage [↗](URL#:~:text=début,fin)` ; sans sélection, la ligne est ancrée à la section
  lue (`[↗ Titre](URL#:~:text=Titre)`) ; `Alt+Shift+S` capture la partie visible de la page.
- Les passages de la note sont retrouvés dans la page (index du texte sans espaces ni casse,
  `TreeWalker`, balises en ligne et limites de blocs ignorées) et **surlignés** avec la *CSS Custom
  Highlight API* : aucun élément de la page n’est modifié, seule une feuille `::highlight()` est
  ajoutée. Ils sont relus depuis `chrome.storage` (surlignage même panneau fermé, à chaque visite)
  et réessayés quand l’application affiche son contenu en différé (Notion).
- Page → note : pendant le défilement, la ligne de la note qui cite le passage lu est surlignée.
  Note → page : un clic sur `↗` fait défiler jusqu’au passage et le fait clignoter (dans un autre
  onglet s’il s’agit d’une autre page : le navigateur interprète lui-même `#:~:text=`).
- La progression est le point le plus loin atteint (`position` 0–100, `duration` 100), mesurée sur
  le document ou le conteneur défilant principal (Notion ne fait pas défiler le document).

La **progression** (position / durée) d’un média qui a une note est enregistrée à la pause, à la
fin, après un saut, toutes les 15 s de lecture et à la fermeture de la page, puis envoyée à
l’application Desktop (`media.progress`).

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

### Flow 3 — transcription et passages

```
lecture ─► content script (toutes les 300 ms) : SubtitleCollector
  1. video.textTracks (piste masquée chargée, jamais affichée par nous)   → liste complète
  2. YouTube : "captionTracks" de la page → timedtext &fmt=json3           → liste complète
  3. sinon : lignes de sous-titres affichées (sélecteurs par lecteur)      → applyLiveSample
  ─► transcript:put (liste entière, ou répliques nouvelles) ─► SW TranscriptStore
     (gardé si la note existe ou si le panneau est ouvert ; une meilleure source remplace
      la précédente en gardant traductions et commentaires)
  ─► panneau : 'caption' (réplique en cours → bandeau), storage → onglet Transcription
fin du média ─► panneau : ligne 📄 épinglée (sinon transcript:pin par le SW)

Alt+I ─► captureStream() + MediaRecorder (image + son, ou son) ; première image
Alt+O ─► asset:save (image) + media:chunk… / media:commit (IndexedDB « boo-notes-media »)
      ─► panneau : 'insert-passage' → "[02:05–06:07] ![Passage …](assets/…) [Extrait](media/…)"
```

Les transcriptions (`transcript.put`) et les enregistrements (`media.chunk` / `media.put`) partent
vers l’application après les notes ([PROTOCOL.md](PROTOCOL.md)).

## Routage multi-onglets (« un seul lecteur actif »)

Le SW tient dans `chrome.storage.session` la liste des onglets lecteurs et l’**onglet actif** : le
dernier ayant reçu une interaction (clic, touche, ouverture de vidéo). Une commande est envoyée à :

1. la vidéo de la fenêtre pop-out, si la pop-out a le focus ;
2. l’onglet courant s’il affiche une vidéo prise en charge ;
3. **ouvrir les notes** (icône, `Alt+Shift+N`) : l’onglet courant, où Boo Notes démarre s’il le
   peut — une leçon SCORM ou un article pas encore suivis compris (auparavant, la commande partait
   vers la vidéo d’un autre onglet et rien ne se passait sur la page affichée) ;
4. sinon le lecteur actif (capture / saut arrière sans changer d’onglet ; horodatage et Smart
   Pause ramènent l’onglet au premier plan ; ouvrir les notes depuis une page où Boo Notes ne peut
   pas tourner, comme un nouvel onglet, ramène à la vidéo).

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
| `note:<noteId>` | `{ id, platform, url, title, markdown, createdAt, updatedAt, rev, lastWriter, course?, chapter?, placedAt? }` |
| `asset:<path>` | capture (data URL), dimensions, temps vidéo |
| `notes:index` | résumé de chaque note (page d’options) |
| `sync:outbox` | `{ noteId: rev }` en attente d’acquittement Desktop |
| `sync:assets` | captures déjà envoyées |
| `progress:<noteId>` | dernière position de lecture `{ position, duration, updatedAt }` |
| `sync:progress` | positions pas encore envoyées à l’application Desktop |
| `sites:enabled` | origines où Boo Notes s’active à chaque visite |
| `notion:config` | connexion Notion (jeton — secret ou accès OAuth `via: 'oauth'` —, table, coffre : page, nom, adresse ; origine : `desktop` ou `extension`) |
| `notion:link:<noteId>` | page Notion de la note, empreintes de ses blocs (synchro incrémentale), cours où elle est listée |
| `notion:course:<clé>` | page d’un cours dans le coffre (`course:<titre normalisé>`, `unfiled` : notes à ranger) et blocs écrits |
| `notion:pending` | notes à écrire dans Notion (application fermée) |
| `qa:config` | l’IA des questions et des résumés : le fournisseur choisi et, pour chacun, `{ key, model, base? }` ; jamais synchronisé |
| `summary:<noteId>` | résumé d’une leçon : problématique, objectifs, solution `{ text, at[] }`, plan `{ title, at, intro?, children: [{ title, at, detail, kind, code? }] }` (un résumé d’avant : titres seuls), `edited` (modifié à la main : quand), la transcription lue (`basis` : répliques, fin, complète — « à mettre à jour » quand elle change), fournisseur, modèle, parties |
| `course-summary:<cours normalisé>` | résumé d’un cours : problématique, objectifs (avec leur chapitre), solution, chapitres › leçons (synthèse, état), transcription lue de chaque leçon, `full` (toutes lues ensemble) |
| `desktop:titles` | titres de la bibliothèque Desktop (complétion `[[`) |
| `desktop:courses` | cours et chapitres de la bibliothèque Desktop (classement depuis le panneau) |
| `players:allowed` | hôtes de lecteurs intégrés autorisés (agent injecté dans leurs iframes) |
| `transcript:<noteId>` | transcription : langue, source, répliques `{ id, start, end, text, tr?, note? }`, parts regardées |
| `sync:transcripts` | `{ noteId: rev }` transcriptions en attente d’acquittement Desktop |

Les **extraits de passages** et le **son conservé** (trop volumineux pour `chrome.storage`) vivent
dans IndexedDB (`boo-notes-media`, origine de l’extension, partagée par le SW et le panneau).

`noteId` : `youtube:<id>`, `udemy:<cours>/<leçon>`, `coursera:<cours>/<item>`, `notion:<page>`,
`web:<hôte><chemin>` — une note par vidéo, audio ou page.
Les écritures passent toutes par le SW et sont sérialisées ; `rev` croît à chaque sauvegarde, ce
qui permet à un second éditeur (pop-out) d’ignorer ses propres échos et d’appliquer les autres.

`chrome.storage.session` : état de routage (lecteurs, onglet actif, pop-outs), statut de
synchronisation lu par « Se connecter à… », et `notion:grant` — la réponse de la fenêtre de Notion
le temps de choisir le coffre (15 min au plus, en mémoire, jamais écrite sur disque).
`chrome.storage.sync` : réglages.

**Une note par leçon.** L’identité d’une note est celle de ce qui est étudié : vidéo, leçon
Udemy / Coursera, page (paramètres de suivi retirés), et pour les cours d’une seule page la route
de l’adresse quand elle nomme une leçon (`#/lessons/…`, `#/module/2` — pas une diapositive ni `#/home`). Un module de cours affiché dans un cadre (Articulate Rise…) change
de leçon dans le cadre sans changer l’adresse de la page : son agent de cadre annonce la route et
le titre de la leçon (`{ kind: 'route' }`), et la note devient `<note de la page>#lesson/<route>` —
deux leçons du même module ne partagent jamais une note (ni son classement cours › chapitre).

## Robustesse

- **Une seule instance du script de contenu par onglet** : à l’installation, le service worker
  réinjecte le script dans les onglets déjà ouverts, ce qui peut doubler l’injection déclarative.
  Une copie vivante dans le même monde isolé est conservée ; une copie d’une version précédente
  (autre monde) est démontée via l’événement `boo-notes:teardown`, et le démarrage s’interrompt si
  ce démontage survient pendant une étape asynchrone.
- **Plein écran** : Chrome ne dessine que l’élément plein écran et ses descendants, et rend tout
  le reste inerte (même un *popover* de la top layer, visible, n’y reçoit aucun clic). Le drawer
  et le HUD sont donc déplacés dans cet élément, qui est réduit par `scale` / `translate` (Chrome y
  force `transform: none`, pas ces propriétés) ; le drawer et le HUD reçoivent la transformation
  inverse (boîte fixe couvrant l’élément) et gardent taille et place. Une `<video>` ou une iframe
  seule en plein écran ne peut rien contenir : notes ouvertes, Boo Notes quitte ce plein écran et
  le redemande pour son parent tant que l’activation du clic de l’utilisateur est valable.
- **Notes toujours visibles** : la page peut afficher sa leçon dans la *top layer* (élément plein
  écran, `<dialog>` modale, popover), au-dessus de tout z-index et rendant le reste inerte. Le script
  de la page suit cette couche (toutes les 0,7 s et à chaque changement de plein écran) et y place le
  panneau et le HUD. Il vérifie aussi que le panneau ouvert est bien ce que la page montre à cet
  endroit (`elementFromPoint`) : recouvert, il repasse au premier plan ; toujours recouvert (ou son
  cadre jamais chargé), les notes s’ouvrent dans la fenêtre détachée.
- **Cadre du cours seul en plein écran** (Docebo / Databricks : « Développer la vue de la leçon ») :
  seul ce cadre est à l’écran. Si l’agent Boo Notes y tourne (demandé à l’instant par `postMessage`
  s’il ne s’est pas encore annoncé), le script de la page lui demande d’afficher le panneau des notes
  chez lui (`notice: notes-host`, redemandé tant que le panneau ne s’est pas connecté) : c’est le même
  panneau (`panel.html?tab=…`), relié au script de la page par son port, le panneau de la page
  s’effaçant. Quand le plein écran se termine, les notes reviennent dans la page. Un panneau retiré
  envoie ses dernières modifications aussitôt (`pagehide`), sans file d’attente. Un cadre sans agent
  (ou une vidéo seule) en plein écran laisse la place à son conteneur.
- **Ancré, la page entière se décale** : la marge sur `<html>` ne déplace pas les éléments fixés à la
  fenêtre. Ceux qui sont calés sur le bord de l’ancrage (la colonne « Contenu du cours » d’Udemy :
  sans cela cachée sous les notes, sa place réservée restant vide à côté de la vidéo) sont trouvés
  par `elementsFromPoint` le long de ce bord et décalés de la taille des notes (`left` / `right` en
  ligne, rendus tels quels ensuite ; `src/content/edges.ts`, revu chaque seconde tant que les notes
  sont ancrées). Les éléments sur toute la largeur et le lecteur sont laissés de côté.
- **Un seul plein écran partagé** : le bouton ⤢ du panneau met **le lecteur lui-même** en plein écran,
  comme le bouton du site (son conteneur seulement pour une vidéo nue ou un cadre, qui ne peuvent
  pas contenir les notes) ; un site qui met **toute la page** en plein écran (Udemy) voit son lecteur
  ajusté de la même façon, avec un fond noir autour (`box-shadow`, retiré ensuite). Dans les trois
  cas le lecteur, déjà à la taille de l’écran, est réduit dans la place libre et centré : la vidéo
  la remplit.
- **Panneau déplacé** : la poignée, les bords et les zones d’ancrage sont dans le Shadow DOM du
  drawer, au-dessus de l’iframe (un geste commencé dans l’iframe n’arriverait pas à la page) ; le
  pointeur est capturé (`setPointerCapture`) et l’iframe ignore la souris pendant le geste. Les marges
  posées sur `<html>` (un côté à la fois) sont gardées et rendues telles quelles. Une place retenue
  est ramenée dans la fenêtre si celle-ci a rétréci.
- **Côte à côte désactivé** (`TILING_ENABLED = false`, `src/shared/tiling.ts`) : sous Windows 11,
  la fenêtre de la vidéo aimantée par le système bougeait encore malgré les garde-fous ci-dessous. Ni
  le menu « Disposition du panneau » ni la fenêtre des notes ne le proposent, le service worker
  n’écoute plus `chrome.windows.onBoundsChanged` et refuse `tile:set` : aucune fenêtre n’est
  surveillée ni déplacée. Le `Tiler` et ses tests (unitaires) restent ; les tests de bout en bout du
  côte à côte sont sautés tant que l’interrupteur est à `false`.
- **Côte à côte** : Chrome refuse une fenêtre à moins de 50 % sur un écran ; rendue à sa taille
  d’avant hors de l’écran actuel, la fenêtre de la vidéo y est ramenée (`within`).
- **Côte à côte sans tremblement** : Boo Notes ne se bat jamais avec l’utilisateur ni avec le système
  pour la place des fenêtres. Les changements d’une fenêtre sont lus une fois la fenêtre immobile
  (150 ms : un glisser en rapporte des dizaines). Après qu’il a placé une fenêtre, sa mise en place
  par le système (bordures invisibles, arrondis, largeur minimale d’une fenêtre Chrome ≈ 510 px)
  est prise telle quelle pendant 800 ms, jamais « suivie ». Seul un glisser de la **frontière
  commune** (le bord intérieur bouge, le bord extérieur et la hauteur restent) est suivi par l’autre
  fenêtre ; une fenêtre déplacée, aimantée ailleurs ou agrandie veut dire que l’utilisateur range ses
  fenêtres autrement : Boo Notes lâche le côte à côte (plus rien ne bouge tout seul) et le dit dans
  la fenêtre des notes. Si le bord d’une fenêtre **revient là où il était** il y a moins de 6 s
  (1/2 → 2/3 → 1/2 : le système la tient à cette place), ou si la frontière bouge encore et encore
  (plus de 3 suivis en 4 s : le système aimante aussi, avec une autre idée de « bord à bord »), il
  lâche aussi, sans rien déplacer. Une fois les deux fenêtres posées (≈ 1 s), Boo Notes regarde où
  elles sont **vraiment** : si le système a gardé la fenêtre de la vidéo ailleurs (Windows tient une
  fenêtre aimantée à sa moitié), les notes se rangent à côté d’elle, **une fois** — plus de trou où
  l’on voit une autre fenêtre — et la vidéo n’est plus jamais redimensionnée par Boo Notes ; la
  fenêtre des notes l’explique (détacher la vidéo de l’aimantation avant de choisir une autre
  répartition). Décision pure : `judgeChange`, `innerEdge` (`src/shared/tiling.ts`) ; vérifié
  contre un gestionnaire de fenêtres simulé (`tests/unit/tiling-stability.test.ts`, et
  `tests/unit/tiling-held.test.ts` : la vidéo tenue à 1/2, la vidéo qui bascule seule 1/2 ↔ 2/3)
  et dans un vrai Chrome sous un gestionnaire de fenêtres (`tests/e2e/tiling-wm.spec.ts`, à lancer
  avec `TILING_WM=1` sous Xvfb + openbox).
- L’éditeur n’est jamais bloqué par la synchronisation : sauvegarde locale d’abord, envoi ensuite.

## Sécurité

- Le port du panneau n’est accepté que depuis l’extension elle-même (`sender.id`).
- Les pages ne peuvent pas envoyer de messages à l’extension (`externally_connectable` absent).
- Le panneau est *web accessible* sur tous les sites (il doit pouvoir s’afficher sur un site activé
  à la demande) : un site peut donc détecter que l’extension est installée. `use_dynamic_url` éviterait
  cette détection mais empêche l’écriture dans le presse-papier depuis le panneau (constaté sur Chromium 141).
- Aucun site n’est lu sans action de l’utilisateur : hors YouTube / Udemy / Coursera / Notion, le
  script n’est injecté qu’après un clic sur l’icône ou un raccourci (`activeTab`), ou sur un site
  explicitement autorisé (« Toujours activer ici », permission révocable dans les réglages).
- L’adresse Desktop est limitée à `localhost` / `127.0.0.1` ; jeton d’appairage ; l’application doit
  vérifier l’en-tête `Origin: chrome-extension://…` (voir [PROTOCOL.md](PROTOCOL.md)).
- Notion : seule permission d’hôte ajoutée, `https://api.notion.com/*` (l’API n’accepte pas les
  requêtes CORS des pages). Le secret n’est lu que par le service worker ; les sites n’ont pas accès à
  `chrome.storage` de l’extension.
- « Connecter Notion » : permission `identity` (`chrome.identity.launchWebAuthFlow`, retour sur
  `https://<id>.chromiumapp.org/notion`, paramètre `state` vérifié). Le *client secret* de
  l’intégration publique n’est jamais dans l’extension : `tools/notion-oauth/worker.mjs`
  (Cloudflare Worker) échange le code (`/token`), renouvelle un accès expiré (`/refresh`, sur une
  réponse 401) et le retire à la déconnexion (`/revoke`) ; il n’accepte qu’une adresse de retour
  `chromiumapp.org` (liste d’extensions autorisées possible) et ne conserve rien.
- Les icônes sont construites en DOM (pas d’`innerHTML`), compatible Trusted Types (YouTube).
- `media-bridge.js` s’exécute dans le monde de la page mais ne lit ni n’envoie rien : il déplace
  seulement un média qui joue hors du document dans un élément caché. Les agents d’iframe parlent au
  service worker par un port (`sender.frameId` fait foi) ; le seul message visible des scripts de la
  page est le jeton posté à la page parente, qui ne sert qu’à situer l’`<iframe>` à l’écran.
