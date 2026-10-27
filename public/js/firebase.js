// ==========================================
// RAHMAPOINT — js/firebase.js
// ==========================================
// Site statique (GitHub Pages) → imports via CDN gstatic (pas de bundler).
//
// NOTE SÉCURITÉ : la configuration ci-dessous est PUBLIQUE par conception (elle identifie le
// projet, elle ne l'authentifie pas). La vraie protection = règles Firestore (rules/firestore.rules),
// restrictions de la clé API (console Google Cloud) et domaines autorisés (Firebase Auth).
// Voir docs/GUIDE_ACTIONS_MANUELLES.md.

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCUrMrLy-bFPOT9YCglSWZTFxcusnsctJQ",
  authDomain:        "rahma-point.firebaseapp.com",
  projectId:         "rahma-point",
  storageBucket:     "rahma-point.firebasestorage.app",
  messagingSenderId: "169407709238",
  appId:             "1:169407709238:web:aa822072edee91b9d01897",
  measurementId:     "G-DD05YNHGDE"
};

// Clé publique reCAPTCHA (v3 ou Enterprise) pour Firebase App Check.
// Laissée VIDE volontairement : App Check nécessite de créer une clé reCAPTCHA et d'enregistrer
// l'application dans la console Firebase (voir le guide). Ne pas activer « Enforce » avant d'avoir
// vérifié que les requêtes légitimes sont bien « vérifiées ». App Check complète les règles, il ne les remplace pas.
const APP_CHECK_SITE_KEY = "";

const app = initializeApp(firebaseConfig);

if (APP_CHECK_SITE_KEY) {
  const { initializeAppCheck, ReCaptchaV3Provider } =
    await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-check.js");
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

const db   = getFirestore(app);   // cache mémoire uniquement : aucune persistance IndexedDB des données
const auth = getAuth(app);

// Analytics : chargé UNIQUEMENT après acceptation de la politique de confidentialité (consentement).
let analytics = null;
async function enableAnalytics() {
  if (analytics) return analytics;
  try {
    const mod = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-analytics.js");
    if (await mod.isSupported()) analytics = mod.getAnalytics(app);
  } catch (e) {
    console.warn("Analytics non initialisé :", e?.code || e?.message);
  }
  return analytics;
}

export { app, db, auth, enableAnalytics };
