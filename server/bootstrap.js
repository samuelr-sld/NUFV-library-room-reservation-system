import { FieldValue } from 'firebase-admin/firestore';
import { audit } from './audit.js';

export class BootstrapError extends Error {}

// One-time provisioning of the first administrator. Run by an operator through server/scripts/bootstrap-admin.js only:
// there is no HTTP route, no default account and no password handling. The administrator must already exist in
// Firebase Authentication (created by the operator in the Console or Emulator UI, who sets the password there).
//
// A Console-created account is never email-verified, and an account with no profile cannot sign in to the app to fix that.
// verifyEmail is the operator's explicit statement "I control this mailbox": the Admin SDK then marks it verified, but only after
// every other check passed and the profile was written, and the audit entry records that the operator vouched for it.
export async function bootstrapAdmin({ auth, db, config, email, fullName, confirmProject, verifyEmail = false, operator = 'unknown' }) {
  if (config.cloud && confirmProject !== config.projectId) {
    throw new BootstrapError(`Bootstrapping a real project needs --confirm-project ${config.projectId}.`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) throw new BootstrapError('A valid --email is required.');
  const name = (fullName ?? '').trim();
  if (name.length < 2 || name.length > 100) throw new BootstrapError('--name must be 2 to 100 characters.');

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') throw new BootstrapError(`No Firebase Auth account exists for ${email}. Create it first.`);
    throw err;
  }
  if (user.disabled) throw new BootstrapError('That account is disabled.');
  // Emulator accounts cannot click a verification link, so the check applies to real projects only.
  const vouch = config.cloud && !user.emailVerified && verifyEmail === true;
  if (config.cloud && !user.emailVerified && !vouch) {
    throw new BootstrapError('That email address is not verified. If you control that mailbox, repeat with --verify-email to vouch for it.');
  }

  const userRef = db.doc(`users/${user.uid}`);
  await db.runTransaction(async (tx) => {
    // Re-checked inside the transaction so two concurrent runs cannot both succeed.
    const [profile, admins] = await Promise.all([tx.get(userRef), tx.get(db.collection('users').where('role', '==', 'admin').limit(1))]);
    if (!admins.empty) throw new BootstrapError('An administrator already exists; bootstrap is a one-time operation.');
    if (profile.exists) {
      throw new BootstrapError('That account already has a profile and will not be promoted. Use a dedicated administrator account.');
    }
    tx.create(userRef, {
      email: user.email, fullName: name, studentNumber: null,
      program: '', yearLevel: null,
      role: 'admin', status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    audit(db, tx, { actorUid: null, action: 'admin.bootstrap', targetType: 'user', targetId: user.uid, details: { operator, project: config.projectId, emailVerifiedByOperator: vouch } });
  });

  await auth.setCustomUserClaims(user.uid, { role: 'admin' });
  if (vouch) await auth.updateUser(user.uid, { emailVerified: true });
  return { uid: user.uid, email: user.email };
}
