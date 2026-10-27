/*
 * RahmaPoint — js/app.js
 * v4 : audit de sécurité — voir docs/RAPPORT_AUDIT_SECURITE.md
 *
 * Principes appliqués :
 *  - aucune donnée Firestore n'est interprétée comme du code (assainissement + échappement,
 *    plus aucun gestionnaire onclick inline : délégation d'événements via data-action) ;
 *  - toutes les écritures sont aussi contrôlées côté serveur par rules/firestore.rules ;
 *  - aucune suppression par compteur ; les signalements abusifs sont seulement MASQUÉS ;
 *  - pas de cache local des signalements / contacts ; analytics seulement après consentement.
 */

import { db, auth, enableAnalytics } from './firebase.js';
import {
  collection, doc, getDoc, onSnapshot, query, orderBy, limit,
  writeBatch, updateDoc, arrayUnion, increment, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  esc, cleanText, LIMITS, EXPIRATION_DAYS, DAY_MS, isValidLatLng, validateSignal,
  sanitizeSignal, sanitizeComment, isExpired, getDaysLeft, isHidden, safeAvatarUrl, routeUrl,
} from './util.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_CENTER = [36.19, 5.41];
const PRIVACY_KEY    = 'rahmapoint_privacy_accepted';
const LANG_KEY       = 'rahmapoint_lang';
const LEGACY_CACHE_KEY = 'rahmapoint_situations';   // ancien cache (contenait les contacts) : purgé

const TYPE_CONFIG = {
  nourriture: { emoji: '🍞', color: '#C0392B', fr: 'Nourriture', ar: 'طعام' },
  medical:    { emoji: '🏥', color: '#8E44AD', fr: 'Médical',    ar: 'طبي'  },
  vetement:   { emoji: '👕', color: '#2980B9', fr: 'Vêtement',   ar: 'ملابس' },
  abri:       { emoji: '🏠', color: '#D35400', fr: 'Abri',       ar: 'مأوى' },
  autre:      { emoji: '💬', color: '#27AE60', fr: 'Autre',      ar: 'أخرى' },
};

// Fournisseurs de tuiles — tous SANS clé API (les domaines doivent figurer dans la CSP <meta> de public/index.html).
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_LAYERS = {
  osm:       { url: OSM_URL, attr: '© OpenStreetMap contributors', maxNativeZoom: 19 },
  hot:       { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
               attr: '© OpenStreetMap contributors, style par Humanitarian OpenStreetMap Team, hébergé par OpenStreetMap France',
               maxNativeZoom: 19 },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
               attr: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
  dark:      { url: OSM_URL, attr: '© OpenStreetMap contributors', maxNativeZoom: 19, className: 'tiles-dark' },
  topo:      { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
               attr: 'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)',
               maxNativeZoom: 17 },
};

function buildTileLayer(cfg) {
  return L.tileLayer(cfg.url, {
    attribution:   cfg.attr,
    maxZoom:       19,
    maxNativeZoom: cfg.maxNativeZoom || 19,
    className:     cfg.className || '',
  });
}

const DEFAULT_MAP_STYLE = 'osm';

// ─── State ───────────────────────────────────────────────────────────────────

let situations   = [];
let currentLang  = 'fr';
let currentUser  = null;
let activeFilter = 'all';
let selectedType = '';
let tempLatLng   = null;
let map, markersLayer, currentTileLayer, tempMarker;
let hintHidden   = false;
let firestoreListening = false;
let detailId     = null;       // signalement affiché dans la modale détail
let commentsUnsub = null;      // abonnement aux commentaires du détail ouvert
let lastSearchAt = 0;
let submitting   = false;

const t = (fr, ar) => (currentLang === 'fr' ? fr : ar);
const $ = (id) => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Purge l'ancien cache local (il contenait numéros de téléphone et données de tous les signalements)
  try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch (_) { /* ignore */ }

  try {
    const savedLang = localStorage.getItem(LANG_KEY);
    if (savedLang === 'ar' || savedLang === 'fr') currentLang = savedLang;
  } catch (_) { /* ignore */ }
  setLangUI(currentLang);

  checkPrivacyAccepted();
  initMap();
  initSearchBar();
  initAuth();
  $('acceptCheck')?.addEventListener('change', updateAcceptBtn);
  renderAll();
});

// ─── Politique de confidentialité ────────────────────────────────────────────

function checkPrivacyAccepted() {
  let accepted = false;
  try { accepted = localStorage.getItem(PRIVACY_KEY) === 'yes'; } catch (_) { /* ignore */ }
  if (accepted) {
    $('privacyModal').classList.remove('active');
    enableAnalytics();               // consentement déjà donné lors d'une visite précédente
  }
}

function updateAcceptBtn() {
  $('acceptBtn').disabled = !$('acceptCheck').checked;
}

function acceptPrivacy() {
  try { localStorage.setItem(PRIVACY_KEY, 'yes'); } catch (_) { /* ignore */ }
  $('privacyModal').classList.remove('active');
  enableAnalytics();                 // analytics uniquement après consentement
  showToast(t('✓ Bienvenue sur RahmaPoint !', '✓ مرحباً بك في رحمة بوينت!'));
}

// ─── Firestore ────────────────────────────────────────────────────────────────

