import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, accessDecision, LoginError, MESSAGES, HOME } from '../../public/js/session.js';

const active = (role = 'student') => ({ role, status: 'active', fullName: 'Juan' });

// Fake Firebase: a user store keyed by email, a profile store keyed by uid, and a record of sign-outs.
function fake({ users = {}, profiles = {}, signedIn = null, readFails = false } = {}) {
  const state = { current: signedIn, signOuts: 0 };
  const session = createSession({
    getUser: async () => state.current,
    signInWithPassword: async (email, password) => {
      const u = users[email];
      if (u === 'network') throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' });
      if (u === 'disabled') throw Object.assign(new Error('x'), { code: 'auth/user-disabled' });
      if (u === 'throttled') throw Object.assign(new Error('x'), { code: 'auth/too-many-requests' });
      if (!u || u.password !== password) throw Object.assign(new Error('secret detail'), { code: 'auth/invalid-credential' });
      return (state.current = { uid: u.uid });
    },
    signOut: async () => { state.signOuts++; state.current = null; },
    readProfile: async (uid) => {
      if (readFails) throw new Error('offline');
      return profiles[uid] ?? null;
    },
  });
  return { session, state };
}
const juan = { 'juan@example.com': { uid: 'u1', password: 'secret123' } };

test('login succeeds for an active student and returns the student home', async () => {
  const { session, state } = fake({ users: juan, profiles: { u1: active() } });
  const result = await session.login('juan@example.com', 'secret123');
  assert.deepEqual(result, { role: 'student', to: HOME.student });
  assert.equal(state.signOuts, 0);
  assert.match(HOME.student, /nav\/main\/main\.html$/);
});

test('an admin is sent to the admin home, never the student one', async () => {
  const { session } = fake({ users: juan, profiles: { u1: active('admin') } });
  assert.equal((await session.login('juan@example.com', 'secret123')).to, HOME.admin);
  assert.match(HOME.admin, /nav\/admin\/admin\.html$/);
});

test('wrong password and unknown email give the same message', async () => {
  const { session } = fake({ users: juan, profiles: { u1: active() } });
  const wrongPassword = await session.login('juan@example.com', 'nope').catch((e) => e);
  const unknownEmail = await session.login('ghost@example.com', 'secret123').catch((e) => e);
  assert.ok(wrongPassword instanceof LoginError);
  assert.equal(wrongPassword.message, unknownEmail.message);
  assert.equal(wrongPassword.message, MESSAGES['bad-credentials']);
  assert.doesNotMatch(wrongPassword.message, /secret detail/);
});

test('network, throttling and disabled accounts get their own messages', async () => {
  const { session } = fake({ users: { 'a@x.com': 'network', 'b@x.com': 'throttled', 'c@x.com': 'disabled' } });
  assert.equal((await session.login('a@x.com', 'p').catch((e) => e)).reason, 'network');
  assert.equal((await session.login('b@x.com', 'p').catch((e) => e)).reason, 'rate-limited');
  assert.equal((await session.login('c@x.com', 'p').catch((e) => e)).reason, 'suspended');
});

test('a valid sign-in without a Firestore profile is rejected and signed out', async () => {
  const { session, state } = fake({ users: juan, profiles: {} });
  const err = await session.login('juan@example.com', 'secret123').catch((e) => e);
  assert.equal(err.reason, 'no-profile');
  assert.equal(state.signOuts, 1);
  assert.equal(state.current, null);
});

test('suspended and orphaned profiles are rejected and signed out; a bogus role is treated as no profile', async () => {
  for (const [profile, reason] of [
    [{ role: 'student', status: 'suspended' }, 'suspended'],
    [{ role: 'student', status: 'orphaned' }, 'suspended'],
    [{ role: 'superuser', status: 'active' }, 'no-profile'],
    [{ status: 'active' }, 'no-profile'],
  ]) {
    const { session, state } = fake({ users: juan, profiles: { u1: profile } });
    assert.equal((await session.login('juan@example.com', 'secret123').catch((e) => e)).reason, reason);
    assert.equal(state.current, null);
  }
});

