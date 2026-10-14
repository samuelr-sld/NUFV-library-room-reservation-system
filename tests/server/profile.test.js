import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const t = setup();
const { db, call, audits } = t;

before(() => t.start());
after(() => t.stop());

const stored = async (uid) => (await db.doc(`users/${uid}`).get()).data();

test('profile routes need a signed-in account with an active profile', async () => {
  assert.equal((await call(null, 'GET', '/api/profile')).status, 401);
  assert.equal((await call(null, 'PATCH', '/api/profile', { fullName: 'Nobody' })).status, 401);
  const none = await t.actor({ role: null });
  assert.equal((await call(none, 'GET', '/api/profile')).code, 'no-profile');
  const suspended = await t.actor({ role: 'student', status: 'suspended' });
  assert.equal((await call(suspended, 'PATCH', '/api/profile', { fullName: 'Still Me' })).code, 'account-suspended');
  assert.equal((await stored(suspended.uid)).fullName, 'Test Person');
});

test('students and administrators read their own profile, with sign-in facts from Firebase Auth', async () => {
  const s = await t.actor({ role: 'student', emailVerified: true });
  const a = await t.actor({ role: 'admin' });
  const sp = (await call(s, 'GET', '/api/profile')).body.profile;
  assert.deepEqual(sp, { fullName: 'Test Person', email: s.email, role: 'student', status: 'active', studentNumber: '2023-000000', address: '', program: '', emailVerified: true, passwordReset: true });
  const ap = (await call(a, 'GET', '/api/profile')).body.profile;
  assert.deepEqual({ role: ap.role, studentNumber: ap.studentNumber, emailVerified: ap.emailVerified }, { role: 'admin', studentNumber: null, emailVerified: false });
});

test('a user can change only their own display name, and the change is audited', async () => {
  const me = await t.actor({ role: 'student' });
  const other = await t.actor({ role: 'student' });
  const res = await call(me, 'PATCH', '/api/profile', { fullName: '  Maria Santos  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.fullName, 'Maria Santos');
  assert.equal((await stored(me.uid)).fullName, 'Maria Santos');
  assert.equal((await stored(other.uid)).fullName, 'Test Person', 'no route reaches another account');

  const [log] = await audits(me.uid, 'profile.update');
  assert.equal(log.actorUid, me.uid);
  assert.deepEqual(log.details.changes, { fullName: { from: 'Test Person', to: 'Maria Santos' } });

  assert.equal((await call(me, 'PATCH', '/api/profile', { fullName: 'Maria Santos' })).status, 200);
  assert.equal((await audits(me.uid, 'profile.update')).length, 1, 'an unchanged name writes nothing');
});

test('email, student number, role, status and any other field cannot be changed, and nothing is written', async () => {
  const me = await t.actor({ role: 'student' });
  const before = await stored(me.uid);
  for (const body of [
    { role: 'admin' }, { email: 'x@example.com' }, { studentNumber: '2099-1' }, { status: 'suspended' }, { emailVerified: true },
    { uid: 'someone-else' }, { fullName: 'Ok Name', role: 'admin' }, { address: 'x', role: 'admin' }, {}, [], 'text',
  ]) {
    assert.equal((await call(me, 'PATCH', '/api/profile', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await stored(me.uid), before);
  assert.equal((await audits(me.uid, 'profile.update')).length, 0);
});

test('address and course are editable, stored on the user document, and audited', async () => {
  const me = await t.actor({ role: 'student' });
  const res = await call(me, 'PATCH', '/api/profile', { address: '  12 Mabini St, Quezon City ', program: 'BS Computer Science' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.profile.address, res.body.profile.program, res.body.profile.fullName], ['12 Mabini St, Quezon City', 'BS Computer Science', 'Test Person']);
  assert.deepEqual([(await stored(me.uid)).address, (await stored(me.uid)).program], ['12 Mabini St, Quezon City', 'BS Computer Science']);
  const [log] = await audits(me.uid, 'profile.update');
  assert.deepEqual(Object.keys(log.details.changes).sort(), ['address', 'program']);
  assert.equal((await call(me, 'PATCH', '/api/profile', { address: '' })).status, 200, 'address may be cleared');
  for (const bad of [{ address: 'x'.repeat(201) }, { program: 'x'.repeat(101) }, { address: 'a\nb' }, { program: 5 }, { fullName: 'A' }]) {
    assert.equal((await call(me, 'PATCH', '/api/profile', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await stored(me.uid)).program, 'BS Computer Science');
});

test('invalid names are rejected', async () => {
  const me = await t.actor({ role: 'admin' });
  for (const fullName of ['', ' ', 'A', 'x'.repeat(101), 'Bad\u0000Name', 'Line\nBreak', 42, null]) {
    assert.equal((await call(me, 'PATCH', '/api/profile', { fullName })).status, 400, String(fullName));
  }
  assert.equal((await stored(me.uid)).fullName, 'Test Person');
  assert.equal((await call(me, 'PATCH', '/api/profile', { fullName: 'Ad Ministrator' })).status, 200);
  assert.equal((await stored(me.uid)).role, 'admin', 'renaming never touches the role');
});
