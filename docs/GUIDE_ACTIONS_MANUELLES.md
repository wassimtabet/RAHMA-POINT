# Guide des actions manuelles (Firebase, Google Cloud, GitHub Pages)

Je n'ai accès à aucune de vos consoles : **rien de ce qui suit n'a été fait ni testé en réel.**
Aucun secret privé n'a été trouvé dans le projet, donc **aucune clé à révoquer**. La clé `AIza…` de `firebase.js` est la clé web Firebase, publique par conception.

## Ordre recommandé

### 0. Tester les règles AVANT de les publier
```
npm install
npm run test:unit && npm run test:browser
npm run test:rules        # nécessite Java ; lance l'émulateur Firestore (47 scénarios)
```
Les 47 tests de règles n'ont **pas pu être exécutés** dans mon environnement (téléchargement de l'émulateur bloqué). Si l'un échoue, ne publiez pas : corrigez d'abord.

### 1. Publier les règles (console Firebase → Firestore → Règles)
Collez `rules/firestore.rules`, ou : `npx firebase-tools deploy --only firestore:rules --project rahma-point`.
Si Storage est activé dans la console, collez aussi `rules/storage.rules` (refus total). Sinon ne l'activez pas.
⚠️ Les anciennes pages encore en cache dans les navigateurs recevront « Action refusée » : c'est normal.

### 2. Politiques TTL (purge automatique à 5 jours)
Console Firestore → *Time-to-live* → créer 3 politiques sur le champ `expiresAt`, pour les groupes de collections `signalements`, `comments` et `private`. Ou en ligne de commande :
```
gcloud firestore fields ttls update expiresAt --collection-group=signalements --enable-ttl --project=rahma-point
gcloud firestore fields ttls update expiresAt --collection-group=comments     --enable-ttl --project=rahma-point
gcloud firestore fields ttls update expiresAt --collection-group=private      --enable-ttl --project=rahma-point
```
La suppression TTL n'est pas instantanée (le site masque déjà les signalements de plus de 5 jours). À vérifier : disponibilité et facturation sur votre formule.

### 3. Purger les anciens signalements
Les anciens documents (sans `expiresAt`) contiennent encore contact, nom et photo en clair et ne seront jamais purgés par le TTL. Soit supprimez-les dans la console (ils ont au plus 5 jours), soit `scripts/purge-legacy.mjs` (simulation par défaut, `--delete` pour supprimer ; non testé).

### 4. Firebase Authentication
- *Sign-in method* : **Google uniquement**. Désactivez Anonyme et E-mail/mot de passe.
- *Settings → Authorized domains* : ajoutez `VOTRE-COMPTE.github.io` (le domaine seul, **sans** `/depot`) puis, plus tard, votre domaine `.com` et son `www` ; retirez `localhost` s'il ne sert plus.
- Activez la protection contre l'énumération d'e-mails si l'option est proposée.

### 5. Restreindre la clé API (Google Cloud Console → API et services → Identifiants)
Restrictions d'application : *Référents HTTP* : `https://VOTRE-COMPTE.github.io/NOM-DU-DEPOT/*`, puis `https://votredomaine.com/*` et `https://www.votredomaine.com/*`, `https://rahma-point.firebaseapp.com/*`.
Restrictions d'API : limitez aux API utilisées (Identity Toolkit, Token Service, Cloud Firestore, Firebase Installations, + Firebase Management/Analytics si vous gardez les statistiques). **Testez la connexion Google juste après** : une restriction trop stricte la casse.

### 6. Budget et quotas
Google Cloud → Facturation → créer une alerte de budget ; surveillez l'onglet *Utilisation* de Firestore.

### 7. App Check (optionnel mais recommandé)
Crée un service/clé reCAPTCHA (nouveau service, à votre décision) : console Firebase → App Check → enregistrer l'app web → copier la **clé de site** (publique) dans `APP_CHECK_SITE_KEY` de `public/js/firebase.js`. Surveillez les métriques plusieurs jours, puis seulement activez *Enforce* pour Firestore. App Check complète les règles, il ne les remplace pas. Ajoutez au besoin `https://www.google.com` / `https://www.gstatic.com/recaptcha/` à la CSP.

### 8. Déploiement GitHub Pages
Voir `GUIDE_DEPLOIEMENT_GITHUB_PAGES.md`. Aucune variable d'environnement ni secret n'est nécessaire. Les en-têtes HTTP (HSTS, X-Frame-Options, Permissions-Policy, nosniff) ne sont **pas** configurables sur GitHub Pages : voir `MIGRATION_GITHUB_PAGES.md`.

### 9. Première vérification en ligne (CSP) — important
La CSP a été validée dans Chromium avec Firebase simulé, **pas avec les vrais serveurs Google**. Après déploiement : ouvrez la console du navigateur, testez *Continuer avec Google*, publier, commenter, recherche, les 5 fonds de carte. Si une ressource légitime est bloquée (« Refused to … Content Security Policy »), ajoutez son domaine dans la balise `<meta http-equiv="Content-Security-Policy">` de `public/index.html`. Le mode « Report-Only » n'existe pas en `<meta>` : en cas de blocage de la connexion, corrigez directement la liste des domaines autorisés (console du navigateur → message « Refused to … »).

### 10. Modération (rôle admin)
Les signalements abusifs (3 signalements d'utilisateurs distincts) sont **masqués**, jamais supprimés. Pour en supprimer un : console Firestore, ou un compte « admin » (`node scripts/set-admin.mjs email@gmail.com`, non testé ; l'utilisateur doit se reconnecter).

## Décisions qui vous appartiennent
1. **Politique de confidentialité inexacte** (art. 6) : elle dit « La localisation exacte n'est pas affichée publiquement », or la carte publie les coordonnées exactes ; elle cite aussi « Photo (optionnel) » (inexistante). Je n'ai pas modifié ce texte juridique. Corrigez le texte, ou floutez les coordonnées publiques (arrondi, décalage), ce que je recommande pour des personnes vulnérables.
2. **Fond « Satellite » Esri** : ses conditions d'usage peuvent exiger une clé/licence en production. Retirez-le ou vérifiez les conditions.
3. **« Marquer résolu »** : tout utilisateur connecté peut clore ; seul l'auteur (ou un admin) peut rouvrir. Dites-moi si vous préférez « auteur uniquement ».
