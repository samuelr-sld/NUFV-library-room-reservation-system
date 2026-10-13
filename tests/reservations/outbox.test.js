import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { enqueue, outboxId, processOutbox, backoffMs, MAX_ATTEMPTS } from '../../server/mail/outbox.js';
import { Timestamp } from 'firebase-admin/firestore';
import { createMailer, createSinkAdapter, createSmtpAdapter } from '../../server/mail/adapters.js';

const h = harness();
const { db } = h;
const T0 = new Date('2030-06-10T02:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);

beforeEach(() => h.reset());

const queue = (items) => db.runTransaction(async (tx) => { for (const item of items) enqueue(db, tx, { now: T0, kind: 'note', subject: 'Hello', text: 'Body', ...item }); });
const doc = async (key) => (await db.doc(`emailOutbox/${outboxId(key)}`).get()).data();
const run = (adapter, now, extra = {}) => processOutbox({ db, adapter, now, workerId: extra.workerId ?? 'w1', ...extra });

// An adapter that follows a script: 'ok', 'transient' or 'permanent' per call (the last entry repeats).
function scripted(plan) {
  const sent = [];
  let i = 0;
  return {
    name: 'scripted', sent,
    async send(m) {
      const step = plan[Math.min(i++, plan.length - 1)];
      if (step === 'transient') throw new Error('421 temporarily unavailable');
      if (step === 'permanent') throw Object.assign(new Error('550 no such mailbox'), { permanent: true });
      sent.push(m);
    },
  };
}

test('a queued message is delivered once and its history is kept', async () => {
  await queue([{ dedupeKey: 'k1', to: 'a@example.edu' }]);
  const sink = createSinkAdapter();
  assert.deepEqual(await run(sink, T0), { sent: 1, retried: 0, failed: 0 });
  assert.deepEqual(await run(sink, at(1000)), { sent: 0, retried: 0, failed: 0 }, 'nothing left to do');
  assert.equal(sink.messages.length, 1);
  assert.deepEqual([sink.messages[0].to, sink.messages[0].subject], ['a@example.edu', 'Hello']);

  const m = await doc('k1');
  assert.equal(m.status, 'sent');
  assert.equal(m.attempts, 1);
  assert.equal(m.history.length, 1);
  assert.deepEqual([m.history[0].outcome, m.history[0].attempt], ['sent', 1]);
  assert.ok(m.sentAt && m.createdAt);
  assert.equal(m.text, 'Body', 'ordinary messages keep their body');
});

test('a transient failure is retried with growing backoff, never earlier than due, and ends in success', async () => {
  await queue([{ dedupeKey: 'k2', to: 'a@example.edu' }]);
  const adapter = scripted(['transient', 'transient', 'ok']);

  assert.deepEqual(await run(adapter, T0), { sent: 0, retried: 1, failed: 0 });
  let m = await doc('k2');
  assert.deepEqual([m.status, m.attempts], ['queued', 1]);
  assert.equal(m.nextAttemptAt.toMillis(), T0.getTime() + backoffMs(1));
  assert.match(m.lastError, /421/);

  assert.deepEqual(await run(adapter, at(backoffMs(1) - 1)), { sent: 0, retried: 0, failed: 0 }, 'not due yet');
  assert.deepEqual(await run(adapter, at(backoffMs(1))), { sent: 0, retried: 1, failed: 0 });
  m = await doc('k2');
  assert.equal(m.nextAttemptAt.toMillis(), at(backoffMs(1)).getTime() + backoffMs(2), 'the delay doubles');

  assert.deepEqual(await run(adapter, at(backoffMs(1) + backoffMs(2))), { sent: 1, retried: 0, failed: 0 });
  m = await doc('k2');
  assert.deepEqual([m.status, m.attempts, m.lastError], ['sent', 3, null]);
  assert.deepEqual(m.history.map((e) => e.outcome), ['retry', 'retry', 'sent']);
  assert.equal(adapter.sent.length, 1, 'delivered once despite two failed attempts');
});

test('a permanent failure is never retried', async () => {
  await queue([{ dedupeKey: 'k3', to: 'nobody@example.edu' }]);
  const adapter = scripted(['permanent']);
  assert.deepEqual(await run(adapter, T0), { sent: 0, retried: 0, failed: 1 });
  const m = await doc('k3');
  assert.deepEqual([m.status, m.attempts], ['failed', 1]);
  assert.match(m.lastError, /550/);
  assert.deepEqual(await run(adapter, at(24 * 3600_000)), { sent: 0, retried: 0, failed: 0 });
  assert.equal((await doc('k3')).attempts, 1);
});

test('retries are bounded: after the attempt limit the message is marked failed and left alone', async () => {
  await queue([{ dedupeKey: 'k4', to: 'a@example.edu' }]);
  const adapter = scripted(['transient']);
  let clock = 0;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await run(adapter, at(clock));
    clock += backoffMs(i) + 1;
  }
  const m = await doc('k4');
  assert.deepEqual([m.status, m.attempts], ['failed', MAX_ATTEMPTS]);
  assert.equal(m.history.length, MAX_ATTEMPTS);
  assert.deepEqual(await run(adapter, at(clock + 24 * 3600_000)), { sent: 0, retried: 0, failed: 0 });
});