function listenToFirestore() {
  // limit() est exigé par les règles (anti lecture massive) ; l'expiration réelle est faite par la politique TTL.
  const q = query(collection(db, 'signalements'), orderBy('createdAt', 'desc'), limit(LIMITS.LIST_MAX));
  onSnapshot(q,
    (snapshot) => {
      const now = Date.now();
      situations = snapshot.docs
        .map(d => sanitizeSignal(d.id, d.data({ serverTimestamps: 'estimate' }), now))
        .filter(s => s && !isExpired(s, now));
      renderAll();
      if (detailId && !situations.some(s => s.id === detailId)) closeModalById('detailModal');
    },
    (err) => {
      console.error('Firestore sync error:', err?.code || err?.message);
      showToast(t('⚠️ Connexion Firebase impossible', '⚠️ تعذّر الاتصال'));
    }
  );
}

function errorToast(err) {
  console.error(err?.code || err?.message || err);
  if (err?.code === 'permission-denied') {
    showToast(t('⛔ Action refusée (droits ou limite de fréquence)', '⛔ تم رفض الإجراء (الصلاحيات أو الحد الزمني)'));
  } else {
    showToast(t('❌ Erreur Firebase', '❌ خطأ في Firebase'));
  }
}

// Signalements visibles pour l'utilisateur courant (les signalements abusifs sont masqués, jamais supprimés)
function visibleSituations() {
  const uid = currentUser?.uid;
  return situations.filter(s => !isHidden(s, uid));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function initAuth() {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    renderAuthZone();
    renderAll();
    if (detailId) openDetail(detailId);            // rafraîchit contact / commentaires selon la connexion
    if (!firestoreListening) {
      firestoreListening = true;
      listenToFirestore();
    }
  });
}

function renderAuthZone() {
  const zone = $('authZone');
  if (!zone) return;

  if (currentUser) {
    const photo = safeAvatarUrl(currentUser.photoURL);
    const avatarHTML = photo
      ? `<img src="${esc(photo)}" alt="avatar" class="user-avatar" referrerpolicy="no-referrer">`
      : `<div class="user-avatar user-avatar-placeholder">${esc(currentUser.displayName?.[0] ?? '?')}</div>`;

    zone.innerHTML = `
      <div class="user-info">
        ${avatarHTML}
        <span class="user-name">${esc(currentUser.displayName || currentUser.email)}</span>
      </div>
      <button class="btn-logout" data-action="logoutUser">
        <span data-fr="Déconnexion" data-ar="تسجيل خروج">Déconnexion</span>
      </button>`;
  } else {
    zone.innerHTML = `
      <button class="btn-google-login" data-action="loginWithGoogle">
        <svg width="18" height="18" viewBox="0 0 48 48" style="flex-shrink:0">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        <span data-fr="Continuer avec Google" data-ar="تسجيل الدخول بـ Google">Continuer avec Google</span>
      </button>`;
  }

  applyLang(currentLang);
}

async function loginWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
    // textContent (showToast) → pas d'HTML interprété ; pas besoin d'échapper ici
    showToast(t(`✓ Bienvenue ${auth.currentUser?.displayName ?? ''} !`, `✓ أهلاً ${auth.currentUser?.displayName ?? ''} !`));
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error(err?.code || err?.message);
      showToast(t('❌ Connexion échouée', '❌ فشل تسجيل الدخول'));
    }
  }
}

async function logoutUser() {
  await signOut(auth).catch((e) => console.error(e?.code || e?.message));
  closeModalById('detailModal');
  showToast(t('👋 Déconnecté', '👋 تم تسجيل الخروج'));
}

// ─── Carte ────────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 12);
  const def = TILE_LAYERS[DEFAULT_MAP_STYLE] || TILE_LAYERS.osm;
  currentTileLayer = buildTileLayer(def).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    const isModalOpen = $('signalModal').classList.contains('active');
    tempLatLng = e.latlng;
    const coordStr = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
    $('locationInput').value = coordStr;

    if (!hintHidden) {
      hintHidden = true;
      $('mapHint')?.classList.add('hidden');
    }

    showTempMarker(e.latlng);

    if (isModalOpen) {
      showToast(t('📍 Position mise à jour', '📍 تم تحديث الموقع'));
    } else {
      openSignalModal();
      // openSignalModal() réinitialise le formulaire : on restaure la position cliquée
      if ($('signalModal').classList.contains('active')) {
        tempLatLng = e.latlng;
        $('locationInput').value = coordStr;
        showToast(t('📍 Position sélectionnée — complétez le formulaire', '📍 تم اختيار الموقع — أكمل النموذج'));
      }
    }
  });
}

function showTempMarker(latlng) {
  if (tempMarker) map.removeLayer(tempMarker);
  const icon = L.divIcon({
    className: '',
    html: '<div class="temp-marker-anim"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  tempMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
}

function switchMapStyle(style, btn) {
  if (!Object.hasOwn(TILE_LAYERS, style)) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = buildTileLayer(TILE_LAYERS[style]).addTo(map);
  currentTileLayer.bringToBack();
  document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showToast(`🗺 ${style}`);
}

function locateOnMap() {
  if (!navigator.geolocation) {
    showToast(t('Géolocalisation non disponible', 'تحديد الموقع غير متاح'));
    return;
  }
  showToast(t('📍 Localisation en cours…', '📍 جارٍ تحديد الموقع…'));
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 15, { animate: true });
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
        radius: 8, color: '#4A9B6F', fillColor: '#4A9B6F', fillOpacity: .35, weight: 2,
      }).addTo(markersLayer);
    },
    () => showToast(t('Position indisponible', 'تعذّر تحديد موقعك'))
  );
}

