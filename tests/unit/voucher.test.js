import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, generateVoucherPassword } from '../../server/voucher.js';
import { dueReason, TICKET_ID, TRANSITIONS, ACTIVE } from '../../server/tickets.js';
import { loadConfig } from '../../server/config.js';

test('demo passwords are labelled, use the unambiguous alphabet, and do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generateVoucherPassword();
    assert.match(p, /^DEMO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});

test('encryption round-trips, uses a fresh IV each time, and hides the plaintext', () => {
  const key = randomBytes(32);
  const a = encryptSecret(key, 'DEMO-AAAA-BBBB-CCCC', 'WF-1');
  const b = encryptSecret(key, 'DEMO-AAAA-BBBB-CCCC', 'WF-1');
  assert.equal(decryptSecret(key, a, 'WF-1'), 'DEMO-AAAA-BBBB-CCCC');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.ok(!JSON.stringify(a).includes('AAAA'));
});

test('decryption fails closed for a wrong key, another ticket, or tampered data', () => {
  const key = randomBytes(32);
  const box = encryptSecret(key, 'DEMO-AAAA-BBBB-CCCC', 'WF-1');
  assert.equal(decryptSecret(randomBytes(32), box, 'WF-1'), null);
  assert.equal(decryptSecret(key, box, 'WF-2'), null);
  const flipped = Buffer.from(box.ct, 'base64');
  flipped[0] ^= 1;
  assert.equal(decryptSecret(key, { ...box, ct: flipped.toString('base64') }, 'WF-1'), null);
  assert.equal(decryptSecret(key, { ...box, tag: Buffer.alloc(16).toString('base64') }, 'WF-1'), null);
  assert.equal(decryptSecret(key, { v: 1 }, 'WF-1'), null);
});

test('ticket ids have a service prefix and an unambiguous 10 character body', () => {
  for (const ok of ['SR-0123456789', 'CS-ABCDEFGHJK', 'WF-MNPQRSTVWX']) assert.match(ok, TICKET_ID);
  for (const bad of ['XX-0123456789', 'SR-012345678', 'SR-0123456789A', 'sr-0123456789', 'SR-ILOU012345', '../users/x', '']) assert.doesNotMatch(bad, TICKET_ID, bad);
});

const T = (ms) => ({ toMillis: () => ms });
test('dueReason: no-show after the check-in deadline, expired after the end time, nothing before', () => {
  const t = { status: 'issued', checkInDeadline: T(1000), expiresAt: T(5000) };
  assert.equal(dueReason(t, new Date(999)), null);
  assert.equal(dueReason(t, new Date(1000)), 'no_show');
  assert.equal(dueReason({ ...t, status: 'checked_in' }, new Date(4999)), null);
  assert.equal(dueReason({ ...t, status: 'checked_in' }, new Date(5000)), 'expired');
  assert.equal(dueReason({ ...t, checkInDeadline: null }, new Date(4999)), null);
  assert.equal(dueReason({ ...t, checkInDeadline: null }, new Date(5000)), 'expired');
});

test('terminal states have no outgoing transitions and only issued or checked_in are active', () => {
  for (const s of ['checked_out', 'expired', 'revoked']) assert.deepEqual(TRANSITIONS[s], []);
  assert.deepEqual(ACTIVE, ['issued', 'checked_in']);
});

test('the voucher key: required in production, validated everywhere, ephemeral only outside production', () => {
  const dev = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  const prod = {
    NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation', CORS_ORIGINS: 'https://lrc-room-reservation.web.app',
    APPROVAL_SECRET: randomBytes(32).toString('base64'), APP_BASE_URL: 'https://lrc-room-reservation.web.app',
    MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'f@example.edu', MAIL_LIVE_APPROVED: 'yes',
  };
  const key = randomBytes(32).toString('base64');

  assert.equal(loadConfig(dev).voucherKey.length, 32);
  assert.notDeepEqual(loadConfig(dev).voucherKey, loadConfig(dev).voucherKey, 'ephemeral keys are random per start');
  assert.deepEqual(loadConfig({ ...dev, VOUCHER_ENCRYPTION_KEY: key }).voucherKey, Buffer.from(key, 'base64'));
  assert.throws(() => loadConfig(prod), /VOUCHER_ENCRYPTION_KEY is required/);
  assert.equal(loadConfig({ ...prod, VOUCHER_ENCRYPTION_KEY: key }).voucherKey.length, 32);
  for (const bad of ['short', randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'x'.repeat(44)]) {
    assert.throws(() => loadConfig({ ...prod, VOUCHER_ENCRYPTION_KEY: bad }), /32 random bytes/, bad);
  }
});