test('one-time codes are blanked from the database once delivery ends, successfully or not', async () => {
  await queue([
    { dedupeKey: 'c1', kind: 'approval-code', to: 'a@example.edu', text: 'Your one-time code is 123456' },
    { dedupeKey: 'c2', kind: 'approval-code', to: 'b@example.edu', text: 'Your one-time code is 654321' },
    { dedupeKey: 'c3', kind: 'approval-request', to: 'c@example.edu', text: 'Open the link' },
  ]);
  assert.equal((await doc('c1')).text, 'Your one-time code is 123456', 'the body is there while it waits to be sent');
  const flaky = { name: 'x', async send(m) { if (m.to === 'b@example.edu') throw Object.assign(new Error('550'), { permanent: true }); } };
  await run(flaky, T0);
  assert.equal((await doc('c1')).text, null);
  assert.equal((await doc('c2')).text, null);
  assert.equal((await doc('c2')).status, 'failed');
  assert.equal((await doc('c3')).text, 'Open the link');
  assert.ok(!JSON.stringify(await Promise.all(['c1', 'c2'].map(doc))).includes('123456'));
});

test('a worker that dies mid-send loses its lease; the message is delivered again, possibly twice, never lost', async () => {
  await queue([{ dedupeKey: 'k5', to: 'a@example.edu' }]);
  const sink = createSinkAdapter();
  // Simulate the crash: the message was claimed ("sending") and handed to the transport, but "sent" was never recorded.
  await db.doc(`emailOutbox/${outboxId('k5')}`).update({ status: 'sending', attempts: 1, claimedBy: 'dead-worker', leaseUntil: new Timestamp(Math.floor(T0.getTime() / 1000) + 60, 0) });
  await sink.send({ id: 'k5', to: 'a@example.edu', subject: 'Hello', text: 'Body' });

  assert.deepEqual(await run(sink, at(30_000)), { sent: 0, retried: 0, failed: 0 }, 'still leased: nobody else touches it');
  assert.deepEqual(await run(sink, at(61_000)), { sent: 1, retried: 0, failed: 0 }, 'lease expired: re-delivered');
  assert.equal(sink.messages.length, 2, 'the recipient may get a duplicate: delivery is at-least-once');
  const m = await doc('k5');
  assert.deepEqual([m.status, m.attempts], ['sent', 2]);
});

test('a slow worker that lost its lease cannot clobber the new owner, and the possible duplicate is recorded', async () => {
  await queue([{ dedupeKey: 'k6', to: 'a@example.edu' }]);
  const slowSent = [];
  const slow = { name: 'slow', async send(m) { await new Promise((r) => setTimeout(r, 400)); slowSent.push(m.id); } };
  const fastSink = createSinkAdapter();

  const first = run(slow, T0, { workerId: 'slow-worker', leaseMs: 100 });
  await new Promise((r) => setTimeout(r, 150)); // the slow worker has claimed it and is stuck inside the transport
  await run(fastSink, at(500), { workerId: 'fast-worker' }); // the lease (100 ms) has expired by this clock
  await first;

  assert.equal(fastSink.messages.length, 1);
  assert.equal(slowSent.length, 1, 'both transports delivered: a duplicate, which at-least-once allows');
  const m = await doc('k6');
  assert.equal(m.status, 'sent');
  assert.ok(m.history.some((e) => /possible duplicate/.test(e.note ?? '')), JSON.stringify(m.history));
});

