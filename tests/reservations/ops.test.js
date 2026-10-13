import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { outboxId } from '../../server/mail/outbox.js';

// Administrator visibility and recovery: pending approvals, queued / failed email, the audit viewer.
const h = harness();
const { db, call, reserve, day, resDoc, adminDecide } = h;
const DEAN = 'dean@example.edu';
let admin;

before(async () => {
  await h.start();
  admin = await h.actor({ role: 'admin' });
});
after(() => h.stop());
beforeEach(async () => {
  await h.reset();
  h.mail.failing = false;
  await h.room('room-a', { capacity: 4 });
  await h.setChain(DEAN);
});

const make = async (extra) => {
  const student = await h.student();
  const r = await reserve(student, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { student, id: r.body.reservation.id };
};
const approvals = () => call(admin, 'GET', '/api/admin/ops/approvals').then((r) => r.body);
const emails = (status) => call(admin, 'GET', `/api/admin/ops/emails${status ? `?status=${status}` : ''}`).then((r) => r.body);
const requeue = (id) => call(admin, 'POST', `/api/admin/ops/emails/${id}/requeue`, {});
const noticeId = async (reservationId) => outboxId(`approver-notice:${(await resDoc(reservationId)).activeChallengeId}`);

// ---------------------------------------------------------------- pending approvals

test('pending approval steps show who each is waiting on, when it expires, and what needs attention', async () => {
  const { id } = await make({ date: day(5) });
  await h.deliver();
  const notice = h.mailsTo(DEAN, 'approval-request')[0].text;
  assert.match(notice, /This request expires on \d{1,2} \w{3} 2030, \d{1,2}:\d{2} (am|pm) \(Asia\/Manila\)\./, 'the deadline is written in local time');
  assert.doesNotMatch(notice, /\d{4}-\d{2}-\d{2}T/, 'and never as a raw UTC timestamp');
  let view = await approvals();
  assert.equal(view.pending.length, 1);
  const row = view.pending[0];
  assert.deepEqual([row.id, row.stepType, row.approverEmail, row.currentStep, row.challenge.state, row.notice, row.attention], [id, 'external', DEAN, 0, 'open', 'sent', []]);
  assert.ok(Date.parse(row.stepDeadline) > h.clock().getTime());

  // The administrator step is listed too, without an approver address.
  await h.decide(DEAN);
  const other = await make({ date: day(6) });
  view = await approvals();
  assert.equal(view.pending.length, 2);
  const admins = view.pending.find((p) => p.id === id);
  assert.deepEqual([admins.stepType, admins.approverEmail, admins.challenge, admins.currentStep], ['admin', null, null, 1]);
  assert.equal(view.pending.find((p) => p.id === other.id).notice, 'queued', 'its review email has not been delivered yet');
  assert.deepEqual(view.pending.map((p) => p.stepDeadline), view.pending.map((p) => p.stepDeadline).sort(), 'soonest deadline first');
});

test('a locked request and a failed review email are flagged, and "send the request again" clears the flag', async () => {
  const { id } = await make({ date: day(5) });
  await h.deliver();
  const cid = (await resDoc(id)).activeChallengeId;
  for (let round = 0; round < 2; round++) {
    h.advance(0.6);
    await call(null, 'POST', `/api/approvals/${cid}/code`, {});
    await h.deliver();
    const wrong = h.codeFor(DEAN) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await call(null, 'POST', `/api/approvals/${cid}/verify`, { code: wrong });
  }
  let row = (await approvals()).pending[0];
  assert.deepEqual([row.challenge.state, row.attention], ['locked', ['locked']]);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'approval.locked').get()).size, 1, 'the lock is on the audit log');

  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {})).status, 200);
  row = (await approvals()).pending[0];
  assert.deepEqual([row.challenge.state, row.attention], ['open', []]);
  assert.equal((await resDoc(id)).currentStep, 0, 'recovery re-sends the step; it never skips or resets it');

  h.mail.failing = 'permanent';
  await h.deliver();
  row = (await approvals()).pending[0];
  assert.deepEqual([row.notice, row.attention], ['failed', ['notice-failed']]);
});

test('expired approval requests are listed with their reason, and stay expired', async () => {
  const { id } = await make({ date: day(5) });
  h.advance(60 * 49); // past the 48 h step deadline; nobody has read or swept anything
  const view = await approvals();
  assert.equal(view.pending.length, 0);
  assert.deepEqual(view.expired.map((e) => [e.id, e.endReason]), [[id, 'approval_timeout']]);
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {})).code, 'not-pending', 'an expired request is never reopened');
  assert.equal((await adminDecide(admin, id, 0)).code, 'not-pending');
});

// ---------------------------------------------------------------- email

