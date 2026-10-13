import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../server/config.js';
import { initFirebase } from '../../server/firebase.js';
import { bootstrapAdmin, BootstrapError } from '../../server/bootstrap.js';
import { createStudentProfile } from '../../server/routes/students.js';
import { createApp } from '../../server/app.js';

// A private demo project keeps the "no admin exists yet" precondition independent of other test files running in parallel.
const config = loadConfig({ ...process.env, NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'demo-bootstrap', GCLOUD_PROJECT: 'demo-bootstrap' }, { forServer: false });
const { auth, db } = initFirebase(config);
const prodLike = { production: true, cloud: true, projectId: 'lrc-room-reservation' };

const newAccount = (opts = {}) => auth.createUser({ email: `${randomUUID()}@example.com`, password: 'secret123', ...opts });
const boot = (user, extra = {}) => bootstrapAdmin({ auth, db, config, email: user.email, fullName: 'Library Admin', ...extra });
const clearAdmins = async () => {
  for (const d of (await db.collection('users').where('role', '==', 'admin').get()).docs) await d.ref.delete();
};
const refused = (p, re) => assert.rejects(p, (e) => e instanceof BootstrapError && re.test(e.message));

before(clearAdmins);

test('provisions an existing Auth account as the first administrator, with claim and audit entry', async () => {
  await clearAdmins();
  const user = await newAccount();
  const result = await boot(user);
  assert.equal(result.uid, user.uid);

  const profile = (await db.doc(`users/${user.uid}`).get()).data();
  assert.equal(profile.role, 'admin');
  assert.equal(profile.status, 'active');
  assert.equal(profile.studentNumber, null);
  assert.equal(profile.email, user.email);
  assert.deepEqual((await auth.getUser(user.uid)).customClaims, { role: 'admin' });

  const logs = await db.collection('auditLogs').where('targetId', '==', user.uid).get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get('action'), 'admin.bootstrap');
});

test('is one-time: a second administrator cannot be bootstrapped', async () => {
  await clearAdmins();
  await boot(await newAccount());
  const other = await newAccount();
  await refused(boot(other), /already exists/);
  assert.equal((await db.doc(`users/${other.uid}`).get()).exists, false);
});

test('two concurrent bootstraps: exactly one wins', async () => {
  await clearAdmins();
  const [a, b] = await Promise.all([newAccount(), newAccount()]);
  const results = await Promise.allSettled([boot(a), boot(b)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.collection('users').where('role', '==', 'admin').get()).size, 1);
});

test('an existing student is never silently promoted', async () => {
  await clearAdmins();
  const user = await newAccount();
  await createStudentProfile({ auth, db, uid: user.uid, email: user.email, body: { fullName: 'Plain Student', studentNumber: '2023-111111' } });
  await refused(boot(user), /will not be promoted/);
  assert.equal((await db.doc(`users/${user.uid}`).get()).get('role'), 'student');
  assert.equal((await auth.getUser(user.uid)).customClaims.role, 'student');
});

test('the account must exist, be enabled and have a valid email and name', async () => {
  await clearAdmins();
  await refused(bootstrapAdmin({ auth, db, config, email: `${randomUUID()}@example.com`, fullName: 'Ghost' }), /No Firebase Auth account/);
  await refused(bootstrapAdmin({ auth, db, config, email: 'not-an-email', fullName: 'Ghost' }), /valid --email/);
  const user = await newAccount();
  await refused(boot(user, { fullName: 'x' }), /--name/);
  const disabled = await newAccount({ disabled: true });
  await refused(boot(disabled), /disabled/);
  assert.equal((await db.collection('users').where('role', '==', 'admin').get()).size, 0);
});

test('production needs a typed project confirmation and a verified email; both checked before any write', async () => {
  await clearAdmins();
  const unverified = await newAccount({ emailVerified: false });
  const verified = await newAccount({ emailVerified: true });
  const base = { auth, db, config: prodLike, fullName: 'Library Admin' };
  await refused(bootstrapAdmin({ ...base, email: verified.email }), /--confirm-project/);
  await refused(bootstrapAdmin({ ...base, email: verified.email, confirmProject: 'some-other-project' }), /--confirm-project/);
  await refused(bootstrapAdmin({ ...base, email: unverified.email, confirmProject: 'lrc-room-reservation' }), /not verified/);
  assert.equal((await db.collection('users').where('role', '==', 'admin').get()).size, 0);
  await bootstrapAdmin({ ...base, email: verified.email, confirmProject: 'lrc-room-reservation' });
  assert.equal((await db.collection('users').where('role', '==', 'admin').get()).size, 1);
});

