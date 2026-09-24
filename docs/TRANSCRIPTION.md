# Transcription, traduction, passages et piste audio

> **L’idée.** Pendant qu’une vidéo ou un audio de cours joue, Boo Notes recopie en arrière-plan
> ses **sous-titres horodatés** dans un document à part — la **transcription** — sans jamais
> toucher à votre prise de notes. Sur cette transcription, vous **traduisez** (en français par
> défaut) et **commentez** chaque réplique ; une phrase importante s’**épingle** dans vos notes en
> un geste. Vous pouvez **conserver le son** du cours et **extraire un passage** (par exemple
> 02:05 → 06:07) avec son image, son son, ses sous-titres et les notes prises pendant ce
> passage. À la fin de la lecture, la transcription est **épinglée** à votre note.

![Onglet Transcription du panneau : répliques traduites et commentées, suivi de la lecture](screenshots/panel-transcript.png)

## 1. Ce que vous faites, ce que Boo Notes fait

| Moment | Vous | Boo Notes, en arrière-plan |
| --- | --- | --- |
| La vidéo démarre | Vous prenez vos notes comme d’habitude (`Alt + Maj + N`) | Trouve les sous-titres du cours et remplit la transcription (onglet **Transcription · 312**) |
| Pendant la lecture | Vous écrivez ; une phrase du prof vous intéresse | Le **bandeau de sous-titre** sous vos notes montre la réplique en cours et sa traduction ; `Ctrl/⌘ + Maj + K` (ou **⊕**) la cite dans la note, horodatée |
| Un passage clé commence | `Alt + I` (**Début du passage**, bouton ⧗) | Pose le point d’entrée ; enregistre image et son à partir de là (pastille **REC**) |
| Le passage se termine | `Alt + O` (**Fin du passage**) | Ajoute la **carte du passage** 02:05–06:07 à la note, avec son **extrait** enregistré |
| Plus tard | Onglet **Transcription** (`Alt + T`) : traduire, commenter, choisir deux répliques → **Créer le passage** | Garde tout dans la transcription, jamais dans vos notes personnelles |
| Fin de la vidéo (ou page quittée) | — | Épingle la transcription en bas de la note : `📄 Transcription — anglais → français · 312 répliques` |

Deux principes :

1. **Vos notes restent les vôtres.** Les sous-titres vivent dans un document à part ; ils
   n’entrent dans la note que quand vous le décidez (épingler une réplique, créer un passage) ou,
   à la fin, sous la forme d’une seule ligne-pièce jointe.
2. **Rien ne bloque la saisie.** Capture, traduction et enregistrement tournent sans voler le
   focus ; tout est réversible (supprimer la ligne épinglée, la carte du passage…).

## 2. Interface

### Panneau de l’extension

```
┌──────────────────────────────────────────┐
│ (● Connecté)  ● REC        ⧉ ⇪ 📌 ✕      │  REC : son ou passage en cours d’enregistrement
│ Maths › Analyse                          │  cours › chapitre
│ Théorème de Stokes — Cours 7             │
│ YouTube   2 notes · 1 passage  Enregistré│
│ [ Notes │ Transcription 312 ]            │  onglets (Alt+T)
├──────────────────────────────────────────┤
│ 02:05  Définition de la circulation      │  vos notes (inchangées)
│ ┌──────────────────────────────────────┐ │
│ │ Théorème de Stokes · 4 min        [≣]│ │  carte « passage » : première image,
│ │               ▶                      │ │  titre (votre première note du passage,
│ │ 02:05–06:07        ▶ Revoir le passage│ │  sinon la première réplique), durée ;
│ └──────────────────────────────────────┘ │  [≣] : lire sa transcription
│ 🔊 Extrait                                │  l’extrait enregistré, lu dans le panneau
├──────────────────────────────────────────┤
│ 04:12 the curl of F through S…        ⊕  │  bandeau de sous-titre en direct
│       le rotationnel de F à travers S…   │  (clic : ouvre la transcription)
├──────────────────────────────────────────┤
│ ▶ 04:12 ──|──[■■■■]──|────────── 12:30   │  chronologie : [■■] passage, ▁ son conservé
│ [⏱ Horodater] [📷] [⧗]            🔗 ↺ ⌨ │  ⧗ : début / fin du passage
└──────────────────────────────────────────┘
```