function refreshMap() {
  renderMarkers();
  map.setView(DEFAULT_CENTER, 12, { animate: true });
  showToast(t('🔄 Carte actualisée', '🔄 تم تحديث الخريطة'));
}

function toggleMapFullscreen() {
  const wrapper = $('mapWrapper');
  const btn = $('mapFullscreenBtn');
  if (!wrapper) return;
  const isFullscreen = wrapper.classList.toggle('fullscreen');
  document.body.classList.toggle('map-fullscreen-active', isFullscreen);
  if (btn) btn.textContent = isFullscreen ? '✕' : '⛶';
  setTimeout(() => map.invalidateSize(), 250);
}

// ─── Barre de recherche (Nominatim / OpenStreetMap) ──────────────────────────
// La politique d'usage de Nominatim interdit l'auto-complétion et limite à 1 requête/s :
// la recherche se lance donc à la validation (touche Entrée), avec un délai minimal entre deux requêtes.

const SEARCH_MIN_INTERVAL_MS = 1100;

function initSearchBar() {
  const wrapper = $('mapSearchWrapper');
  if (!wrapper) return;

  const input    = wrapper.querySelector('#mapSearchInput');
  const results  = wrapper.querySelector('#mapSearchResults');
  const clearBtn = wrapper.querySelector('#mapSearchClear');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    clearBtn.style.display = input.value.trim() ? 'flex' : 'none';
    if (input.value.trim().length < 3) { results.replaceChildren(); results.classList.remove('open'); }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim().slice(0, 100);
    if (q.length < 3) return;
    const wait = lastSearchAt + SEARCH_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) { showToast(t('⏳ Patientez une seconde…', '⏳ انتظر ثانية…')); return; }
    lastSearchAt = Date.now();
    geocodeSearch(q, results);
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      results.replaceChildren();
      results.classList.remove('open');
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    results.replaceChildren();
    results.classList.remove('open');
    clearBtn.style.display = 'none';
    input.focus();
  });
}

function messageRow(text) {
  const div = document.createElement('div');
  div.className = 'search-no-result';
  div.textContent = text;
  return div;
}

