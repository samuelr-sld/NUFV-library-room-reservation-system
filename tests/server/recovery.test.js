import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../server/config.js';
import { initFirebase } from '../../server/firebase.js';
import { createApp } from '../../server/app.js';
import { BootstrapError, bootstrapAdmin } from '../../server/bootstrap.js';
import { recoverAdmin } from '../../server/recovery.js';
import { createStudentProfile } from '../../server/routes/students.js';

// Private demo project: recovery looks at every administrator, so it must not see other test files' data.
const config = loadConfig({ ...process.env, NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'demo-recovery', GCLOUD_PROJECT: 'demo-recovery' }, { forServer: false });
const { auth, db } = initFirebase(config);
const REASON = 'lost access to the administrator mailbox';

const account = (opts = {}) => auth.createUser({ email: `${randomUUID()}@example.com`, password: 'secret123', ...opts });
async function admin(status = 'active', opts = {}) {
  const user = await account(opts);
  await db.doc(`users/${user.uid}`).set({ email: user.email, fullName: 'Old Admin', studentNumber: null, role: 'admin', status });
  await auth.setCustomUserClaims(user.uid, { role: 'admin' });
  return user;
}
const clearAdmins = async () => {
  for (const d of (await db.collection('users').where('role', '==', 'admin').get()).docs) await d.ref.delete();
};
const recover = (oldUser, newUser, extra = {}) => recoverAdmin({ auth, db, config, oldEmail: oldUser.email, newEmail: newUser.email, reason: REASON, ...extra });
const refused = (p, re) => assert.rejects(p, (e) => e instanceof BootstrapError && re.test(e.message));
const profile = async (uid) => (await db.doc(`users/${uid}`).get()).data();
const adminCount = async () => (await db.collection('users').where('role', '==', 'admin').where('status', '==', 'active').get()).size;

before(clearAdmins);

test('replaces a lost sole administrator: new admin active, old one suspended, disabled, signed out and audited', async () => {
  await clearAdmins();
  const lost = await admin();
  const spare = await account();
  const result = await recover(lost, spare, { operator: 'ops-tester' });
  assert.equal(result.newAdmin.uid, spare.uid);

  const fresh = await profile(spare.uid);
  assert.equal(fresh.role, 'admin');
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.studentNumber, null);
  assert.equal((await profile(lost.uid)).status, 'suspended');
  assert.equal((await profile(lost.uid)).role, 'admin'); // still only two roles; the status is what locks it out
  assert.equal((await auth.getUser(lost.uid)).disabled, true);
  assert.equal((await auth.getUser(lost.uid)).customClaims?.role, undefined);
  assert.deepEqual((await auth.getUser(spare.uid)).customClaims, { role: 'admin' });
  assert.equal(await adminCount(), 1);

  const logs = (await db.collection('auditLogs').where('targetId', '==', spare.uid).get()).docs.map((d) => d.data());
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'admin.recovery');
  assert.deepEqual({ ...logs[0].details }, { lostAdminUid: lost.uid, reason: REASON, operator: 'ops-tester', project: 'demo-recovery' });
});

test('it never creates an account: an unknown replacement or lost-admin email is refused', async () => {
  await clearAdmins();
  const lost = await admin();
  const ghost = `${randomUUID()}@example.com`;
  await refused(recoverAdmin({ auth, db, config, oldEmail: lost.email, newEmail: ghost, reason: REASON }), /No Firebase Auth account/);
  await assert.rejects(auth.getUserByEmail(ghost), { code: 'auth/user-not-found' });
  await refused(recoverAdmin({ auth, db, config, oldEmail: ghost, newEmail: (await account()).email, reason: REASON }), /No Firebase Auth account/);
  assert.equal((await profile(lost.uid)).status, 'active');
});

test('it never promotes a student: a replacement with any profile is refused and nothing changes', async () => {
  await clearAdmins();
  const lost = await admin();
  const student = await account();
  await createStudentProfile({ auth, db, uid: student.uid, email: student.email, body: { fullName: 'Plain Student', studentNumber: '2023-333333' } });
  await refused(recover(lost, student), /will not be promoted/);
  assert.equal((await profile(student.uid)).role, 'student');
  assert.equal((await profile(lost.uid)).status, 'active');
  assert.equal((await auth.getUser(lost.uid)).disabled, false);
});

