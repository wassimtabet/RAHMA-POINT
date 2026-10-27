// Supprime les signalements de l'ANCIENNE version (sans champ `expiresAt`) : ils contiennent encore
// contact, nom et photo Google en clair et ne seront jamais purgés par la politique TTL.
// Les signalements durent 5 jours : le plus simple est de l'exécuter une fois, juste après le déploiement des règles.
//
// Usage (depuis ce dossier, avec un compte autorisé sur le projet) :
//   npm install firebase-admin
//   gcloud auth application-default login            # ou GOOGLE_APPLICATION_CREDENTIALS=<clé JSON — jamais dans le dépôt>
//   node purge-legacy.mjs            # simulation (liste seulement)
//   node purge-legacy.mjs --delete   # suppression effective
// NON TESTÉ dans l'environnement d'audit (aucun accès au projet Firebase).
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const apply = process.argv.includes('--delete');
initializeApp({ credential: applicationDefault(), projectId: 'rahma-point' });
const db = getFirestore();

const snap = await db.collection('signalements').get();
const legacy = snap.docs.filter(d => !d.data().expiresAt);
console.log(`${snap.size} signalement(s), dont ${legacy.length} ancien(s) format.`);
for (const d of legacy) {
  console.log(apply ? 'suppression' : 'à supprimer', d.id);
  if (apply) await db.recursiveDelete(d.ref);
}
if (!apply && legacy.length) console.log('Relancer avec --delete pour supprimer.');
