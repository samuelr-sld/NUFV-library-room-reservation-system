import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, outboxId, MAX_ATTEMPTS } from '../../server/mail/outbox.js';
import { createAdapter, createMailer, createSinkAdapter, createSmtpAdapter } from '../../server/mail/adapters.js';
import { sendSmtpTest } from '../../server/mail/smtpTest.js';
import { assertDemoEnvironment, scrubMailEnv } from '../../server/demo.js';
import { loadConfig } from '../../server/config.js';

const DEV = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const PROD = {
  NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation', CORS_ORIGINS: 'https://lrc-room-reservation.web.app',
  VOUCHER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), APPROVAL_SECRET: Buffer.alloc(32, 2).toString('base64'), APP_BASE_URL: 'https://lrc-room-reservation.web.app',
};
const SMTP = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.edu', SMTP_PORT: '587', SMTP_USER: 'mailer', SMTP_PASS: 'secret', MAIL_FROM: 'library@example.edu', MAIL_LIVE_APPROVED: 'yes' };

test('retry backoff grows, is capped, and the attempt limit is finite', () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffMs), [15_000, 30_000, 60_000, 120_000]);
  assert.equal(backoffMs(30), 30 * 60_000);
  assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10);
});

test('outbox ids derive from the dedupe key: the same key always lands on the same document', () => {
  assert.equal(outboxId('approver-notice:abc'), outboxId('approver-notice:abc'));
  assert.notEqual(outboxId('approver-notice:abc'), outboxId('approver-notice:abd'));
  assert.match(outboxId('x'), /^[0-9a-f]{32}$/);
});

test('the sink keeps messages in memory for inspection and caps its size', async () => {
  const sink = createSinkAdapter({ keep: 3 });
  for (let i = 0; i < 5; i++) await sink.send({ id: `m${i}`, kind: 'k', to: `u${i}@example.edu`, subject: 's', text: `body ${i}` });
  assert.deepEqual(sink.messages.map((m) => m.id), ['m2', 'm3', 'm4']);
  assert.equal(sink.name, 'sink');
});

test('SMTP errors are classified: 5xx is permanent; 4xx and network trouble are retried; credentials never leak', async () => {
  const failing = (err) => createSmtpAdapter({ host: 'h', port: 587, secure: false, user: 'u', pass: 'hunter2', from: 'f@example.edu' }, { transportFactory: () => ({ sendMail: async () => { throw err; } }) });
  const attempt = (err) => failing(err).send({ to: 'a@example.edu', subject: 's', text: 't' }).then(() => null, (e) => e);
  assert.equal((await attempt(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }))).permanent, true);
  assert.equal((await attempt(Object.assign(new Error('451 try later'), { responseCode: 451 }))).permanent, false);
  assert.equal((await attempt(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).permanent, false);
  assert.equal((await attempt(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', responseCode: 550 }))).permanent, false);
  assert.equal((await attempt(new Error('weird'))).permanent, false);
  assert.ok(!(await attempt(new Error('auth failed for hunter2'))).message.includes('\n'));

  const sent = [];
  const ok = createSmtpAdapter({ host: 'h', port: 587, secure: false, user: 'u', pass: 'p', from: 'Library <f@example.edu>' }, { transportFactory: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: '<1@x>' }; } }) });
  assert.deepEqual(await ok.send({ to: 'a@example.edu', subject: 'Hi', text: 'Body' }), { messageId: '<1@x>' });
  assert.deepEqual(sent[0], { from: 'Library <f@example.edu>', to: 'a@example.edu', subject: 'Hi', text: 'Body' });
});

test('the mailer does nothing on its own when auto-kick is off, and drains on request', async () => {
  const calls = [];
  const db = { collection: () => ({ where: () => ({ where: () => ({ limit: () => ({ get: async () => { calls.push(1); return { docs: [] }; } }) }) }) }) };
  const mailer = createMailer({ db, adapter: createSinkAdapter(), autoKick: false });
  mailer.kick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  await mailer.drain();
  assert.equal(calls.length, 2); // queued + abandoned queries
});

