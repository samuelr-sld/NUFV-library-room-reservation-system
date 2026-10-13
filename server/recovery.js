import { FieldValue } from 'firebase-admin/firestore';
import { audit } from './audit.js';
import { BootstrapError } from './bootstrap.js';

// Operator-only recovery for loss of access to the sole administrator (server/scripts/recover-admin.js). There is no HTTP route.
// It never creates an account and never promotes a student: the replacement must already exist in Firebase Authentication
// and must have no profile. The lost administrator is suspended, disabled and signed out everywhere.
export async function recoverAdmin({ auth, db, config, oldEmail, newEmail, reason, confirmProject, operator = 'unknown' }) {
  const refuse = (msg) => { throw new BootstrapError(msg); };

  if (config.cloud && confirmProject !== config.projectId) refuse(`Recovery in a real project needs --confirm-project ${config.projectId}.`);
  const why = (reason ?? '').trim();
  if (why.length < 10) refuse('--reason must describe why recovery is needed (at least 10 characters).');
  if (!oldEmail || !newEmail || oldEmail.toLowerCase() === newEmail.toLowerCase()) refuse('--old-admin and --new-admin must be two different emails.');

  // Credentials are verified by use: a real privileged call has to succeed before anything is changed.
  if (config.cloud) {
    try { await auth.listUsers(1); } catch { refuse('The operator credentials could not be verified against this project.'); }
  }

  const lookup = async (email, label) => {
    try { return await auth.getUserByEmail(email); } catch (err) {
      if (err.code === 'auth/user-not-found') refuse(`No Firebase Auth account exists for the ${label} (${email}).`);
      throw err;
    }
  };
  const [oldUser, newUser] = [await lookup(oldEmail, 'lost administrator'), await lookup(newEmail, 'replacement administrator')];
  if (newUser.disabled) refuse('The replacement account is disabled.');
  if (config.cloud && !newUser.emailVerified) refuse('The replacement email address is not verified.');

  const oldRef = db.doc(`users/${oldUser.uid}`);
  const newRef = db.doc(`users/${newUser.uid}`);
  await db.runTransaction(async (tx) => {
    const [oldProfile, newProfile, admins] = await Promise.all([tx.get(oldRef), tx.get(newRef), tx.get(db.collection('users').where('role', '==', 'admin'))]);
    if (!oldProfile.exists || oldProfile.get('role') !== 'admin') refuse('The lost account is not an administrator.');
    if (newProfile.exists) refuse('The replacement account already has a profile and will not be promoted. Use a dedicated account.');

    // Recovery is for a *sole* administrator. If another one can still act, use that account instead.
    for (const doc of admins.docs) {
      if (doc.id === oldUser.uid || doc.get('status') !== 'active') continue;
      const other = await auth.getUser(doc.id).catch((err) => (err.code === 'auth/user-not-found' ? null : Promise.reject(err)));
      if (other && !other.disabled) refuse(`Another active administrator exists (${other.email}); recovery is not needed.`);
    }

    tx.update(oldRef, { status: 'suspended', suspendedReason: 'admin-recovery', updatedAt: FieldValue.serverTimestamp() });
    tx.create(newRef, {
      email: newUser.email, fullName: newUser.displayName || newUser.email, studentNumber: null,
      program: '', yearLevel: null, role: 'admin', status: 'active',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    audit(db, tx, {
      actorUid: null, action: 'admin.recovery', targetType: 'user', targetId: newUser.uid,
      details: { lostAdminUid: oldUser.uid, reason: why, operator, project: config.projectId },
    });
  });

  // The Firestore profile change above already locks the old administrator out of the API; these close the remaining doors.
  try {
    await auth.setCustomUserClaims(newUser.uid, { role: 'admin' });
    await auth.setCustomUserClaims(oldUser.uid, null);
    await auth.updateUser(oldUser.uid, { disabled: true });
    await auth.revokeRefreshTokens(oldUser.uid);
  } catch (err) {
    throw new BootstrapError(`Profiles were updated, but a follow-up step failed (${err.code ?? err.message}). Do not re-run this command; disable ${oldEmail} in Firebase Authentication by hand and check the replacement's role claim.`);
  }
  return { newAdmin: { uid: newUser.uid, email: newUser.email }, lostAdmin: { uid: oldUser.uid, email: oldUser.email } };
}