async function geocodeSearch(q, resultsEl) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}&countrycodes=dz`;
    const res  = await fetch(url, { headers: { 'Accept-Language': currentLang } });
    if (!res.ok) throw new Error('Nominatim error ' + res.status);
    const data = await res.json();

    resultsEl.replaceChildren();
    const places = (Array.isArray(data) ? data : [])
      .map(p => ({ name: cleanText(p.display_name, 200), lat: Number(p.lat), lon: Number(p.lon) }))
      .filter(p => p.name && isValidLatLng(p.lat, p.lon));

    if (!places.length) {
      resultsEl.appendChild(messageRow(t('Aucun résultat', 'لا توجد نتائج')));
      resultsEl.classList.add('open');
      return;
    }

    for (const place of places) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.tabIndex = 0;
      const pin = document.createElement('span');  pin.className = 'search-pin';  pin.textContent = '📍';
      const nm  = document.createElement('span');  nm.className  = 'search-name'; nm.textContent  = place.name;
      item.append(pin, nm);

      const go = () => {
        map.setView([place.lat, place.lon], 15, { animate: true });
        resultsEl.replaceChildren();
        resultsEl.classList.remove('open');
        $('mapSearchInput').value = place.name;
        $('mapSearchClear').style.display = 'flex';
      };
      item.addEventListener('click', go);
      item.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      resultsEl.appendChild(item);
    }
    resultsEl.classList.add('open');
  } catch (err) {
    console.error('Geocode error:', err?.message);
    resultsEl.replaceChildren(messageRow('⚠️ ' + t('Erreur de recherche', 'خطأ في البحث')));
    resultsEl.classList.add('open');
  }
}

// ─── Marqueurs ────────────────────────────────────────────────────────────────

function renderMarkers() {
  markersLayer.clearLayers();
  getFiltered().forEach(addMarker);
}

function addMarker(s) {
  const cfg   = TYPE_CONFIG[s.type] || TYPE_CONFIG.autre;
  const color = s.resolved ? '#5B8A5B' : cfg.color;

  const icon = L.divIcon({
    className: '',
    html: `<div class="rahma-marker" style="background:${color}"><div class="rahma-marker-inner">${cfg.emoji}</div></div>`,
    iconSize: [36, 36], iconAnchor: [18, 36], popupAnchor: [0, -38],
  });

  L.marker([s.lat, s.lng], { icon })
    .bindPopup(buildPopupHTML(s), { maxWidth: 260 })
    .addTo(markersLayer);
}

function buildPopupHTML(s) {
  const cfg          = TYPE_CONFIG[s.type] || TYPE_CONFIG.autre;
  const label        = cfg[currentLang] || cfg.fr;
  const shortDesc    = esc(s.description.length > 80 ? s.description.slice(0, 80) + '…' : s.description);
  const confirmCount = s.confirmedBy.length;
  const fr = currentLang === 'fr';

  return `
    <div class="popup-inner">
      <div class="popup-type">${cfg.emoji} ${label}</div>
      <div class="popup-desc">${shortDesc}</div>
      ${confirmCount > 0 ? `<div class="popup-confirms">✓ ${fr ? `${confirmCount} confirmation${confirmCount > 1 ? 's' : ''}` : `${confirmCount} تأكيد`}</div>` : ''}
      <button class="popup-btn" data-action="openDetail" data-id="${esc(s.id)}">${fr ? 'Voir détail' : 'عرض التفاصيل'}</button>
      ${s.resolved
        ? `<span class="popup-resolved">${fr ? 'Résolu ✓' : 'تم الحل ✓'}</span>`
        : `<button class="popup-btn green" data-action="resolveFromMap" data-id="${esc(s.id)}">✓ ${fr ? 'Marquer résolu' : 'تم الحل'}</button>`}
    </div>`;
}

// ─── Rendu ────────────────────────────────────────────────────────────────────

function renderAll() {
  renderCards();
  renderMarkers();
  updateStats();
}

function renderCards() {
  const grid  = $('cardsGrid');
  const empty = $('emptyState');
  const items = getFiltered();               // déjà triés du plus récent au plus ancien (requête desc)

  grid.replaceChildren();
  empty.style.display = items.length ? 'none' : 'block';
  items.forEach((s, i) => grid.appendChild(buildCard(s, i)));
}

function buildCard(s, delay) {
  const cfg    = TYPE_CONFIG[s.type] || TYPE_CONFIG.autre;
  const fr     = currentLang === 'fr';
  const label  = cfg[currentLang] || cfg.fr;
  const timeAgo = getTimeAgo(s.createdAtMs);
  const daysLeft = getDaysLeft(s.createdAtMs);

  const confirmCount     = s.confirmedBy.length;
  const uid              = currentUser?.uid;
  const isOwner          = !!uid && uid === s.userId;
  const alreadyConfirmed = !!uid && s.confirmedBy.includes(uid);
  const id = esc(s.id);

  const card = document.createElement('div');
  card.className = `card${s.resolved ? ' resolved' : ''}`;
  card.style.animationDelay = `${delay * 0.07}s`;

  // Bouton « résolu » : n'importe quel utilisateur connecté peut marquer résolu ; seul l'auteur peut rouvrir.
  const resolveBtn = s.resolved
    ? (isOwner
        ? `<button class="card-btn gray" data-action="toggleResolve" data-id="${id}">${fr ? 'Rouvrir' : 'إعادة فتح'}</button>`
        : `<button class="card-btn gray" disabled>${fr ? 'Résolu ✓' : 'تم الحل ✓'}</button>`)
    : `<button class="card-btn green" data-action="toggleResolve" data-id="${id}">${fr ? 'Marquer résolu' : 'وضع علامة محلول'}</button>`;

  // Toutes les données issues de Firestore passent par esc() ; lat/lng sont des nombres validés (sanitizeSignal).
  card.innerHTML = `
    <div class="card-header" style="background:${s.resolved ? '#5B8A5B' : cfg.color}">
      <span class="card-type">${cfg.emoji} ${label}</span>
      <span class="card-badge${s.resolved ? ' resolved-badge' : ''}">${fr ? (s.resolved ? 'Résolu' : 'En attente') : (s.resolved ? 'تم الحل' : 'بانتظار')}</span>
    </div>
    <div class="card-body">
      <p class="card-desc">${esc(s.description)}</p>
      <div class="card-meta">
        <span>🕐 ${esc(timeAgo)}</span>
        ${daysLeft !== null ? `<span class="expiry-badge" title="${fr ? 'Expiration automatique' : 'حذف تلقائي'}">⏳ ${daysLeft}j</span>` : ''}
        ${s.location ? `<span>📍 ${esc(s.location)}</span>` : ''}
        ${s.reportCount > 0 ? `<span class="report-count">⚠️ ${s.reportCount}</span>` : ''}
      </div>
      ${confirmCount > 0 ? `<span class="confirm-count">✓ ${fr ? `${confirmCount} confirmation${confirmCount > 1 ? 's' : ''}` : `${confirmCount} تأكيد`}</span>` : ''}
      <div class="card-actions">
        <button class="card-btn primary" data-action="openDetail" data-id="${id}">${fr ? 'Détail' : 'تفاصيل'}</button>
        <button class="card-btn gray" data-action="goToRoute" data-lat="${s.lat}" data-lng="${s.lng}">🗺 ${fr ? 'Itinéraire' : 'الطريق'}</button>
        ${resolveBtn}
        ${isOwner ? '' : `<button class="card-btn gray" data-action="reportSituation" data-id="${id}">⚠️ ${fr ? 'Signaler' : 'إبلاغ'}</button>`}
      </div>
      ${isOwner ? '' : `<button class="btn-confirm${alreadyConfirmed ? ' confirmed' : ''}" data-action="confirmSituation" data-id="${id}" ${alreadyConfirmed ? 'disabled' : ''}>
        ${alreadyConfirmed ? (fr ? '✓ Déjà confirmé' : '✓ تم التأكيد مسبقاً') : (fr ? '✓ Confirmer cette situation' : '✓ تأكيد هذا الموقف')}
      </button>`}
    </div>`;

  return card;
}

// ─── Modal détail ─────────────────────────────────────────────────────────────

function stopCommentsListener() {
  if (commentsUnsub) { commentsUnsub(); commentsUnsub = null; }
}

function openDetail(id) {
  const s = situations.find(x => x.id === id);
  if (!s) return;
  map.closePopup();
  stopCommentsListener();
  detailId = id;

  const cfg    = TYPE_CONFIG[s.type] || TYPE_CONFIG.autre;
  const fr     = currentLang === 'fr';
  const label  = cfg[currentLang] || cfg.fr;
  const daysLeft = getDaysLeft(s.createdAtMs);

  const uid              = currentUser?.uid;
  const isOwner          = !!uid && uid === s.userId;
  const confirmCount     = s.confirmedBy.length;
  const alreadyConfirmed = !!uid && s.confirmedBy.includes(uid);
  const sid = esc(s.id);

  const resolveBtn = s.resolved
    ? (isOwner ? `<button class="card-btn gray" data-action="toggleResolveAndClose" data-id="${sid}">${fr ? 'Rouvrir' : 'إعادة فتح'}</button>` : '')
    : `<button class="card-btn primary" data-action="toggleResolveAndClose" data-id="${sid}">${fr ? '✓ Marquer résolu' : '✓ تم الحل'}</button>`;

  const loginNote = fr
    ? 'Connectez-vous pour voir le contact et les commentaires.'
    : 'سجّل الدخول لعرض معلومات التواصل والتعليقات.';

  $('detailContent').innerHTML = `
    <div class="detail-header" style="background:${s.resolved ? '#5B8A5B' : cfg.color}">
      <div class="detail-type">${cfg.emoji} ${label}</div>
      <div class="detail-title">${esc(s.description)}</div>
    </div>

    ${s.location ? `
    <div class="detail-section">
      <div class="detail-label">${fr ? 'Localisation' : 'الموقع'}</div>
      <div class="detail-value">📍 ${esc(s.location)}</div>
    </div>` : ''}

    <div class="detail-section" id="detailContactSection" ${currentUser ? 'hidden' : ''}>
      <div class="detail-label">${fr ? 'Contact' : 'التواصل'}</div>
      <div class="detail-value" id="detailContactValue">${currentUser ? '…' : '🔒 ' + esc(loginNote)}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">${fr ? 'Signalé le' : 'أُبلغ في'}</div>
      <div class="detail-value">${esc(new Date(s.createdAtMs).toLocaleString(fr ? 'fr-DZ' : 'ar-DZ'))}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">${fr ? 'Expiration' : 'انتهاء الصلاحية'}</div>
      <div class="detail-value">⏳ ${daysLeft !== null
        ? (fr ? `Suppression dans ${daysLeft} jour(s)` : `يُحذف خلال ${daysLeft} يوم`)
        : (fr ? 'Expiré' : 'منتهي الصلاحية')}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">${fr ? 'Statut' : 'الحالة'}</div>
      <div class="detail-value">${s.resolved
        ? `<span style="color:#5B8A5B;font-weight:700">✓ ${fr ? 'Situation résolue' : 'تم حل الموقف'}</span>`
        : `<span style="color:#C0392B">⏳ ${fr ? "En attente d'aide" : 'بانتظار المساعدة'}</span>`}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">${fr ? 'Confirmations terrain' : 'تأكيدات ميدانية'}</div>
      <div class="detail-value confirm-count-detail">
        ✓ ${confirmCount} ${fr
          ? `personne${confirmCount > 1 ? 's ont' : ' a'} confirmé`
          : 'شخص أكّد وجود هذا الموقف'}
      </div>
    </div>

    <div class="detail-actions">
      <button class="card-btn green" data-action="goToRoute" data-lat="${s.lat}" data-lng="${s.lng}">🗺 ${fr ? 'Itinéraire' : 'الطريق'}</button>
      ${resolveBtn}
      ${isOwner ? `<button class="card-btn gray" data-action="deleteOwn" data-id="${sid}">🗑 ${fr ? 'Supprimer' : 'حذف'}</button>`
                : `<button class="card-btn gray" data-action="reportSituation" data-id="${sid}">⚠️</button>`}
    </div>

    ${isOwner ? '' : `<button class="btn-confirm-detail${alreadyConfirmed ? ' confirmed' : ''}"
      data-action="confirmSituation" data-id="${sid}" ${alreadyConfirmed ? 'disabled' : ''}>
      ${alreadyConfirmed ? (fr ? '✓ Déjà confirmé' : '✓ تم التأكيد مسبقاً') : (fr ? '✓ Confirmer cette situation' : '✓ تأكيد هذا الموقف')}
    </button>`}

    <div class="comments-section">
      <div class="comments-title" id="commentsTitle">${fr ? 'Commentaires' : 'التعليقات'}</div>
      <div id="commentsList">${currentUser ? '' : `<p class="no-comments">${esc(loginNote)}</p>`}</div>
      ${currentUser ? `<div class="comment-input-row">
        <input type="text" id="commentInput" maxlength="${LIMITS.COMMENT_MAX}" data-id="${sid}"
          placeholder="${fr ? 'Ajouter un commentaire…' : 'أضف تعليقاً…'}" />
        <button data-action="addComment" data-id="${sid}">${fr ? 'Envoyer' : 'إرسال'}</button>
      </div>` : ''}
    </div>`;

  $('detailModal').classList.add('active');

  if (currentUser) {
    loadPrivateContact(s.id);
    listenToComments(s.id);
  }
}

// Le contact est stocké dans signalements/{id}/private/info (lisible uniquement par un utilisateur connecté)
async function loadPrivateContact(id) {
  try {
    const snap = await getDoc(doc(db, 'signalements', id, 'private', 'info'));
    if (detailId !== id) return;                      // la modale a changé entre-temps
    const section = $('detailContactSection');
    const value   = $('detailContactValue');
    if (!section || !value) return;
    const contact = snap.exists() && typeof snap.data().contact === 'string' ? cleanText(snap.data().contact, LIMITS.CONTACT_MAX) : '';
    if (contact) { value.textContent = '📞 ' + contact; section.hidden = false; }
    else section.hidden = true;
  } catch (err) {
    console.warn('Contact non lisible:', err?.code);
    $('detailContactSection')?.setAttribute('hidden', '');
  }
}

function listenToComments(id) {
  const q = query(collection(db, 'signalements', id, 'comments'), orderBy('createdAt', 'asc'), limit(LIMITS.COMMENTS_MAX));
  commentsUnsub = onSnapshot(q,
    (snap) => {
      if (detailId !== id) return;
      const now = Date.now();
      const comments = snap.docs.map(d => sanitizeComment(d.id, d.data({ serverTimestamps: 'estimate' }), now)).filter(Boolean);
      const fr = currentLang === 'fr';
      const list = $('commentsList');
      if (!list) return;
      list.innerHTML = comments.map(c => `
        <div class="comment-item">
          <p>${esc(c.text)}</p>
          <div class="comment-time">${esc(getTimeAgo(c.createdAtMs))}</div>
        </div>`).join('') || `<p class="no-comments">${fr ? 'Aucun commentaire.' : 'لا توجد تعليقات.'}</p>`;
      const title = $('commentsTitle');
      if (title) title.textContent = fr ? `Commentaires (${comments.length})` : `التعليقات (${comments.length})`;
    },
    (err) => console.warn('Commentaires non lisibles:', err?.code)
  );
}

// ─── Modal signalement ────────────────────────────────────────────────────────

function openSignalModal() {
  if (!currentUser) {
    $('loginRequiredModal').classList.add('active');
    return;
  }
  selectedType = '';
  tempLatLng   = null;
  $('descInput').value     = '';
  $('locationInput').value = '';
  $('contactInput').value  = '';
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
  $('signalModal').classList.add('active');
}

function closeSignalModal() {
  $('signalModal').classList.remove('active');
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
}

function selectType(btn) {
  const type = btn.dataset.type;
  if (!Object.hasOwn(TYPE_CONFIG, type)) return;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedType = type;
}

function getLocation() {
  if (!navigator.geolocation) {
    showToast(t('Géolocalisation non disponible', 'تحديد الموقع غير متاح'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      tempLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $('locationInput').value = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
      map.setView([pos.coords.latitude, pos.coords.longitude], 15);
      showToast(t('📍 Position détectée !', '📍 تم تحديد الموقع!'));
    },
    () => showToast(t('Position indisponible', 'تعذّر تحديد موقعك'))
  );
}

const SIGNAL_ERRORS = {
  type:         ['⚠️ Choisissez un type', '⚠️ اختر نوعاً'],
  desc_short:   [`⚠️ Description trop courte (${LIMITS.DESC_MIN} caractères min)`, `⚠️ الوصف قصير جداً (${LIMITS.DESC_MIN} أحرف على الأقل)`],
  desc_long:    [`⚠️ Description trop longue (${LIMITS.DESC_MAX} caractères max)`, `⚠️ الوصف طويل جداً (${LIMITS.DESC_MAX} حرف كحد أقصى)`],
  contact_long: ['⚠️ Contact trop long', '⚠️ معلومات الاتصال طويلة جداً'],
  position:     ['⚠️ Cliquez sur la carte (ou sur 📍) pour indiquer la position — en Algérie', '⚠️ انقر على الخريطة (أو 📍) لتحديد الموقع داخل الجزائر'],
};

async function submitSignal() {
  if (!requireAuth() || submitting) return;

  const desc    = cleanText($('descInput').value, LIMITS.DESC_MAX + 1);
  const contact = cleanText($('contactInput').value, LIMITS.CONTACT_MAX + 1);
  const lat = tempLatLng ? Number(Number(tempLatLng.lat).toFixed(5)) : NaN;
  const lng = tempLatLng ? Number(Number(tempLatLng.lng).toFixed(5)) : NaN;

  const code = validateSignal({ type: selectedType, description: desc, contact, lat, lng });
  if (code) { showToast(t(...SIGNAL_ERRORS[code])); return; }

  const uid = currentUser.uid;
  const expiresAt = Timestamp.fromMillis(Date.now() + EXPIRATION_DAYS * DAY_MS);   // purge automatique (politique TTL)
  const ref = doc(collection(db, 'signalements'));

  // userName / userPhoto ne sont plus stockés (minimisation des données) ; le contact est dans un document privé.
  const batch = writeBatch(db);
  batch.set(ref, {
    type:        selectedType,
    description: desc,
    location:    `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    lat, lng,
    createdAt:   serverTimestamp(),
    expiresAt,
    resolved:    false,
    reportCount: 0,
    reportedBy:  [],
    confirmedBy: [],
    userId:      uid,
  });
  if (contact) {
    batch.set(doc(db, 'signalements', ref.id, 'private', 'info'), { contact, userId: uid, expiresAt });
  }
  batch.set(doc(db, 'rate', uid), { lastReportAt: serverTimestamp() }, { merge: true });   // limitation de fréquence (règles)

  submitting = true;
  try {
    await batch.commit();
    closeSignalModal();
    showToast(t('✓ Signalement publié', '✓ تم نشر البلاغ'));
  } catch (err) {
    errorToast(err);
  } finally {
    submitting = false;
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function requireAuth() {
  if (!currentUser) {
    $('loginRequiredModal').classList.add('active');
    return false;
  }
  return true;
}

// Tout utilisateur connecté peut marquer « résolu » ; seul l'auteur (ou un admin) peut rouvrir — appliqué par les règles.
async function toggleResolve(id) {
  if (!requireAuth()) return;
  const s = situations.find(x => x.id === id);
  if (!s) return;
  const next = !s.resolved;
  if (!next && s.userId !== currentUser.uid) return;
  try {
    await updateDoc(doc(db, 'signalements', id), { resolved: next });
    showToast(next ? t('✓ Marqué comme résolu', '✓ وُضعت علامة محلول') : t('↩ Rouvert', '↩ أُعيد فتحه'));
  } catch (err) { errorToast(err); }
}

function resolveFromMap(id) {
  toggleResolve(id);
  map.closePopup();
}

// Un signalement abusif est compté (une fois par utilisateur) et, à partir d'un seuil, MASQUÉ — jamais supprimé.
async function reportSituation(id) {
  if (!requireAuth()) return;
  const s = situations.find(x => x.id === id);
  if (!s) return;
  const uid = currentUser.uid;
  if (s.userId === uid) return;
  if (s.reportedBy.includes(uid)) {
    showToast(t('⚠️ Vous avez déjà signalé cette situation', '⚠️ لقد أبلغت عن هذا الموقف مسبقاً'));
    return;
  }
  try {
    await updateDoc(doc(db, 'signalements', id), {
      reportCount: increment(1),
      reportedBy: arrayUnion(uid),
    });
    showToast(t('⚠️ Signalement enregistré — merci', '⚠️ تم تسجيل البلاغ — شكراً'));
  } catch (err) { errorToast(err); }
}

async function confirmSituation(id) {
  if (!requireAuth()) return;
  const s = situations.find(x => x.id === id);
  if (!s) return;
  const uid = currentUser.uid;
  if (s.userId === uid) return;
  if (s.confirmedBy.includes(uid)) {
    showToast(t('⚠️ Vous avez déjà confirmé cette situation', '⚠️ لقد أكدت هذا الموقف مسبقاً'));
    return;
  }
  try {
    await updateDoc(doc(db, 'signalements', id), { confirmedBy: arrayUnion(uid) });
    showToast(t('✓ Situation confirmée — merci !', '✓ تم التأكيد — شكراً!'));
  } catch (err) { errorToast(err); }
}

// Les commentaires sont des documents distincts (sous-collection) : pas de réécriture de tableau,
// donc pas de perte de commentaires en cas d'envois simultanés.
async function addComment(id) {
  if (!requireAuth()) return;
  const input = $('commentInput');
  const text  = cleanText(input?.value, LIMITS.COMMENT_MAX + 1);
  if (!text || text.length > LIMITS.COMMENT_MAX) return;

  const s = situations.find(x => x.id === id);
  if (!s || !s.expiresAtTs) return;

  const uid = currentUser.uid;
  const batch = writeBatch(db);
  batch.set(doc(collection(db, 'signalements', id, 'comments')), {
    text, userId: uid, createdAt: serverTimestamp(), expiresAt: s.expiresAtTs,
  });
  batch.set(doc(db, 'rate', uid), { lastCommentAt: serverTimestamp() }, { merge: true });
  try {
    await batch.commit();
    if (input) input.value = '';
    showToast(t('💬 Commentaire ajouté', '💬 تمت إضافة التعليق'));
  } catch (err) { errorToast(err); }
}

// Suppression de son propre signalement (droit de suppression)
async function deleteOwn(id) {
  if (!requireAuth()) return;
  const s = situations.find(x => x.id === id);
  if (!s || s.userId !== currentUser.uid) return;
  if (!window.confirm(t('Supprimer définitivement ce signalement ?', 'هل تريد حذف هذا البلاغ نهائياً؟'))) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'signalements', id, 'private', 'info'));
  batch.delete(doc(db, 'signalements', id));
  try {
    await batch.commit();
    closeModalById('detailModal');
    showToast(t('🗑️ Signalement supprimé', '🗑️ تم حذف البلاغ'));
  } catch (err) { errorToast(err); }
}

