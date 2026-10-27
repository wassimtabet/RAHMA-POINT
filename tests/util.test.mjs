// Tests unitaires des fonctions de sécurité côté client (node --test tests/util.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, cleanText, validateSignal, sanitizeSignal, sanitizeComment, isExpired, getDaysLeft,
  isHidden, safeAvatarUrl, routeUrl, isValidLatLng, LIMITS, DAY_MS,
} from '../public/js/util.js';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const good = (over = {}) => ({
  type: 'abri', description: 'Personne seule devant la gare', lat: 36.19, lng: 5.41,
  createdAt: new Date(NOW - 3600e3).toISOString(), resolved: false, reportCount: 0,
  reportedBy: [], confirmedBy: ['u1'], userId: 'owner', location: '36.19000, 5.41000', ...over,
});

test('esc neutralise les caractères HTML, y compris quote et backtick', () => {
  assert.equal(esc(`<img src=x onerror=alert(1)>"'\`&`), '&lt;img src=x onerror=alert(1)&gt;&quot;&#x27;&#x60;&amp;');
  assert.equal(esc(null), '');
});

test('XSS : lat/lng sous forme de chaîne (vecteur onclick) est rejeté', () => {
  assert.equal(sanitizeSignal('abc123', good({ lat: "1);alert(document.domain)//", lng: 5 }), NOW), null);
  assert.equal(sanitizeSignal('abc123', good({ lat: '36.19', lng: '5.41' }), NOW), null);
  assert.equal(sanitizeSignal('abc123', good({ lat: NaN }), NOW), null);
  assert.equal(sanitizeSignal('abc123', good({ lat: 90, lng: 5 }), NOW), null);       // hors Algérie
});

test("XSS : identifiant de document dangereux (rupture de chaîne JS) est rejeté", () => {
  for (const id of [`x');alert(1)//`, 'a b', '<b>', '', 'a'.repeat(65), 'a/b', '"onmouseover="x']) {
    assert.equal(sanitizeSignal(id, good(), NOW), null, id);
  }
  assert.ok(sanitizeSignal('Abc_123-xyz', good(), NOW));
});

test('type inconnu / description non-chaîne rejetés', () => {
  assert.equal(sanitizeSignal('a1', good({ type: '__proto__' }), NOW), null);
  assert.equal(sanitizeSignal('a1', good({ description: { toString: () => 'x' } }), NOW), null);
  assert.equal(sanitizeSignal('a1', null, NOW), null);
});

test('la description XSS reste du texte une fois échappée', () => {
  const s = sanitizeSignal('a1', good({ description: '<script>alert(1)</script><img src=x onerror=alert(2)>' }), NOW);
  assert.ok(s);
  assert.ok(!/[<>]/.test(esc(s.description)));
});

test('tableaux et compteurs : types forcés', () => {
  const s = sanitizeSignal('a1', good({ confirmedBy: ['u1', 5, null, {}], reportCount: '99', reportedBy: 'x' }), NOW);
  assert.deepEqual(s.confirmedBy, ['u1']);
  assert.equal(s.reportCount, 0);
  assert.deepEqual(s.reportedBy, []);
});

test('date future ignorée (pas de signalement « immortel » via createdAt)', () => {
  const s = sanitizeSignal('a1', good({ createdAt: new Date(NOW + 400 * DAY_MS).toISOString() }), NOW);
  assert.equal(s.createdAtMs, NOW);
});

test('Timestamp Firestore et ISO sont acceptés', () => {
  const ts = { toMillis: () => NOW - 1000 };
  assert.equal(sanitizeSignal('a1', good({ createdAt: ts, expiresAt: ts }), NOW).createdAtMs, NOW - 1000);
});

test('expiration à 5 jours', () => {
  const s = sanitizeSignal('a1', good({ createdAt: new Date(NOW - 5 * DAY_MS - 1).toISOString() }), NOW);
  assert.equal(isExpired(s, NOW), true);
  assert.equal(isExpired({ createdAtMs: NOW - 4 * DAY_MS }, NOW), false);
  assert.equal(getDaysLeft(NOW - 4 * DAY_MS, NOW), 1);
  assert.equal(getDaysLeft(NOW - 6 * DAY_MS, NOW), null);
});

test('un signalement abusif est masqué mais jamais supprimé ; son auteur le voit toujours', () => {
  const s = { reportCount: LIMITS.HIDE_AT_REPORTS, userId: 'owner' };
  assert.equal(isHidden(s, 'other'), true);
  assert.equal(isHidden(s, undefined), true);
  assert.equal(isHidden(s, 'owner'), false);
  assert.equal(isHidden({ reportCount: 2, userId: 'owner' }, 'other'), false);
});

test('validateSignal : contrôles de longueur, type, position', () => {
  const base = { type: 'abri', description: 'x'.repeat(10), contact: '', lat: 36, lng: 5 };
  assert.equal(validateSignal(base), null);
  assert.equal(validateSignal({ ...base, type: 'hack' }), 'type');
  assert.equal(validateSignal({ ...base, description: 'court' }), 'desc_short');
  assert.equal(validateSignal({ ...base, description: 'x'.repeat(501) }), 'desc_long');
  assert.equal(validateSignal({ ...base, contact: 'x'.repeat(51) }), 'contact_long');
  assert.equal(validateSignal({ ...base, lat: NaN, lng: NaN }), 'position');
  assert.equal(validateSignal({ ...base, lat: 48.8, lng: 2.3 }), 'position');
  assert.equal(validateSignal({ ...base, description: 12345678901 }), 'desc_short');
});

test('cleanText retire caractères de contrôle et marques bidirectionnelles', () => {
  assert.equal(cleanText('  a\u0000b‮c\u0007d  ', 50), 'abcd');
  assert.equal(cleanText('x'.repeat(10), 3), 'xxx');
});

test('sanitizeComment', () => {
  assert.equal(sanitizeComment('c1', { text: '' }, NOW), null);
  assert.equal(sanitizeComment('c1', { text: 'x'.repeat(999), createdAt: null }, NOW).text.length, LIMITS.COMMENT_MAX);
  assert.equal(sanitizeComment('bad id', { text: 'ok' }, NOW), null);
});

test('avatar : uniquement https Google', () => {
  assert.ok(safeAvatarUrl('https://lh3.googleusercontent.com/a/xyz'));
  assert.equal(safeAvatarUrl('javascript:alert(1)'), '');
  assert.equal(safeAvatarUrl('https://evil.example/a.png'), '');
  assert.equal(safeAvatarUrl('https://googleusercontent.com.evil.example/a.png'), '');
  assert.equal(safeAvatarUrl('http://lh3.googleusercontent.com/a'), '');
});

test('itinéraire : uniquement à partir de nombres valides', () => {
  assert.equal(routeUrl('1);alert(1)//', 5), null);
  assert.equal(routeUrl(36.19, 5.41), 'https://www.google.com/maps/dir/?api=1&destination=36.19,5.41');
  assert.equal(isValidLatLng(Infinity, 5), false);
});
