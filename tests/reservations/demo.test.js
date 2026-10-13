import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { DEMO_ACCOUNTS, DEMO_APPROVERS, DEMO_PASSWORD, DEMO_RESOURCES, assertDemoEnvironment, seedDemo } from '../../server/demo.js';

// The demonstration seed: safe to repeat, complete enough to walk the whole system, and incapable of touching anything real.
const h = harness();
const { db, auth, config } = h;

before(async () => { await h.start(); });
after(async () => {
  for (const a of DEMO_ACCOUNTS) {
    const user = await auth.getUserByEmail(a.email).catch(() => null);
    if (user) { await db.doc(`users/${user.uid}`).delete(); await auth.deleteUser(user.uid); }
    if (a.studentNumber) await db.doc(`studentNumbers/${a.studentNumber}`).delete();
  }
  await h.stop();
});
beforeEach(async () => { await h.reset(); });

test('the seed creates every demo account, the inventory and the approval chain, and running it again changes nothing', async () => {
  const first = await seedDemo({ auth, db, config });
  assert.deepEqual(first, { accounts: DEMO_ACCOUNTS.length, resources: DEMO_RESOURCES.length, workflow: true });
  const second = await seedDemo({ auth, db, config });
  assert.deepEqual(second, { accounts: 0, resources: 0, workflow: false });

  for (const a of DEMO_ACCOUNTS.filter((x) => x.profile !== false)) {
    const user = await auth.getUserByEmail(a.email);
    const profile = (await db.doc(`users/${user.uid}`).get()).data();
    assert.deepEqual([profile.role, profile.status, profile.fullName, profile.studentNumber], [a.role, a.status ?? 'active', a.name, a.studentNumber], a.email);
    assert.equal(user.emailVerified, a.emailVerified ?? true, a.email);
    assert.equal((await auth.getUser(user.uid)).customClaims.role, a.role);
  }
  assert.equal((await db.collection('resources').get()).size, DEMO_RESOURCES.length);
  const rooms = (await db.collection('resources').where('type', '==', 'discussion-room').get()).docs.map((d) => [d.id, d.get('capacity')]).sort();
  assert.deepEqual(rooms, [['room-a', 6], ['room-b', 4], ['room-c', 10]]);
  assert.deepEqual((await db.doc('approvalWorkflows/current').get()).get('steps'), DEMO_APPROVERS);
});

test('seeded accounts really work: the demo password signs in, the API accepts the student, and the demo administrator is an administrator', async () => {
  await seedDemo({ auth, db, config });
  const signIn = async (email) => (await (await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD, returnSecureToken: true }),
  })).json()).idToken;
  const student = await signIn('ana.reyes@demo.nufv.test');
  const admin = await signIn('admin@demo.nufv.test');
  assert.equal((await h.call(student, 'GET', '/api/reservations/rooms')).body.rooms.length, 3);
  assert.equal((await h.call(admin, 'GET', '/api/admin/summary')).status, 200);
  assert.equal((await h.call(student, 'GET', '/api/admin/summary')).status, 403);
  assert.equal((await h.call(await signIn('una.unverified@demo.nufv.test'), 'GET', '/api/reservations/rooms')).code, 'email-not-verified');
  assert.equal((await h.call(await signIn('sam.suspended@demo.nufv.test'), 'GET', '/api/reservations/rooms')).code, 'account-suspended');
  assert.equal((await h.call(await signIn('nina.noprofile@demo.nufv.test'), 'GET', '/api/reservations/rooms')).code, 'no-profile', 'an account without a profile can sign in but use nothing');
});

test('the demonstration refuses anything that is not the local emulators of a demo project', () => {
  const ok = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' };
  assert.doesNotThrow(() => assertDemoEnvironment(ok));
  for (const [change, why] of [
    [{ NODE_ENV: 'production' }, /production/], [{ NODE_ENV: 'cloud-dev' }, /cloud-dev/], [{ FIREBASE_PROJECT_ID: 'lrc-room-reservation' }, /demo-\*/], [{ FIREBASE_PROJECT_ID: undefined }, /demo-\*/],
    [{ FIRESTORE_EMULATOR_HOST: undefined }, /loopback/], [{ FIREBASE_AUTH_EMULATOR_HOST: 'firestore.googleapis.com:443' }, /loopback/], [{ FIRESTORE_EMULATOR_HOST: '10.0.0.5:8080' }, /loopback/],
    [{ GOOGLE_APPLICATION_CREDENTIALS: 'C:/keys/prod.json' }, /credentials/i],
  ]) assert.throws(() => assertDemoEnvironment({ ...ok, ...change }), why, JSON.stringify(change));
});

test('the demo email sink viewer is a page of its own that never caches, and the data it reads is the sink', async () => {
  const page = await h.call(null, 'GET', '/api/dev/mail/view');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await h.call(null, 'GET', '/api/dev/mail')).status, 200);
  // Verification and reset links from the Auth emulator are listed too, so the whole demo has one place to look.
  const user = await auth.createUser({ email: 'links-test@demo.nufv.test', password: DEMO_PASSWORD });
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: 'links-test@demo.nufv.test' }),
  });
  const { links } = (await h.call(null, 'GET', '/api/dev/mail/auth-links')).body;
  assert.ok(links.some((l) => l.email === 'links-test@demo.nufv.test' && l.type === 'PASSWORD_RESET' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(l.link)));
  await auth.deleteUser(user.uid);
});
