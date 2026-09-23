# Design — drawer, HUD, micro-interactions

Référence pour reporter l’interface dans Figma (étape 1 du cahier des charges). Les valeurs sont
celles du code : `src/tokens.css` (panneau, options), `src/content/overlay.ts` (HUD, toasts,
marqueur), `src/content/drawer.ts` (drawer).

## Panneau latéral (drawer)

```
┌───────────────────────────────────────┐  ← sous l’en-tête fixe du site (YouTube : 56 px)
│ (● Hors-ligne)         ⧉   ⇪   📌   ✕ │  barre d’actions, boutons 32×32
│ Titre de la vidéo ou du cours          │  15 px / 650, 2 lignes max
│ YouTube · Enregistré localement        │  12 px, --muted ; messages d’export à droite
├───────────────────────────────────────┤
│ [00:04] Hooks                          │  titres rendus, marqueurs Markdown masqués
│ [00:12] useState retourne la valeur    │  horodatage = puce cliquable
│▌- [00:31] effets : useEffect(fn, deps) │  ▌ ligne du dernier horodatage atteint
│ [00:45]                                │
│ ┌───────────────────────────────────┐ │
│ │        vignette 16:9 (capture)    │ │  clic = revoir ce moment
│ └───────────────────────────────────┘ │
│ |                                      │
├───────────────────────────────────────┤
│ ▶ 00:47                    ⏱   📷   ↺ │  horloge vidéo + actions souris
└───────────────────────────────────────┘
  ↔ 300–500 px (360 par défaut), poignée de 8 px sur le bord gauche
```

- **Ouverture** : translation horizontale 180 ms `cubic-bezier(.2,.8,.2,1)` ; aucune animation si
  `prefers-reduced-motion`.
- **Disposition** : *côte à côte* (défaut : la page est décalée, le lecteur reste entièrement visible)
  ou *superposé*. En plein écran le panneau épinglé flotte par-dessus la vidéo.
- **États du badge** : `Connecté` (point vert `--ok`), `Connexion…` (point pulsé), `Hors-ligne`
  (point orange `--warn`) ; infobulle avec le nombre de notes en attente et la raison.
- **Épinglé** (📌 actif) : `Échap` rend le focus au lecteur au lieu de fermer ; le panneau reste
  ouvert en plein écran et après rechargement de la page.
- **Pop-out** : même page dans une fenêtre `popup` ; le bouton devient « Rattacher au lecteur ».
- **Thème** : automatique d’après le fond de la page (YouTube sombre → panneau sombre), ou forcé.

## HUD sur la vidéo

```
┌──────────────────────────────────────┐
│ [ 04:15 ] │  📷   📌   ⚙             │  pilule 34 px de haut, rayon 999 px
└──────────────────────────────────────┘
```

- Coin supérieur droit de la vidéo, marge 12 px ; fond `rgba(18,18,22,.82)` + flou 10 px, texte
  `#f4f4f5` mono 12 px ; boutons 28×28.
- Apparaît au mouvement de la souris sur la vidéo (fondu 160 ms), disparaît après 2,5 s
  d’inactivité ou 250 ms après la sortie ; reste visible tant que le pointeur est dessus.
- `[ 04:15 ]` copie `[04:15](URL#t=255)` ; 📌 état pressé = fond `#6d5ef0`.

## Feedbacks

| Élément | Spécification |
| --- | --- |
| Flash de capture | Blanc, opacité 0,9 → 0 en **100 ms**, limité à l’image (bandes noires exclues). |
| Toast | Bas-gauche du lecteur, 10 px au-dessus de la barre de progression ; fond `rgba(14,14,17,.92)`, mono 12 px ; **2 s** ; liseré gauche vert (succès) ou orange (erreur) ; 3 max empilés. Texte : `04:15 - Capture sauvegardée`. |
| Marqueur de prévisualisation | Trait jaune `#facc15` 4×18 px sur la barre de progression native + étiquette `03:12` ; affiché au survol d’un horodatage de la note. |
| Ligne « en cours » | Fond `--now-bg` + barre 3 px `--now-border` dans la marge gauche. |

## Tokens et contrastes (WCAG 2.2)

Vérifiés automatiquement par `tests/unit/contrast.test.ts` (texte ≥ 4,5:1, composants ≥ 3:1).

| Token | Sombre | Clair | Contraste sur `--bg` (sombre / clair) |
| --- | --- | --- | --- |
| `--bg` | `#16161a` | `#ffffff` | — |
| `--surface` | `#1e1e24` | `#f6f6f9` | — |
| `--text` | `#ececf1` | `#1b1b22` | 15,3 / 17,1 |
| `--muted` | `#a4a4b0` | `#555562` | 7,3 / 7,3 |
| `--faint` (placeholder, marqueurs Markdown) | `#8a8a97` | `#6e6e7b` | 5,3 / 5,0 |
| `--accent` (liens, notices) | `#9b8cff` | `#5143c9` | 6,5 / 7,0 |
| `--ts-text` sur `--ts-bg` (puce horodatage) | `#cdc5ff` | `#3f32a8` | 8,4 / 7,8 |
| `--on-accent` sur `--accent-strong` (puce survolée) | `#fff` / `#6d5ef0` | `#fff` / `#4c3dc4` | 4,7 / 7,6 |
| `--danger` | `#f87171` | `#b91c1c` | 6,5 / 6,5 |
| `--ok` (point Connecté) | `#22c55e` | `#15803d` | 7,9 / 5,0 |
| `--warn` (point Hors-ligne) | `#f59e0b` | `#b45309` | 8,4 / 5,0 |
| `--focus` (anneau de focus) | `#a5b4fc` | `#4f46e5` | 9,1 / 6,3 |
| `--now-border` | `#facc15` | `#a16207` | 11,8 / 4,9 |

Typographie : `system-ui` 14 px / 1,6 dans l’éditeur ; `ui-monospace` pour horodatages, horloge,
HUD et toasts. Rayons : 6 px (boutons), 10 px (cartes, menu), 999 px (pilules).

## Accessibilité

- Tous les boutons ont un nom accessible (`aria-label`) ; ceux qui ont un raccourci l’indiquent
  (HUD, pied du panneau).
- HUD : `role="toolbar"`, rendu `inert` quand il est caché (pas de tabulation vers un élément
  invisible). Toasts : `role="status"`, `aria-live="polite"`.
- Menu d’export : `role="menu"`, navigation aux flèches, `Échap` rend le focus au bouton.
- Anneau de focus visible partout (`:focus-visible`).

## Captures

`npm run screenshots` régénère :

| | |
| --- | --- |
| ![Sombre](screenshots/drawer-dark.png) | ![Clair](screenshots/drawer-light.png) |
| ![Toast](screenshots/capture-toast.png) | ![Options](screenshots/options.png) |