test('if the profile cannot be read at login the user is signed out and told to retry', async () => {
  const { session, state } = fake({ users: juan, readFails: true });
  assert.equal((await session.login('juan@example.com', 'secret123').catch((e) => e)).reason, 'unavailable');
  assert.equal(state.current, null);
});

test('logout signs out', async () => {
  const { session, state } = fake({ signedIn: { uid: 'u1' } });
  await session.logout();
  assert.equal(state.current, null);
  assert.equal(state.signOuts, 1);
});

test('session restoration: an existing valid session passes a protected page check', async () => {
  const { session } = fake({ signedIn: { uid: 'u1' }, profiles: { u1: active() } });
  const r = await session.check('student');
  assert.equal(r.status, 'allow');
  assert.equal(r.profile.fullName, 'Juan');
});

test('protected pages: no session goes to login', async () => {
  const { session } = fake();
  assert.deepEqual(await session.check('student'), { status: 'login' });
});

test('protected pages: the wrong role is redirected to its own home without signing out', async () => {
  const student = fake({ signedIn: { uid: 'u1' }, profiles: { u1: active('student') } });
  assert.deepEqual(await student.session.check('admin'), { status: 'redirect', to: HOME.student });
  const admin = fake({ signedIn: { uid: 'u1' }, profiles: { u1: active('admin') } });
  assert.deepEqual(await admin.session.check('student'), { status: 'redirect', to: HOME.admin });
  assert.equal(student.state.signOuts + admin.state.signOuts, 0);
});

test('protected pages: a suspended or profile-less session is signed out and sent to login with a reason', async () => {
  const s = fake({ signedIn: { uid: 'u1' }, profiles: { u1: { role: 'student', status: 'suspended' } } });
  assert.deepEqual(await s.session.check('student'), { status: 'login', reason: 'suspended' });
  assert.equal(s.state.signOuts, 1);
  const n = fake({ signedIn: { uid: 'u1' }, profiles: {} });
  assert.deepEqual(await n.session.check('student'), { status: 'login', reason: 'no-profile' });
});

test('protected pages: an unreachable backend keeps the session and reports unavailable (fail closed, no sign-out)', async () => {
  const { session, state } = fake({ signedIn: { uid: 'u1' }, readFails: true });
  assert.deepEqual(await session.check('student'), { status: 'unavailable' });
  assert.equal(state.signOuts, 0);
  assert.deepEqual(state.current, { uid: 'u1' });
});

test('accessDecision without a required role accepts either role', () => {
  assert.equal(accessDecision(active('student')).ok, true);
  assert.equal(accessDecision(active('admin')).ok, true);
  assert.equal(accessDecision(null).ok, false);
});

test('every page the session can redirect to exists', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { LOGIN_URL } = await import('../../public/js/session.js');
  for (const url of [LOGIN_URL, HOME.student, HOME.admin]) assert.ok(existsSync(fileURLToPath(url)), url);
});

// ---------------------------------------------------------------- where a sign-in may return to

import { readFileSync, existsSync } from 'node:fs';
import { safeNext, RETURN_PAGES } from '../../public/js/session.js';

const SITE = 'https://library.example.edu';

test('a known page for the person\'s own role is returned to, as an absolute URL on this site', () => {
  assert.equal(safeNext('/nav/stubs/stubs.html', 'student', SITE), `${SITE}/nav/stubs/stubs.html`);
  assert.equal(safeNext('/nav/reservations/reservations.html', 'student', SITE), `${SITE}/nav/reservations/reservations.html`);
  assert.equal(safeNext('/nav/admin/admin.html#ops', 'admin', SITE), `${SITE}/nav/admin/admin.html#ops`);
  assert.equal(safeNext(`${SITE}/nav/reserve/reserve.html`, 'student', SITE), `${SITE}/nav/reserve/reserve.html`, 'the same site, written out in full');
});

