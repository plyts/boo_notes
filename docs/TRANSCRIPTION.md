# Transcription, traduction, passages et piste audio

> **L’idée.** Pendant qu’une vidéo ou un audio de cours joue, Boo Notes récupère en arrière-plan
> ses **sous-titres horodatés** dans un document à part — la **transcription** — sans jamais
> interrompre votre prise de notes. Sur cette transcription, vous **traduisez** (en français par
> défaut) et **commentez** chaque réplique ; une phrase importante s’**épingle** dans vos notes en
> un geste. Vous pouvez **conserver la piste audio** du cours et **extraire un passage** (par
> exemple 02:05 → 06:07) avec son image, son son, ses sous-titres et les notes prises pendant ce
> passage. À la fin de la lecture, la transcription est **épinglée** à votre note.

## 1. Ce que vous faites, ce que Boo Notes fait

| Moment | Vous | Boo Notes, en arrière-plan |
| --- | --- | --- |
| La vidéo démarre | Vous prenez vos notes comme d’habitude (`Alt+Shift+N`) | Détecte les sous-titres du cours et commence la transcription (pastille « Transcription · en cours ») |
| Pendant la lecture | Vous écrivez ; une phrase du prof vous intéresse | Le **bandeau de sous-titre** sous l’éditeur montre la réplique en cours et sa traduction ; `Ctrl/⌘ + Maj + K` (ou **Épingler**) la cite dans la note, horodatée |
| Un passage clé commence | `Alt + I` (**Début du passage**) | Pose le point d’entrée ; si l’option est active, enregistre image et son à partir de là |
| Le passage se termine | `Alt + O` (**Fin du passage**) | Crée le **passage** 02:05 → 06:07 : carte dans la note, extrait audio / vidéo, sous-titres et notes de l’intervalle |
| Plus tard | Onglet **Transcription** : traduire, commenter, sélectionner des répliques → **Passage** | Garde tout dans la transcription, jamais dans vos notes personnelles |
| Fin de la vidéo | — | Épingle la transcription en bas de la note (`📄 Transcription — anglais → français`) |

Deux principes :

1. **Vos notes restent les vôtres.** Les sous-titres vivent dans un document à part ; ils
   n’entrent dans la note que quand vous le décidez (épingler une réplique, un passage) ou, à la
   fin, sous la forme d’une seule ligne-pièce jointe.
2. **Rien ne bloque la saisie.** Capture, traduction et enregistrement tournent sans voler le
   focus ; tout est réversible (supprimer la ligne épinglée, arrêter l’enregistrement).

## 2. Interface (panneau de l’extension, et note dans l’application)

```
┌──────────────────────────────────────────┐
│ (● Connecté)   ● REC 12:40      ⧉ ⇪ 📌 ✕ │  REC : piste audio conservée (clic = arrêter)
│ Maths › Analyse                          │  cours › chapitre
│ Théorème de Stokes — Cours 7             │
│ [ Notes │ Transcription 312 ]            │  contrôle segmenté
├──────────────────────────────────────────┤
│ 02:05  Définition de la circulation      │  vos notes (inchangées)
│ ┌──────────────────────────────────────┐ │
│ │ ▶ 02:05–06:07  Théorème de Stokes   │ │  carte « passage » : image, durée,
│ │   4 min · 3 notes · 18 répliques 🔊 │ │  ▶ Revoir le passage, 🔊 extrait
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ 04:12 « the curl of F through S… »       │  bandeau de sous-titre en direct
│       le rotationnel de F à travers S…  ⊕│  ⊕ = épingler dans la note
├──────────────────────────────────────────┤
│ ▶ 04:12 ──|──[■■■■]──|──────── 12:30     │  chronologie : [■■■] = passage, ▁ = audio conservé
│ [⏱ Horodater] [📷 Capturer] [⧗ Passage]  │
└──────────────────────────────────────────┘
```

**Onglet Transcription** (le « fichier en back-office »), qui suit la lecture comme un karaoké :

```
│ Sous-titres YouTube · anglais   [Traduire en français ●]  🔍 │
│ ✓ 38 % capturé   ● Conserver l’audio                          │
│ 02:01  So let’s look at the theorem.                          │
│        Regardons donc le théorème.                            │
│▌02:05  The circulation of F around the boundary…   ⊕ 💬 ⧗    │  réplique en cours
│        La circulation de F le long du bord…                   │
│        💬 Attention : orientation du bord !                    │  votre commentaire
│ 02:11  …equals the flux of the curl.                          │
```

- **Clic** sur une heure : la vidéo y saute. **Survol** d’une réplique : ⊕ l’épingler dans la
  note, 💬 la commenter, ⧗ commencer un passage ici. **Maj + clic** sur une seconde réplique :
  sélection d’un intervalle → **Créer le passage 02:05 → 06:07**.
