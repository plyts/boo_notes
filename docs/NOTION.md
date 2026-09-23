# Notion : le coffre de toutes vos notes

Quel que soit le support — vidéo YouTube / Udemy / Coursera, audio, page Notion, article web, PDF,
texte, image (graphe, schéma), fiche de révision — chaque note rejoint **un seul tableau Notion**,
intégré dans la page de votre choix :

```
📄 Mes cours                       ← votre page (le « hub »)
   👻 Boo Notes — Mes notes        ← tableau intégré (base inline) : une ligne par note
      🎬 React — Les hooks          React › Hooks · Vidéo · YouTube · En cours · 42 % · 21:00 / 50:00 · Liens : 🗂️ useEffect
      🌐 La loi d’Ohm — Cours       Physique › Électricité · Page web · En cours · 62 % lu
      📄 Probabilités — Chapitre 3  Maths › Probabilités · PDF + audio · p. 12 / 40
      🗂️ useEffect                  React › Hooks · Fiche · Prochaine révision : 12 oct. · Liée depuis : 🎬 React — Les hooks
```

Chaque ligne est une page : la source en tête (vidéo YouTube intégrée, signet, image), puis la note
bloc par bloc, avec ses liens cliquables vers l’instant, la page ou le passage d’origine, et les
`[[liens]]` vers les autres notes devenus des **mentions de pages**. Une note ouvre ainsi les
autres, qui en ouvrent d’autres… comme des fiches de révision reliées.

## Qui écrit dans Notion ?

```
Extension (navigateur) ──ws://localhost──► Boo Notes Desktop ──HTTPS──► API Notion
        │                                        ▲
        └──────── HTTPS (app Desktop fermée) ────┴──────────────────────► API Notion
```

- **App Desktop lancée** : l’extension lui envoie ses notes ; l’application écrit toutes les notes
  (celles du navigateur et ses PDF, audios, vidéos, textes, images, fiches) dans Notion.
- **App Desktop fermée, ou pas installée** : l’extension écrit **elle-même** ses notes dans Notion,
  quelques secondes après chaque modification. Quand l’application revient, chacune apprend de
  l’autre quelle page Notion correspond à quelle note (identifiant « Boo ID ») : pas de doublon.

## Mise en place (2 minutes)

