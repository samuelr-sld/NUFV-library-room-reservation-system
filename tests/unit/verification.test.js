import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestVerificationEmail, refreshVerification, VERIFY_MESSAGES } from '../../public/js/verification.js';
import { createSession, HOME } from '../../public/js/session.js';

const failing = (code) => async () => { throw Object.assign(new Error('internal detail'), { code }); };

test('sending the verification email reports success', async () => {
  assert.equal(await requestVerificationEmail(async () => {}), 'sent');
});

test('quota and rate-limit errors are reported gracefully, as are network and unexpected failures', async () => {
  assert.equal(await requestVerificationEmail(failing('auth/too-many-requests')), 'rate-limited');
  assert.equal(await requestVerificationEmail(failing('auth/quota-exceeded')), 'rate-limited');
  assert.equal(await requestVerificationEmail(failing('auth/network-request-failed')), 'network');
  assert.equal(await requestVerificationEmail(failing('auth/internal-error')), 'error');
  assert.equal(await requestVerificationEmail(failing(undefined)), 'error');
  for (const m of Object.values(VERIFY_MESSAGES)) assert.doesNotMatch(m, /internal detail|auth\//);
});

test('refresh: still unverified after reload means pending, and the token is not refreshed', async () => {
  const calls = [];
  const outcome = await refreshVerification({ reload: async () => calls.push('reload'), refreshToken: async () => calls.push('token'), isVerified: () => false });
  assert.equal(outcome, 'pending');
  assert.deepEqual(calls, ['reload']);
});

test('refresh: once verified, the ID token is force-refreshed so the server sees email_verified', async () => {
  const calls = [];
  const outcome = await refreshVerification({ reload: async () => calls.push('reload'), refreshToken: async () => calls.push('token'), isVerified: () => true });
  assert.equal(outcome, 'verified');
  assert.deepEqual(calls, ['reload', 'token']);
});

test('refresh failures are mapped, not thrown', async () => {
  assert.equal(await refreshVerification({ reload: failing('auth/network-request-failed'), refreshToken: async () => {}, isVerified: () => true }), 'network');
  assert.equal(await refreshVerification({ reload: async () => {}, refreshToken: failing('auth/internal-error'), isVerified: () => true }), 'error');
});

// ---- session routing for unverified students

function session({ user, profile, reloadVerifies = false, reloadFails = false }) {
  const state = { user: { uid: 'u1', ...user }, reloads: 0 };
  return {
    state,
    s: createSession({
      getUser: async () => state.user,
      signInWithPassword: async () => state.user,
      signOut: async () => {},
      readProfile: async () => profile,
      reloadUser: async (u) => {
        state.reloads++;
        if (reloadFails) throw new Error('offline');
        if (reloadVerifies) u.emailVerified = true;
      },
    }),
  };
}
const student = { role: 'student', status: 'active' };

test('a library page that requires verification sends an unverified student to the verification page', async () => {
  const { s, state } = session({ user: { emailVerified: false }, profile: student });
  assert.equal((await s.check('student', { requireVerified: true })).status, 'unverified');
  assert.equal(state.reloads, 1);
});

test('a verified student passes; pages without the requirement do not demand verification at all', async () => {
  assert.equal((await session({ user: { emailVerified: true }, profile: student }).s.check('student', { requireVerified: true })).status, 'allow');
  const { s, state } = session({ user: { emailVerified: false }, profile: student });
  assert.equal((await s.check('student')).status, 'allow');
  assert.equal(state.reloads, 0);
});

test('a stale flag is refreshed once: verifying on another device lets the student straight in', async () => {
  const { s } = session({ user: { emailVerified: false }, profile: student, reloadVerifies: true });
  assert.equal((await s.check('student', { requireVerified: true })).status, 'allow');
});

test('if the refresh itself fails the student stays unverified (fail closed)', async () => {
  const { s } = session({ user: { emailVerified: false }, profile: student, reloadFails: true });
  assert.equal((await s.check('student', { requireVerified: true })).status, 'unverified');
});

test('administrators are never routed to email verification', async () => {
  const { s } = session({ user: { emailVerified: false }, profile: { role: 'admin', status: 'active' } });
  assert.equal((await s.check('admin', { requireVerified: true })).status, 'allow');
});

test('role checks still come first: an admin on a student page is redirected, a suspended student is signed out', async () => {
  const admin = session({ user: { emailVerified: false }, profile: { role: 'admin', status: 'active' } });
  assert.deepEqual(await admin.s.check('student', { requireVerified: true }), { status: 'redirect', to: HOME.admin });
  const suspended = session({ user: { emailVerified: false }, profile: { role: 'student', status: 'suspended' } });
  assert.deepEqual(await suspended.s.check('student', { requireVerified: true }), { status: 'login', reason: 'suspended' });
});
