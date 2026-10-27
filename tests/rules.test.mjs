// Tests des règles Firestore avec l'émulateur Firebase (nécessite Java + firebase-tools).
//   npm install && npm run test:rules
// Hors émulateur (variable FIRESTORE_EMULATOR_HOST absente) les tests sont ignorés (SKIP), jamais faussement « réussis ».
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HAS_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;
const skip = HAS_EMULATOR ? false : 'émulateur Firestore absent (lancer via `npm run test:rules`)';

let env, T, F;
const DAY = 86400000;
const GOOGLE = (extra = {}) => ({ email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...extra });

if (HAS_EMULATOR) {
  T = await import('@firebase/rules-unit-testing');
  F = await import('firebase/firestore');
}

before(async () => {
  if (!HAS_EMULATOR) return;
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await T.initializeTestEnvironment({
    projectId: 'demo-rahmapoint',
    firestore: { rules: fs.readFileSync(path.resolve(import.meta.dirname, '../rules/firestore.rules'), 'utf8'), host, port: Number(port) },
  });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { if (env) await env.clearFirestore(); });

const user  = (uid, claims) => env.authenticatedContext(uid, GOOGLE(claims)).firestore();
const anon  = () => env.unauthenticatedContext().firestore();
const id20  = (c = 'a') => c.repeat(20);

function signal(uid, over = {}) {
  return {
    type: 'abri', description: 'Personne seule devant la gare routière', location: '36.19000, 5.41000',
    lat: 36.19, lng: 5.41, createdAt: F.serverTimestamp(), expiresAt: F.Timestamp.fromMillis(Date.now() + 5 * DAY),
    resolved: false, reportCount: 0, reportedBy: [], confirmedBy: [], userId: uid, ...over,
  };
}

// Création complète (signalement + rate), comme le fait l'application
async function createSignal(db, uid, sid = id20('a'), over = {}) {
  const batch = F.writeBatch(db);
  batch.set(F.doc(db, 'signalements', sid), signal(uid, over));
  batch.set(F.doc(db, 'rate', uid), { lastReportAt: F.serverTimestamp() }, { merge: true });
  return batch.commit();
}

// Prépare un signalement existant sans passer par les règles
async function seed(sid = id20('a'), owner = 'owner', over = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await F.setDoc(F.doc(ctx.firestore(), 'signalements', sid), signal(owner, { createdAt: F.Timestamp.now(), ...over }));
  });
}

// ── 1. Création ─────────────────────────────────────────────────────────────
test('1. visiteur non connecté ne peut pas créer', { skip }, async () => {
  await T.assertFails(F.setDoc(F.doc(anon(), 'signalements', id20()), signal('x')));
});

test('1b. utilisateur Google vérifié peut créer (signalement + rate)', { skip }, async () => {
  await T.assertSucceeds(createSignal(user('alice'), 'alice'));
});