![Carte d’un passage, son extrait et le bandeau de sous-titre](screenshots/panel-passage.png)

**Onglet Transcription** (le « fichier en back-office »), qui suit la lecture comme un karaoké :

- **Clic** sur une heure : la vidéo y saute. **Survol** d’une réplique : ⊕ l’épingler dans la
  note (avec sa traduction), 文A la traduire à la main, 💬 la commenter, ⧗ début / fin d’un
  passage (ou **Maj + clic** sur une seconde heure) → barre **Créer le passage 02:05–06:07 ·
  18 répliques · 3 notes**, avec ou sans **Enregistrer l’extrait** (la lecture rejoue le passage
  et l’enregistre ; vous continuez d’écrire).
- **Suivre la lecture** : la réplique en cours reste visible ; si vous faites défiler, le suivi se
  met en pause (**↓ Revenir à 04:12**).
- **Traduire** (interrupteur) **vers** la langue de votre choix (liste à côté : français,
  anglais, espagnol…) : anglais → français, français → anglais… à votre convenance. Traduction
  **sur l’appareil** (Chrome 138 et plus, aucun envoi à un service tiers), réplique par réplique à
  mesure qu’elles arrivent, en commençant par le moment regardé ; la langue des sous-titres est
  détectée si besoin. Des sous-titres **déjà** dans la langue choisie ? L’onglet propose l’autre
  sens en un clic (« Traduire en anglais »). Changer de langue retraduit tout. Chaque traduction
  reste modifiable (clic dessus). Sans traduction automatique, 文A traduit une réplique à la main.
- **Lire la transcription d’un passage** : l’icône [≣] en haut à droite de la carte d’un passage
  (et celle du lecteur de l’extrait) ouvre l’onglet sur ses répliques, surlignées, avec
  **▶ Lire le passage** (la vidéo le rejoue et s’arrête à sa fin).
- **Aucun sous-titre encore ?** L’onglet l’explique et propose **Afficher les sous-titres** : le
  bouton CC du lecteur est activé pour vous, et le fichier que le lecteur télécharge alors devient
  la transcription complète.
- **Recherche** (🔍) dans le texte, les traductions et les commentaires ; **📌** épingle la
  transcription à la note tout de suite.
- **Capture en direct** : la part de la vidéo regardée avec les sous-titres affichés
  (« 38 % capturé »).

### Application Desktop

La note d’une vidéo ou d’un audio a les mêmes onglets **Notes │ Transcription** (même vue), le
même **bandeau de sous-titre** sous les notes, le même bouton **Passage** (`Alt + I` / `Alt + O`),
le même enregistrement des extraits, la même lecture d’un intervalle (et les passages en bandes
sur la barre de lecture), et la transcription s’épingle à la note à la fin de la vidéo. Une vidéo importée avec ses sous-titres à côté (`cours.mp4` +
`cours.vtt`, `cours.en.srt`…) a sa transcription d’office ; **＋ Ajouter des sous-titres**
importe un `.vtt` / `.srt` (les traductions et commentaires suivent le moment dont ils parlaient).
La transcription d’une note du navigateur s’y **lit** (les annotations se font dans l’extension).

![Transcription d’une vidéo locale dans l’application](screenshots/desktop-transcript.png)

## 3. D’où viennent les sous-titres

Par ordre de préférence, sans configuration :

