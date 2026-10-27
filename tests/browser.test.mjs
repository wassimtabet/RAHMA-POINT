// Test navigateur (Chromium via playwright-core) — exécute le VRAI index.html + js/app.js, sous la CSP réelle de
// la balise <meta> CSP de index.html, servi sous un SOUS-DOSSIER (/rahmapoint/) comme sur GitHub Pages, avec Firebase/Firestore remplacés par des doubles de test (aucun réseau, aucune donnée réelle).
//   npm install --no-save playwright-core && node --test tests/browser.test.mjs
// Variable CHROMIUM_PATH pour indiquer le binaire (défaut : /opt/pw-browsers/chromium).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pub  = path.join(root, 'public');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const skip = fs.existsSync(CHROMIUM) ? false : 'Chromium introuvable (définir CHROMIUM_PATH)';

let chromium; try { ({ chromium } = await import('playwright-core')); } catch { /* skip */ }
const skipAll = skip || (chromium ? false : 'playwright-core non installé');

// ── Serveur statique SANS en-têtes spéciaux, sous /rahmapoint/ (comme https://utilisateur.github.io/rahmapoint/) ──
const PREFIX = '/rahmapoint/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
let server, base; const notFound = [];
before(async () => {
  if (skipAll) return;
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!u.startsWith(PREFIX)) { notFound.push(u); res.writeHead(404); return res.end(); }   // un chemin absolu « /js/app.js » échouerait ici
    const rel = u.slice(PREFIX.length) || 'index.html';
    const file = path.normalize(path.join(pub, rel));
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { notFound.push(u); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
});
after(() => server?.close());

