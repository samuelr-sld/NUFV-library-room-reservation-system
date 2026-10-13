import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { loadConfig } from '../../server/config.js';
import { initFirebase } from '../../server/firebase.js';
import { createApp } from '../../server/app.js';
import express from 'express';
import { authenticate, requireAdmin } from '../../server/middleware/auth.js';
import { errorHandler } from '../../server/errors.js';

// Runs against the Auth and Firestore emulators started by `firebase emulators:exec` (see npm test).
const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const { auth, db } = initFirebase(config);
const clients = [];
let server, adminServer, flakyServer, base, adminBase, flakyBase;
let failClaimsOnce = false; // makes the next setCustomUserClaims throw, simulating a crash after the Firestore commit

const listen = async (app) => {
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return [s, `http://127.0.0.1:${s.address().port}`];
};

before(async () => {
  [server, base] = await listen(createApp({ config, auth, db }));
  // Minimal admin-only route so requireAdmin is tested through real HTTP; the real admin routes land in a later phase.
  const admin = express();
  admin.get('/__admin-only', authenticate({ auth }), requireAdmin({ db }), (req, res) => res.json({ ok: true }));
  admin.use(errorHandler);
  [adminServer, adminBase] = await listen(admin);

  const flakyAuth = {
    verifyIdToken: (...a) => auth.verifyIdToken(...a),
    setCustomUserClaims: async (...a) => {
      if (failClaimsOnce) { failClaimsOnce = false; throw new Error('simulated crash after commit'); }
      return auth.setCustomUserClaims(...a);
    },
  };
  [flakyServer, flakyBase] = await listen(createApp({ config, auth: flakyAuth, db }));
});

after(async () => {
  server.close();
  adminServer.close();
  flakyServer.close();
  await Promise.all(clients.map(deleteApp));
});

// Each user gets its own client app so sign-in state does not leak between tests.
function newClientAuth() {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-nufv' }, randomUUID());
  clients.push(app);
  const clientAuth = getAuth(app);
  connectAuthEmulator(clientAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  return clientAuth;
}

const withRegister = (user) => ({
  user,
  register: async (body, token, url = base) => fetch(`${url}/api/students/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? await user.getIdToken()}` },
    body: JSON.stringify(body),
  }),
});

async function newUser() {
  const { user } = await createUserWithEmailAndPassword(newClientAuth(), `${randomUUID()}@example.com`, 'secret123');
  return withRegister(user);
}

// Random so reruns against a long-lived emulator do not collide.
const newNumber = () => `2023-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const code = async (res) => (await res.json()).error.code;
const adminOnly = async (user) => fetch(`${adminBase}/__admin-only`, { headers: { Authorization: `Bearer ${await user.getIdToken(true)}` } });

test('creates the profile, claims the student number, sets the role claim and audits', async () => {
  const s = await newUser();
  const studentNumber = newNumber();

  const res = await s.register({ fullName: 'Juan Dela Cruz', studentNumber });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { role: 'student' });

  const profile = (await db.doc(`users/${s.user.uid}`).get()).data();
  assert.equal(profile.studentNumber, studentNumber);
  assert.equal(profile.fullName, 'Juan Dela Cruz');
  assert.equal(profile.role, 'student');
  assert.equal(profile.status, 'active');
  assert.equal(profile.email, s.user.email);
  assert.equal(profile.program, '');
  assert.equal(profile.yearLevel, null);

  assert.equal((await s.user.getIdTokenResult(true)).claims.role, 'student');
  assert.equal((await db.doc(`studentNumbers/${studentNumber}`).get()).get('uid'), s.user.uid);
  const logs = await db.collection('auditLogs').where('targetId', '==', s.user.uid).get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get('action'), 'profile.create');
});

test('retrying with the same data is idempotent: no second audit log, same role', async () => {
  const s = await newUser();
  const body = { fullName: 'Juan Dela Cruz', studentNumber: newNumber() };
  assert.equal((await s.register(body)).status, 201);
  const retry = await s.register(body);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { role: 'student' });
  assert.equal((await db.collection('auditLogs').where('targetId', '==', s.user.uid).get()).size, 1);
});

test('a second profile with a different number is rejected', async () => {
  const s = await newUser();
  await s.register({ fullName: 'Juan Dela Cruz', studentNumber: newNumber() });
  const res = await s.register({ fullName: 'Juan Dela Cruz', studentNumber: newNumber() });
  assert.equal(res.status, 409);
});

test('a duplicate student number is rejected and leaves no profile behind', async () => {
  const studentNumber = newNumber();
  await (await newUser()).register({ fullName: 'First Owner', studentNumber });
  const second = await newUser();
  const res = await second.register({ fullName: 'Second Person', studentNumber });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'already-exists');
  assert.equal((await db.doc(`users/${second.user.uid}`).get()).exists, false);
});

test('two simultaneous registrations for one student number: exactly one wins', async () => {
  const studentNumber = newNumber();
  const [a, b] = await Promise.all([newUser(), newUser()]);
  const statuses = (await Promise.all([
    a.register({ fullName: 'Racer A', studentNumber }),
    b.register({ fullName: 'Racer B', studentNumber }),
  ])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
});

test('rejects malformed input', async () => {
  const s = await newUser();
  for (const bad of [
    { fullName: 'Juan', studentNumber: 'ab' },
    { fullName: 'Juan', studentNumber: 'has space' },
    { fullName: 'Juan', studentNumber: 'x'.repeat(25) },
    { fullName: 'Juan', studentNumber: '-leading-hyphen' },
    { fullName: 'Juan', studentNumber: '../users/x' },
    { fullName: 'Juan', studentNumber: 123456 },
    { fullName: 'J', studentNumber: newNumber() },
    { fullName: 'x'.repeat(101), studentNumber: newNumber() },
    { fullName: { not: 'a string' }, studentNumber: newNumber() },
    {},
  ]) {
    const res = await s.register(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(await code(res), 'invalid-argument');
  }
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).exists, false);
});

test('missing and invalid ID tokens are rejected', async () => {
  const s = await newUser();
  const body = { fullName: 'Juan', studentNumber: newNumber() };
  const none = await fetch(`${base}/api/students/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(none.status, 401);
  // The emulator issues unsigned (alg=none) tokens, so signature tampering can only be checked against real keys, not here.
  const [h, p] = (await s.user.getIdToken()).split('.');
  for (const token of ['garbage', `${h}.${p}`, 'a.b.c']) {
    assert.equal((await s.register(body, token)).status, 401, token);
  }
});