| Source | Plateformes | Couverture |
| --- | --- | --- |
| **Pistes de sous-titres du lecteur** (`video.textTracks`, WebVTT) | Coursera, lecteurs video.js / Plyr / JW / hls.js, la plupart des plateformes d’école, vidéos Notion — **y compris dans un lecteur intégré** (iframe) | Toute la vidéo, dès le début (les flux HLS : au fil du chargement) |
| **Fichiers de sous-titres téléchargés par le lecteur** (WebVTT, SubRip, TTML, YouTube json3 / srv3, sous-titres en JSON type Wistia) | YouTube (avec le jeton du lecteur), Vimeo, Wistia, lecteurs HLS / DASH, lecteurs maison — dans la page ou dans un lecteur intégré | Toute la vidéo (ou morceau par morceau pour un flux) |
| **Liste de sous-titres de la plateforme** | YouTube : le fichier de sous-titres, sinon la transcription de la vidéo (panneau « Afficher la transcription ») — manuels, sinon automatiques de la langue parlée | Toute la vidéo |
| **Capture en direct** des sous-titres affichés | YouTube, Udemy, video.js, Plyr, JW, Shaka, MediaElement… et tout lecteur qui dessine ses sous-titres par-dessus la vidéo (reconnus à leur place et à leur nom), lecteurs intégrés compris | Ce qui est joué sous-titres affichés (« 38 % capturé ») |
| **Fichier** `.vtt` / `.srt` | Application : fichier voisin de la vidéo, ou **＋ Ajouter des sous-titres** | Tout le fichier |

**YouTube** refuse désormais son fichier de sous-titres sans le jeton que seul son lecteur possède :
Boo Notes lit donc (1) le fichier que le lecteur télécharge lui-même quand les sous-titres sont
affichés — même avant l’ouverture du panneau —, (2) sinon la transcription de la vidéo (comme le
panneau « Afficher la transcription » de YouTube), (3) sinon ce qui s’affiche à l’écran. Une
vidéo sans aucun sous-titre est signalée comme telle.

Une meilleure source remplace la précédente en gardant vos traductions et commentaires ; une
capture en direct n’écrase jamais un fichier de sous-titres. Rien n’est gardé pour une vidéo
**sans note** : la transcription n’est enregistrée qu’une fois la note créée ou le panneau ouvert.

Un audio sans sous-titres (podcast, enregistrement d’amphi) n’a pas de transcription ; le son
conservé garde la trace du cours, et une reconnaissance vocale locale pourra s’y brancher (la
transcription est une source interchangeable).

## 4. Son du cours et extraits

- **Conserver l’audio du cours** (options de l’extension) : le son des médias notés est
  enregistré pendant la lecture, par segments (une pause, un saut ou 10 minutes = un nouveau
  segment), en Opus 48 kb/s (≈ 20 Mo par heure). La chronologie montre les parties conservées ;
  dans la transcription, 🔊 réécoute une réplique. Les segments rejoignent le dossier de notes de
  l’application (`media/`).
- **Extrait d’un passage** : image et son (vidéo WebM) ou son seul (audio).
  - *En direct* : entre **Début** et **Fin du passage**, pendant que vous regardez (l’enregistrement
    suit la lecture : rien n’est enregistré pendant une pause).
  - *Après coup* : depuis la transcription, **Enregistrer l’extrait** rejoue l’intervalle et
    l’enregistre (la durée du passage).
- Les extraits se lisent dans le panneau (🔊 **Extrait**), dans l’application, et partent dans
  l’export.
- **Revoir un passage** : clic sur sa carte, ou sur n’importe quel intervalle `[02:05–06:07]`
  écrit dans la note — la lecture s’arrête à la fin.

> Les lecteurs protégés (DRM : certains cours Udemy, Netflix…) interdisent d’enregistrer leur
> image et leur son : la carte du passage est alors dessinée, et les sous-titres et les notes
> fonctionnent quand même. Usage personnel d’étude : respectez les conditions de la plateforme.

## 5. Formats

**Dans la note** (Markdown, lisible partout) :

```markdown
[02:05] Définition de la circulation
> [04:12] « the curl of F through S » — *le rotationnel de F à travers S*
[02:05–06:07] ![Passage 02:05–06:07 · Théorème de Stokes](assets/youtube-abc-02-05-k3j2.jpg) [Extrait](media/youtube-abc-passage-02-05-x7q.webm)

📄 [Transcription — anglais → français · 312 répliques](transcripts/youtube-abc.md)
```

- `[02:05–06:07]` (tiret court ou trait d’union) est un **intervalle** : clic = revoir le passage.
- La ligne `📄 [Transcription…](transcripts/…)` est la pièce jointe épinglée ; un clic ouvre
  l’onglet Transcription.

**La transcription** : `transcripts/<note>.json` (langue, source, et pour chaque réplique `start`,
`end`, `text`, `tr` — la traduction —, `note` — votre commentaire), et pour les humains et les
lecteurs `transcripts/<note>.md`, `.vtt` et `.fr.vtt` (la traduction).