// ── Doubles de Firebase (servis à la place de gstatic.com) ──
const STUBS = {
  'firebase-app.js': `export const initializeApp = () => ({});`,
  'firebase-analytics.js': `window.__ANALYTICS = (window.__ANALYTICS||0)+1; export const getAnalytics = () => ({}); export const isSupported = async () => true;`,
  'firebase-auth.js': `
    const auth = { currentUser: null }; let cb = () => {};
    window.__setUser = (u) => { auth.currentUser = u; cb(u); };
    export const getAuth = () => auth;
    export class GoogleAuthProvider { setCustomParameters() {} }
    export const signInWithPopup = async () => { window.__setUser(window.__LOGIN_USER); };
    export const signOut = async () => { window.__setUser(null); };
    export const onAuthStateChanged = (a, f) => { cb = f; setTimeout(() => f(auth.currentUser), 0); return () => {}; };`,
  'firebase-firestore.js': `
    const conv = (v) => Array.isArray(v) ? v.map(conv) : (v && typeof v === 'object')
      ? (('__ts' in v) ? { toMillis: () => v.__ts } : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]))) : v;
    const auto = () => 'AUTO' + Math.random().toString(36).slice(2).padEnd(16, 'x').slice(0, 16);
    window.__WRITES = window.__WRITES || [];
    export const getFirestore = () => ({});
    export const collection = (a, ...p) => ({ path: p.join('/') });
    export const doc = (a, ...p) => { if (a && a.path !== undefined && !p.length) { const i = auto(); return { path: a.path + '/' + i, id: i }; } return { path: p.join('/'), id: p[p.length - 1] }; };
    export const orderBy = (f, d) => ({ orderBy: f, d }); export const limit = (n) => ({ limit: n });
    export const query = (c, ...k) => ({ path: c.path, k });
    export const onSnapshot = (q, ok) => {
      window.__QUERIES = (window.__QUERIES || []).concat([{ path: q.path, limit: q.k.find(x => 'limit' in x)?.limit }]);
      const src = q.path === 'signalements' ? window.__DOCS : window.__COMMENTS;
      setTimeout(() => ok({ docs: (src || []).map(d => ({ id: d.id, data: () => conv(d.data) })) }), 0);
      return () => {};
    };
    export const getDoc = async (ref) => ({ exists: () => true, data: () => window.__PRIVATE });
    export const updateDoc = async (ref, data) => { window.__WRITES.push({ op: 'update', path: ref.path, data }); };
    export const writeBatch = () => { const ops = []; return {
      set: (ref, data, o) => ops.push({ op: 'set', path: ref.path, data, merge: !!o }),
      delete: (ref) => ops.push({ op: 'delete', path: ref.path }),
      commit: async () => { window.__WRITES.push(...ops); } }; };
    export const arrayUnion = (v) => ({ __op: 'arrayUnion', v });
    export const increment = (n) => ({ __op: 'increment', n });
    export const serverTimestamp = () => ({ __op: 'serverTimestamp' });
    export const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };`,
};

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const id = (c) => c.repeat(20);
const DOCS = [
  { id: id('a'), data: { type: 'abri', description: 'Homme seul près de la gare', location: '36.19000, 5.41000', lat: 36.19, lng: 5.41, createdAt: iso(NOW - 3600e3), expiresAt: { __ts: NOW + 4 * 86400e3 }, resolved: false, reportCount: 0, reportedBy: [], confirmedBy: [], userId: 'owner' } },
  { id: id('b'), data: { type: 'medical', description: '<img src=x onerror="window.__pwned=\'desc\'"><script>window.__pwned=\'script\'</script>', location: '<svg onload="window.__pwned=\'loc\'">', lat: 36.2, lng: 5.4, createdAt: iso(NOW - 7200e3), resolved: false, reportCount: 1, reportedBy: ['z'], confirmedBy: ['z'], userId: 'someone' } },
  { id: id('c'), data: { type: 'abri', description: 'lat piégée', lat: "1);window.__pwned='lat'//", lng: '2', createdAt: iso(NOW), userId: 'x' } },
  { id: "x');window.__pwned='id'//", data: { type: 'abri', description: 'id piégé', lat: 36, lng: 5, createdAt: iso(NOW), userId: 'x' } },
  { id: id('d'), data: { type: '<img src=x onerror=alert(1)>', description: 'type piégé', lat: 36, lng: 5, createdAt: iso(NOW), userId: 'x' } },
  { id: id('e'), data: { type: 'abri', description: 'signalé 3 fois (masqué)', lat: 36, lng: 5, createdAt: iso(NOW), reportCount: 3, userId: 'x' } },
  { id: id('f'), data: { type: 'abri', description: 'expiré depuis 6 jours', lat: 36, lng: 5, createdAt: iso(NOW - 6 * 86400e3), userId: 'x' } },
];
const COMMENTS = [{ id: id('k'), data: { text: '<img src=x onerror="window.__pwned=\'comment\'">merci', createdAt: { __ts: NOW - 60e3 }, userId: 'u9' } }];
const PRIVATE = { contact: '0555 <b>12</b> 34' };
const ME = { uid: 'u-me', displayName: '<b>Wassim</b>', email: 'w@example.org', photoURL: 'javascript:alert(1)' };

let browser;
before(async () => { if (!skipAll) browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-features=OptimizationHints,AutofillServerCommunication', '--disable-background-networking'] }); });
after(async () => { await browser?.close(); });

async function open({ legacyCache = false, consent = true } = {}) {
  const ctx = await browser.newContext({ locale: 'fr-FR', permissions: [] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const seen = { analyticsRequests: 0, nominatim: 0, violations: [], consoleErrors: [], popups: [] };
  await page.addInitScript(({ DOCS, COMMENTS, PRIVATE, ME, legacyCache, consent }) => {
    window.__DOCS = DOCS; window.__COMMENTS = COMMENTS; window.__PRIVATE = PRIVATE; window.__LOGIN_USER = ME;
    window.__CSP = [];
    document.addEventListener('securitypolicyviolation', e => window.__CSP.push(`${e.violatedDirective} ${e.blockedURI}`));
    window.confirm = () => true;
    if (legacyCache) localStorage.setItem('rahmapoint_situations', '[{"contact":"0555"}]');
    if (consent) localStorage.setItem('rahmapoint_privacy_accepted', 'yes');
  }, { DOCS, COMMENTS, PRIVATE, ME, legacyCache, consent });
  page.on('console', m => { if (m.type() === 'error') seen.consoleErrors.push(m.text()); });
  page.on('pageerror', e => seen.consoleErrors.push('pageerror: ' + e.message));
  ctx.on('page', p => seen.popups.push(p.url()));
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'www.gstatic.com') {
      const name = url.pathname.split('/').pop();
      if (name === 'firebase-analytics.js') seen.analyticsRequests++;
      return STUBS[name] ? route.fulfill({ contentType: 'text/javascript', body: STUBS[name] }) : route.abort();
    }
    if (url.hostname === 'nominatim.openstreetmap.org') {
      seen.nominatim++;
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify([{ display_name: '<img src=x onerror="window.__pwned=\'nominatim\'">Alger', lat: '36.75', lon: '3.06' },
                              { display_name: 'Hors Algérie', lat: '48.8', lon: '2.3' }, { display_name: 'Piégé', lat: "1);alert(1)", lon: '3' }]) });
    }
    return route.abort();
  });
  await page.goto(base);
  await page.waitForSelector('#cardsGrid .card');
  seen.page = page; seen.ctx = ctx;
  return seen;
}
const pwned = (p) => p.evaluate(() => window.__pwned);

