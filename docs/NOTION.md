# Notion : le coffre de toutes vos notes

Quel que soit le support — vidéo YouTube / Udemy / Coursera, leçon d’un module de cours, audio,
page Notion, article web, PDF, texte, image, fiche de révision — chaque note rejoint **un seul
coffre** dans votre Notion, au nom que vous lui donnez (« Boo Notes » par défaut, « Coursera
notes », « Sample notes »…) :

```
👻 Boo Notes                        ← le coffre : un mot d’accueil, puis…
   🗂️ Toutes les notes               ← la table : une ligne (une page) par note
   📚 Mes cours
   📘 AI Orchestration               ← une page par cours : ses leçons par chapitre,
        🎯 3 leçons · 2 chapitres · 1 terminée · 30 % du cours
        Les bases
          ☑ 🎬 Introduction to Airflow      Terminé
          ☐ 🎬 Les DAG                        En cours · 40 %
        Hooks et outils
          ☐ 🌐 HookToolset                    À commencer
   📘 Databricks Agents
   📥 Notes à ranger                 ← les notes rangées dans aucun cours
```

Chaque leçon de la page d’un cours est un **lien vers sa note** ; chaque note commence par **son
cours et son chapitre** (lien vers la page du cours) et rouvre la vidéo ou la page d’origine à
l’instant noté. Cours → note → leçon, et retour : tout se rejoint en un clic. Les `[[liens]]` vers
les autres notes deviennent des **mentions de pages**.

**Jamais de doublon** : un seul coffre (retrouvé à chaque connexion, même depuis un autre
appareil), une seule table dedans, une seule page par cours et par note (retrouvées avant d’en
créer une, par leur place et leur « Boo ID »).

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

## Se connecter : un bouton

Pas de secret, pas de lien à copier : **« Se connecter à… »**, en haut du **panneau de notes** (ou
**options › Notion › Se connecter à Notion**).

1. Une petite fenêtre s’ouvre : choisissez **Notion**.
2. La fenêtre de Notion s’ouvre, comme « Se connecter avec Google » : connectez-vous (ou créez votre
   compte), choisissez **« Utiliser le modèle »** (ou cochez une page), puis **« Autoriser
   l’accès »**.
3. **Nommez votre coffre** — « Boo Notes » est proposé — ou, si vous en avez déjà un, gardez-le
   (il est proposé en premier). **Valider**.

C’est tout : le coffre, sa table et les pages des cours sont créés (ou retrouvés), et toutes vos
notes y partent. Le bouton affiche alors le nom du coffre (point vert : notes envoyées ; orange :
un problème, expliqué). Un clic dessus : **Ouvrir le coffre dans Notion**, **Synchroniser
maintenant**, **Déconnecter**.

- **Déconnecter** oublie la connexion *et* retire l’accès de Boo Notes dans Notion. Les pages
  déjà créées restent.
- **Reconnecter** : même bouton ; le coffre existant est proposé, rien n’est créé en double (une
  nouvelle copie du modèle faite par Notion part à la corbeille).
- **Accès expiré** : renouvelé automatiquement, sans rien demander.
- L’app Boo Notes Desktop apparaît dans la même fenêtre (« Connectée » / « Non détectée », un
  clic pour réessayer).

### Pour le développeur : activer le bouton (une fois)

Le bouton repose sur une **intégration publique** de Boo Notes et un tout petit serveur
d’échange (un Cloudflare Worker, gratuit) qui garde le *client secret* hors de l’extension —
tout est décrit dans [`tools/notion-oauth/README.md`](../tools/notion-oauth/README.md) :

