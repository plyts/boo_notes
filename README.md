# Boo Notes — extension navigateur (YouTube / Udemy / Coursera)

Prise de notes horodatées **au clavier** pendant une vidéo : un panneau latéral rétractable, un
horodatage automatique sur chaque ligne, des captures d’écran en résolution native insérées en
vignette dans la note Markdown, et une synchronisation locale avec l’application Desktop.

![Panneau de notes (thème sombre)](docs/screenshots/drawer-dark.png)

| Thème clair | Toast après capture |
| --- | --- |
| ![Thème clair](docs/screenshots/drawer-light.png) | ![Toast](docs/screenshots/capture-toast.png) |

Extension Chrome / Chromium **Manifest V3**, écrite en TypeScript, sans framework UI. L’éditeur
s’appuie sur **CodeMirror 6** (Markdown « à la volée »).

---

## Installation (développement)

```bash
npm ci
npm run build        # → dist/
```

1. Ouvrir `chrome://extensions`, activer le **mode développeur**.
2. **Charger l’extension non empaquetée** → sélectionner le dossier `dist/`.
3. Ouvrir une vidéo YouTube, une leçon Udemy ou Coursera, puis `Alt+Shift+N`.

`npm run watch` reconstruit à chaque modification (recharger l’extension ensuite).

## Raccourcis

| Action | Défaut | Comportement |
| --- | --- | --- |
| Ouvrir / réduire le panneau | `Alt+Shift+N` | Ouvre le panneau et donne le focus à l’éditeur ; `Échap` le referme. |
| Insérer l’horodatage | `Alt+Shift+T` | Injecte `[MM:SS]` au curseur, sans interrompre la lecture. |
| Capture d’écran | `Alt+Shift+S` | Capture la frame, flash 100 ms, toast, vignette `![](assets/…)` dans la note. |
| Smart Pause | `Alt+Shift+Space` | Pause + focus immédiat sur une nouvelle ligne de l’éditeur. |
| Saut arrière | `Alt+←` | Recule de 5 s (durée réglable). |

Tous sont modifiables dans `chrome://extensions/shortcuts` (bouton dans la page d’options).

> **Limites de Chrome, gérées automatiquement.** Chrome n’accepte que **4** raccourcis par défaut
> par extension et **ignore silencieusement** ceux qui entrent en conflit avec les siens —
> c’est le cas de `Alt+Shift+T` (« focus sur la barre d’outils » sous Windows / Linux). Tout
> raccourci par défaut non enregistré par Chrome est donc géré **dans la page et dans le panneau**
> (option « Raccourcis de secours dans la page », activée par défaut). Il fonctionne alors quand le
> focus est sur la vidéo ou dans les notes, mais pas depuis un autre onglet. La page d’options
> indique pour chaque action si le raccourci est global ou « dans la page ».

## Fonctionnalités (correspondance avec le cahier des charges)

| Cahier des charges | Implémentation |
| --- | --- |
| **Invisibilité** | Rien d’autre qu’un calque transparent n’est injecté tant que les notes ne sont pas ouvertes ; le HUD n’apparaît qu’au survol de la vidéo et disparaît après 2,5 s. |
| **Zéro friction** | Les 5 actions au clavier ; les raccourcis globaux fonctionnent aussi depuis le panneau, la fenêtre détachée ou un autre onglet (routés vers le lecteur actif). |
| **Non-intrusivité** | Le lecteur n’est jamais modifié : HUD, toasts, flash et marqueur sont dessinés dans un calque séparé (Shadow DOM) positionné d’après la géométrie de la vidéo. En mode « côte à côte », la page est décalée de la largeur du panneau et le panneau commence sous l’en-tête fixe de YouTube. |
| **Flow 1** | `Alt+Shift+N` → panneau + focus ; la première lettre tapée sur une ligne vide ajoute `[MM:SS]` (après `- `, `1. `, `## `, `> ` si présents) ; `Échap` ferme ou panneau laissé ouvert. |
| **Flow 2** | `Alt+Shift+S` → extraction `<canvas>` en résolution native, flash blanc 100 ms, toast `04:15 - Capture sauvegardée`, ligne `[04:15] ![Capture 04:15](assets/…)` rendue en vignette. |
| **Drawer** | À droite, 300–500 px (360 par défaut, poignée de redimensionnement), badge de synchronisation (vert / orange), titre de la vidéo ou du cours, pop-out, export (Desktop, Notion via Desktop, `.md` + captures, presse-papier). |
| **Éditeur** | CodeMirror 6 : Markdown rendu sur les lignes inactives (titres, gras, code, citations), horodatages cliquables, vignettes, listes continuées. |
| **HUD** | `[ 04:15 ]` copie `[04:15](URL#t=255)` ; 📸 capture ; 📌 épingle le panneau ; ⚙️ paramètres. |
| **Auto-pause (option)** | Pause après 1,5 s de frappe continue, reprise 1 s après la dernière touche — uniquement si c’est l’extension qui a mis en pause. |
| **Surbrillance bidirectionnelle** | Survol d’un horodatage → marqueur sur la barre de progression native ; pendant la lecture, la ligne du dernier horodatage atteint est surlignée dans la note. |
| **Toasts** | Bas-gauche du lecteur (au-dessus des contrôles), 2 s, sombre, mono-espace. |
| **Capture** | `<canvas>` détaché à la résolution de la vidéo ; repli sur une capture de l’onglet recadrée si la source est cross-origin sans CORS. |
| **Desktop** | WebSocket local `ws://localhost:43117` + jeton d’appairage ; stockage `chrome.storage.local` d’abord, file d’envoi rejouée à la reconnexion. Voir [docs/PROTOCOL.md](docs/PROTOCOL.md). |
| **Multi-onglets** | Un seul lecteur actif : celui qui a reçu la dernière interaction ; les raccourcis lancés ailleurs lui sont routés. |

Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · design & contrastes : [docs/DESIGN.md](docs/DESIGN.md).