test('chargement : les données piégées sont neutralisées, rien ne s\'exécute, aucune violation CSP', { skip: skipAll }, async () => {
  const s = await open({ legacyCache: true, consent: false }); const p = s.page;
  // 2 cartes valides (a, b) ; lat piégée, id piégé, type piégé, masqué (3 signalements) et expiré sont écartés
  assert.equal(await p.locator('#cardsGrid .card').count(), 2);
  assert.equal(await pwned(p), undefined);
  assert.equal(await p.locator('#cardsGrid img[src="x"], #cardsGrid script, #cardsGrid svg[onload]').count(), 0);
  assert.match(await p.locator('#cardsGrid').innerText(), /<img src=x onerror=/);        // affiché comme TEXTE
  assert.deepEqual(await p.evaluate(() => window.__CSP), []);
  assert.deepEqual(s.consoleErrors.filter(e => /Content Security Policy|pageerror/.test(e)), []);
  assert.equal(await p.evaluate(() => localStorage.getItem('rahmapoint_situations')), null);   // ancien cache purgé
  assert.deepEqual(await p.evaluate(() => window.__QUERIES.find(q => q.path === 'signalements')), { path: 'signalements', limit: 300 });
  await s.ctx.close();
});

test('la CSP bloque réellement un script inline injecté', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  const ran = await p.evaluate(() => { const el = document.createElement('script'); el.textContent = 'window.__inl = 1'; document.head.appendChild(el); return window.__inl; });
  assert.equal(ran, undefined);
  assert.ok((await p.evaluate(() => window.__CSP)).some(v => v.startsWith('script-src')));
  await s.ctx.close();
});

test('analytics : aucune requête avant consentement, chargé après acceptation', { skip: skipAll }, async () => {
  const s = await open({ consent: false }); const p = s.page;
  await p.waitForTimeout(500);
  assert.equal(s.analyticsRequests, 0);
  await p.click('#acceptLabel'); await p.click('#acceptBtn');
  await p.waitForFunction(() => window.__ANALYTICS >= 1);
  assert.ok(s.analyticsRequests >= 1);
  await s.ctx.close();
});

test('visiteur : détail sans contact ni commentaires ; création demande la connexion', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  await p.locator('#cardsGrid .card [data-action="openDetail"]').first().click();
  await p.waitForSelector('#detailModal.active');
  const txt = await p.locator('#detailContent').innerText();
  assert.match(txt, /Connectez-vous/);
  assert.equal(await p.locator('#commentInput').count(), 0);
  assert.equal(await p.evaluate(() => (window.__QUERIES || []).filter(q => q.path.endsWith('/comments')).length), 0);
  await p.click('#detailModal .modal-close');
  assert.equal(await p.locator('#detailModal.active').count(), 0);
  await p.locator('.hero [data-action="openSignalModal"], [data-action="openSignalModal"]').first().click();
  await p.waitForSelector('#loginRequiredModal.active');
  assert.equal(await p.locator('#signalModal.active').count(), 0);
  await s.ctx.close();
});