**Dans Notion** : chaque passage est une image légendée « Passage 02:05–06:07 · titre » ; la
transcription devient une section **Transcription** en fin de page (heure liée à l’instant de la
vidéo, réplique, traduction en italique, 💬 commentaire).

**À l’export** : fiches de révision (chaque passage avec les notes prises et les répliques dites
pendant lui), Markdown (`transcripts/`, `media/`), JSON (`passages` avec `notes` et `said`,
`transcript` complet) pour générer des QCM.

**Copier la note** (menu ⇪ du panneau, bouton ⧉ de l’application) met **toute la note** dans le
presse-papier, à coller dans Obsidian, Notion, Google Docs, Word, un mail… :

| Élément | Markdown (Obsidian, éditeurs de texte) | HTML (Notion, Docs, Word…) |
| --- | --- | --- |
| Titre, source, cours › chapitre | `# Titre`, lien de la vidéo | titre, lien |
| Horodatages `[04:15]`, intervalles `[02:05–06:07]` | liens vers l’instant de la vidéo | liens vers l’instant |
| Captures d’écran, images, cartes des passages | **intégrées** (`data:image/…`) : visibles sans aucun fichier | **intégrées** dans la page |
| Extrait enregistré d’un passage | lien **▶ Revoir le passage** (à la source) | la légende de la carte est ce lien |
| Citations de sous-titres, `[[liens]]`, `==surlignage==` | conservés tels quels | citation, gras, surligné |
| Transcription (📄) | section **Transcription** : heure liée, réplique, *traduction*, 💬 | idem |

Les extraits vidéo, trop lourds pour un presse-papier, voyagent avec **Télécharger** (extension :
dossier `.md` + `assets/` + `media/` + `transcripts/`) ou l’**export Markdown** de l’application :
glissé dans un coffre Obsidian, tout s’affiche et se lit.

### Copier / coller dans les notes (extension et application)

**Coller** (`Ctrl/⌘ + V`) ou **glisser-déposer** dans une note :

| Ce qui est collé | Ce que devient la note |
| --- | --- |
| Une **image** : capture d’écran (Impr. écran, `Win + Maj + S`, `⌘ + Maj + 4`), « Copier l’image » d’un site, fichier image | enregistrée avec les captures (`assets/…`, réduite à 2400 px au plus) ; pendant une vidéo, à l’instant de la vidéo : `[04:12] ![Image collée 04:12](assets/…)`, une carte comme une capture |
| Une **vidéo** ou un **audio** (fichier `.mp4`, `.webm`, `.mov`, `.mp3`, `.m4a`, `.wav`…, jusqu’à 500 Mo) | gardé avec la note (`media/…`, envoyé à l’application Desktop) : `[04:12] [🎬 cours.mp4](media/…)` ; un clic le lit au-dessus des notes, **⤓** le télécharge |
| Du **texte mis en forme** (page web, Notion, Google Docs, Word, un mail…) | Markdown : titres, gras, italique, surligné, barré, listes et cases à cocher, citations, code, tableaux, liens ; ses **images** sont enregistrées dans la note (celles qu’un site refuse de céder restent en ligne, affichées) ; vidéos, audios et vidéos intégrées (YouTube, Vimeo, Loom) deviennent des liens |
| Une **partie d’une autre note** Boo Notes | telle quelle : mêmes captures, cartes de passage, extraits et transcription ; ses horodatages deviennent des liens vers les instants de **sa** vidéo (un clic l’ouvre) |
| Du texte simple | comme d’habitude |

Pendant l’enregistrement d’un fichier, un repère « Import de … » tient sa place dans la note : vous
continuez d’écrire.

**Copier** (`Ctrl/⌘ + C`, ou couper) une **partie** de la note met dans le presse-papier, comme
« Copier la note » mais sans titre : Markdown et HTML avec les **images intégrées**, horodatages
liés à l’instant de la vidéo — et le format de Boo Notes, pour la coller telle quelle dans une autre
note. **Copier l’image** (au survol d’une carte) met l’image elle-même (PNG), à coller dans
n’importe quelle application. Une **vidéo** ne passe pas par le presse-papier d’un navigateur : son
lecteur propose **⤓ Télécharger le fichier**.

