/*
 * RahmaPoint — util.js
 * Fonctions pures (sans DOM, sans Firebase) : échappement, validation, assainissement
 * des données reçues de Firestore. Testées dans tests/util.test.mjs.
 *
 * Les limites ci-dessous DOIVENT rester identiques à celles de rules/firestore.rules.
 */

export const EXPIRATION_DAYS = 5;
export const DAY_MS = 86400000;

export const LIMITS = Object.freeze({
  DESC_MIN: 10,
  DESC_MAX: 500,
  LOCATION_MAX: 100,
  CONTACT_MAX: 50,
  COMMENT_MAX: 300,
  ARRAY_MAX: 500,        // confirmedBy / reportedBy
  LIST_MAX: 300,         // nombre max de signalements lus (aussi imposé par les règles)
  COMMENTS_MAX: 100,     // nombre max de commentaires lus par signalement
  HIDE_AT_REPORTS: 3,    // masquage (jamais suppression) à partir de N signalements abusifs
});

// Emprise approximative de l'Algérie (identique aux règles Firestore)
export const BOUNDS = Object.freeze({ LAT_MIN: 18.0, LAT_MAX: 38.0, LNG_MIN: -9.0, LNG_MAX: 12.5 });

export const VALID_TYPES = new Set(['nourriture', 'medical', 'vetement', 'abri', 'autre']);

/** Échappe les caractères HTML (à utiliser pour tout texte inséré dans un gabarit HTML). */
export function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/`/g, '&#x60;');
}

/** Supprime les caractères de contrôle et normalise les espaces d'un texte libre. */
export function cleanText(str, max) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}

export function isValidLatLng(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= BOUNDS.LAT_MIN && lat <= BOUNDS.LAT_MAX
    && lng >= BOUNDS.LNG_MIN && lng <= BOUNDS.LNG_MAX;
}

/**
 * Valide un nouveau signalement. Retourne null si valide, sinon un code d'erreur :
 * 'type' | 'desc_short' | 'desc_long' | 'contact_long' | 'position'
 */
export function validateSignal({ type, description, contact, lat, lng }) {
  if (!VALID_TYPES.has(type)) return 'type';
  if (typeof description !== 'string' || description.length < LIMITS.DESC_MIN) return 'desc_short';
  if (description.length > LIMITS.DESC_MAX) return 'desc_long';
  if (contact && contact.length > LIMITS.CONTACT_MAX) return 'contact_long';
  if (!isValidLatLng(lat, lng)) return 'position';
  return null;
}

/** Convertit Timestamp Firestore / Date / ISO / nombre en millisecondes (NaN si invalide). */
export function toMillis(v) {
  if (v == null) return NaN;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

function stringArray(a, max) {
  if (!Array.isArray(a)) return [];
  return a.filter(x => typeof x === 'string' && x.length > 0 && x.length <= 128).slice(0, max);
}

/**
 * Assainit un document Firestore avant tout usage dans l'interface.
 * Retourne null si le document est malformé : il est alors ignoré (jamais affiché).
 * Garantit que lat/lng sont de vrais nombres (empêche l'injection via les anciens
 * gestionnaires onclick), que l'id est sûr et que les types sont ceux attendus.
 */
export function sanitizeSignal(id, d, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!d || typeof d !== 'object') return null;
  if (!VALID_TYPES.has(d.type)) return null;
  if (typeof d.description !== 'string' || d.description.length === 0) return null;
  if (!isValidLatLng(d.lat, d.lng)) return null;

  let createdAtMs = toMillis(d.createdAt);
  if (!Number.isFinite(createdAtMs)) createdAtMs = now;            // écriture locale en attente
  if (createdAtMs > now + 5 * 60000) createdAtMs = now;            // date future : ignorée
  const expiresAtMs = toMillis(d.expiresAt);

  const reportCount = Number.isInteger(d.reportCount) ? Math.min(Math.max(d.reportCount, 0), 100000) : 0;

  return {
    id,
    type: d.type,
    description: d.description.slice(0, LIMITS.DESC_MAX),
    location: typeof d.location === 'string' ? d.location.slice(0, LIMITS.LOCATION_MAX) : '',
    lat: d.lat,
    lng: d.lng,
    createdAtMs,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    expiresAtTs: d.expiresAt && typeof d.expiresAt.toMillis === 'function' ? d.expiresAt : null,
    resolved: d.resolved === true,
    reportCount,
    reportedBy: stringArray(d.reportedBy, LIMITS.ARRAY_MAX),
    confirmedBy: stringArray(d.confirmedBy, LIMITS.ARRAY_MAX),
    userId: typeof d.userId === 'string' ? d.userId : '',
  };
}

/** Assainit un commentaire (sous-collection comments). */
export function sanitizeComment(id, d, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!d || typeof d.text !== 'string' || d.text.length === 0) return null;
  let ms = toMillis(d.createdAt);
  if (!Number.isFinite(ms)) ms = now;
  return { id, text: d.text.slice(0, LIMITS.COMMENT_MAX), createdAtMs: ms, userId: typeof d.userId === 'string' ? d.userId : '' };
}

/** Un signalement est expiré 5 jours après sa création (date serveur). */
export function isExpired(s, now = Date.now()) {
  return s.createdAtMs + EXPIRATION_DAYS * DAY_MS <= now;
}

export function getDaysLeft(createdAtMs, now = Date.now()) {
  const remaining = EXPIRATION_DAYS * DAY_MS - (now - createdAtMs);
  return remaining > 0 ? Math.ceil(remaining / DAY_MS) : null;
}

/** Masqué (non supprimé) si trop de signalements abusifs, sauf pour son auteur. */
export function isHidden(s, uid) {
  return s.reportCount >= LIMITS.HIDE_AT_REPORTS && s.userId !== uid;
}

/** N'accepte que des avatars https servis par Google. */
export function safeAvatarUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol === 'https:' && /(^|\.)googleusercontent\.com$/.test(url.hostname)) return url.href;
  } catch (_) { /* invalide */ }
  return '';
}

/** Lien d'itinéraire construit uniquement à partir de nombres validés. */
export function routeUrl(lat, lng) {
  if (!isValidLatLng(lat, lng)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