test('--verify-email marks the mailbox verified only when asked, and never bypasses another check', async () => {
  await clearAdmins();
  const base = { auth, db, config: prodLike, fullName: 'Library Admin', confirmProject: 'lrc-room-reservation' };
  const stillUnverified = async (u) => assert.equal((await auth.getUser(u.uid)).emailVerified, false);

  const unverified = await newAccount({ emailVerified: false });
  await refused(bootstrapAdmin({ ...base, email: unverified.email }), /--verify-email/);
  await refused(bootstrapAdmin({ ...base, email: unverified.email, verifyEmail: true, confirmProject: undefined }), /--confirm-project/);
  await refused(bootstrapAdmin({ ...base, email: unverified.email, verifyEmail: 'yes' }), /--verify-email/); // only a real boolean true counts
  const disabled = await newAccount({ emailVerified: false, disabled: true });
  await refused(bootstrapAdmin({ ...base, email: disabled.email, verifyEmail: true }), /disabled/);
  const student = await newAccount({ emailVerified: false });
  await db.doc(`users/${student.uid}`).create({ role: 'student', status: 'active' });
  await refused(bootstrapAdmin({ ...base, email: student.email, verifyEmail: true }), /already has a profile/);
  for (const u of [unverified, disabled, student]) await stillUnverified(u);
  assert.equal((await db.collection('users').where('role', '==', 'admin').get()).size, 0);

  await bootstrapAdmin({ ...base, email: unverified.email, verifyEmail: true });
  const after = await auth.getUser(unverified.uid);
  assert.deepEqual([after.emailVerified, after.customClaims.role], [true, 'admin']);
  const log = (await db.collection('auditLogs').where('targetId', '==', unverified.uid).get()).docs[0].get('details');
  assert.equal(log.emailVerifiedByOperator, true);

  const second = await newAccount({ emailVerified: false });
  await refused(bootstrapAdmin({ ...base, email: second.email, verifyEmail: true }), /administrator already exists/);
  await stillUnverified(second);
  await db.doc(`users/${student.uid}`).delete();
});

test('a bootstrapped admin cannot be turned into a student by the registration endpoint', async () => {
  await clearAdmins();
  const user = await newAccount();
  await boot(user);
  await assert.rejects(
    createStudentProfile({ auth, db, uid: user.uid, email: user.email, body: { fullName: 'Library Admin', studentNumber: '2023-222222' } }),
    { status: 409 },
  );
  assert.equal((await db.doc(`users/${user.uid}`).get()).get('role'), 'admin');
});

test('the HTTP API exposes no way to provision administrators', async () => {
  const app = createApp({ config: { corsOrigins: [] }, auth, db });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/admin/bootstrap', '/api/admins', '/api/students/admin', '/api/students/role']) {
      for (const method of ['POST', 'PUT', 'GET']) {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{"role":"admin"}' });
        // 401 for anonymous callers (the admin area demands a token first); never a success.
        assert.ok([401, 404].includes(res.status), `${method} ${path} -> ${res.status}`);
      }
    }
  } finally {
    server.close();
  }
});

test('the CLI fails closed: no environment, emulator hosts in production, or missing production confirmation', () => {
  const run = (env) => spawnSync(process.execPath, ['server/scripts/bootstrap-admin.js', '--email', 'a@example.com', '--name', 'Admin'], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  const noEnv = run({});
  assert.equal(noEnv.status, 1);
  assert.match(noEnv.stderr, /NODE_ENV/);

  const prodWithEmulator = run({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(prodWithEmulator.status, 1);
  assert.match(prodWithEmulator.stderr, /emulator hosts/);

  const noConfirm = run({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation' });
  assert.equal(noConfirm.status, 1);
  assert.match(noConfirm.stderr, /--confirm-project lrc-room-reservation/);

  const realProjectInDev = run({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'lrc-room-reservation' });
  assert.equal(realProjectInDev.status, 1);
  assert.match(realProjectInDev.stderr, /demo-\*/);
});