// ---------------------------------------------------------------- configuration: no live email unless an operator opts in

test('development defaults to the in-memory sink with no mail settings at all', () => {
  const c = loadConfig(DEV);
  assert.deepEqual(c.mail, { transport: 'sink' });
  assert.equal(c.appBaseUrl, 'http://localhost:5000');
  assert.equal(c.approvalKey.length, 32);
  assert.notDeepEqual(loadConfig(DEV).approvalKey, loadConfig(DEV).approvalKey);
});

test('production has no default transport, refuses the sink, and needs every SMTP setting plus explicit live approval', () => {
  assert.throws(() => loadConfig(PROD), /MAIL_TRANSPORT is required/);
  assert.throws(() => loadConfig({ ...PROD, MAIL_TRANSPORT: 'sink' }), /sink cannot be used in production/);
  assert.throws(() => loadConfig({ ...PROD, MAIL_TRANSPORT: 'carrier-pigeon' }), /must be "sink" or "smtp"/);
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) {
    assert.throws(() => loadConfig({ ...PROD, ...SMTP, [key]: undefined }), new RegExp(key), key);
  }
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, SMTP_PORT: 'abc' }), /SMTP_PORT/);
  for (const approved of [undefined, 'true', 'YES', '1', '']) {
    assert.throws(() => loadConfig({ ...PROD, ...SMTP, MAIL_LIVE_APPROVED: approved }), /MAIL_LIVE_APPROVED=yes/, String(approved));
  }
  const ok = loadConfig({ ...PROD, ...SMTP });
  assert.equal(ok.mail.transport, 'smtp');
  assert.equal(ok.mail.smtp.secure, false);
  assert.equal(loadConfig({ ...PROD, ...SMTP, SMTP_PORT: '465' }).mail.smtp.secure, true);
});

test('SMTP also needs the live-approval flag outside production, and the approval secret and base URL are validated', () => {
  assert.throws(() => loadConfig({ ...DEV, ...SMTP, MAIL_LIVE_APPROVED: undefined }), /MAIL_LIVE_APPROVED=yes/);
  assert.equal(loadConfig({ ...DEV, ...SMTP }).mail.transport, 'smtp');
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, APPROVAL_SECRET: undefined }), /APPROVAL_SECRET is required/);
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, APPROVAL_SECRET: 'short' }), /32 random bytes/);
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, APP_BASE_URL: undefined }), /APP_BASE_URL is required/);
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, APP_BASE_URL: 'http://lrc-room-reservation.web.app' }), /https/);
  assert.throws(() => loadConfig({ ...PROD, ...SMTP, APP_BASE_URL: 'https://x.web.app/path' }), /bare origin/);
  assert.throws(() => loadConfig({ ...DEV, APP_BASE_URL: 'not a url' }), /valid URL/);
});

// ---------------------------------------------------------------- Gmail SMTP: opt-in, test command, demo isolation (fake transport only)

const GMAIL = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'library.test@example.invalid', SMTP_PASS: 'fake-app-password-123', MAIL_FROM: 'library.test@example.invalid', MAIL_LIVE_APPROVED: 'yes' };
const MSG = { to: 'a@example.edu', subject: 's', text: 't' };

test('Gmail settings (port 465) give an implicit-TLS transport; without the opt-in flag nothing is built', () => {
  const smtp = loadConfig({ ...DEV, ...GMAIL }).mail.smtp;
  assert.deepEqual([smtp.host, smtp.port, smtp.secure], ['smtp.gmail.com', 465, true]);
  assert.throws(() => loadConfig({ ...DEV, ...GMAIL, MAIL_LIVE_APPROVED: undefined }), /MAIL_LIVE_APPROVED=yes/);
  assert.equal(loadConfig({ ...DEV, SMTP_USER: 'x', SMTP_PASS: 'y' }).mail.transport, 'sink'); // credentials alone change nothing
});