test('queued, retrying and failed email are visible with counts, but message text is never exposed', async () => {
  await make({ date: day(5) });
  let view = await emails('queued');
  assert.deepEqual([view.counts.queued, view.counts.failed, view.counts.sent], [1, 0, 0]);
  assert.equal(view.messages[0].kind, 'approval-request');

  h.mail.failing = 'transient';
  await h.outbox().drain();
  view = await emails('queued');
  assert.deepEqual([view.messages[0].attempts, view.messages[0].willRetry, view.messages[0].requeueable], [1, true, false]);
  assert.match(view.messages[0].lastError, /550/);

  h.mail.failing = 'permanent';
  h.advance(1);
  await h.outbox().drain();
  view = await emails('failed');
  assert.equal(view.counts.failed, 1);
  assert.equal(view.messages[0].requeueable, true);
  const everything = JSON.stringify([view, await emails('queued'), await emails('sent'), await emails('sending')]);
  assert.ok(!/"text"|#[A-Za-z0-9_-]{24}|one-time code/.test(everything), 'no message body, review link or code is returned');

  assert.equal((await call(admin, 'GET', '/api/admin/ops/emails?status=bogus')).status, 400);
  assert.equal((await call(admin, 'GET', '/api/admin/ops/emails?status=failed&status=sent')).status, 400);
});

test('a failed review email can be sent again: same message, fresh attempts, audited, delivered at least once', async () => {
  const { id } = await make({ date: day(5) });
  h.mail.failing = 'permanent';
  await h.deliver();
  const [failed] = (await emails('failed')).messages;
  assert.equal(failed.id, await noticeId(id));
  assert.equal(h.sink.messages.length, 0);

  h.mail.failing = false;
  const done = await requeue(failed.id);
  assert.equal(done.status, 200);
  assert.equal(done.body.counts.failed, 0, 'the response is the refreshed failed list');
  const after = (await db.doc(`emailOutbox/${failed.id}`).get()).data();
  assert.deepEqual([after.status, after.attempts], ['queued', 0]);
  assert.equal(after.history.at(-1).outcome, 'requeued');
  assert.equal(after.history.at(-1).by, admin.uid);

  await h.deliver();
  assert.equal(h.mailsTo(DEAN, 'approval-request').length, 1, 'the approver finally got the request');
  assert.equal((await emails('sent')).messages.length, 1);
  const log = (await db.collection('auditLogs').where('action', '==', 'email.requeued').get()).docs.map((d) => d.data());
  assert.deepEqual(log.map((a) => [a.actorUid, a.targetId, a.details.kind]), [[admin.uid, failed.id, 'approval-request']]);

  // The link in the message works, so the workflow was recovered, not restarted.
  assert.equal((await h.decide(DEAN)).status, 200);
  assert.equal((await resDoc(id)).currentStep, 1);
  assert.equal((await requeue(failed.id)).code, 'not-failed', 'only a failed message can be sent again');
});

test('a message that cannot safely be sent again is refused with the way forward', async () => {
  const { id } = await make({ date: day(5) });
  h.mail.failing = 'permanent';
  await h.deliver();
  const oldNotice = await noticeId(id);

  // The review link was replaced by "send the request again": the old message would carry a dead link.
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {})).status, 200);
  const stale = await requeue(oldNotice);
  assert.equal(stale.code, 'superseded');
  assert.match(stale.body.error.message, /Send the request again/);

  // A one-time code is discarded once delivery ends; the approver asks for a new one.
  h.mail.failing = false;
  await h.deliver();
  h.mail.failing = 'permanent';
  const cid = (await resDoc(id)).activeChallengeId;
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).status, 200);
  await h.deliver();
  const codeMail = (await emails('failed')).messages.find((m) => m.kind === 'approval-code');
  assert.deepEqual([codeMail.requeueable, (await db.doc(`emailOutbox/${codeMail.id}`).get()).get('text')], [false, null]);
  assert.equal((await requeue(codeMail.id)).code, 'body-discarded');

  assert.equal((await requeue('nonsense')).status, 404);
  assert.equal((await requeue('f'.repeat(32))).status, 404);
  assert.equal((await resDoc(id)).currentStep, 0, 'no step was skipped by any of this');
});

test('retrying is bounded and a recovered transport delivers each queued message exactly once here', async () => {
  const { id } = await make({ date: day(5) });
  h.mail.failing = 'transient';
  for (let i = 0; i < 8; i++) { await h.outbox().drain(); h.advance(40); }
  const m = (await db.doc(`emailOutbox/${await noticeId(id)}`).get()).data();
  assert.deepEqual([m.status, m.attempts], ['failed', 6], 'gave up after the attempt limit');
  h.mail.failing = false;
  assert.equal((await requeue(await noticeId(id))).status, 200);
  await h.deliver();
  await h.deliver();
  assert.equal(h.mailsTo(DEAN, 'approval-request').length, 1);
});

// ---------------------------------------------------------------- audit viewer