test('1c. comptes non Google / e-mail non vérifié refusés', { skip }, async () => {
  const anonymous = env.authenticatedContext('bot', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const unverified = env.authenticatedContext('bot2', { email_verified: false, firebase: { sign_in_provider: 'google.com' } }).firestore();
  await T.assertFails(createSignal(anonymous, 'bot'));
  await T.assertFails(createSignal(unverified, 'bot2'));
});

for (const [name, over] of Object.entries({
  'userId d\'un autre utilisateur': () => ({ userId: 'bob' }),
  'createdAt fourni par le client': () => ({ createdAt: F.Timestamp.now() }),
  'createdAt antidaté': () => ({ createdAt: F.Timestamp.fromMillis(Date.now() - 10 * DAY) }),
  'reportCount pré-rempli': () => ({ reportCount: 5 }),
  'confirmedBy pré-rempli (faux témoins)': () => ({ confirmedBy: ['x', 'y', 'z'] }),
  'reportedBy pré-rempli': () => ({ reportedBy: ['x'] }),
  'resolved à true': () => ({ resolved: true }),
  'champ supplémentaire (rôle)': () => ({ role: 'admin' }),
  'champ supplémentaire userName': () => ({ userName: 'Jean Dupont' }),
  'description trop courte': () => ({ description: 'court' }),
  'description trop longue': () => ({ description: 'x'.repeat(501) }),
  'description non-chaîne': () => ({ description: 12345678901234 }),
  'type invalide': () => ({ type: 'hack' }),
  'lat en chaîne': () => ({ lat: '36.19' }),
  'lat hors Algérie': () => ({ lat: 48.85 }),
  'lng hors bornes': () => ({ lng: 99 }),
  'lat NaN': () => ({ lat: NaN }),
  'location trop longue': () => ({ location: 'x'.repeat(101) }),
  'expiresAt dans 30 jours (signalement immortel)': () => ({ expiresAt: F.Timestamp.fromMillis(Date.now() + 30 * DAY) }),
  'expiresAt déjà passé': () => ({ expiresAt: F.Timestamp.fromMillis(Date.now() - DAY) }),
  'expiresAt en chaîne': () => ({ expiresAt: 'jamais' }),
})) {
  test(`1d. création refusée : ${name}`, { skip }, async () => {
    await T.assertFails(createSignal(user('alice'), 'alice', id20('b'), over()));
  });
}

test('1e. identifiant de document personnalisé refusé (rupture de chaîne JS / ID piégé)', { skip }, async () => {
  for (const bad of ["x');alert(1)//", 'court', 'a'.repeat(21)]) {
    await T.assertFails(createSignal(user('alice'), 'alice', bad));
  }
});

test('1f. champ manquant refusé', { skip }, async () => {
  const db = user('alice');
  const d = signal('alice'); delete d.reportedBy;
  const batch = F.writeBatch(db);
  batch.set(F.doc(db, 'signalements', id20()), d);
  batch.set(F.doc(db, 'rate', 'alice'), { lastReportAt: F.serverTimestamp() }, { merge: true });
  await T.assertFails(batch.commit());
});

// ── 2. Limitation de fréquence ───────────────────────────────────────────────
test('2. création sans mise à jour du compteur de fréquence refusée', { skip }, async () => {
  const db = user('alice');
  await T.assertFails(F.setDoc(F.doc(db, 'signalements', id20()), signal('alice')));
});

test('2b. deuxième signalement < 2 min refusé ; accepté après le délai', { skip }, async () => {
  const db = user('alice');
  await T.assertSucceeds(createSignal(db, 'alice', id20('a')));
  await T.assertFails(createSignal(db, 'alice', id20('b')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await F.setDoc(F.doc(ctx.firestore(), 'rate', 'alice'), { lastReportAt: F.Timestamp.fromMillis(Date.now() - 600000) });
  });
  await T.assertSucceeds(createSignal(db, 'alice', id20('c')));
});

test('2c. rate : impossible d\'écrire pour un autre, d\'antidater ou de supprimer', { skip }, async () => {
  const db = user('alice');
  await T.assertFails(F.setDoc(F.doc(db, 'rate', 'bob'), { lastReportAt: F.serverTimestamp() }));
  await T.assertFails(F.setDoc(F.doc(db, 'rate', 'alice'), { lastReportAt: F.Timestamp.fromMillis(Date.now() - 9 * DAY) }));
  await T.assertSucceeds(F.setDoc(F.doc(db, 'rate', 'alice'), { lastReportAt: F.serverTimestamp() }));
  await T.assertFails(F.deleteDoc(F.doc(db, 'rate', 'alice')));
});

// ── 3. Lecture ───────────────────────────────────────────────────────────────
test('3. lecture publique des signalements, mais limit obligatoire (≤ 300)', { skip }, async () => {
  await seed();
  const col = F.collection(anon(), 'signalements');
  await T.assertSucceeds(F.getDoc(F.doc(anon(), 'signalements', id20())));
  await T.assertSucceeds(F.getDocs(F.query(col, F.orderBy('createdAt', 'desc'), F.limit(300))));
  await T.assertFails(F.getDocs(F.query(col, F.orderBy('createdAt', 'desc'))));                 // pas de limit
  await T.assertFails(F.getDocs(F.query(col, F.orderBy('createdAt', 'desc'), F.limit(301))));   // trop grand
});

test('3b. contact et commentaires : illisibles pour un visiteur, lisibles connecté ; pas de listing du contact', { skip }, async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await F.setDoc(F.doc(db, 'signalements', id20(), 'private', 'info'), { contact: '0555', userId: 'owner', expiresAt: F.Timestamp.now() });
    await F.setDoc(F.doc(db, 'signalements', id20(), 'comments', id20('c')), { text: 'ok', userId: 'owner', createdAt: F.Timestamp.now(), expiresAt: F.Timestamp.now() });
  });
  await T.assertFails(F.getDoc(F.doc(anon(), 'signalements', id20(), 'private', 'info')));
  await T.assertFails(F.getDocs(F.query(F.collection(anon(), 'signalements', id20(), 'comments'), F.limit(10))));
  await T.assertSucceeds(F.getDoc(F.doc(user('bob'), 'signalements', id20(), 'private', 'info')));
  await T.assertSucceeds(F.getDocs(F.query(F.collection(user('bob'), 'signalements', id20(), 'comments'), F.limit(10))));
  await T.assertFails(F.getDocs(F.query(F.collection(user('bob'), 'signalements', id20(), 'private'), F.limit(10))));  // pas de listing
  await T.assertFails(F.getDocs(F.query(F.collectionGroup(user('bob'), 'private'), F.limit(10))));                       // ni par groupe
});