test('a disabled Firebase account cannot register', async () => {
  const s = await newUser();
  const token = await s.user.getIdToken();
  await auth.updateUser(s.user.uid, { disabled: true });
  const res = await s.register({ fullName: 'Juan', studentNumber: newNumber() }, token);
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'account-suspended');
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).exists, false);
});

test('a suspended profile cannot re-register or be reactivated by retrying', async () => {
  const s = await newUser();
  const body = { fullName: 'Juan Dela Cruz', studentNumber: newNumber() };
  await s.register(body);
  await db.doc(`users/${s.user.uid}`).update({ status: 'suspended' });
  const res = await s.register(body);
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'account-suspended');
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).get('status'), 'suspended');
});

test('role escalation: a client-supplied role is ignored and cannot reach admin routes', async () => {
  const s = await newUser();
  const res = await s.register({ fullName: 'Mallory', studentNumber: newNumber(), role: 'admin', status: 'active', uid: 'someone-else' });
  assert.deepEqual(await res.json(), { role: 'student' });
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).get('role'), 'student');
  assert.equal((await s.user.getIdTokenResult(true)).claims.role, 'student');
  assert.equal((await adminOnly(s.user)).status, 403);
});

test('an existing admin retrying registration is not demoted', async () => {
  const s = await newUser();
  const studentNumber = newNumber();
  await db.doc(`users/${s.user.uid}`).set({ email: s.user.email, studentNumber, role: 'admin', status: 'active' });
  const res = await s.register({ fullName: 'Admin Person', studentNumber });
  assert.deepEqual(await res.json(), { role: 'admin' });
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).get('role'), 'admin');
});

test('admin routes: students, forged claims, suspended admins and profile-less users are refused; active admins pass', async () => {
  const student = await newUser();
  await student.register({ fullName: 'Plain Student', studentNumber: newNumber() });
  assert.equal((await adminOnly(student.user)).status, 403);

  // A forged/stale admin claim alone is not enough: the Firestore profile is the source of truth.
  await auth.setCustomUserClaims(student.user.uid, { role: 'admin' });
  assert.equal((await adminOnly(student.user)).status, 403);

  const nobody = await newUser();
  assert.equal((await adminOnly(nobody.user)).status, 403);

  const anon = await fetch(`${adminBase}/__admin-only`);
  assert.equal(anon.status, 401);

  const admin = await newUser();
  await db.doc(`users/${admin.user.uid}`).set({ role: 'admin', status: 'active' });
  assert.equal((await adminOnly(admin.user)).status, 200);

  await db.doc(`users/${admin.user.uid}`).update({ status: 'suspended' });
  const res = await adminOnly(admin.user);
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'account-suspended');
});

