# Relier Boo Notes à Notion

Boo Notes Desktop crée dans votre espace Notion une base **« Boo Notes — Cours »** : une page par
cours (vidéo YouTube / Udemy / Coursera, vidéo ou audio déposé dans Notion, podcast, PDF, fichier
local), avec sa progression et vos notes horodatées. La synchronisation passe par l’application
Desktop : l’extension du navigateur lui envoie les notes, l’application les écrit dans Notion.

```
Navigateur (extension) ──ws://localhost──► Boo Notes Desktop ──HTTPS──► API Notion
PDF / audio / vidéo locaux ───────────────►        │
                                                   └──► Dossier de notes (Markdown)
```

## Mise en place (2 minutes)

1. **Créez une intégration interne.** Sur [notion.so › Paramètres › Intégrations](https://www.notion.so/profile/integrations),
   « Nouvelle intégration », type **Interne**, choisissez l’espace de travail. Capacités : *Lire*,
   *Mettre à jour* et *Insérer du contenu*. Copiez le **secret** (`ntn_…` ou `secret_…`).
2. **Partagez une page avec l’intégration.** Ouvrez (ou créez) la page Notion qui accueillera vos
   cours, par exemple « Mes cours » : menu **•••** › **Connexions** › ajoutez votre intégration.
3. **Dans Boo Notes Desktop** › Réglages › Notion : collez le secret et le lien de la page
   (**Partager › Copier le lien**), puis **Connecter Notion**.

La base « Boo Notes — Cours » est créée sous cette page. Vous pouvez aussi coller le lien d’une
**base existante** : Boo Notes l’adopte et y ajoute les colonnes manquantes.

Le secret est chiffré sur votre ordinateur (DPAPI sous Windows, Trousseau sous macOS, libsecret
sous Linux) et n’est envoyé qu’à `api.notion.com`.

## Ce que contient Notion

**La base** (une ligne par cours) :

| Colonne | Contenu |
| --- | --- |
| Nom | Titre du cours / de la vidéo / du document |
| Type | Vidéo · Audio · PDF |
| Plateforme | YouTube · Udemy · Coursera · Notion · Web · Fichier local |
| Statut | À commencer · En cours · Terminé (déduit de la progression, ou choisi dans l’app) |
| Progression | Pourcentage du cours parcouru (point le plus loin atteint) |
| Position | `21:00 / 45:00` ou `p. 12 / 240` : où vous vous êtes arrêté |
| Notes | Nombre de notes horodatées / par page |
| Source | Lien de la vidéo ou du cours (vide pour un fichier local) |
| Dernière activité | Date de la dernière note ou progression |

Triez ou filtrez comme toute base Notion : vue tableau « En cours », vue galerie, vue calendrier
sur « Dernière activité »…

**La page de chaque cours** :

- en tête, la **vidéo YouTube intégrée** (lecteur Notion), un signet vers le cours pour les autres
  sites, ou un encadré « Fichier local : cours.pdf » ;
- puis la note, **une ligne = un bloc** : chaque horodatage est un lien `04:15` qui rouvre la
  vidéo à cet instant (l’extension gère `#t=` sur toutes les plateformes), les références `p. 12`
  renvoient aux pages du PDF ;
- les **captures** sont téléversées dans Notion et légendées par leur horodatage cliquable ;
- les titres, listes, cases à cocher, citations, blocs de code et le gras / italique sont conservés ;
- pour un PDF, une section **« Passages surlignés »** reprend vos surlignages avec leur couleur.

## Synchronisation

- **Automatique** (par défaut) : quelques secondes après chaque modification d’une note, et après
  chaque changement de progression (seules les colonnes sont alors mises à jour).
- **Manuelle** : bouton Notion d’un cours, menu « ⋯ » d’une ligne de la bibliothèque, « Tout
  synchroniser » dans les réglages, menu de la zone de notification, ou **Exporter › Notion** dans
  le panneau de l’extension.
- **Incrémentale** : chaque bloc écrit par Boo Notes a une empreinte. Une note qui s’allonge ne
  génère que l’ajout des nouvelles lignes ; une ligne modifiée réécrit la fin de la page à partir
  de cette ligne. Les captures déjà envoyées ne sont pas renvoyées.
- **Sens unique** : Boo Notes → Notion. Ce que vous ajoutez vous-même dans la page Notion (sous
  les blocs de Boo Notes, ou dans d’autres colonnes) est conservé, mais n’est pas rapatrié. Évitez
  de modifier les blocs écrits par Boo Notes : ils seraient remplacés à la synchronisation suivante.
- Page supprimée dans Notion → recréée à la synchronisation suivante ; base supprimée → recréée
  sous la page parente.

## Suivre un cours hébergé dans Notion

Une vidéo ou un audio **déposé dans une page Notion** (bloc Vidéo / Audio) se prend en notes
comme sur YouTube : ouvrez la page dans le navigateur, `Alt+Shift+N`, écrivez — chaque ligne est
horodatée, `Alt+Shift+S` capture l’image. La note est liée à la page Notion (identifiant de la
page) et apparaît dans la base avec sa progression.

## Dépannage

| Message | Que faire |
| --- | --- |
| Jeton Notion refusé | Recopiez le secret de l’intégration (il change si vous le régénérez). |
| Page Notion introuvable / Accès refusé | La page n’est pas partagée avec l’intégration : ••• › Connexions › ajoutez-la. |
| Lien Notion invalide | Utilisez « Partager › Copier le lien » de la page (le lien contient un identifiant de 32 caractères). |
| Notion est injoignable | Pas de connexion Internet : les notes restent dans le dossier local et partiront à la prochaine synchronisation. |
| Notion limite le nombre de requêtes | Automatique : Boo Notes respecte ~3 requêtes / s et réessaie après le délai demandé par Notion. |

## Limites

- API Notion : 100 blocs par requête (découpage automatique), 2 000 caractères par segment de texte
  (découpage automatique), fichiers de 20 Mo maximum par capture.
- Un fichier local (PDF, audio, vidéo) n’est pas envoyé à Notion : seules la note, la progression
  et les captures le sont.
- Les colonnes « Statut » utilisent une sélection simple : l’API Notion ne permet pas de créer une
  propriété de type *Statut*.

## Développement

`api.notion.com` n’est pas nécessaire pour développer : `desktop/tools/mock-notion.mjs` imite les
points d’API utilisés (mêmes validations : 100 blocs, 2 000 caractères, fichiers, 429…).

```bash
cd desktop
npm run mock:notion                                   # http://127.0.0.1:43118, secret « secret_test »
NOTION_API_BASE=http://127.0.0.1:43118 npm start      # l’app parle au mock
```

Le lien de page parente du mock est `11111111-1111-4111-8111-111111111111`.
