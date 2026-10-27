// Donne (ou retire) le rôle « admin » modérateur à un compte, via custom claim (seul moyen reconnu par les règles).
// Les règles autorisent alors cet utilisateur à supprimer n'importe quel signalement / commentaire.
//
//   npm install firebase-admin
//   gcloud auth application-default login
//   node set-admin.mjs adresse@gmail.com          # accorder
//   node set-admin.mjs adresse@gmail.com --revoke  # retirer
// L'utilisateur doit se reconnecter (ou rafraîchir son jeton) pour que le claim soit pris en compte.
// NON TESTÉ dans l'environnement d'audit (aucun accès au projet Firebase).
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [email, flag] = process.argv.slice(2);
if (!email) { console.error('Usage : node set-admin.mjs <email> [--revoke]'); process.exit(1); }
initializeApp({ credential: applicationDefault(), projectId: 'rahma-point' });
const user = await getAuth().getUserByEmail(email);
await getAuth().setCustomUserClaims(user.uid, flag === '--revoke' ? { admin: null } : { admin: true });
console.log(flag === '--revoke' ? 'rôle admin retiré' : 'rôle admin accordé', 'à', user.uid);
