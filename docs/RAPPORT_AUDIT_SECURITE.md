# Rapport d'audit de sécurité — RahmaPoint

Date : 12/10/2026 · Périmètre : `rahmapoint_corrige_v2.zip` (index.html, app.js, firebase.js, style.css, logos).
**Ce rapport n'affirme pas que le site est sécurisé.** Il décrit ce qui a été trouvé, corrigé, testé, et ce qui reste.

## 1. Ce qui a été examiné — et ce qui manquait
Présents : 5 fichiers de code, aucune dépendance npm. Leaflet et la police étaient chargés depuis des CDN.
**Absents** : `firestore.rules`, `storage.rules`, `firebase.json`, configuration d'hébergement, en-têtes, `package.json`. Les règles réellement actives dans votre console Firebase sont **inconnues** : je n'ai pas pu les auditer. Le client (suppression par n'importe quel connecté, réécriture de tableaux) ne fonctionne que si elles sont très permissives, ou en mode test ouvert.

## 2. Vulnérabilités

Statut : **C** = confirmé (preuve technique) · **P** = potentiel (dépend de la configuration externe).

| # | Gravité | Statut | Problème | Fichier (original) | Correction |
|---|---|---|---|---|---|
| 1 | Critique | C (code) | **Suppression de n'importe quel signalement par 2 comptes Google** : `reportSituation` appelle `deleteDoc` dès que `reportCount >= 2` ; compteur calculé côté client. | app.js `reportSituation` | Plus aucune suppression par compteur ; incrément ±1 contrôlé par les règles ; masquage côté client à 3 signalements d'utilisateurs distincts. |
| 2 | Critique | P | **Aucune règle Firestore fournie** ; règles actives inconnues (probablement permissives). | — | `rules/firestore.rules` : refus par défaut, schéma, types, longueurs, propriétaire, compteurs, limites. |
| 3 | Élevé | **C (PoC)** | **XSS DOM** : `lat`/`lng` insérés tels quels dans `onclick="goToRoute(${s.lat},${s.lng})"`, et `esc()` sur l'id dans `onclick="openDetail('…')"` est inefficace (`&#x27;` redevient `'` dans l'attribut). | app.js `buildCard`, `openDetail`, `buildPopupHTML` | Plus aucun `onclick` (délégation `data-action`), `sanitizeSignal` (nombres validés, id `[A-Za-z0-9_-]`, type liste blanche), CSP sans `unsafe-inline` pour les scripts. |
| 4 | Élevé | C | **Données personnelles** : contact (téléphone), nom et photo Google, uid stockés dans un document public ; **cache `localStorage` de tous les signalements, contacts compris**. | app.js `submitSignal`, `listenToFirestore` | Contact déplacé en sous-document `private/info` (utilisateurs connectés seulement) ; `userName`/`userPhoto` supprimés ; cache supprimé (et ancien cache purgé) ; cartes sans contact. |
| 5 | Élevé | C | **Dates côté client** : `createdAt` fourni par le client (signalement « immortel » en postdatant) ; purge faite par tout visiteur via `deleteDoc` (implique des droits de suppression larges). | app.js `purgeExpired` | `createdAt == request.time` (règles), `expiresAt` borné à 6 jours, purge par politique TTL, fonction client supprimée. |
| 6 | Moyen | C | **Commentaires** : tableau entier réécrit (`updateDoc comments`) → écrasement/perte en cas d'envois simultanés ; tout connecté peut réécrire tous les commentaires. | app.js `addComment` | Sous-collection `comments`, un document par commentaire, non modifiable. |
| 7 | Moyen | C | **« Marquer résolu » ouvert à tous**, y compris pour rouvrir/falsifier l'état. | app.js `toggleResolve` | Tout connecté peut résoudre ; seul l'auteur/admin rouvre. |
| 8 | Moyen | C | **Fausse position** : sans clic carte, coordonnées aléatoires autour de Skikda. | app.js `submitSignal` | Position obligatoire et validée (emprise Algérie). |
| 9 | Moyen | C | **Spam / quotas** : aucune limitation, lecture de toute la collection. | app.js | Intervalle 120 s (signalement) / 10 s (commentaire) via règles ; `limit ≤ 300` obligatoire ; confirmations et signalements uniques par utilisateur, interdits à l'auteur. |
| 10 | Moyen | C | **Analytics lancé avant consentement.** | firebase.js | Chargé uniquement après acceptation. |
| 11 | Moyen | C | **Pas de CSP/en-têtes ; Leaflet chargé depuis unpkg sans SRI** (chaîne d'approvisionnement). | index.html | CSP et Referrer-Policy (balise `<meta>` de `public/index.html`) ; HSTS/nosniff/anti-clickjacking/Permissions-Policy : voir `MIGRATION_GITHUB_PAGES.md` ; Leaflet 1.9.4 auto-hébergé. |
| 12 | Moyen | C | **Nominatim** : recherche à la frappe = auto-complétion interdite par sa politique d'usage ; max 1 requête/s (source ci-dessous). Résultats non validés. | app.js `geocodeSearch` | Recherche à la touche Entrée, ≥ 3 caractères, délai 1,1 s, résultats validés, rendu en `textContent`. |
| 13 | Moyen | C | **Politique de confidentialité inexacte** (localisation « non publique », « photo »). | index.html | **Non modifié** (décision propriétaire, voir guide). |
| 14 | Faible | C | `window.open` sans `noopener` ; avatar non filtré ; toasts avec valeur échappée deux fois. | app.js | Corrigé (`noopener,noreferrer`, avatar https Google seulement). |
| 15 | Faible | P | Clé API Firebase non restreinte (publique par conception). | firebase.js | Instructions de restriction (guide §5). |
| 16 | Info | C | Fichiers en double (`logo (3).png`), commentaire « GitHub Pages ». | — | Nettoyé. |

### Preuve technique des points 1 et 3
- **XSS (PoC exécuté localement sur le code original, Chromium, Firebase simulé)** : un document avec `lat = "1);window.__pwned='…'//"` puis un clic sur « Itinéraire » exécute le script ; un document dont l'id est `x');window.__pwned2='…'//` l'exécute au clic sur « Détail ». Résultat : `{"cards":2,"pwned_lat":"XSS via lat","pwned_id":"XSS via id"}`. Exploitable par quiconque peut écrire un document (avec les règles actuelles inconnues, au minimum tout compte Google connecté si elles sont permissives ou en mode test). Le même scénario, rejoué sur la nouvelle version (tests navigateur 1 et 5), n'exécute rien et écarte les documents piégés.
- **Suppression par compteur** : lecture directe du code (`if (newCount >= 2) { await deleteDoc(...) }`). Non exécutée en réel (pas d'accès au projet).

## 3. Contrôles par thème (A à K)
- **A. Auth** : écritures réservées aux comptes `google.com` à e-mail vérifié (règles) ; rôle admin = custom claim posé côté serveur ; les contrôles JS ne sont qu'ergonomiques.
- **B. Firestore** : voir `rules/firestore.rules` (commenté). Storage : non utilisé, refus total.
- **C. Signalements** : traités (points 1, 5–9).
- **D. XSS** : tous les `innerHTML` restants n'insèrent que des valeurs passées par `esc()` ou des nombres validés ; résultats de recherche, toasts, contact en `textContent`.
- **E. Validation** : client (`util.js`) **et** serveur (règles), limites identiques.
- **F. Abus** : voir point 9 ; App Check préparé mais **désactivé** (nécessite une clé reCAPTCHA).
- **G. Confidentialité** : points 4, 10, 13.
- **H. Secrets/dépendances** : aucun secret privé ; aucune dépendance de production ; Leaflet 1.9.4 : `npm audit` → 0 vulnérabilité.
- **I. Hébergement** : CSP en `<meta>`, publication de `public/` seulement (workflow GitHub Pages) ; en-têtes HTTP non disponibles (voir migration).
- **J. Cartes** : OSM reste le fond par défaut ; Esri Satellite à vérifier (conditions d'usage).
- **K. Autres** : plafonds de tableaux (500), `limit` sur lecture, ids de documents contraints (`^[A-Za-z0-9]{20}$`).

## 4. Tests

| Test | Résultat |
|---|---|
| Unitaires `util.test.mjs` (échappement, XSS lat/id/type, dates, masquage, validation, avatar, itinéraire) | **15/15 réussis** |
| Statiques `static.test.mjs` (pas de handler inline, pas de secret — avec test négatif, CSP, règles, publication) | **10/10 réussis** (13 depuis la migration) |
| Navigateur `browser.test.mjs` (Chromium, vrai `index.html` + CSP réelle, Firebase simulé) : charges XSS dans description, lieu, commentaire, contact, nom, résultats de recherche ; CSP bloque un script inline ; analytics après consentement ; flux visiteur/connecté/auteur ; écritures conformes aux règles ; RTL | **9/9 réussis** |
| ESLint (`no-undef`, `no-eval`, etc.) sur `public/js` | 0 erreur |
| `npm audit` (Leaflet 1.9.4) | 0 vulnérabilité |
| **Règles Firestore (émulateur) — 47 scénarios écrits** | **NON EXÉCUTÉS** : le téléchargement de l'émulateur est bloqué ici |
| Syntaxe des règles | **Non validée par machine** (relue à la main) : le compilateur est dans l'émulateur |
| Connexion Google, Firestore, Analytics, TTL, App Check réels ; CSP avec les vrais serveurs Google | **Non testables ici** |
| En-têtes/CSP sur l'hébergement en ligne | **Non testables ici** |
| Tests de charge sur le site public | Volontairement non lancés |

Correspondance avec vos 8 scénarios : (1) visiteur crée → règles 1 [non exécuté] + navigateur « invite de connexion » [réussi] · (2) lecture non autorisée → règles 3b [non exécuté] + navigateur [réussi : pas de contact/commentaires] · (3) modifier le signalement d'un autre → règles 4 [non exécuté] · (4) supprimer → règles 4b/5c [non exécuté] · (5) falsifier compteur/rôle → règles 1d, 5, 5b, 4e [non exécuté] · (6) XSS → unitaires + navigateur [réussis] · (7) commentaires simultanés → règles 7c [non exécuté] ; structurellement corrigé (un document par commentaire) · (8) contournement du frontend → règles 1d [non exécuté] ; validations client [réussies].

## 5. Risques résiduels
- **Les règles n'ont jamais été exécutées** : lancez `npm run test:rules` avant publication.
- **Coordonnées exactes publiques** (nature du service) : danger réel pour des personnes vulnérables ; floutage recommandé.
- **Comptes Google multiples** : un attaquant peut fabriquer des confirmations ou masquer un signalement (3 comptes) ; mitigation : revue admin, App Check, seuil.
- Le contact n'est protégé que par une connexion Google gratuite (scraping par comptes possible).
- Firebase SDK chargé depuis `gstatic.com` (SRI impossible sur modules ES) ; Google Fonts externe.
- CSP : `style-src 'unsafe-inline'` conservé (nombreux styles inline) ; domaines Google possiblement incomplets : tester en ligne.
- Tolérance d'horloge client de 1 jour sur `expiresAt` ; TTL non instantané ; anciens documents lisibles tant que non purgés (guide §3).
- Aucun plafond de commentaires par signalement (limitation de fréquence seulement).
- Pas de modération automatique, pas de journalisation.

## 6. Actions manuelles
Voir `GUIDE_ACTIONS_MANUELLES.md` (règles, TTL, purge, Auth, clé API, App Check, budget, GitHub Pages, vérification CSP, décisions à prendre).

## 7. Fichiers modifiés / créés
- **Remplacés** : `index.html` (handlers → `data-action`, scripts externes, Leaflet local) ; `app.js` → `public/js/app.js` (réécriture des parties sensibles) ; `firebase.js` → `public/js/firebase.js` (analytics après consentement, App Check préparé).
- **Créés** : `public/js/util.js`, `public/js/reveal.js`, `public/vendor/leaflet/*`, `rules/firestore.rules`, `rules/storage.rules`, `firestore.indexes.json`, `firebase.json`, `package.json`, `.gitignore`, `tests/*` (4 fichiers), `scripts/*` (2), `docs/*`, `README.md`.
- **Inchangés** : `style.css`, `logo.png`. **Supprimé** : `logo (3).png` (doublon identique).

## 8. Sources
- Politique d'usage Nominatim (consultée : auto-complétion interdite, 1 requête/s max, Referer valide) : https://operations.osmfoundation.org/policies/nominatim/
- Firebase — règles et requêtes (`request.query.limit`, « les règles ne sont pas des filtres ») : https://firebase.google.com/docs/firestore/security/rules-query
- Firebase — TTL : https://firebase.google.com/docs/firestore/ttl
- Firebase — clés API : https://firebase.google.com/docs/projects/api-keys · Checklist : https://firebase.google.com/support/guides/security-checklist
- OWASP Top 10 (A01 contrôle d'accès, A03 injection, A05 mauvaise configuration, A08 intégrité) et Cheat Sheets XSS/CSP.

Transparence : seule la page Nominatim a pu être ouverte et citée ; les autres pages ont été identifiées par recherche mais leur contenu n'a pas pu être relu ici, et les points correspondants reposent sur ma connaissance de ces documentations.
