# Questions et notes libres

Une interaction visuelle plutôt qu’une syntaxe à retenir, comme dans Notion : **je survole une ligne
→ un + apparaît → je clique → Question ou Note libre**.

## Le +

- Le **+** n’est pas affiché en permanence : il apparaît à gauche de la ligne sous la souris (d’un
  bloc entier : à sa première ligne), et s’efface dès qu’on tape.
- Son menu propose :
  - **Question** : l’IA cherche la réponse dans le cours ;
  - **Note libre** : une note personnelle, sans horodatage ni réponse ;
  - dans un bloc : **Note normale** (le bloc est retiré, son texte reste) et, pour une question,
    **Chercher la réponse** / **Chercher à nouveau** (la réponse est remplacée).
- Au clavier : `Ctrl + .` (`⌘ .` sur macOS) ouvre le même menu pour la ligne du curseur ; flèches,
  `Entrée`, `Échap`.

Ce qui distingue les lignes :

| Ligne | Ce qui se passe |
| --- | --- |
| Note normale | Rien de plus : horodatée pendant la lecture, comme toujours. |
| **Note libre** | Contenu personnel, **pas associé à l’horodatage** de la vidéo, sans recherche. |
| **Question** | Numérotée, recherche dans le cours, réponse, sources et horodatages. |

## Question

La ligne devient **Question N**, numérotée dans l’ordre de la note (les numéros suivent si l’on
ajoute, déplace ou supprime une question). L’instant où elle a été posée reste dans son en-tête
(« Question 4 · 15:32 », cliquable). Une question écrite sur une ligne vide est posée avec `Entrée`.

La réponse est cherchée, en priorité, dans :

1. la **transcription** de la vidéo (les sous-titres recueillis pendant la lecture, et leur
   traduction) — ce qui a été dit juste avant la question compte un peu plus ;
2. le **texte du cours** : la page, et un module dans ses cadres (SCORM, Articulate Rise…) ;
3. les **notes** déjà prises : celle-ci (sans les autres questions et leurs réponses) et les
   autres notes du même cours ;

puis écrite sous la question, avec ses sources :

```
> [!question] Question 1 · [15:32]
> Pourquoi cette méthode fonctionne-t-elle dans ce cas ?
>
> **Réponse :** La méthode fonctionne parce que…
>
> **Source du cours — [23:41]**
> « Passage pertinent du transcript… »
>
> **Source du cours — [↗ Titre de la section](https://…#:~:text=…)**
> « Passage de la page… »
```

L’horodatage d’une source est celui du **sous-titre cité** : un clic y ramène la vidéo. Le lien d’un
passage de la page le surligne dans la page. Pendant la recherche, « Recherche de la réponse dans le
cours… » s’affiche sous la question ; **la vidéo continue**, et l’on peut écrire ailleurs dans la
note.

### Qui écrit la réponse

Options › Questions › **Qui rédige les réponses** :

- **IA de Chrome** (par défaut) : l’IA intégrée de Chrome (Gemini Nano), **sur cet ordinateur,
  gratuite, rien n’est envoyé**. Son modèle se télécharge une fois (bouton *Télécharger le
  modèle* : quelques Go, en arrière-plan), sur les ordinateurs assez puissants, avec Chrome 138 ou
  plus récent. Elle n’écrit pas encore le français (Chrome 141 : anglais, espagnol, japonais) :
  la question lui est posée en anglais et sa réponse est traduite en français par le **traducteur
  de Chrome**, téléchargé avec elle (lui aussi sur l’appareil). Tant qu’elle n’est pas là, la
  réponse est faite des passages les plus proches, et une ligne dit comment l’activer.
- **Claude** (Anthropic), avec **votre clé API** : *Vérifier et activer* essaie la clé, puis
  propose les modèles qu’elle permet, le plus récent choisi. La clé reste dans le stockage local
  du navigateur (non synchronisé) ; pour chaque question, la question et les extraits du cours
  (transcription, texte de la page, notes) partent **directement** à l’API Claude, à aucun autre
  serveur. Payant à l’usage, sur votre compte Anthropic.
- **Sans IA** : la réponse est faite des **passages du cours les plus proches** de la question
  (« Réponse — passages du cours les plus proches (sans IA) »), classés par les mots de la
  question ; une question en français sur un cours en anglais les trouve par la traduction des
  sous-titres, ou par le traducteur de Chrome quand il est prêt.

Dans tous les cas, l’IA ne répond qu’à partir des extraits du cours et cite ceux qu’elle utilise ;
les horodatages viennent toujours de la transcription elle-même. Si elle ne répond pas (clé
refusée, réseau, modèle indisponible), les passages les plus proches sont donnés, et la raison est
écrite sous la réponse.

## Note libre

```
> [!note] Note libre
> Cette partie me fait penser à un autre concept vu précédemment.
> > « Extrait du cours… » [↗](https://…#:~:text=…)
> ![Capture](assets/…)
```

- Rien n’y est horodaté automatiquement, même pendant la lecture.
- Tout y reste possible : texte, **citations** du cours (bulle « Citer » ou `Alt+Shift+T` sur une
  sélection de la page), **captures** (`Alt+Shift+S`, rangées sans l’instant de la vidéo), images
  collées, `[[liens]]`, liens.
- Une citation ou une capture va dans la note libre où se trouve le curseur, même si l’on a cliqué
  dans la page entre-temps.
- `Entrée` continue la note libre ; `Entrée` sur sa dernière ligne vide en sort.

## Vidéo, notes et cours en même temps

Rien de tout cela n’arrête la vidéo : écrire, transformer une ligne, chercher une réponse, citer du
texte de la page (y compris à côté d’une vidéo), capturer. Seules la **Smart Pause** et l’option
**auto-pause** (désactivée par défaut) mettent en pause, à votre demande.

## Format et exports

Les blocs sont des **callouts** Markdown (syntaxe d’Obsidian) : la note reste du Markdown ordinaire.

| Export | Rendu |
| --- | --- |
| `.md`, copie Markdown | Tel quel (callouts Obsidian). |
| Copie riche (Notion, Docs, Word) | Une citation titrée « ❓ Question 1 · 15:32 » / « 📝 Note libre ». |
| PDF | Un bloc titré, barre de couleur, horodatages cliquables, captures intégrées. |
| Notion | Un bloc *callout* ❓ ou 📝 contenant les lignes. |

## Pour les développeurs

| Élément | Fichier |
| --- | --- |
| Format des blocs, numérotation, conversion d’une ligne, réponse écrite | `src/shared/callouts.ts` |
| Éditeur : le +, son menu, `Ctrl + .`, `Entrée`, apparence, numérotation, questions en attente | `src/panel/blocks.ts` (branché dans `src/panel/editor.ts`) |
| Recherche : sources, passages, classement (BM25), requête et réponse de l’IA | `src/shared/qa.ts`, `src/panel/answers.ts` |
| Texte du cours dans l’onglet (page et cadres) | `src/shared/course-text.ts` (requête `course:text` du service worker) |
| IA intégrée de Chrome (état, téléchargement, réponse, traduction) | `src/shared/chrome-ai.ts` |
| API Claude (modèles, message) | `src/shared/claude.ts` ; réglage `qa:config` (`src/shared/qa-config.ts`) |
| Exports | `src/shared/pdf-notes.ts`, `src/shared/notion/blocks.ts`, `src/shared/notion/html.ts` |
| Tests | `tests/unit/callouts.test.ts`, `tests/unit/qa.test.ts`, `tests/unit/blocks-export.test.ts`, `tests/e2e/questions.spec.ts` |
