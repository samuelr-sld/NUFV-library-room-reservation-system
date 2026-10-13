import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPasswordReset, RESET_MESSAGES } from '../../public/js/password-reset.js';

const failing = (code) => async () => { throw Object.assign(new Error('internal detail'), { code }); };

test('a valid email is trimmed and sent', async () => {
  let sent;
  assert.equal(await requestPasswordReset(async (e) => { sent = e; }, '  juan@example.com '), 'sent');
  assert.equal(sent, 'juan@example.com');
});

test('invalid emails are rejected locally without calling Firebase', async () => {
  let called = false;
  for (const bad of ['', '   ', 'juan', 'juan@', '@example.com', 'a b@example.com', 'juan@example']) {
    assert.equal(await requestPasswordReset(async () => { called = true; }, bad), 'invalid-email', bad);
  }
  assert.equal(called, false);
});

test('an unknown account looks exactly like success (no account enumeration)', async () => {
  assert.equal(await requestPasswordReset(failing('auth/user-not-found'), 'ghost@example.com'), 'sent');
  assert.match(RESET_MESSAGES.sent, /^If an account exists/);
});

test('real failures map to friendly messages that expose no internals', async () => {
  assert.equal(await requestPasswordReset(failing('auth/invalid-email'), 'a@b.co'), 'invalid-email');
  assert.equal(await requestPasswordReset(failing('auth/too-many-requests'), 'a@b.co'), 'rate-limited');
  assert.equal(await requestPasswordReset(failing('auth/network-request-failed'), 'a@b.co'), 'network');
  assert.equal(await requestPasswordReset(failing('auth/internal-error'), 'a@b.co'), 'error');
  assert.equal(await requestPasswordReset(failing(undefined), 'a@b.co'), 'error');
  for (const m of Object.values(RESET_MESSAGES)) assert.doesNotMatch(m, /internal detail|auth\//);
});
