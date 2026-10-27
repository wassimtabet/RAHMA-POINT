# Migration vers GitHub Pages — rapport

## 1. Inventaire initial
Recherche insensible à la casse de `netlify`, `.netlify`, `_redirects`, `_headers` dans tout le projet. Éléments trouvés (tous issus de l'audit précédent) :
`netlify.toml`, `public/_headers`, et des mentions dans le README, `package.json`, deux commentaires de code, les tests et les documents.
**Absents, donc rien à migrer** : Netlify Functions, appels `/.netlify/`, redirections/réécritures, variables d'environnement, scripts de déploiement, dépendances npm Netlify, `netlify.app` dans le code. Aucune fonctionnalité de l'application ne dépendait d'un backend Netlify : Firebase (Auth, Firestore) est conservé tel quel.

## 2. Fichiers supprimés
| Fichier | Raison |
|---|---|
| `netlify.toml` | Ne contenait que `publish = "public"` : remplacé par le workflow GitHub Pages (`path: public`). Aucune règle de sécurité perdue. |
| `public/_headers` | Spécifique à l'ancien hébergeur (non lu par GitHub Pages). Son contenu a été examiné : la CSP et la Referrer-Policy sont migrées en `<meta>` ; les autres en-têtes ne sont pas migrables (§4). |

## 3. Fichiers modifiés / créés
- `public/index.html` : ajout, avant toute ressource, de `<meta http-equiv="Content-Security-Policy">` (mêmes directives qu'avant, sauf `frame-ancestors`, ignoré en `<meta>`), `<meta name="referrer">` et `js/framebuster.js`.
- `public/js/framebuster.js` (nouveau) : anti-clickjacking de remplacement, partiel.
- `public/.nojekyll` (nouveau) : désactive le traitement Jekyll.
- `.github/workflows/pages.yml` (nouveau) : tests unitaires puis publication de `public/` ; permissions minimales ; aucun secret ; se déclenche sur `push` vers `main` ou à la main.
- `tests/static.test.mjs`, `tests/browser.test.mjs` : CSP lue dans le `<meta>` ; page servie sous `/rahmapoint/` ; tests de chemins relatifs, de workflow, d'absence de référence à l'ancien hébergeur, du framebuster.
- `README.md`, `package.json`, commentaires de `app.js`/`firebase.js`, `docs/GUIDE_ACTIONS_MANUELLES.md`, `docs/RAPPORT_AUDIT_SECURITE.md` : mentions de l'ancien hébergeur remplacées.
- Nouveau : `docs/GUIDE_DEPLOIEMENT_GITHUB_PAGES.md`.
- **Inchangés** : règles Firestore/Storage, `firebase.json`, `firestore.indexes.json`, code applicatif, `style.css`. Aucun réglage Firebase de production modifié.

## 4. Sécurité : ce qui est préservé et ce qui ne l'est plus
| Protection | Sur l'ancien hébergeur | Sur GitHub Pages |
|---|---|---|
| CSP (scripts, styles, images, connexions, cadres, objets, base-uri, form-action) | en-tête | **balise `<meta>`** : appliquée par le navigateur (vérifié dans Chromium) |
| Referrer-Policy | en-tête | `<meta name="referrer">` |
| `frame-ancestors`, `X-Frame-Options` (clickjacking) | en-tête | **impossible** ; `framebuster.js` = défense partielle, non équivalente |
| `X-Content-Type-Options: nosniff` | en-tête | **impossible** |
| `Permissions-Policy` | en-tête | **impossible** (la géolocalisation n'est utilisée qu'après action de l'utilisateur) |
| `Cross-Origin-Opener-Policy` | en-tête | impossible ; le comportement par défaut du navigateur permet la fenêtre de connexion Google |
| HSTS / HTTPS | en-tête | HTTPS imposé via *Enforce HTTPS* ; l'envoi de l'en-tête HSTS par GitHub **n'a pas été vérifié** |
| Cache longue durée de `vendor/` | en-tête | non configurable |
| Règles Firestore / Storage, validation, TTL | inchangées | inchangées (indépendantes de l'hébergeur) |

Je ne déclare aucun en-tête « actif » : aucun site n'est en ligne et rien n'a pu être vérifié sur GitHub. Pour des en-têtes complets, il faudrait placer un CDN/proxy devant le site (ex. Cloudflare avec règles de réponse, gratuit pour un domaine `.com`) : à décider ensuite, non fait ici.

Autres points propres à GitHub Pages : origine `*.github.io` partagée entre les sites d'un même compte (voir guide) ; site public même depuis un dépôt privé ; Pages en dépôt privé selon la formule GitHub.

## 5. Références restantes à l'ancien hébergeur
Uniquement dans le présent document (historique de la migration). Le test automatique `plus aucune référence…` vérifie qu'il n'y en a aucune ailleurs.

## 6. Tests réellement exécutés
Résultats obtenus dans cette session (`npm run test:unit`, `test:browser`, `test:rules`) :

| Test | Résultat |
|---|---|
| Unitaires `tests/util.test.mjs` | **15/15 réussis** |
| Statiques `tests/static.test.mjs` (dont CSP en `<meta>` avant tout script, chemins relatifs, workflow, aucune référence résiduelle, secrets) | **13/13 réussis** |
| Navigateur `tests/browser.test.mjs` (Chromium, page servie sous `/rahmapoint/`, Firebase simulé) : charges XSS neutralisées, CSP active, aucune ressource locale introuvable en sous-dossier (Leaflet, logo, scripts), flux visiteur/connecté/auteur, recherche, RTL, frame-busting depuis une autre origine | **11/11 réussis** |
| ESLint (`public/js`) | 0 erreur |
| Règles Firestore (émulateur, 47 scénarios) | **NON EXÉCUTÉS** (émulateur inaccessible dans mon environnement) |
| Syntaxe du workflow YAML | lue par un parseur YAML : valide ; **jamais exécuté sur GitHub** |
| Connexion Google et Firestore réels, domaines autorisés, CSP avec les vrais serveurs Google | **non testables ici** |
| Déploiement sur GitHub Pages, en-têtes HTTP réellement servis | **non effectués / non vérifiés** (aucun déploiement sans votre accord) |

Précision : un chiffre donné dans une réponse précédente (« 25 tests unitaires ») additionnait les tests unitaires (15) et statiques (10) ; le rapport d'audit est corrigé.

## 7. Actions manuelles restantes
Toutes celles de `GUIDE_ACTIONS_MANUELLES.md` (règles, TTL, purge, Auth, clé API, App Check, budget) + `GUIDE_DEPLOIEMENT_GITHUB_PAGES.md` (dépôt, Pages, domaine, domaines autorisés Firebase).