### Liens horodatés

Les liens copiés ou exportés ont la forme demandée `URL#t=255`. Le script de contenu les interprète à
l’ouverture sur les trois plateformes (Udemy et Coursera ne gèrent pas ce fragment nativement).

## Application Desktop

L’extension fonctionne entièrement hors-ligne. Quand l’application Desktop écoute sur
`ws://localhost:43117`, les notes et captures lui sont envoyées (badge vert). Pour développer sans
l’application réelle, un **mock** implémente le protocole et écrit les notes en Markdown :

```bash
npm run mock:desktop -- --token mon-jeton     # écrit dans ./.boo-desktop-data/
```

Puis renseigner le jeton dans la page d’options de l’extension.

## Développement

| Commande | Rôle |
| --- | --- |
| `npm run build` / `npm run watch` | Bundle esbuild → `dist/` |
| `npm run typecheck` | TypeScript strict |
| `npm test` | Tests unitaires (Vitest) : horodatage, plateformes, Markdown, auto-stamp, auto-pause, raccourcis, stockage, synchronisation, **contrastes WCAG des tokens** |
| `npm run test:e2e` | Tests de bout en bout (Playwright + Chromium avec l’extension chargée) sur une page « YouTube » locale |
| `npm run screenshots` | Régénère `docs/screenshots/` |
| `npm run fixtures` | Régénère la vidéo de test `tests/e2e/fixtures/sample.webm` |

Les tests E2E couvrent : ouverture du panneau et horodatage automatique, `Alt+Shift+T` (y compris le
repli dans la page), Smart Pause, capture + toast + vignette, `Alt+←`, HUD et copie du lien,
épinglage, plein écran, liens `#t=`, marqueur de prévisualisation et clic sur un horodatage, pop-out
puis rattachement, export `.md` + captures et copie du Markdown, persistance après rechargement,
synchronisation hors-ligne → en ligne avec le mock Desktop, jeton refusé, auto-pause, routage
multi-onglets.

```
src/
  background/   service worker : raccourcis, routage multi-onglets, stockage, export, sync Desktop
  content/      script de contenu : détection de la vidéo, HUD / toasts / flash / marqueur, panneau
  panel/        page du panneau (iframe du drawer + fenêtre pop-out) : éditeur CodeMirror
  options/      page d’options
  shared/       logique pure partagée (testée unitairement)
tools/mock-desktop/   serveur WebSocket simulant l’application Desktop
tests/unit, tests/e2e
docs/         architecture, protocole, design
```

## Limites connues

- **Contenu DRM** (Widevine, certains cours Udemy) : le navigateur renvoie une image noire ; la
  capture est enregistrée avec un avertissement.
- **Vidéo cross-origin sans CORS** : la capture passe par une capture de l’onglet recadrée, qui exige
  que Chrome ait accordé `activeTab` — c’est le cas quand la capture est lancée par le raccourci
  global, pas par le bouton du HUD (un message l’explique).
- **Sélecteurs Udemy / Coursera** (titre, barre de progression) : écrits d’après le DOM connu de ces
  plateformes mais non vérifiés sur les sites réels depuis cet environnement. Des replis existent
  (plus grande `<video>` visible, `document.title`, marqueur le long du bas de la vidéo).
- **Mode côte à côte** : la page est décalée via une marge sur `<html>` ; les éléments en
  `position: fixed` d’un site restent calés sur la fenêtre (le panneau démarre sous l’en-tête fixe de
  YouTube pour ne pas le masquer).
- **Plein écran** : le HUD et le panneau épinglé sont déplacés dans l’élément plein écran (seule façon
  d’être visibles) puis remis en place à la sortie.
- **Maquettes Figma** (étape 1) : ce dépôt fournit les tokens, mesures, états et captures dans
  [docs/DESIGN.md](docs/DESIGN.md) pour les reporter dans Figma ; aucun fichier Figma n’est inclus.
- **Noms de fichiers exportés** : si Chrome refuse les caractères accentués (certaines locales
  Linux), le dossier et le fichier sont renommés en ASCII (« Vidéo » → « Video »).
- **Native Messaging** : non implémenté ; seul le WebSocket local l’est.
- Cible : Chrome / Chromium ≥ 116 (Edge, Brave… compatibles). Firefox demanderait des adaptations.