test('inputs are validated: reason, distinct emails, enabled replacement, and the lost account must be an administrator', async () => {
  await clearAdmins();
  const lost = await admin();
  const spare = await account();
  await refused(recover(lost, spare, { reason: 'short' }), /--reason/);
  await refused(recover(lost, spare, { reason: undefined }), /--reason/);
  await refused(recover(lost, lost), /two different emails/);
  await refused(recover(lost, { email: lost.email.toUpperCase() }), /two different emails/);
  await refused(recover(lost, await account({ disabled: true })), /disabled/);
  const notAdmin = await account();
  await db.doc(`users/${notAdmin.uid}`).set({ role: 'student', status: 'active', studentNumber: '2023-444444' });
  await refused(recover(notAdmin, spare), /not an administrator/);
  assert.equal((await profile(lost.uid)).status, 'active');
  assert.equal((await db.doc(`users/${spare.uid}`).get()).exists, false);
});

test('it is only for a sole administrator: another working administrator blocks it; unusable ones do not', async () => {
  await clearAdmins();
  const lost = await admin();
  const other = await admin();
  const spare = await account();
  await refused(recover(lost, spare), /Another active administrator exists/);
  assert.equal((await profile(lost.uid)).status, 'active');
  assert.equal((await db.doc(`users/${spare.uid}`).get()).exists, false);

  await auth.updateUser(other.uid, { disabled: true }); // cannot sign in, so it is not "another active administrator"
  await recover(lost, spare);
  assert.equal((await profile(spare.uid)).role, 'admin');
  assert.equal((await profile(lost.uid)).status, 'suspended');
});

test('suspended or deleted other administrators do not block recovery', async () => {
  await clearAdmins();
  const lost = await admin();
  await admin('suspended');
  const deleted = await admin();
  await auth.deleteUser(deleted.uid);
  const spare = await account();
  await recover(lost, spare);
  assert.equal((await profile(spare.uid)).status, 'active');
});

test('production needs the typed project, a reason, a verified replacement email and working operator credentials', async () => {
  await clearAdmins();
  const lost = await admin();
  const verified = await account({ emailVerified: true });
  const unverified = await account({ emailVerified: false });
  const prod = { production: true, cloud: true, projectId: 'lrc-room-reservation' };
  const go = (extra) => recoverAdmin({ auth, db, config: prod, oldEmail: lost.email, newEmail: verified.email, reason: REASON, ...extra });

  await refused(go({}), /--confirm-project/);
  await refused(go({ confirmProject: 'another-project' }), /--confirm-project/);
  await refused(go({ confirmProject: 'lrc-room-reservation', newEmail: unverified.email }), /not verified/);

  const broken = Object.create(auth, { listUsers: { value: async () => { throw new Error('invalid_grant'); } } });
  await refused(go({ auth: broken, confirmProject: 'lrc-room-reservation' }), /credentials could not be verified/);
  assert.equal((await profile(lost.uid)).status, 'active');
  assert.equal(await adminCount(), 1);

  await go({ confirmProject: 'lrc-room-reservation' });
  assert.equal((await profile(verified.uid)).role, 'admin');
});

test('afterwards bootstrap stays closed, and the lost administrator cannot be silently reinstated by it', async () => {
  await clearAdmins();
  const lost = await admin();
  await recover(lost, await account());
  await assert.rejects(
    bootstrapAdmin({ auth, db, config, email: (await account()).email, fullName: 'Another' }),
    (e) => e instanceof BootstrapError && /already exists/.test(e.message),
  );
});

test('there is no HTTP route for recovery', async () => {
  const server = createApp({ config: { corsOrigins: [] }, auth, db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/admin/recover', '/api/admin/recovery', '/api/recover-admin', '/api/students/recover']) {
      for (const method of ['POST', 'GET']) {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.ok([401, 404].includes(res.status), `${method} ${path} -> ${res.status}`);
      }
    }
  } finally {
    server.close();
  }
});

test('the CLI fails closed without an environment, with emulators in production, or without production confirmation', () => {
  const run = (env) => spawnSync(process.execPath, ['server/scripts/recover-admin.js', '--old-admin', 'a@example.com', '--new-admin', 'b@example.com', '--reason', REASON], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  const none = run({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /NODE_ENV/);
  const emulatorInProd = run({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.match(emulatorInProd.stderr, /emulator hosts/);
  const noConfirm = run({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation' });
  assert.equal(noConfirm.status, 1);
  assert.match(noConfirm.stderr, /--confirm-project lrc-room-reservation/);
  assert.equal(run({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'lrc-room-reservation' }).status, 1);
});
