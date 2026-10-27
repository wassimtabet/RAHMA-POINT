# Guide : dépôt GitHub privé, GitHub Pages et domaine .com

Rien n'a été déployé ni modifié chez GitHub, Firebase ou Google Cloud : ce sont des étapes à faire par vous.

## ⚠️ À savoir avant de commencer
1. **GitHub Pages depuis un dépôt privé** n'est disponible que sur certaines formules payantes de GitHub (Pro, Team, Enterprise) ; la formule gratuite exige un dépôt public. À vérifier dans *Settings → Pages* de votre compte. Même depuis un dépôt privé, **le site publié est public**. Seul le contenu de `public/` est publié (pas les règles, tests, scripts ni docs).
2. Sur `VOTRE-COMPTE.github.io`, tous vos sites Pages partagent la même origine : un autre dépôt Pages du même compte pourrait lire le stockage du navigateur de ce site (session Firebase comprise). Évitez d'héberger d'autres projets sous ce compte, ou passez au plus vite au domaine `.com`.
3. Le site publié sera à `https://VOTRE-COMPTE.github.io/NOM-DU-DEPOT/` ; tous les chemins du projet sont relatifs et fonctionnent dans ce sous-dossier.

## A. Envoyer le projet vers un dépôt privé
1. Sur github.com : *New repository* → nom (ex. `rahmapoint`) → **Private** → ne cochez ni README, ni .gitignore, ni licence → *Create*.
2. Dans le dossier du projet (celui qui contient `public/`) :
```
git init -b main
git add .
git status          # vérifiez : pas de node_modules, pas de .env, pas de clé JSON
git commit -m "RahmaPoint - version GitHub Pages"
git remote add origin https://github.com/VOTRE-COMPTE/rahmapoint.git
```
**Ne poussez pas encore** si vous voulez décider du moment de la publication : le workflow se lance à chaque `push` sur `main`. Si votre formule ne permet pas Pages, il échouera à l'étape de déploiement (sans conséquence).
3. Quand vous êtes prêt : `git push -u origin main` (authentification par jeton personnel ou GitHub CLI ; ne le mettez jamais dans un fichier du dépôt).

## B. Activer GitHub Pages
1. Dépôt → *Settings → Pages* → *Build and deployment → Source* : **GitHub Actions** (et non « Deploy from a branch »).
2. Onglet *Actions* : le workflow « Deploy to GitHub Pages » exécute d'abord `npm run test:unit` puis publie `public/`. Au premier lancement, validez si GitHub demande l'approbation de l'environnement `github-pages`.
3. L'adresse apparaît dans *Settings → Pages* et dans le résumé du workflow.
4. **Avant de tester la connexion Google**, ajoutez `VOTRE-COMPTE.github.io` dans Firebase → Authentication → Settings → *Authorized domains* (domaine seul, sans `/depot`), et complétez les actions de `GUIDE_ACTIONS_MANUELLES.md` (règles, TTL, restrictions de clé API…).
5. Vérifiez : connexion Google, création, commentaire, recherche, 5 fonds de carte ; console du navigateur sans « Refused to … Content Security Policy ».

## C. Domaine personnalisé `.com` (plus tard)
1. Achetez le domaine chez un registrar.
2. **Vérifiez le domaine** dans GitHub (*Settings → Pages → Add a domain*, ou profil → *Settings → Pages → Verified domains*) pour empêcher qu'un tiers le détourne.
3. DNS chez le registrar :
   - domaine nu (`votredomaine.com`) : 4 enregistrements **A** vers `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (et facultativement 4 **AAAA** `2606:50c0:8000::153` … `8003::153`) ;
   - `www` : enregistrement **CNAME** vers `VOTRE-COMPTE.github.io`.
   (Valeurs à recouper avec la documentation GitHub Pages au moment de la configuration : je n'ai pas pu la consulter ici.)
4. *Settings → Pages → Custom domain* : saisissez le domaine, enregistrez, attendez la vérification DNS puis cochez **Enforce HTTPS**.
   Avec le déploiement par workflow, **n'ajoutez pas de fichier `CNAME`** : le domaine se règle uniquement dans les paramètres Pages.
5. Firebase → *Authorized domains* : ajoutez `votredomaine.com` et `www.votredomaine.com`. Clé API : ajoutez les référents `https://votredomaine.com/*` et `https://www.votredomaine.com/*` (guide actions §5).
6. Rien à changer dans le code : les chemins sont relatifs et la CSP utilise `'self'`. `authDomain` peut rester `rahma-point.firebaseapp.com`.