test('3c. collections inconnues refusées', { skip }, async () => {
  await T.assertFails(F.getDoc(F.doc(user('alice'), 'users', 'alice')));
  await T.assertFails(F.setDoc(F.doc(user('alice'), 'users', 'alice'), { admin: true }));
});

// ── 4. Modification / suppression par un tiers ──────────────────────────────
test('4. un tiers ne peut ni modifier le contenu, ni la position, ni le propriétaire', { skip }, async () => {
  await seed();
  const db = user('mallory');
  const ref = F.doc(db, 'signalements', id20());
  await T.assertFails(F.updateDoc(ref, { description: 'défiguré par un tiers' }));
  await T.assertFails(F.updateDoc(ref, { lat: 30, lng: 3 }));
  await T.assertFails(F.updateDoc(ref, { userId: 'mallory' }));
  await T.assertFails(F.updateDoc(ref, { expiresAt: F.Timestamp.fromMillis(Date.now() + 900 * DAY) }));
  await T.assertFails(F.updateDoc(ref, { role: 'admin' }));
});

test('4b. un tiers ne peut pas supprimer un signalement', { skip }, async () => {
  await seed();
  await T.assertFails(F.deleteDoc(F.doc(user('mallory'), 'signalements', id20())));
  await T.assertFails(F.deleteDoc(F.doc(anon(), 'signalements', id20())));
});

test('4c. résolu : un tiers peut marquer résolu mais pas rouvrir ; l\'auteur peut rouvrir', { skip }, async () => {
  await seed();
  const ref = (db) => F.doc(db, 'signalements', id20());
  await T.assertSucceeds(F.updateDoc(ref(user('carol')), { resolved: true }));
  await T.assertFails(F.updateDoc(ref(user('carol')), { resolved: false }));
  await T.assertSucceeds(F.updateDoc(ref(user('owner')), { resolved: false }));
});

test('4d. l\'auteur peut supprimer son signalement (et son contact)', { skip }, async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await F.setDoc(F.doc(ctx.firestore(), 'signalements', id20(), 'private', 'info'), { contact: '0555', userId: 'owner', expiresAt: F.Timestamp.now() });
  });
  const db = user('owner');
  const batch = F.writeBatch(db);
  batch.delete(F.doc(db, 'signalements', id20(), 'private', 'info'));
  batch.delete(F.doc(db, 'signalements', id20()));
  await T.assertSucceeds(batch.commit());
});

test('4e. rôle admin = custom claim uniquement', { skip }, async () => {
  await seed();
  await T.assertSucceeds(F.deleteDoc(F.doc(user('mod', { admin: true }), 'signalements', id20())));
  await seed();
  await T.assertFails(F.deleteDoc(F.doc(user('mod'), 'signalements', id20())));
});