test('everything else is ignored: other roles\' pages, other sites, odd encodings, queries, pages that are not destinations', () => {
  const unsafe = [
    ['/nav/admin/admin.html', 'student'], ['/nav/stubs/stubs.html', 'admin'], ['/nav/main/main.html', 'admin'],
    ['https://evil.example/', 'student'], ['//evil.example/nav/stubs/stubs.html', 'student'], ['\\evil.example', 'student'], ['/\evil.example', 'student'],
    ['javascript:alert(1)', 'student'], ['data:text/html,hi', 'student'], ['http://library.example.edu@evil.example/nav/stubs/stubs.html', 'student'],
    ['https://library.example.edu.evil.example/nav/stubs/stubs.html', 'student'], ['http://library.example.edu/nav/stubs/stubs.html', 'student'], // other scheme = other origin
    ['/nav/stubs/stubs.html/../../../etc/passwd', 'student'], ['/nav/stubs/stubs.html%00', 'student'], ['/nav/stubs/stubs.html\u0000', 'student'], ['/nav/stubs/stubs.html\n', 'student'],
    ['/NAV/STUBS/STUBS.HTML', 'student'], ['/nav/stubs/stubs.html/', 'student'], ['/nav//stubs/stubs.html', 'student'], ['/nav/stubs/stubs.html?x=1', 'student'], ['/nav/stubs/stubs.html?next=//evil.example', 'student'],
    ['/nav/stubs/stubs.html#anything', 'student'], ['/nav/admin/admin.html#../../x', 'admin'], ['/nav/admin/admin.html#' + 'a'.repeat(30), 'admin'], ['/nav/admin/admin.html#Ops', 'admin'],
    ['/login%20page/login.html', 'student'], ['/nav/verify/verify.html', 'student'], ['/server/index.js', 'student'], ['/', 'student'], ['', 'student'], ['%2f%2fevil.example', 'student'],
    ['/nav/stubs/stubs.html', 'nobody'], ['/nav/stubs/stubs.html', undefined], ['x'.repeat(300), 'student'],
    [null, 'student'], [undefined, 'student'], [42, 'student'], [['/nav/stubs/stubs.html'], 'student'], [{ toString: () => '/nav/stubs/stubs.html' }, 'student'],
  ];
  for (const [raw, role] of unsafe) assert.equal(safeNext(raw, role, SITE), null, `${JSON.stringify(raw)} as ${role}`);
});

test('every return page exists, belongs to the role its own page declares, and the guard knows how to ask for it', () => {
  for (const [role, pages] of Object.entries(RETURN_PAGES)) {
    for (const path of pages) {
      assert.ok(existsSync(`public${path}`), path);
      assert.match(readFileSync(`public${path}`, 'utf8'), new RegExp(`<html[^>]*data-role="${role}"`), `${path} is a ${role} page`);
    }
  }
  const guard = readFileSync('public/js/guard.js', 'utf8');
  assert.match(guard, /safeNext\(location\.pathname \+ location\.hash, role\)/, 'the guard only remembers pages the login page would honor');
  assert.match(guard, /leaving = true;[\s\S]*session\.logout\(\)/, 'an explicit log out is marked before the sign-out event fires');
  assert.match(guard, /if \(!leaving\) location\.replace\(loginWithReturn\(\)\)/);
  assert.match(guard, /event\.persisted\) location\.reload\(\)/, 'a page restored from the back/forward cache is checked again');
  assert.match(readFileSync('public/login page/login.js', 'utf8'), /window\.location\.replace\(safeNext\(next, role\) \?\? HOME\[role\]\)/, 'one exit, replace() so the login page leaves the history');
});

test('the sign-in, registration and reset buttons start disabled in the HTML and are enabled by their script, so an early submit cannot reload the page', () => {
  for (const [html, js] of [['login page/login.html', 'login page/login.js'], ['register page/register.html', 'register page/register.js'], ['forgot_pass/forgot.html', 'forgot_pass/forgot.js']]) {
    assert.match(readFileSync(`public/${html}`, 'utf8'), /<button type="submit" class="[a-z-]+" disabled>/, html);
    assert.match(readFileSync(`public/${js}`, 'utf8'), /submitButton\.disabled = false;/, js);
  }
});