test('an SMTP login failure is permanent and the password and username never appear in the error', async () => {
  const boom = Object.assign(new Error(`Invalid login: 535 5.7.8 for ${GMAIL.SMTP_USER} using ${GMAIL.SMTP_PASS}`), { code: 'EAUTH', responseCode: 535 });
  const adapter = createSmtpAdapter(loadConfig({ ...DEV, ...GMAIL }).mail.smtp, { transportFactory: () => ({ sendMail: async () => { throw boom; } }) });
  const err = await adapter.send(MSG).then(() => null, (e) => e);
  assert.equal(err.permanent, true);
  assert.ok(!err.message.includes(GMAIL.SMTP_PASS) && !err.message.includes(GMAIL.SMTP_USER), err.message);
});

test('the SMTP test command: refuses without a recipient, without MAIL_TRANSPORT=smtp, credentials or approval, and never builds a transport then', async () => {
  let built = 0;
  const transportFactory = () => { built++; return { sendMail: async () => ({ messageId: '<t@x>' }) }; };
  const refuse = (env, to = 'dev@example.edu') => sendSmtpTest({ env, to, transportFactory }).then(() => 'sent', (e) => e.message);
  assert.match(await refuse(GMAIL, ''), /one recipient/);
  assert.match(await refuse(GMAIL, 'a@x.edu, b@x.edu'), /one recipient/);
  assert.match(await refuse({ ...GMAIL, MAIL_TRANSPORT: undefined }), /not "smtp"/);
  assert.match(await refuse({ ...GMAIL, SMTP_PASS: undefined }), /SMTP_PASS/);
  assert.match(await refuse({ ...GMAIL, MAIL_LIVE_APPROVED: 'true' }), /MAIL_LIVE_APPROVED=yes/);
  assert.equal(built, 0);
  for (const msg of [await refuse({ ...GMAIL, SMTP_PASS: undefined }), await refuse({ ...GMAIL, MAIL_LIVE_APPROVED: '' })]) assert.ok(!msg.includes(GMAIL.SMTP_PASS));
});

test('the SMTP test command sends exactly one message and reports failure without secrets', async () => {
  const sent = [];
  const ok = await sendSmtpTest({ env: GMAIL, to: 'dev@example.edu', transportFactory: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: '<t@x>' }; } }) });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to, sent[0].from], ['dev@example.edu', GMAIL.MAIL_FROM]);
  assert.ok(!ok.includes(GMAIL.SMTP_PASS) && !ok.includes(GMAIL.SMTP_USER), ok);
  let calls = 0;
  const failing = { sendMail: async () => { calls++; throw Object.assign(new Error(`connect ETIMEDOUT with ${GMAIL.SMTP_PASS}`), { code: 'ETIMEDOUT' }); } };
  const err = await sendSmtpTest({ env: GMAIL, to: 'dev@example.edu', transportFactory: () => failing }).then(() => null, (e) => e);
  assert.equal(calls, 1, 'no retry loop');
  assert.ok(err && !err.message.includes(GMAIL.SMTP_PASS));
});

test('the demonstration stays local: SMTP settings in the shell are scrubbed, refused, and still give the sink', () => {
  const env = scrubMailEnv({ ...DEV, ...GMAIL, KEEP: '1' });
  assert.deepEqual(Object.keys(env).filter((k) => /^(MAIL_|SMTP_)/.test(k)), []);
  assert.equal(env.KEEP, '1');
  assert.equal(createAdapter(loadConfig(env)).name, 'sink');
  assert.throws(() => assertDemoEnvironment({ ...DEV, ...GMAIL }), /never sends real email/);
  assert.doesNotThrow(() => assertDemoEnvironment(env));
});