1. **Créez une intégration interne.** [notion.so › Paramètres › Intégrations](https://www.notion.so/profile/integrations),
   « Nouvelle intégration », type **Interne**. Capacités : *Lire*, *Mettre à jour* et *Insérer du
   contenu*. Copiez le **secret** (`ntn_…` ou `secret_…`).
2. **Choisissez la page hub** (« Mes cours », par exemple) : menu **•••** › **Connexions** ›
   ajoutez votre intégration, puis **Partager › Copier le lien**.
3. **Connectez** :
   - dans **Boo Notes Desktop** › Réglages › Notion : collez le secret et le lien, **Connecter
     Notion**. L’option « Partager la connexion Notion avec l’extension » (activée par défaut)
     transmet la connexion à l’extension appairée, qui peut alors écrire dans Notion quand
     l’application est fermée ;
   - **ou**, sans l’application, dans les **options de l’extension** › Notion : même secret, même lien.

Le tableau **« Boo Notes — Mes notes »** est créé *dans* la page (base intégrée). Vous pouvez
aussi coller le lien d’une **base existante** : Boo Notes l’adopte et y ajoute les colonnes
manquantes. Ajoutez librement du texte, d’autres vues ou d’autres blocs autour du tableau.

**Le secret** : chiffré par le système dans l’application (DPAPI sous Windows) ; dans le
navigateur, conservé dans le stockage local de l’extension (inaccessible aux sites web). Il n’est
envoyé qu’à `api.notion.com`. Désactivez « Partager la connexion Notion avec l’extension » pour
qu’il ne quitte pas l’application.

## Le tableau

| Colonne | Contenu |
| --- | --- |
| Nom | Titre de la note (vidéo, page, document, fiche) |
| Type | Vidéo · Audio · PDF · Texte · Image · Page web · Fiche |
| Plateforme | YouTube · Udemy · Coursera · Notion · Web · Fichier local |
| Cours | Le cours de la note (sélection : une couleur par cours) — choisi dans l’app ou dans le panneau de l’extension |
| Chapitre | Le chapitre du cours |
| Supports | Tous les supports liés à la note, un par ligne (`PDF · Probabilités — Chapitre 3`, `Audio · Amphi 3`…) |
| Statut | À commencer · En cours · Terminé (déduit de la progression, ou choisi dans l’app) |
| Progression | Part du support parcourue (point le plus loin atteint) |
| Position | `21:00 / 50:00`, `p. 12 / 40`, `§ 4 / 30`, `62 % lu`, `3 repères` |
| Notes | Nombre de notes ancrées (instants, pages, paragraphes, repères, passages cités) |
| Liens | Notes reliées par `[[Titre]]` (relation vers le même tableau) |
| Liée depuis | L’inverse, tenu à jour par Notion : les notes qui pointent vers celle-ci |
| Prochaine révision | Date de la prochaine révision espacée d’une fiche (app Desktop) |
| Source | Lien de la vidéo, du cours ou de la page (vide pour un fichier local) |
| Dernière activité | Date de la dernière note ou progression |
| Boo ID | Identifiant de la note (utilisé par Boo Notes, ne pas modifier) |

Idées de vues : **par cours** (groupé par *Cours*, puis trié par *Chapitre*), **« À réviser »** (filtre *Prochaine révision* ≤ aujourd’hui, trié par date),
**« En cours »** (Statut), **tableau Kanban** par Statut, **calendrier** sur *Prochaine révision*,
**galerie** groupée par Type.

## La page de chaque note

- En tête : la **vidéo YouTube intégrée**, un **signet** vers le cours ou l’article, l’**image**
  étudiée (téléversée), ou un encadré « Fichier local : cours.pdf » — et, pour une note appuyée sur
  **plusieurs supports**, un en-tête par support (PDF, enregistrement de l’amphi, vidéo…), chaque
  repère renvoyant au sien.
- Puis la note, **une ligne = un bloc** : `04:15` rouvre la vidéo à cet instant (l’extension gère
  `#t=` sur toutes les plateformes), `p. 12`, `§ 4`, `◉ 3` rappellent la page, le paragraphe ou le
  repère de l’image ; une **citation** d’article garde son lien `↗` qui rouvre la page *sur le
  passage* (surligné par le navigateur).
- `[[useEffect]]` devient une **mention** de la page « useEffect » : cliquez, vous y êtes.
- Les **captures** sont téléversées et légendées ; titres, listes, cases à cocher, citations, code,
  gras / italique sont conservés ; pour un PDF, une section **« Passages surlignés »** reprend vos
  surlignages avec leur couleur.

## Synchronisation

- **Automatique** : quelques secondes après chaque modification ; un changement de progression ne
  met à jour que les colonnes.
- **Manuelle** : bouton Notion d’une note et « Tout synchroniser » (application), **Exporter ›
  Envoyer vers Notion** dans le panneau de l’extension, « Synchroniser » dans ses options.
- **Incrémentale** : chaque bloc écrit a une empreinte ; une note qui s’allonge n’ajoute que ses
  nouvelles lignes, une ligne modifiée réécrit la page à partir de cette ligne.
- **Sens unique** : Boo Notes → Notion. Ce que vous ajoutez dans la page Notion sous les blocs de
  Boo Notes, ou dans d’autres colonnes, est conservé mais pas rapatrié ; évitez de modifier les
  blocs écrits par Boo Notes (remplacés à la synchronisation suivante).
- Page supprimée → recréée ; tableau supprimé → recréé dans la page hub.
- Une note liée qui n’a pas encore de page en reçoit une (vide, puis remplie) pour que la mention
  et la relation existent.

## Prendre des notes *dans* Notion

L’extension est active sur `notion.so` / `notion.site` :

- **Page avec une vidéo ou un audio déposé** : notes horodatées comme sur YouTube, captures.
- **Page de cours écrite** (sans média) : `Alt+Shift+N` ouvre les notes en **mode lecture** —
  sélectionnez un passage et **Citer** (`Alt+Shift+T`) : la citation garde le lien vers le
  passage, surligné dans la page à chaque visite ; la progression de lecture est suivie.

La note est liée à la page Notion (identifiant de page) et apparaît dans le tableau.

## Dépannage

| Message | Que faire |
| --- | --- |
| Jeton Notion refusé | Recopiez le secret de l’intégration (il change si vous le régénérez). |
| Page Notion introuvable / Accès refusé | La page n’est pas partagée avec l’intégration : ••• › Connexions › ajoutez-la. |
| Lien Notion invalide | Utilisez « Partager › Copier le lien » (le lien contient un identifiant de 32 caractères). |
| Notion est injoignable | Pas de connexion : les notes attendent (application : dossier local ; extension : file d’envoi, réessayée chaque minute). |
| Notion limite le nombre de requêtes | Automatique : ~3 requêtes / s, nouvel essai après le délai demandé par Notion. |
| « … n’existe pas encore » en cliquant un `[[lien]]` dans le navigateur | La fiche n’existe que dans votre tête : lancez l’app Desktop, le clic la crée. |

## Limites

- API Notion : 100 blocs par requête et 2 000 caractères par segment (découpés automatiquement),
  fichiers de 20 Mo maximum.
- Un PDF, un audio ou une vidéo locale n’est pas envoyé : seules la note, la progression, les
  captures (et l’image étudiée) le sont.
- « Statut » est une sélection simple : l’API ne permet pas de créer une propriété *Statut*.
- Sans l’application, l’extension ne connaît que ses propres notes pour relier les `[[liens]]` ;
  l’application complète les relations vers ses fiches et documents à sa prochaine synchronisation.

## Développement

`api.notion.com` n’est pas nécessaire : `desktop/tools/mock-notion.mjs` imite les points d’API
utilisés (bases inline, relations doubles, mentions, requêtes filtrées, fichiers, 100 blocs,
2 000 caractères, 429…). Il sert aux tests de l’application **et** de l’extension.

```bash
cd desktop
npm run mock:notion                                   # http://127.0.0.1:43118, secret « secret_test »
NOTION_API_BASE=http://127.0.0.1:43118 npm start      # l’app (et l’extension appairée) parlent au mock
```

Le lien de page hub du mock est `11111111-1111-4111-8111-111111111111`.