- **Suivre la lecture** : la réplique en cours reste visible ; si vous faites défiler, le suivi se
  met en pause (« ↓ Revenir à 04:12 »).
- **Traduire en français** : traduction automatique sur l’appareil (Chrome 138+, sans envoi à un
  service tiers), réplique par réplique à mesure qu’elles arrivent ; chaque traduction reste
  modifiable à la main. Sans traduction automatique, un champ « Votre traduction » par réplique.
- **Recherche** dans la transcription (texte, traduction, commentaires).

**Passage** (clic sur la carte) : lecture limitée à l’intervalle (en boucle au choix), l’extrait
enregistré, les notes prises pendant l’intervalle et ses répliques traduites / commentées.

## 3. D’où viennent les sous-titres

Par ordre de préférence, sans configuration :

| Source | Plateformes | Couverture |
| --- | --- | --- |
| **Pistes de sous-titres du lecteur** (`<track>` / `video.textTracks`, WebVTT) | Coursera, lecteurs video.js / Plyr / JW, la plupart des plateformes d’école, fichiers Notion | Toute la vidéo, dès le début |
| **Pistes de la plateforme** (liste des sous-titres de la vidéo) | YouTube (sous-titres manuels ou automatiques) | Toute la vidéo, si la plateforme les fournit |
| **Capture en direct** des sous-titres affichés | YouTube, Udemy, tout lecteur qui affiche ses sous-titres | Ce qui est joué avec les sous-titres affichés (« 38 % capturé ») |
| **Fichier** `.vtt` / `.srt` | Application : fichier voisin de la vidéo (`cours.mp4` + `cours.vtt`), ou « Ajouter des sous-titres… » | Tout le fichier |

Un audio sans sous-titres (podcast, enregistrement d’amphi) n’a pas de transcription ; la piste
audio conservée garde la trace du cours, et une reconnaissance vocale locale pourra s’y brancher
(la transcription est une source interchangeable).

## 4. Piste audio et extraits

- **Conserver l’audio du cours** (bouton ● dans l’onglet Transcription, mémorisé par cours) :
  l’audio est enregistré pendant la lecture, par segments (une reprise après une pause ou un saut
  = un nouveau segment), en Opus ~48 kb/s (≈ 20 Mo / heure). La chronologie montre les parties
  conservées. Les segments rejoignent le dossier de notes de l’application (`media/`).
- **Extrait d’un passage** : image + son (vidéo WebM) ou son seul (audio).
  - *En direct* : entre **Début** et **Fin du passage**, pendant que vous regardez.
  - *Après coup* : sur un passage existant, **Enregistrer l’extrait** rejoue l’intervalle et
    l’enregistre (la durée du passage) ; vous continuez d’écrire pendant ce temps.
- Les extraits se lisent dans le panneau, dans l’application, et partent dans l’export.

> Les lecteurs protégés (DRM : certains cours Udemy, Netflix…) interdisent d’enregistrer leur
> image et leur son ; les sous-titres et les notes fonctionnent quand même. Usage personnel
> d’étude : respectez les conditions de la plateforme.

## 5. Formats

**Dans la note** (Markdown, lisible partout) :

```markdown
[02:05] Définition de la circulation
> [04:12] « the curl of F through S » — *le rotationnel de F à travers S*
[02:05–06:07] ![Passage 02:05–06:07 · Théorème de Stokes](assets/youtube-abc-passage-02-05.jpg) [Extrait](media/youtube-abc-passage-02-05.webm)

📄 [Transcription — anglais → français · 312 répliques](transcripts/youtube-abc.md)
```

- `[02:05–06:07]` est un **intervalle** : clic = revoir le passage (s’arrête à 06:07).
- La ligne `📄 [Transcription…](transcripts/…)` est la pièce jointe épinglée à la fin.

**La transcription** (`transcripts/<note>.json`, et pour les humains `transcripts/<note>.md` et
`.vtt`) : langue, source, et pour chaque réplique `début`, `fin`, `texte`, `traduction`,
`commentaire`.

**Dans Notion** : chaque passage est un bloc (image, intervalle cliquable), la transcription une
section « Transcription » en fin de page (réplique, traduction en italique, commentaire).

**À l’export** : fiches de révision (les passages avec leurs notes et répliques), Markdown
(`transcripts/`, `media/`), JSON (répliques, traductions, commentaires, passages) pour les QCM.

## 6. Raccourcis

| Action | Raccourci |
| --- | --- |
| Épingler la réplique en cours dans la note | `Ctrl/⌘ + Maj + K` (panneau) |
| Début / fin du passage | `Alt + I` / `Alt + O` (page et panneau) |
| Basculer Notes / Transcription | `Ctrl/⌘ + Maj + T` (panneau) |
