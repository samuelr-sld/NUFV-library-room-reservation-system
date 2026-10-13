import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const t = setup();
const { auth, db, call } = t;

before(() => t.start());
after(() => t.stop());

const access = (who, suffix = '') => call(who, 'GET', `/api/students/access${suffix}`);

test('library access needs a signed-in user', async () => {
  assert.equal((await access(null)).status, 401);
  assert.equal((await access('garbage')).status, 401);
});

test('an unverified student is refused with email-not-verified; a verified one is let in', async () => {
  const unverified = await t.actor({ role: 'student', emailVerified: false });
  const refused = await access(unverified);
  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'email-not-verified');

  const verified = await t.actor({ role: 'student', emailVerified: true });
  const ok = await access(verified);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { access: true });
});

test('the signed token is the source of truth: a stale token stays refused until the client refreshes it', async () => {
  const s = await t.actor({ role: 'student', emailVerified: false });
  const stale = await s.token();
  await auth.updateUser(s.uid, { emailVerified: true }); // e.g. the student clicked the link
  assert.equal((await access(stale)).status, 403);
  assert.equal((await access(await s.token(true))).status, 200);
});

test('client-supplied verification claims are ignored', async () => {
  const s = await t.actor({ role: 'student', emailVerified: false });
  const token = await s.token();
  for (const suffix of ['?emailVerified=true', '?email_verified=true', '?verified=1']) {
    assert.equal((await access(token, suffix)).status, 403, suffix);
  }
});

test('a verified email is not enough: the profile must exist and be active', async () => {
  const suspended = await t.actor({ role: 'student', status: 'suspended', emailVerified: true });
  const a = await access(suspended);
  assert.equal(a.status, 403);
  assert.equal(a.code, 'account-suspended');

  const noProfile = await t.actor({ role: null, emailVerified: true });
  assert.equal((await access(noProfile)).code, 'no-profile');
});

test('registration is not blocked by an unverified email', async () => {
  const s = await t.actor({ role: null, emailVerified: false });
  const res = await call(s, 'POST', '/api/students/profile', { fullName: 'Unverified Student', studentNumber: `2023-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}` });
  assert.equal(res.status, 201);
  assert.equal((await db.doc(`users/${s.uid}`).get()).get('role'), 'student');
});

test('the verification requirement is for student library services; administrators are not subject to it', async () => {
  const admin = await t.actor({ role: 'admin', emailVerified: false });
  assert.equal((await call(admin, 'GET', '/api/admin/summary')).status, 200);
});
