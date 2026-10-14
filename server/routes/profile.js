import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from '../errors.js';
import { audit } from '../audit.js';
import { authenticate, requireActiveProfile } from '../middleware/auth.js';

// "My Profile" for either role. The uid always comes from the verified token, so a caller can only ever read or change
// their own record. Only fullName, address and program (Course) are writable; email, student number, role and status have no route at all.
const invalid = (message) => new HttpError(400, 'invalid-argument', message);

export async function readProfile({ auth, db, uid }) {
  const [snap, user] = await Promise.all([db.doc(`users/${uid}`).get(), auth.getUser(uid)]);
  const p = snap.data();
  return {
    fullName: p.fullName ?? '', email: user.email ?? p.email, role: p.role, status: p.status, studentNumber: p.studentNumber ?? null,
    address: p.address ?? '', program: p.program ?? '',
    emailVerified: user.emailVerified,
    passwordReset: user.providerData.some((i) => i.providerId === 'password'), // Google/other sign-ins have no password to reset
  };
}

// Max length per editable field. Name is required; address and course may be cleared.
const FIELDS = { fullName: [2, 100], address: [0, 200], program: [0, 100] };

export async function updateSelf({ auth, db, uid, body }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object.');
  const keys = Object.keys(body);
  if (!keys.length) throw invalid('Nothing to update.');
  const next = {};
  for (const k of keys) {
    if (!(k in FIELDS)) throw invalid(`"${k}" cannot be changed.`);
    const [min, max] = FIELDS[k];
    const v = typeof body[k] === 'string' ? body[k].trim() : null;
    if (v === null || v.length < min || v.length > max || /[\u0000-\u001f]/.test(v)) throw invalid(`${k === 'program' ? 'Course' : k === 'address' ? 'Address' : 'Name'} must be ${min ? `${min} to ` : 'at most '}${max} characters.`);
    next[k] = v;
  }

  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const changes = {};
    for (const [k, to] of Object.entries(next)) if ((cur.get(k) ?? '') !== to) changes[k] = { from: cur.get(k) ?? '', to };
    if (!Object.keys(changes).length) return;
    tx.update(ref, { ...next, updatedAt: FieldValue.serverTimestamp() });
    audit(db, tx, { actorUid: uid, action: 'profile.update', targetType: 'user', targetId: uid, details: { changes } });
  });
  return readProfile({ auth, db, uid });
}

export function profileRouter(deps) {
  const { auth, db } = deps;
  const router = Router();
  router.use(authenticate(deps), requireActiveProfile(deps));
  router.get('/', async (req, res) => res.json({ profile: await readProfile({ auth, db, uid: req.user.uid }) }));
  router.patch('/', async (req, res) => res.json({ profile: await updateSelf({ auth, db, uid: req.user.uid, body: req.body }) }));
  return router;
}
