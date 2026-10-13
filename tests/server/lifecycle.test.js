import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../server/config.js';
import { initFirebase } from '../../server/firebase.js';
import { releaseOrphanedLocks } from '../../server/lifecycle.js';
import { createStudentProfile } from '../../server/routes/students.js';

// Private demo project: the sweep looks at every lock, so it must not see other test files' data.
const config = loadConfig({ ...process.env, NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'demo-lifecycle', GCLOUD_PROJECT: 'demo-lifecycle' }, { forServer: false });
const { auth, db } = initFirebase(config);

const newNumber = () => `2023-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
async function registered() {
  const user = await auth.createUser({ email: `${randomUUID()}@example.com`, password: 'secret123' });
  const studentNumber = newNumber();
  await createStudentProfile({ auth, db, uid: user.uid, email: user.email, body: { fullName: 'Juan Dela Cruz', studentNumber } });
  return { user, studentNumber };
}
const lockExists = async (n) => (await db.doc(`studentNumbers/${n}`).get()).exists;

before(async () => {
  for (const d of (await db.collection('studentNumbers').get()).docs) await d.ref.delete();
});

test('a lock whose Auth account was deleted is reported on a dry run but left untouched', async () => {
  const { user, studentNumber } = await registered();
  await auth.deleteUser(user.uid);
  const report = await releaseOrphanedLocks({ auth, db });
  assert.ok(report.orphaned.some((o) => o.studentNumber === studentNumber && o.uid === user.uid));
  assert.deepEqual(report.released, []);
  assert.equal(await lockExists(studentNumber), true);
  assert.equal((await db.doc(`users/${user.uid}`).get()).get('status'), 'active');
});

test('applying releases the lock, keeps the profile as orphaned, audits, and lets the number be registered again', async () => {
  const { user, studentNumber } = await registered();
  await auth.deleteUser(user.uid);
  const report = await releaseOrphanedLocks({ auth, db, apply: true, operator: 'tester' });
  assert.ok(report.released.some((o) => o.studentNumber === studentNumber));
  assert.equal(await lockExists(studentNumber), false);

  const profile = (await db.doc(`users/${user.uid}`).get()).data();
  assert.equal(profile.status, 'orphaned');
  assert.equal(profile.studentNumber, studentNumber); // history kept
  const logs = await db.collection('auditLogs').where('action', '==', 'studentNumber.release').where('targetId', '==', user.uid).get();
  assert.equal(logs.size, 1);
  assert.deepEqual({ ...logs.docs[0].get('details') }, { studentNumber, hadProfile: true, operator: 'tester' });
  assert.equal((await db.collection('auditLogs').where('targetId', '==', user.uid).get()).size, 2); // original profile.create kept

  const next = await auth.createUser({ email: `${randomUUID()}@example.com`, password: 'secret123' });
  const again = await createStudentProfile({ auth, db, uid: next.uid, email: next.email, body: { fullName: 'New Owner', studentNumber } });
  assert.equal(again.created, true);
});

test('locks of existing accounts are never released, including disabled and suspended ones', async () => {
  const live = await registered();
  const disabled = await registered();
  await auth.updateUser(disabled.user.uid, { disabled: true });
  const suspended = await registered();
  await db.doc(`users/${suspended.user.uid}`).update({ status: 'suspended' });

  const report = await releaseOrphanedLocks({ auth, db, apply: true });
  for (const { studentNumber } of [live, disabled, suspended]) {
    assert.equal(await lockExists(studentNumber), true, studentNumber);
    assert.ok(!report.released.some((r) => r.studentNumber === studentNumber));
  }
  assert.equal((await db.doc(`users/${live.user.uid}`).get()).get('status'), 'active');
});

test('ambiguous or temporary Auth errors keep the lock', async () => {
  const { user, studentNumber } = await registered();
  await auth.deleteUser(user.uid);
  for (const code of ['auth/internal-error', 'auth/network-request-failed', 'app/network-error', undefined]) {
    const flaky = { getUser: async () => { throw Object.assign(new Error('boom'), { code }); } };
    const report = await releaseOrphanedLocks({ auth: flaky, db, apply: true });
    assert.deepEqual(report.released, [], String(code));
    assert.ok(report.skipped.some((s) => s.studentNumber === studentNumber), String(code));
    assert.equal(await lockExists(studentNumber), true);
  }
});

test('an orphaned lock whose profile points at a different number is skipped, not released', async () => {
  const { user, studentNumber } = await registered();
  await auth.deleteUser(user.uid);
  await db.doc(`users/${user.uid}`).update({ studentNumber: newNumber() });
  const report = await releaseOrphanedLocks({ auth, db, apply: true });
  assert.ok(report.skipped.some((s) => s.studentNumber === studentNumber && s.reason === 'inconsistent-profile'));
  assert.equal(await lockExists(studentNumber), true);
});

test('malformed locks are skipped and an orphaned lock without a profile is still released', async () => {
  await db.doc('studentNumbers/2023-999999').set({ nope: true });
  const ghostUid = `ghost-${randomUUID()}`;
  await db.doc('studentNumbers/2023-888888').set({ uid: ghostUid });
  const report = await releaseOrphanedLocks({ auth, db, apply: true });
  assert.ok(report.skipped.some((s) => s.studentNumber === '2023-999999' && s.reason === 'malformed-lock'));
  assert.ok(report.released.some((r) => r.studentNumber === '2023-888888'));
  assert.equal(await lockExists('2023-999999'), true);
  assert.equal(await lockExists('2023-888888'), false);
});