// ── 5. Compteurs ─────────────────────────────────────────────────────────────
test('5. confirmation : +1 uid, une fois, pas de falsification, pas par l\'auteur', { skip }, async () => {
  await seed();
  const ref = (db) => F.doc(db, 'signalements', id20());
  await T.assertSucceeds(F.updateDoc(ref(user('bob')), { confirmedBy: F.arrayUnion('bob') }));
  await T.assertFails(F.updateDoc(ref(user('bob')), { confirmedBy: F.arrayUnion('bob') }));            // doublon
  await T.assertFails(F.updateDoc(ref(user('bob')), { confirmedBy: F.arrayUnion('fake1') }));          // uid d'autrui
  await T.assertFails(F.updateDoc(ref(user('bob')), { confirmedBy: ['bob'] }));                        // remplacement
  await T.assertFails(F.updateDoc(ref(user('owner')), { confirmedBy: F.arrayUnion('owner') }));        // auto-confirmation
  await T.assertFails(F.updateDoc(ref(user('dave')), { confirmedBy: F.arrayUnion('dave'), resolved: true })); // champ en plus
});

test('5b. signalement abusif : +1 exact, une fois, jamais par l\'auteur, pas de compteur seul', { skip }, async () => {
  await seed();
  const ref = (db) => F.doc(db, 'signalements', id20());
  await T.assertFails(F.updateDoc(ref(user('bob')), { reportCount: 99 }));
  await T.assertFails(F.updateDoc(ref(user('bob')), { reportCount: F.increment(2), reportedBy: F.arrayUnion('bob') }));
  await T.assertFails(F.updateDoc(ref(user('bob')), { reportCount: F.increment(-1), reportedBy: F.arrayUnion('bob') }));
  await T.assertFails(F.updateDoc(ref(user('owner')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('owner') }));
  await T.assertSucceeds(F.updateDoc(ref(user('bob')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('bob') }));
  await T.assertFails(F.updateDoc(ref(user('bob')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('bob') }));
});

test('5c. régression critique : atteindre le seuil de signalements ne permet JAMAIS la suppression par un tiers', { skip }, async () => {
  await seed();
  const ref = (db) => F.doc(db, 'signalements', id20());
  await T.assertSucceeds(F.updateDoc(ref(user('bob')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('bob') }));
  await T.assertSucceeds(F.updateDoc(ref(user('carol')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('carol') }));
  await T.assertSucceeds(F.updateDoc(ref(user('dave')), { reportCount: F.increment(1), reportedBy: F.arrayUnion('dave') }));
  await T.assertFails(F.deleteDoc(ref(user('bob'))));
  await T.assertFails(F.deleteDoc(ref(user('carol'))));
  await T.assertFails(F.deleteDoc(ref(user('dave'))));
  await T.assertSucceeds(F.getDoc(ref(anon())));        // toujours présent
});

test('5d. confirmations simultanées de plusieurs utilisateurs : toutes acceptées, aucune perdue', { skip }, async () => {
  await seed();
  const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
  await Promise.all(users.map(u => T.assertSucceeds(F.updateDoc(F.doc(user(u), 'signalements', id20()), { confirmedBy: F.arrayUnion(u) }))));
  const snap = await F.getDoc(F.doc(anon(), 'signalements', id20()));
  assert.deepEqual([...snap.data().confirmedBy].sort(), users);
});

// ── 6. Contact privé ─────────────────────────────────────────────────────────
test('6. contact : seul l\'auteur le crée (même lot que le signalement), ≤ 50 caractères, non modifiable', { skip }, async () => {
  const db = user('alice');
  const exp = F.Timestamp.fromMillis(Date.now() + 5 * DAY);
  const mk = async (contact, who = db, uid = 'alice') => {
    const b = F.writeBatch(who);
    b.set(F.doc(who, 'signalements', id20('d')), signal(uid, { expiresAt: exp }));
    b.set(F.doc(who, 'signalements', id20('d'), 'private', 'info'), { contact, userId: uid, expiresAt: exp });
    b.set(F.doc(who, 'rate', uid), { lastReportAt: F.serverTimestamp() }, { merge: true });
    return b.commit();
  };
  await T.assertFails(mk('x'.repeat(51)));
  await T.assertFails(mk(''));
  await T.assertSucceeds(mk('0555 12 34 56'));
  await T.assertFails(F.updateDoc(F.doc(db, 'signalements', id20('d'), 'private', 'info'), { contact: 'autre' }));
  // un tiers ne peut pas rattacher un contact à un signalement qui n'est pas le sien
  await T.assertFails(F.setDoc(F.doc(user('mallory'), 'signalements', id20('d'), 'private', 'info'), { contact: '0000', userId: 'mallory', expiresAt: exp }));
  // un tiers ne peut pas supprimer le contact
  await T.assertFails(F.deleteDoc(F.doc(user('mallory'), 'signalements', id20('d'), 'private', 'info')));
});