test('the audit viewer lists events newest first with actor, target, outcome and reason, in bounded pages', async () => {
  const { student, id } = await make({ date: day(5) });
  await h.deliver();
  await h.decide(DEAN, 'approve', 'Looks fine');
  const second = await make({ date: day(6), startTime: '13:00', endTime: '14:00' });
  await call(second.student, 'POST', `/api/reservations/${second.id}/cancel`);
  await adminDecide(admin, id, 1, 'reject', 'Room needed for an exam');

  const page = await call(admin, 'GET', '/api/admin/audit?limit=3');
  assert.equal(page.status, 200);
  assert.equal(page.body.entries.length, 3);
  assert.ok(page.body.next);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const [latest] = page.body.entries;
  assert.deepEqual([latest.action, latest.outcome, latest.reason, latest.target], ['reservation.rejected', 'rejected', 'Room needed for an exam', { type: 'reservation', id }]);
  assert.equal(latest.actor.uid, admin.uid);
  assert.equal(latest.actor.label, 'Test Person (admin)');
  const ats = page.body.entries.map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort().reverse());

  const external = (await call(admin, 'GET', '/api/admin/audit?action=reservation.approved')).body.entries[0];
  assert.equal(external.actor.label, 'External approver d***@example.edu');
  assert.equal(external.actor.uid, null);
  assert.equal(external.reason, 'Looks fine');

  // Walk every page: no gaps, no repeats, and the last page has no cursor.
  const seen = [];
  let cursor;
  do {
    const p = (await call(admin, 'GET', `/api/admin/audit?limit=2${cursor ? `&before=${cursor}` : ''}`)).body;
    seen.push(...p.entries.map((e) => e.id));
    cursor = p.next;
  } while (cursor);
  const all = (await call(admin, 'GET', '/api/admin/audit?limit=100')).body.entries.map((e) => e.id);
  assert.deepEqual(seen, all);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(all.length >= 4);

  const mine = (await call(admin, 'GET', `/api/admin/audit?target=${id}`)).body.entries;
  assert.ok(mine.length >= 3 && mine.every((e) => e.target.id === id));
  const submitted = (await call(admin, 'GET', '/api/admin/audit?action=reservation.submitted')).body.entries;
  assert.deepEqual(submitted.filter((e) => e.target.id === id).map((e) => e.actor.uid), [student.uid]);
});

test('audit queries are validated and bounded', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'action=Bad Action', 'action=a.b.', 'target=has space', `target=${'x'.repeat(81)}`, 'action=a.b&target=x', 'before=short', `before=${'a'.repeat(20)}`, 'action=a.b&action=c.d', 'limit=1&limit=2']) {
    const r = await call(admin, 'GET', `/api/admin/audit?${query}`);
    assert.equal(r.status, 400, query);
  }
  assert.equal((await call(admin, 'GET', '/api/admin/audit?limit=100')).status, 200);
});

test('the audit log and its viewer never contain passwords, codes, sessions, challenge links or QR references', async () => {
  const { student, id } = await make({ date: day(5) });
  await h.deliver();
  const dean = await h.signIn(DEAN);
  const code = h.codeFor(DEAN);
  await call(null, 'POST', `/api/approvals/${dean.id}/decision`, { session: dean.session, decision: 'approve' });
  await adminDecide(admin, id, 1);
  await call(student, 'POST', '/api/tickets', { service: 'wifi-voucher' });
  const voucher = (await db.collection('tickets').get()).docs[0];
  const printed = await call(student, 'GET', `/api/tickets/${voucher.id}/print`);
  const password = printed.body.voucher.password;
  assert.match(password, /^DEMO-/);

  // A hand-written entry with secret-looking keys is redacted on the way out (second lock; the first is that nothing writes them).
  await db.collection('auditLogs').add({ actorUid: null, action: 'test.leak', targetType: 'x', targetId: 'x', details: { password: 'p1', nested: { sessionToken: 's1', ok: 'visible' }, list: [{ otp: 'o1' }] }, at: new Date() });

  const page = await call(admin, 'GET', '/api/admin/audit?limit=100');
  const raw = JSON.stringify(page.body) + JSON.stringify((await db.collection('auditLogs').get()).docs.filter((d) => d.get('action') !== 'test.leak').map((d) => d.data()));
  const doc = await resDoc(id);
  for (const secret of [dean.session, dean.id, password, doc.qrRef, voucher.get('qrRef'), 'p1', 's1', 'o1']) {
    assert.ok(!raw.includes(secret), `leaked ${secret.slice(0, 4)}...`);
  }
  assert.doesNotMatch(raw, new RegExp(`(?<!\d)${code}(?!\d)`), 'the one-time code appears nowhere');
  const leak = page.body.entries.find((e) => e.action === 'test.leak');
  assert.deepEqual(leak.details, { password: '[hidden]', nested: { sessionToken: '[hidden]', ok: 'visible' }, list: [{ otp: '[hidden]' }] });
  assert.equal(leak.actor.label, 'System');
});

test('the audit viewer shows the reason a person typed, not the word the system uses for it', async () => {
  const student = await h.student();
  const ticket = (await call(student, 'POST', '/api/tickets', { service: 'wifi-voucher' })).body.ticket;
  assert.equal((await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/revoke`, { reason: 'Wrong person at the desk' })).status, 200);
  const [entry] = (await call(admin, 'GET', '/api/admin/audit?action=ticket.revoked')).body.entries;
  assert.equal(entry.reason, 'Wrong person at the desk');
  assert.equal(entry.outcome, 'revoked');
});