// ---- Registration consistency: identity, retries and partially completed registrations ----

test('anonymous Auth users cannot register', async () => {
  const { user } = await signInAnonymously(newClientAuth());
  const res = await withRegister(user).register({ fullName: 'Anon User', studentNumber: newNumber() });
  assert.equal(res.status, 401);
  assert.equal(await code(res), 'unauthenticated');
  assert.equal((await db.doc(`users/${user.uid}`).get()).exists, false);
});

test('an account without an email (custom-token sign-in) cannot register', async () => {
  const uid = `no-email-${randomUUID()}`;
  const { user } = await signInWithCustomToken(newClientAuth(), await auth.createCustomToken(uid));
  const res = await withRegister(user).register({ fullName: 'No Email', studentNumber: newNumber() });
  assert.equal(res.status, 401);
  assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
});

test('the profile email comes from the verified token, never from the request body', async () => {
  const s = await newUser();
  const res = await s.register({ fullName: 'Juan Dela Cruz', studentNumber: newNumber(), email: 'admin@victim.example' });
  assert.equal(res.status, 201);
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).get('email'), s.user.email);
});

test('a lost response: the identical request sent twice at once yields one profile, one audit log, no error', async () => {
  const s = await newUser();
  const body = { fullName: 'Juan Dela Cruz', studentNumber: newNumber() };
  const statuses = (await Promise.all([s.register(body), s.register(body)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 201]);
  assert.equal((await db.collection('auditLogs').where('targetId', '==', s.user.uid).get()).size, 1);
});

test('an Auth account with no profile (earlier attempt never reached the server) can register later', async () => {
  const s = await newUser();
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).exists, false);
  assert.equal((await s.register({ fullName: 'Juan Dela Cruz', studentNumber: newNumber() })).status, 201);
});

test('after a definitive rejection, the same account can retry with corrected data', async () => {
  const taken = newNumber();
  await (await newUser()).register({ fullName: 'First Owner', studentNumber: taken });
  const s = await newUser();
  assert.equal((await s.register({ fullName: 'Juan Dela Cruz', studentNumber: taken })).status, 409);
  assert.equal((await s.register({ fullName: 'Juan Dela Cruz', studentNumber: 'a/b' })).status, 400);
  assert.equal((await s.register({ fullName: 'Juan Dela Cruz', studentNumber: newNumber() })).status, 201);
});

test('crash after the Firestore commit: the first call fails generically, a retry completes it without duplicates', async () => {
  const s = await newUser();
  const body = { fullName: 'Juan Dela Cruz', studentNumber: newNumber() };
  const log = console.error;
  console.error = () => {};
  failClaimsOnce = true;
  try {
    const first = await s.register(body, undefined, flakyBase);
    assert.equal(first.status, 500);
    assert.doesNotMatch(await first.text(), /simulated/);
  } finally {
    console.error = log;
  }
  // Profile and lock are committed; only the claim is missing.
  assert.equal((await db.doc(`users/${s.user.uid}`).get()).get('studentNumber'), body.studentNumber);
  assert.equal((await s.user.getIdTokenResult(true)).claims.role, undefined);

  const retry = await s.register(body, undefined, flakyBase);
  assert.equal(retry.status, 200);
  assert.equal((await s.user.getIdTokenResult(true)).claims.role, 'student');
  assert.equal((await db.collection('auditLogs').where('targetId', '==', s.user.uid).get()).size, 1);
});

test('reconciliation never overwrites an existing profile and keeps the number locked to its owner', async () => {
  const owner = await newUser();
  const studentNumber = newNumber();
  await owner.register({ fullName: 'Original Name', studentNumber });

  const sameNumber = await owner.register({ fullName: 'Changed Name', studentNumber });
  assert.equal(sameNumber.status, 200);
  assert.equal((await db.doc(`users/${owner.user.uid}`).get()).get('fullName'), 'Original Name');

  const otherNumber = await owner.register({ fullName: 'Original Name', studentNumber: newNumber() });
  assert.equal(otherNumber.status, 409);
  assert.equal((await db.doc(`users/${owner.user.uid}`).get()).get('studentNumber'), studentNumber);

  const thief = await newUser();
  assert.equal((await thief.register({ fullName: 'Thief', studentNumber })).status, 409);
  assert.equal((await db.doc(`studentNumbers/${studentNumber}`).get()).get('uid'), owner.user.uid);
});