test('connecté : contact/commentaires affichés comme texte ; confirmer/signaler = écritures conformes aux règles', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  await p.locator('[data-action="loginWithGoogle"]').first().click();
  await p.waitForSelector('.user-name');
  assert.equal(await p.locator('.user-name').innerText(), '<b>Wassim</b>');          // texte, pas du HTML
  assert.equal(await p.locator('.user-info b').count(), 0);
  assert.equal(await p.locator('.user-info img[src^="javascript"]').count(), 0);      // avatar non-Google ignoré

  await p.locator('#cardsGrid .card', { hasText: 'Homme seul' }).locator('[data-action="openDetail"]').click();
  await p.waitForSelector('#detailModal.active');
  await p.waitForSelector('#commentsList .comment-item');
  assert.match(await p.locator('#detailContactValue').innerText(), /📞 0555 <b>12<\/b> 34/);
  assert.equal(await p.locator('#detailContent b, #detailContent img[src="x"]').count(), 0);
  assert.equal(await pwned(p), undefined);

  await p.click('#detailContent [data-action="confirmSituation"]');
  await p.click('#detailContent [data-action="reportSituation"]');
  const w = await p.evaluate(() => window.__WRITES);
  assert.deepEqual(w[0], { op: 'update', path: `signalements/${id('a')}`, data: { confirmedBy: { __op: 'arrayUnion', v: 'u-me' } } });
  assert.deepEqual(w[1].data, { reportCount: { __op: 'increment', n: 1 }, reportedBy: { __op: 'arrayUnion', v: 'u-me' } });

  // commentaire = document séparé + horodatage de fréquence
  await p.fill('#commentInput', 'Je passe ce soir');
  await p.click('#detailContent [data-action="addComment"]');
  const w2 = (await p.evaluate(() => window.__WRITES)).slice(2);
  assert.equal(w2[0].path.startsWith(`signalements/${id('a')}/comments/`), true);
  assert.deepEqual(Object.keys(w2[0].data).sort(), ['createdAt', 'expiresAt', 'text', 'userId']);
  assert.deepEqual(w2[1], { op: 'set', path: 'rate/u-me', data: { lastCommentAt: { __op: 'serverTimestamp' } }, merge: true });
  await s.ctx.close();
});

test('auteur : pas de confirmation/signalement de son propre cas ; suppression propre', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  await p.evaluate(() => window.__setUser({ uid: 'owner', displayName: 'Owner', photoURL: null }));
  const card = p.locator('#cardsGrid .card', { hasText: 'Homme seul' });
  assert.equal(await card.locator('[data-action="confirmSituation"], [data-action="reportSituation"]').count(), 0);
  await card.locator('[data-action="openDetail"]').click();
  await p.waitForSelector('#detailModal.active');
  await p.click('#detailContent [data-action="deleteOwn"]');
  await p.waitForFunction(() => window.__WRITES.length >= 2);
  assert.deepEqual((await p.evaluate(() => window.__WRITES)).map(w => [w.op, w.path]),
    [['delete', `signalements/${id('a')}/private/info`], ['delete', `signalements/${id('a')}`]]);
  await s.ctx.close();
});

test('nouveau signalement : position obligatoire, champs minimisés, contact séparé, anti-spam', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  await p.locator('[data-action="loginWithGoogle"]').first().click();
  await p.waitForSelector('.user-name');
  await p.locator('[data-action="openSignalModal"]').first().click();
  await p.waitForSelector('#signalModal.active');
  await p.click('#signalModal [data-type="abri"]');
  await p.fill('#descInput', 'Famille de trois personnes dans un abri de fortune');
  await p.fill('#contactInput', '0555 11 22 33');
  await p.click('#signalModal [data-action="submitSignal"]');
  assert.match(await p.locator('#toast').innerText(), /Cliquez sur la carte/);        // pas de position aléatoire
  assert.equal(await p.evaluate(() => (window.__WRITES || []).length), 0);

  await p.click('#signalModal [data-action="getLocation"]').catch(() => {});
  await p.evaluate(() => document.getElementById('signalModal').classList.remove('active'));
  await p.locator('#map').click({ position: { x: 200, y: 200 } });                     // choisit une position
  await p.waitForSelector('#signalModal.active');
  await p.click('#signalModal [data-type="abri"]');
  await p.fill('#descInput', 'Famille de trois personnes dans un abri de fortune');
  await p.fill('#contactInput', '0555 11 22 33');
  await p.click('#signalModal [data-action="submitSignal"]');
  await p.waitForFunction(() => window.__WRITES.length >= 3);
  const [main, priv, rate] = await p.evaluate(() => window.__WRITES);
  assert.deepEqual(Object.keys(main.data).sort(),
    ['confirmedBy', 'createdAt', 'description', 'expiresAt', 'lat', 'lng', 'location', 'reportCount', 'reportedBy', 'resolved', 'type', 'userId']);
  assert.ok(!('contact' in main.data) && !('userName' in main.data) && !('userPhoto' in main.data));
  assert.deepEqual(main.data.createdAt, { __op: 'serverTimestamp' });
  assert.equal(typeof main.data.lat, 'number');
  assert.equal(priv.path, `${main.path}/private/info`);
  assert.equal(priv.data.contact, '0555 11 22 33');
  assert.deepEqual(rate, { op: 'set', path: 'rate/u-me', data: { lastReportAt: { __op: 'serverTimestamp' } }, merge: true });
  await s.ctx.close();
});