1. intégration **publique** sur [notion.so/profile/integrations](https://www.notion.so/profile/integrations),
   adresse de redirection `https://<id-de-l’extension>.chromiumapp.org/notion` (affichée dans les
   options tant que le bouton n’est pas activé), et — recommandé — un **modèle** : l’adresse d’une
   page Notion publique « Boo Notes » que Notion copie chez l’utilisateur pendant le consentement ;
2. `npx wrangler deploy` dans `tools/notion-oauth`, puis `wrangler secret put NOTION_CLIENT_ID` et
   `NOTION_CLIENT_SECRET` (il échange le code, renouvelle l’accès expiré et le retire à la
   déconnexion) ;
3. `notion-oauth.json` à la racine du projet — `{ "clientId": "…", "exchangeUrl": "https://…workers.dev/token" }`
   (ou `BOO_NOTION_CLIENT_ID` / `BOO_NOTION_OAUTH_URL`) — puis `npm run build`.

Sans cette configuration, le bouton est grisé, l’explique, et le secret d’intégration
ci-dessous reste disponible.

## Avec un secret d’intégration (avancé, 2 minutes)

La page dont vous donnez le lien devient le coffre (sa table « Toutes les notes » y est créée, ou
retrouvée).

Pour l’application Desktop, ou dans les options de l’extension › Notion › « Méthode avancée : avec
un secret d’intégration » (« Connecter avec ce secret ») :

1. **Créez une intégration interne.** [notion.so › Paramètres › Intégrations](https://www.notion.so/profile/integrations),
   « Nouvelle intégration », type **Interne**. Capacités : *Lire*, *Mettre à jour* et *Insérer du
   contenu*. Copiez le **secret** (`ntn_…` ou `secret_…`).
2. **Choisissez la page du coffre** (« Boo Notes », par exemple) : menu **•••** › **Connexions** ›
   ajoutez votre intégration, puis **Partager › Copier le lien**.
3. **Connectez** :
   - dans **Boo Notes Desktop** › Réglages › Notion : collez le secret et le lien, **Connecter
     Notion**. L’option « Partager la connexion Notion avec l’extension » (activée par défaut)
     transmet la connexion à l’extension appairée, qui peut alors écrire dans Notion quand
     l’application est fermée ;
   - **ou**, sans l’application, dans les **options de l’extension** › Notion : même secret, même lien.

La table **« Toutes les notes »** est créée *dans* la page (ou retrouvée si elle y est déjà), puis
une page par cours à côté. Vous pouvez aussi coller le lien d’une **table existante** (celle des
premières versions, « Boo Notes — Mes notes ») : Boo Notes l’adopte, y ajoute les colonnes
manquantes, et sa page devient le coffre. Ajoutez librement du texte ou d’autres vues.

**Le secret** : chiffré par le système dans l’application (DPAPI sous Windows) ; dans le
navigateur, conservé dans le stockage local de l’extension (inaccessible aux sites web). Il n’est
envoyé qu’à `api.notion.com`. Désactivez « Partager la connexion Notion avec l’extension » pour
qu’il ne quitte pas l’application.

## La table « Toutes les notes »

Ce qui se lit d’un coup d’œil, rien de plus :

| Colonne | Contenu |
| --- | --- |
| Nom | Titre de la note (leçon, vidéo, page, document, fiche) |
| Cours | Le cours de la note (sélection : une couleur par cours) — rangée depuis le panneau |
| Chapitre | Le chapitre du cours |
| Statut | À commencer · En cours · Terminé (déduit de la progression) |
| Progression | Part du support parcourue (point le plus loin atteint) |
| Type | Vidéo · Audio · PDF · Texte · Image · Page web · Fiche |
| Plateforme | YouTube · Udemy · Coursera · Notion · Web · Fichier local |
| Source | Lien de la leçon, de la vidéo ou de la page (vide pour un fichier local) |
| Dernière activité | Date de la dernière note ou progression |
| Liens / Liée depuis | Notes reliées par `[[Titre]]`, et l’inverse (tenu à jour par Notion) |
| Boo ID | Identifiant de la note (utilisé par Boo Notes, ne pas modifier) |

Les tables des premières versions gardent leurs autres colonnes (Position, Notes, Supports,
Prochaine révision), toujours remplies. Idées de vues : **par cours** (groupé par *Cours*), **« En
cours »** (Statut), **Kanban** par Statut, **galerie** par Type.

## Les pages des cours

Une page par cours dans le coffre (📘), tenue à jour par Boo Notes : un résumé (nombre de leçons,
de chapitres, terminées, progression du cours), puis **chaque chapitre** et **ses leçons** dans
l’ordre où vous les avez commencées — une case cochée quand la leçon est terminée, un lien vers la
note, son état. Une leçon rangée ailleurs quitte la page de l’ancien cours ; les notes rangées
nulle part sont dans **📥 Notes à ranger**. La progression y est arrondie à la dizaine : la page
n’est pas réécrite à chaque minute regardée.

## La page de chaque note

- Tout en haut, pour une note rangée : **📍 son cours › son chapitre** (le cours est un lien vers
  sa page).
- Puis la **vidéo YouTube intégrée**, un **signet** vers le cours ou l’article, l’**image**
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
- Un **passage** d’une vidéo (`[02:05–06:07]`) devient une image légendée « Passage 02:05–06:07 ·
  titre » (l’extrait enregistré reste dans le dossier de notes).
- La **transcription** (sous-titres collectés pendant la lecture) termine la page, **repliée par
  tranches de la vidéo** (« 00:00 – 12:30 · 100 répliques ») : la page reste courte, chaque tranche
  s’ouvre d’un clic ; une réplique par paragraphe — heure liée à l’instant de la vidéo, texte,
  traduction en italique, 💬 votre commentaire. Voir [TRANSCRIPTION.md](TRANSCRIPTION.md).
- Une **Question** garde sa réponse compacte de l’IA, avec la mention « Réponse générée par IA — à
  vérifier » (voir [QUESTIONS.md](QUESTIONS.md)).

## Synchronisation

- **Automatique** : quelques secondes après chaque modification ; un changement de progression ne
  met à jour que les colonnes.
- **Manuelle** : « Se connecter à… › Synchroniser maintenant » dans le panneau, **Exporter ›
  Envoyer vers Notion**, et dans **options › Données** : chaque note dit si elle est **dans
  Notion** (un clic ouvre sa page) ; sinon un bouton **Sync** l’y écrit aussitôt, dans la page de
  son cours ; **Tout synchroniser** fait de même pour toutes celles qui n’y sont pas.
- **Idempotente** : avant d’écrire, Boo Notes vérifie que la table existe (sinon la retrouve dans
  le coffre, sinon la recrée là), que la page de la note existe (sinon la retrouve par son Boo ID,
  sinon la crée) ; les notes déjà à jour sont laissées telles quelles. Synchroniser deux fois ne
  crée rien de plus.
- **Incrémentale** : chaque bloc écrit a une empreinte ; une note qui s’allonge n’ajoute que ses
  nouvelles lignes, une ligne modifiée réécrit la page à partir de cette ligne.
- **Sens unique** : Boo Notes → Notion. Ce que vous ajoutez dans la page Notion sous les blocs de
  Boo Notes, ou dans d’autres colonnes, est conservé mais pas rapatrié ; évitez de modifier les
  blocs écrits par Boo Notes (remplacés à la synchronisation suivante).
- Page supprimée → recréée ; table supprimée → retrouvée ou recréée dans le coffre ; page d’un
  cours supprimée → recréée.
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

`api.notion.com` n’est pas nécessaire : `tools/mock-notion/server.mjs` imite les points d’API
utilisés (bases inline, relations doubles, mentions, requêtes filtrées, fichiers, 100 blocs,
2 000 caractères, 429…) avec les mêmes validations que l’API réelle (un signet sans `url` est
refusé, comme par Notion). Il sert aux tests de l’extension (`tests/unit/notion.test.ts`,
`tests/e2e/reading.spec.ts`).

```bash
npm run mock:notion                                   # http://127.0.0.1:43118, secret « secret_test »
```

Le lien de la page du coffre dans le mock est `11111111-1111-4111-8111-111111111111`.
