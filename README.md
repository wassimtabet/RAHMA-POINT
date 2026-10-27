# RahmaPoint — رحمة بوينت (v4.1, GitHub Pages)

Plateforme solidaire (HTML/CSS/JS + Leaflet + Firebase Auth/Firestore), site statique hébergé sur GitHub Pages.

```
public/                 ← seul dossier publié (workflow GitHub Actions)
  index.html            ← CSP + Referrer-Policy en <meta> (GitHub Pages n'accepte pas d'en-têtes HTTP)
  style.css, logo.png, .nojekyll
  js/app.js firebase.js util.js reveal.js framebuster.js
  vendor/leaflet/       ← Leaflet 1.9.4 auto-hébergé
.github/workflows/pages.yml  ← déploiement de public/ (tests unitaires d'abord)
rules/firestore.rules   ← à publier dans Firebase (voir guide)
rules/storage.rules     ← refus total (Storage non utilisé)
firestore.indexes.json  ← politiques TTL (purge automatique)
tests/  scripts/  docs/
```

**À lire :** `docs/GUIDE_DEPLOIEMENT_GITHUB_PAGES.md` (dépôt privé, Pages, domaine .com), `docs/GUIDE_ACTIONS_MANUELLES.md` (Firebase) et `docs/MIGRATION_GITHUB_PAGES.md` (ce qui a changé, limites).

## Tests
```
npm install                     # une fois (Java requis pour l'émulateur Firestore)
npm run test:unit               # fonctions de sécurité + contrôles statiques
npm run test:browser            # Chromium, page servie sous /rahmapoint/ : XSS, CSP, chemins, flux utilisateur
npm run test:rules              # règles Firestore via l'émulateur (47 scénarios)
```