function goToRoute(lat, lng) {
  const url = routeUrl(Number(lat), Number(lng));
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── Filtres & stats ──────────────────────────────────────────────────────────

function setFilter(filter, btn) {
  if (filter !== 'all' && !Object.hasOwn(TYPE_CONFIG, filter)) return;
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderAll();
}

function getFiltered() {
  const list = visibleSituations();
  return activeFilter === 'all' ? list : list.filter(s => s.type === activeFilter);
}

function updateStats() {
  const list = visibleSituations();
  $('totalCount').textContent    = list.length;
  $('resolvedCount').textContent = list.filter(s => s.resolved).length;
  $('activeCount').textContent   = list.filter(s => !s.resolved).length;
}

// ─── Langue ───────────────────────────────────────────────────────────────────

function toggleLang() {
  currentLang = currentLang === 'fr' ? 'ar' : 'fr';
  try { localStorage.setItem(LANG_KEY, currentLang); } catch (_) { /* ignore */ }
  setLangUI(currentLang);
  renderAll();
  if (detailId) openDetail(detailId);
}

function setLangUI(lang) {
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  document.body.classList.toggle('ar', lang === 'ar');
  const toggleBtn = $('langToggle');
  if (toggleBtn) toggleBtn.textContent = lang === 'fr' ? 'العربية' : 'Français';
  applyLang(lang);
}

function applyLang(lang) {
  document.querySelectorAll('[data-fr][data-ar]').forEach(el => {
    el.textContent = lang === 'ar' ? el.dataset.ar : el.dataset.fr;
  });
  document.querySelectorAll('[data-fr-ph][data-ar-ph]').forEach(el => {
    el.setAttribute('placeholder', lang === 'ar' ? el.dataset.arPh : el.dataset.frPh);
  });
  document.querySelectorAll('[data-fr-title][data-ar-title]').forEach(el => {
    el.setAttribute('title', lang === 'ar' ? el.dataset.arTitle : el.dataset.frTitle);
  });
}

// ─── Modals & toasts ──────────────────────────────────────────────────────────

function closeModalById(modalId) {
  const el = $(modalId);
  if (!el) return;
  el.classList.remove('active');
  if (modalId === 'detailModal') { stopCommentsListener(); detailId = null; }
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;               // textContent : jamais interprété comme HTML
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function getTimeAgo(ms) {
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs  / 24);
  if (currentLang === 'ar') {
    if (mins < 1)  return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    if (hrs  < 24) return `منذ ${hrs} ساعة`;
    return `منذ ${days} يوم`;
  }
  if (mins < 1)  return "À l'instant";
  if (mins < 60) return `Il y a ${mins} min`;
  if (hrs  < 24) return `Il y a ${hrs}h`;
  return `Il y a ${days}j`;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const wrapper = $('mapWrapper');
    if (wrapper && wrapper.classList.contains('fullscreen')) toggleMapFullscreen();
  }
});