// ── 7. Commentaires ──────────────────────────────────────────────────────────
async function addComment(db, uid, sid, over = {}, cid = id20('c')) {
  const parent = await F.getDoc(F.doc(db, 'signalements', sid));
  const b = F.writeBatch(db);
  b.set(F.doc(db, 'signalements', sid, 'comments', cid), {
    text: 'Je confirme, je passe en fin de journée', userId: uid, createdAt: F.serverTimestamp(),
    expiresAt: parent.data().expiresAt, ...over,
  });
  b.set(F.doc(db, 'rate', uid), { lastCommentAt: F.serverTimestamp() }, { merge: true });
  return b.commit();
}

test('7. commentaire valide accepté ; invalides refusés', { skip }, async () => {
  await seed();
  const sid = id20();
  await T.assertSucceeds(addComment(user('bob'), 'bob', sid));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { text: 'x'.repeat(301) }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { text: '' }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { userId: 'bob' }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { createdAt: F.Timestamp.fromMillis(1) }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { expiresAt: F.Timestamp.fromMillis(Date.now() + 900 * DAY) }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, { userName: 'x' }, id20('d')));
  await T.assertFails(addComment(user('carol'), 'carol', sid, {}, 'id-piege'));
});

test('7b. visiteur non connecté ne peut pas commenter ; commentaire non modifiable ; suppression limitée', { skip }, async () => {
  await seed();
  const sid = id20();
  await T.assertFails(F.setDoc(F.doc(anon(), 'signalements', sid, 'comments', id20('c')), { text: 'spam', userId: 'x', createdAt: F.Timestamp.now(), expiresAt: F.Timestamp.now() }));
  await T.assertSucceeds(addComment(user('bob'), 'bob', sid));
  await T.assertFails(F.updateDoc(F.doc(user('bob'), 'signalements', sid, 'comments', id20('c')), { text: 'modifié' }));
  await T.assertFails(F.deleteDoc(F.doc(user('mallory'), 'signalements', sid, 'comments', id20('c'))));
  await T.assertSucceeds(F.deleteDoc(F.doc(user('bob'), 'signalements', sid, 'comments', id20('c'))));
});

test('7c. commentaires simultanés de plusieurs utilisateurs : tous conservés', { skip }, async () => {
  await seed();
  const sid = id20();
  const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  await Promise.all(users.map((u, i) => T.assertSucceeds(addComment(user(u), u, sid, {}, id20(String.fromCharCode(100 + i))))));
  const snap = await F.getDocs(F.query(F.collection(user('u1'), 'signalements', sid, 'comments'), F.limit(100)));
  assert.equal(snap.size, users.length);
});

test('7d. limitation de fréquence des commentaires (10 s)', { skip }, async () => {
  await seed();
  const sid = id20();
  const db = user('bob');
  await T.assertSucceeds(addComment(db, 'bob', sid, {}, id20('d')));
  await T.assertFails(addComment(db, 'bob', sid, {}, id20('e')));
});

test('7e. contournement du frontend : commentaire sans mise à jour du rate refusé', { skip }, async () => {
  await seed();
  const db = user('bob');
  const parent = await F.getDoc(F.doc(db, 'signalements', id20()));
  await T.assertFails(F.setDoc(F.doc(db, 'signalements', id20(), 'comments', id20('c')), {
    text: 'spam', userId: 'bob', createdAt: F.serverTimestamp(), expiresAt: parent.data().expiresAt,
  }));
});
