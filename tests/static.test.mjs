// Contrôles statiques de non-régression (node --test tests/static.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pub  = path.join(root, 'public');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test('aucun gestionnaire d\'événement inline ni script inline dans index.html', () => {
  const html = read('public/index.html');
  assert.deepEqual(html.match(/\son[a-z]+\s*=/gi) ?? [], []);
  assert.deepEqual(html.match(/href\s*=\s*["']\s*javascript:/gi) ?? [], []);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc=/, 'script inline interdit');
    assert.equal(m[2].trim(), '');
  }
});

test('app.js : plus d\'attribut onclick dans les gabarits et plus de localStorage des signalements', () => {
  const js = read('public/js/app.js');
  assert.ok(!/onclick\s*=/.test(js));
  assert.ok(!/localStorage\.setItem\(\s*['"]rahmapoint_situations/.test(js));
  assert.ok(!/deleteDoc\(doc\(db, 'signalements', id\)\);\s*\n\s*document/.test(js));
  assert.ok(!/purgeExpired/.test(js), 'la purge client doit rester supprimée (TTL côté serveur)');
});

test('app.js : pas de suppression déclenchée par un compteur', () => {
  const js = read('public/js/app.js');
  // l'unique suppression de signalement est deleteOwn(), protégée par confirmation + contrôle d'auteur
  const deletions = js.match(/batch\.delete\(doc\(db, 'signalements', id\)\)/g) ?? [];
  assert.equal(deletions.length, 1);
  assert.match(js, /async function deleteOwn[\s\S]*s\.userId !== currentUser\.uid/);
});

test('analytics seulement après consentement (import dynamique, jamais statique)', () => {
  const fb = read('public/js/firebase.js');
  const staticImports = fb.split('\n').filter(l => /^import\s/.test(l)).join('\n');
  assert.ok(!/firebase-analytics/.test(staticImports), 'firebase-analytics ne doit pas être importé statiquement');
  assert.match(fb, /async function enableAnalytics/);
  const app = read('public/js/app.js');
  assert.match(app, /function acceptPrivacy\(\) \{[\s\S]*enableAnalytics\(\)/);
});

test('aucun secret privé dans le projet', () => {
  const patterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/, /AIza[0-9A-Za-z_-]{35}/];
  for (const f of walk(root)) {
    if (f.includes('node_modules') || /\.(png|jpg|ico)$/.test(f) || f.endsWith('.zip')) continue;
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!patterns[0].test(txt) && !patterns[1].test(txt), `secret privé dans ${f}`);
    // La seule clé « AIza » autorisée est la clé web Firebase PUBLIQUE de firebase.js
    if (patterns[2].test(txt) && !f.endsWith(path.join('js', 'firebase.js')) && !f.includes('docs')) {
      assert.fail(`clé API inattendue dans ${f}`);
    }
  }
  assert.ok(!fs.existsSync(path.join(root, '.env')));
});

test('CSP : pas de unsafe-inline/unsafe-eval pour les scripts, objets et cadres verrouillés', () => {
  const html = read('public/index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'la CSP doit précéder tout script');
  const dir = Object.fromEntries(csp.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const [k, ...v] = s.split(/\s+/); return [k, v];
  }));
  assert.ok(!dir['script-src'].includes("'unsafe-inline'"));
  assert.ok(!dir['script-src'].includes("'unsafe-eval'"));
  assert.deepEqual(dir['object-src'], ["'none'"]);
  assert.ok(!('frame-ancestors' in dir), 'frame-ancestors est ignoré dans <meta> : ne pas le déclarer');
  assert.deepEqual(dir['base-uri'], ["'self'"]);
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin"/);
  assert.match(read('public/js/framebuster.js'), /window\.top !== window\.self/);
});

test('CSP : tous les hôtes de tuiles et de services utilisés par le code sont autorisés', () => {
  const csp = read('public/index.html').match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const js = read('public/js/app.js') + read('public/js/firebase.js');
  const hosts = new Set([...js.matchAll(/https:\/\/(?:\{s\}\.)?([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]));
  const ignorable = new Set(['www.gstatic.com', 'www.google.com', 'rahma-point.firebaseapp.com', 'rahma-point.firebasestorage.app']);
  for (const h of hosts) {
    if (ignorable.has(h)) continue;
    const parent = h.split('.').slice(1).join('.');
    assert.ok(csp.includes(h) || csp.includes('*.' + parent) || csp.includes('*.' + h.split('.').slice(-2).join('.')),
      `hôte ${h} absent de la CSP`);
  }
  assert.ok(csp.includes('https://www.gstatic.com'));
});

test('règles Firestore : refus par défaut, pas de allow ... if true en écriture', () => {
  const r = read('rules/firestore.rules');
  assert.match(r, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  assert.ok(!/allow\s+(create|update|delete|write)[^;]*:\s*if\s+true/.test(r));
  assert.match(r, /request\.query\.limit <= 300/);
  assert.match(r, /createdAt == request\.time/);
  // pas de suppression ouverte aux tiers
  assert.ok(!/allow delete: if signedIn\(\);/.test(r));
});

test('Storage : refus total', () => {
  assert.match(read('rules/storage.rules'), /allow read, write: if false;/);
});

test('hors du dossier publié : tests, règles et documents ne sont pas servis', () => {
  for (const f of walk(pub)) {
    assert.ok(!/(\.rules|\.test\.mjs|\.env|\.md)$/.test(f), `fichier sensible publié : ${f}`);
  }
});

test('GitHub Pages : workflow publie uniquement public/, permissions minimales, aucun secret', () => {
  const wf = read('.github/workflows/pages.yml');
  assert.match(wf, /upload-pages-artifact@v\d+\s*\n\s*with:\s*\n\s*path: public\s*\n/);
  assert.match(wf, /pages: write/);
  assert.match(wf, /contents: read/);
  assert.ok(!/secrets\./.test(wf));
  assert.ok(fs.existsSync(path.join(pub, '.nojekyll')));
});

test('GitHub Pages (sous-dossier /depot/) : aucune ressource en chemin absolu', () => {
  const html = read('public/index.html');
  for (const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
    const u = m[1];
    assert.ok(!u.startsWith('/'), `chemin absolu : ${u}`);
  }
  for (const f of ['public/style.css', 'public/js/app.js', 'public/js/firebase.js']) {
    const txt = read(f);
    assert.ok(!/url\(\s*['"]?\/(?!\/)/.test(txt), `url(/…) dans ${f}`);
    assert.ok(!/(?:fetch|import)\s*\(?\s*['"]\/(?!\/)/.test(txt), `chemin absolu dans ${f}`);
  }
  assert.ok(!fs.existsSync(path.join(pub, 'CNAME')), 'CNAME : à ajouter seulement quand le domaine existe (voir guide)');
});

test('plus aucune référence à l\'ancien hébergeur hors du document de migration', () => {
  const needle = new RegExp(['net', 'lify'].join(''), 'i');
  for (const f of walk(root)) {
    if (f.includes('node_modules') || f.endsWith('.png') || f.endsWith('.zip')) continue;
    if (f.endsWith('MIGRATION_GITHUB_PAGES.md') || f.endsWith('static.test.mjs')) continue;
    assert.ok(!needle.test(fs.readFileSync(f, 'utf8')), `référence résiduelle dans ${path.relative(root, f)}`);
    assert.ok(!needle.test(path.relative(root, f)), `fichier résiduel ${f}`);
  }
});