// ─── Délégation d'événements (remplace tous les onclick inline) ──────────────
// Aucune donnée dynamique n'est jamais interprétée comme du code : les attributs data-* sont
// lus comme des chaînes, validées par chaque action.

const ACTIONS = {
  toggleLang:            () => toggleLang(),
  loginWithGoogle:       () => loginWithGoogle(),
  logoutUser:            () => logoutUser(),
  loginFromModal:        () => { loginWithGoogle(); closeModalById('loginRequiredModal'); },
  acceptPrivacy:         () => acceptPrivacy(),
  openSignalModal:       () => openSignalModal(),
  closeSignalModal:      () => closeSignalModal(),
  selectType:            (el) => selectType(el),
  getLocation:           () => getLocation(),
  submitSignal:          () => submitSignal(),
  closeModal:            (el) => closeModalById(el.dataset.target),
  setFilter:             (el) => setFilter(el.dataset.filter, el),
  switchMapStyle:        (el) => switchMapStyle(el.dataset.style, el),
  locateOnMap:           () => locateOnMap(),
  refreshMap:            () => refreshMap(),
  toggleMapFullscreen:   () => toggleMapFullscreen(),
  openDetail:            (el) => openDetail(el.dataset.id),
  toggleResolve:         (el) => toggleResolve(el.dataset.id),
  toggleResolveAndClose: (el) => { toggleResolve(el.dataset.id); closeModalById('detailModal'); },
  resolveFromMap:        (el) => resolveFromMap(el.dataset.id),
  reportSituation:       (el) => reportSituation(el.dataset.id),
  confirmSituation:      (el) => confirmSituation(el.dataset.id),
  addComment:            (el) => addComment(el.dataset.id),
  deleteOwn:             (el) => deleteOwn(el.dataset.id),
  goToRoute:             (el) => goToRoute(el.dataset.lat, el.dataset.lng),
};

document.addEventListener('click', (e) => {
  const overlay = e.target.closest?.('[data-overlay]');
  if (overlay && e.target === overlay) { closeModalById(overlay.dataset.overlay); return; }

  const el = e.target.closest?.('[data-action]');
  if (!el || el.disabled) return;
  const name = el.dataset.action;
  if (Object.hasOwn(ACTIONS, name)) ACTIONS[name](el, e);
});