## 6. Raccourcis

| Action | Raccourci |
| --- | --- |
| Épingler la réplique en cours dans la note | `Ctrl/⌘ + Maj + K` (panneau, application) |
| Début / fin du passage | `Alt + I` / `Alt + O` (page vidéo, panneau, application ; modifiables dans `chrome://extensions/shortcuts`) |
| Basculer Notes / Transcription | `Alt + T` (panneau, application) |
| Fermer le lecteur d’extrait | `Échap` |

## 7. Réglages (options de l’extension)

| Réglage | Par défaut |
| --- | --- |
| Transcrire les sous-titres en arrière-plan | activé |
| Traduire les sous-titres | désactivé (l’interrupteur de l’onglet le mémorise) |
| Traduire vers | français (anglais, espagnol, allemand… ; se change aussi dans l’onglet) |
| Enregistrer l’extrait des passages | activé |
| Conserver l’audio du cours | désactivé |
| Sites › **Activer sur tous les sites** | désactivé : toute vidéo, tout audio (lecteurs intégrés compris) est détecté sans clic ni autorisation par lecteur |

## 8. Limites connues

- Un **lecteur intégré** d’un autre site (Vimeo, Wistia, Kaltura…) doit être autorisé une fois
  (« Autoriser » dans le panneau), ou Boo Notes activé sur tous les sites ; ses sous-titres
  arrivent alors dans la transcription de la page comme son horloge. Un fichier téléchargé avant
  l’autorisation est manqué : la piste du lecteur ou la capture en direct prend le relais.
- Une vidéo **sans aucun sous-titre** (ni fichier, ni sous-titres automatiques) n’a pas de
  transcription : pas de reconnaissance vocale pour l’instant.
- Boo Notes **mis à jour ou rechargé** pendant qu’une page est ouverte : l’ancienne copie du
  script retire son panneau et rend la page (marge, lecteur) ; sur les sites déclarés ou toujours
  actifs, la nouvelle version redémarre seule et **rouvre les notes** qui l’étaient ; ailleurs, une
  carte « Boo Notes a été mis à jour — Recharger » s’affiche (au lieu de l’erreur « Extension
  context invalidated »), vos notes enregistrées sont conservées.
- La traduction automatique demande Chrome 138+ (modèle téléchargé une fois sur l’appareil) ;
  l’application Desktop propose la traduction à la main.

## 9. Pour les développeurs

| Élément | Fichier |
| --- | --- |
| Modèle (répliques, VTT / SRT / TTML / YouTube json3 / srv3 / JSON, capture en direct, passages, lignes de note) | `src/shared/transcript.ts` |
| Fichiers de sous-titres vus par le lecteur (monde de la page → script de contenu) | `src/content/media-bridge.ts`, `src/shared/caption-bridge.ts` |
| Sous-titres d’un lecteur intégré (piste, fichiers, lignes affichées) | `src/content/frame.ts` |
| Stockage de l’extension (fusion des sources, traductions et commentaires) | `src/shared/transcript-store.ts` |
| Extraits et son conservé (IndexedDB) | `src/shared/media-db.ts` |
| Collecte dans la page | `src/content/subtitles.ts` |
| Copier / coller : ce que contient un collage, images, médias collés, format de Boo Notes | `src/panel/rich-clipboard.ts`, `src/shared/html-markdown.ts`, `src/shared/media-paths.ts`, `desktop/src/renderer/lib/clipboard.ts` |
| Enregistrement (captureStream + MediaRecorder), carte d’un passage | `src/content/recorder.ts` |
| Vue Transcription (panneau et application) | `src/panel/transcript-view.ts`, `src/panel/transcript.css` |
| Traduction sur l’appareil | `src/panel/translator.ts` |
| Application : dossier de notes, sous-titres voisins, extraits | `desktop/src/core/library.ts` |
| Application : vue | `desktop/src/renderer/islands/TranscriptPanel.tsx`, `desktop/src/renderer/views/NoteView.tsx` |
| Protocole (`transcript.put`, `media.chunk`, `media.put`) | [PROTOCOL.md](PROTOCOL.md) |