test('recherche : pas de requête à la frappe (Nominatim), résultats affichés comme texte, coordonnées invalides ignorées', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  await p.locator('#mapSearchInput').pressSequentially('Alger', { delay: 60 });
  await p.waitForTimeout(700);
  assert.equal(s.nominatim, 0);
  await p.press('#mapSearchInput', 'Enter');
  await p.waitForSelector('#mapSearchResults .search-result-item');
  assert.equal(s.nominatim, 1);
  assert.equal(await p.locator('#mapSearchResults .search-result-item').count(), 1);   // 2 résultats invalides écartés
  assert.match(await p.locator('#mapSearchResults').innerText(), /<img src=x/);
  assert.equal(await p.locator('#mapSearchResults img').count(), 0);
  assert.equal(await pwned(p), undefined);
  await s.ctx.close();
});

test('itinéraire : ouverture sécurisée ; bascule arabe/RTL conserve l\'affichage', { skip: skipAll }, async () => {
  const s = await open(); const p = s.page;
  const [popup] = await Promise.all([
    s.ctx.waitForEvent('page'),
    p.locator('#cardsGrid .card', { hasText: 'Homme seul' }).locator('[data-action="goToRoute"]').click(),
  ]);
  assert.equal(await popup.evaluate(() => window.opener), null);                        // noopener
  await popup.close();
  await p.click('#langToggle');
  assert.equal(await p.getAttribute('html', 'dir'), 'rtl');
  assert.equal(await p.locator('#cardsGrid .card').count(), 2);
  await s.ctx.close();
});

test('GitHub Pages : aucune ressource locale introuvable sous le sous-dossier du dépôt', { skip: skipAll }, async () => {
  const before = notFound.length;
  const s = await open(); const p = s.page;
  await p.waitForTimeout(500);
  const missing = notFound.slice(before).filter(u => !/favicon\.ico$/.test(u));
  assert.deepEqual(missing, []);
  assert.ok(await p.evaluate(() => !!window.L), 'Leaflet local chargé');
  assert.ok(await p.locator('img.logo-img').evaluate(i => i.complete && i.naturalWidth > 0), 'logo chargé');
  await s.ctx.close();
});

test('anti-clickjacking de remplacement : intégrée dans un iframe d\'une AUTRE origine, la page se redirige ou se masque', { skip: skipAll }, async () => {
  // Page « attaquante » servie par un second serveur, sur une autre origine (localhost ≠ 127.0.0.1)
  const attacker = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<iframe id="f" src="${base}"></iframe>`); }).listen(0, '127.0.0.1');
  await new Promise(r => attacker.once('listening', r));
  const attackerUrl = `http://localhost:${attacker.address().port}/`;
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await ctx.route('**/*', (r) => (['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await page.goto(attackerUrl, { waitUntil: 'commit' }).catch(() => {});   // peut être interrompue par le frame-busting
  await page.waitForTimeout(2000);
  const frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(base));
  // Issues acceptables : la fenêtre parente est ramenée vers la vraie page, ou la page intégrée se masque.
  const busted = page.url().startsWith(base);
  const hidden = frame ? await frame.evaluate(() => document.documentElement.style.display) : null;
  assert.ok(busted || hidden === 'none', `ni redirection (${page.url()}) ni masquage (${hidden})`);
  await ctx.close(); attacker.close();
});
