# « Connecter Notion » — mise en place (une fois)

Le bouton **Se connecter à… › Notion** (panneau de notes, et options › Notion) ouvre la fenêtre
de consentement de Notion : l’utilisateur se connecte, choisit « Utiliser le modèle » (ou coche une
page) et clique sur « Autoriser l’accès », puis nomme son coffre (« Boo Notes » par défaut) et
valide. Rien à copier : l’extension crée (ou retrouve) le coffre, sa table et une page par cours,
et y envoie les notes. Pour cela, il faut une fois :

1. **une intégration publique Notion** (son identifiant client et son secret), avec son modèle ;
2. **ce petit serveur d’échange** (`worker.mjs`), qui garde le secret. Il ne garde rien et n’est
   appelé qu’à trois moments : la connexion (`/token`, le code contre l’accès), un accès expiré
   (`/refresh`) et la déconnexion (`/revoke`, l’accès retiré dans Notion) ;
3. **leurs adresses dans le build** de l’extension.

## 1. L’intégration publique

1. [notion.so/profile/integrations](https://www.notion.so/profile/integrations) › **Nouvelle
   intégration** › type **Public**.
2. Capacités : lire, mettre à jour et insérer du contenu (pas besoin des informations des
   utilisateurs).
3. **URI de redirection** : `https://<id-de-l-extension>.chromiumapp.org/notion` — l’adresse exacte
   s’affiche dans les options de l’extension (section Notion) tant que la connexion en un clic
   n’est pas configurée. L’identifiant change si l’extension est chargée depuis un autre dossier :
   déclarez chaque adresse utilisée.
4. **Modèle (recommandé)** : créez une page « Boo Notes » vide (l’extension y écrit l’accueil, la
   table et les pages des cours, et la renomme au nom choisi), publiez-la sur le web (Partager ›
   Publier) et collez son adresse
   dans « Notion URL for optional template ». La fenêtre de Notion propose alors « Utiliser le
   modèle fourni par le développeur » : la page est copiée chez l’utilisateur et partagée avec
   Boo Notes d’office — l’utilisateur n’a rien à cocher.
5. Notez l’**OAuth client ID** et l’**OAuth client secret**.

## 2. Le serveur d’échange (Cloudflare Worker, offre gratuite)

```bash
cd tools/notion-oauth
npx wrangler deploy                          # → https://boo-notes-notion.<compte>.workers.dev
npx wrangler secret put NOTION_CLIENT_ID     # l’OAuth client ID
npx wrangler secret put NOTION_CLIENT_SECRET # l’OAuth client secret (il ne quitte jamais ce serveur)
npx wrangler secret put ALLOWED_EXTENSIONS   # facultatif : ids d’extension autorisés, séparés par des virgules
```

Il n’accepte que des adresses de retour `https://<id>.chromiumapp.org/notion` et ne répond qu’aux
extensions (en-têtes CORS). Tout autre hébergeur de fonctions (Vercel, Netlify, Deno Deploy…)
convient : `worker.mjs` est un simple gestionnaire `fetch(request, env)`.

## 3. Le build de l’extension

À la racine du dépôt, un fichier `notion-oauth.json` (rien de secret dedans) :

```json
{ "clientId": "…l’OAuth client ID…", "exchangeUrl": "https://boo-notes-notion.<compte>.workers.dev/token" }
```

ou les variables `BOO_NOTION_CLIENT_ID` et `BOO_NOTION_OAUTH_URL`, puis `npm run build` et
rechargez l’extension. Le bouton est alors actif (panneau et options) ; le secret
d’intégration reste disponible comme « méthode avancée ».

## Essayer sans Notion

```bash
npm run mock:notion                                                              # API Notion simulée (consentement compris)
NOTION_CLIENT_ID=client-test NOTION_CLIENT_SECRET=client-secret-test \
  NOTION_API=http://127.0.0.1:43118 npm run mock:notion-oauth                    # l’échange, sur http://127.0.0.1:43119/token
```

Le test `tests/e2e/notion-oauth.spec.ts` parcourt le tout, fenêtre de Chrome comprise : consentement
annulé puis accordé, modèle copié, notes envoyées, accès expiré renouvelé, déconnexion (accès
retiré dans Notion).
