import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from '../errors.js';
import { audit } from '../audit.js';
import { STUDENT_NUMBER, normalizeStudentNumber } from '../policy.js';
import { authenticate, requireActiveProfile, requireVerifiedEmail } from '../middleware/auth.js';


const text = (v) => (typeof v === 'string' ? v.trim() : '');

export async function createStudentProfile({ auth, db, uid, email, body }) {
  // Only fullName and studentNumber are read; a client-supplied role (or anything else) is ignored.
  const fullName = text(body?.fullName);
  const studentNumber = normalizeStudentNumber(body?.studentNumber);
  if (fullName.length < 2 || fullName.length > 100) {
    throw new HttpError(400, 'invalid-argument', 'Full name must be 2 to 100 characters.');
  }
  if (!STUDENT_NUMBER.test(studentNumber)) {
    throw new HttpError(400, 'invalid-argument', 'Enter your student number (3 to 24 letters, digits or hyphens).');
  }

  const userRef = db.doc(`users/${uid}`);
  const numberRef = db.doc(`studentNumbers/${studentNumber}`);

  const result = await db.runTransaction(async (tx) => {
    const [user, number] = await Promise.all([tx.get(userRef), tx.get(numberRef)]);
    if (user.exists) {
      if (user.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
      // Idempotent retry; return the stored role so an existing admin is never demoted.
      if (user.get('studentNumber') === studentNumber) return { role: user.get('role'), created: false };
      throw new HttpError(409, 'already-exists', 'This account already has a profile.');
    }
    if (number.exists) throw new HttpError(409, 'already-exists', 'This student number is already registered.');

    tx.create(numberRef, { uid });
    tx.create(userRef, {
      email, fullName, studentNumber,
      program: '', yearLevel: null,
      role: 'student', status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    audit(db, tx, { actorUid: uid, action: 'profile.create', targetType: 'user', targetId: uid });
    return { role: 'student', created: true };
  });

  // Claims are set after commit; a retry re-applies them from the stored role.
  await auth.setCustomUserClaims(uid, { role: result.role });
  return result;
}

export function studentsRouter(deps) {
  const router = Router();
  router.post('/profile', authenticate(deps), async (req, res) => {
    const { role, created } = await createStudentProfile({ ...deps, ...req.user, body: req.body });
    res.status(created ? 201 : 200).json({ role });
  });
  // Gate for library services: the token must carry a verified email and the profile must be active.
  router.get('/access', authenticate(deps), requireVerifiedEmail, requireActiveProfile(deps), (req, res) => res.json({ access: true }));
  return router;
}