test('concurrent processors never deliver the same message twice', async () => {
  await queue(Array.from({ length: 6 }, (_, i) => ({ dedupeKey: `m${i}`, to: `u${i}@example.edu` })));
  const calls = [];
  const adapter = { name: 'counting', async send(m) { calls.push(m.to); await new Promise((r) => setTimeout(r, 30)); } };
  await Promise.all([run(adapter, T0, { workerId: 'a' }), run(adapter, T0, { workerId: 'b' }), run(adapter, T0, { workerId: 'c' })]);
  assert.equal(calls.length, 6, JSON.stringify(calls));
  assert.equal(new Set(calls).size, 6);
  assert.equal((await db.collection('emailOutbox').where('status', '==', 'sent').get()).size, 6);
});

test('the system never queues the same notification twice: a repeated dedupe key is refused whole', async () => {
  await queue([{ dedupeKey: 'once', to: 'a@example.edu' }]);
  await assert.rejects(queue([{ dedupeKey: 'other', to: 'b@example.edu' }, { dedupeKey: 'once', to: 'a@example.edu' }]), /ALREADY_EXISTS|already exists/i);
  assert.equal((await db.collection('emailOutbox').get()).size, 1, 'the whole transaction rolled back, including the other message');
});

test('queued mail survives a restart: a brand-new processor picks it up', async () => {
  await queue([{ dedupeKey: 'k7', to: 'a@example.edu' }]);
  const sink = createSinkAdapter();
  const restarted = createMailer({ db, adapter: sink, clock: () => T0, autoKick: false });
  assert.equal((await restarted.drain()).sent, 1);
  assert.equal(sink.messages.length, 1);
});

test('the auto mailer delivers shortly after kick() without being asked again', async () => {
  await queue([{ dedupeKey: 'k8', to: 'a@example.edu' }]);
  const sink = createSinkAdapter();
  const mailer = createMailer({ db, adapter: sink, clock: () => T0, autoKick: true });
  mailer.kick();
  mailer.kick(); // coalesced
  for (let i = 0; i < 60 && (await doc('k8')).status !== 'sent'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(sink.messages.length, 1);
  assert.equal((await doc('k8')).status, 'sent');
});

test('replaying reservation actions never queues extra email', async () => {
  await h.start();
  try {
    const admin = await h.actor({ role: 'admin' });
    await h.room('room-a');
    const student = await h.student();
    const id = (await h.reserve(student)).body.reservation.id;
    const count = async () => (await db.collection('emailOutbox').get()).size;
    assert.equal(await count(), 0, 'no external approver is configured, so submitting notifies nobody');
    for (let i = 0; i < 3; i++) await h.call(student, 'POST', `/api/reservations/${id}/cancel`, {});
    await h.call(admin, 'POST', `/api/admin/reservations/${id}/cancel`, {});
    assert.equal(await count(), 1, 'one cancellation notice, however often the cancellation is repeated');
  } finally {
    await h.stop();
  }
});

// The real SMTP adapter (fake transport, no network) behind the outbox: what Gmail failures do to a stored message.
const PASS = 'fake-app-password-123';
const gmail = (sendMail) => createSmtpAdapter({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'library.test@example.invalid', pass: PASS, from: 'library.test@example.invalid' }, { transportFactory: () => ({ sendMail }) });

test('SMTP behind the outbox: a timeout is retried then delivered; a rejected login fails at once, without leaking the password', async () => {
  await queue([{ dedupeKey: 's1', to: 'a@example.edu' }, { dedupeKey: 's2', kind: 'approval-code', to: 'b@example.edu', text: 'Your one-time code is 123456' }]);
  let n = 0;
  const flaky = gmail(async ({ to }) => {
    if (to === 'b@example.edu') throw Object.assign(new Error(`Invalid login: 535 ${PASS}`), { code: 'EAUTH', responseCode: 535 });
    if (n++ === 0) throw Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    return { messageId: '<ok@x>' };
  });
  assert.deepEqual(await run(flaky, T0), { sent: 0, retried: 1, failed: 1 });
  assert.deepEqual([(await doc('s1')).status, (await doc('s2')).status], ['queued', 'failed']);
  assert.deepEqual(await run(flaky, at(backoffMs(1))), { sent: 1, retried: 0, failed: 0 });
  assert.equal((await doc('s1')).status, 'sent');
  const stored = JSON.stringify([await doc('s1'), await doc('s2')]);
  assert.ok(!stored.includes(PASS), 'no credential reaches Firestore');
  assert.equal((await doc('s2')).text, null, 'the failed one-time code was discarded');
});
