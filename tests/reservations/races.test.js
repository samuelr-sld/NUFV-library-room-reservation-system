import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { harness } from './harness.js';
import { expireDueReservations } from '../../server/reservations.js';

// Reservation deadlines, concurrent actors, and what happens to the system when the backend restarts.
const h = harness();
const { db, call, reserve, day, resDoc, locksOf, trail, adminDecide } = h;
const DEAN = 'dean@example.edu';
let admin;

before(async () => {
  await h.start();
  admin = await h.actor({ role: 'admin' });
});
after(() => h.stop());
beforeEach(async () => {
  await h.reset();
  await h.room('room-a', { capacity: 4 });
  await h.setChain(DEAN);
});

const make = async (extra, who) => {
  const student = who ?? await h.student();
  const r = await reserve(student, { date: day(5), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await h.deliver();
  return { student, id: r.body.reservation.id };
};
const emailsAbout = async (kind) => (await db.collection('emailOutbox').where('kind', '==', kind).get()).size;

// ---------------------------------------------------------------- deadlines

test('a decision a moment before the step deadline still counts', async () => {
  const { id } = await make();
  h.advance(48 * 60 - 10); // ten minutes left
  const { id: cid, session } = await h.signIn(DEAN);
  h.advance(9.9); // six seconds left
  const res = await call(null, 'POST', `/api/approvals/${cid}/decision`, { session, decision: 'approve' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await resDoc(id)).currentStep, 1);
});

test('a decision exactly at the deadline is refused as expired, releases the room, and mails the student once', async () => {
  const { id } = await make();
  const { id: cid, session } = await h.signIn(DEAN);
  const deadline = (await resDoc(id)).stepDeadline.toMillis();
  h.time.now = new Date(deadline); // exactly the deadline

  const res = await call(null, 'POST', `/api/approvals/${cid}/decision`, { session, decision: 'approve' });
  assert.deepEqual([res.status, res.code], [409, 'reservation-expired']);
  const done = await resDoc(id);
  assert.deepEqual([done.status, done.endReason], ['expired', 'approval_timeout']);
  assert.equal((await locksOf(id)).length, 0);
  assert.deepEqual((await trail(id)).map((a) => a.action), ['submitted', 'expired']);
  assert.equal(await emailsAbout('reservation-outcome'), 1);
  // Repeating it changes nothing and queues nothing more.
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/decision`, { session, decision: 'approve' })).status, 409);
  assert.equal(await emailsAbout('reservation-outcome'), 1);
});

test('an approver, an administrator, the student and the sweeper all arriving after the deadline produce exactly one expiry', async () => {
  await h.setChain(); // straight to the administrator
  const { student, id } = await make();
  h.advance(48 * 60); // the deadline
  const results = await Promise.all([
    adminDecide(admin, id, 0),
    adminDecide(admin, id, 0, 'reject'),
    call(student, 'POST', `/api/reservations/${id}/cancel`),
    call(admin, 'POST', `/api/admin/reservations/${id}/cancel`, {}),
    expireDueReservations({ db, config: h.config, now: h.clock() }),
    call(student, 'GET', '/api/reservations'),
  ]);
  const refused = results.slice(0, 4);
  assert.ok(refused.every((r) => r.status === 409 && ['reservation-expired', 'not-pending', 'not-cancellable'].includes(r.code)), JSON.stringify(refused.map((r) => [r.status, r.code])));
  assert.equal((await resDoc(id)).status, 'expired');
  assert.deepEqual((await trail(id)).map((a) => a.action), ['submitted', 'expired'], 'one ending, whoever got there first');
  assert.equal(await emailsAbout('reservation-outcome'), 1);
  assert.equal((await locksOf(id)).length, 0);
});

test('the moment a lapsed request frees its room, two students race for it and exactly one wins', async () => {
  await make({ startTime: '09:00', endTime: '10:00' });
  h.advance(48 * 60 + 1);
  const [one, two] = [await h.student(), await h.student()];
  const results = await Promise.all([reserve(one, { date: day(5) }), reserve(two, { date: day(5) })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).code, 'slot-taken');
  const live = (await db.collection('reservationLocks').where('expiresAt', '>', new Date(h.clock())).get()).docs;
  assert.equal(live.length, 4, 'only the winner holds the room');
});

test('a booking whose start time arrives while it is still waiting expires: the step deadline never outlives the start', async () => {
  const student = await h.student();
  const id = (await reserve(student, { date: day(1), startTime: '09:00', endTime: '10:00' })).body.reservation.id; // starts in 23 hours
  const doc = await resDoc(id);
  assert.equal(doc.stepDeadline.toMillis(), doc.startsAt.toMillis(), 'capped at the start, not 48 hours');
  h.time.now = new Date(doc.startsAt.toMillis());
  const out = await call(admin, 'POST', `/api/admin/reservations/${id}/decision`, { decision: 'approve', step: 0 });
  assert.deepEqual([out.status, out.code], [409, 'reservation-expired']);
  const done = await resDoc(id);
  assert.deepEqual([done.status, done.endReason], ['expired', 'start_passed']);
  assert.equal((await locksOf(id)).length, 0);
});

// ---------------------------------------------------------------- backend restart

test('a restart that keeps the approval key keeps an approver signed in and loses nothing else', async () => {
  const { student, id } = await make();
  const { id: cid, session } = await h.signIn(DEAN);
  await h.restart();
  const review = await call(null, 'POST', `/api/approvals/${cid}/review`, { session });
  assert.equal(review.status, 200, 'the session is a keyed hash in the database, valid for any process with the same key');
  const done = await call(null, 'POST', `/api/approvals/${cid}/decision`, { session, decision: 'approve' });
  assert.equal(done.status, 200);
  assert.equal((await resDoc(id)).currentStep, 1);
  assert.equal((await call(student, 'GET', `/api/reservations/${id}`)).body.reservation.status, 'pending');
  assert.equal((await locksOf(id)).length, 4, 'holds live in the database, not in the process');
});

test('a restart with a different approval key (the development default) invalidates sessions and codes, and the approver simply starts again', async () => {
  const { id } = await make();
  const first = await h.signIn(DEAN);
  await h.restart({ approvalKey: randomBytes(32) });

  const stale = await call(null, 'POST', `/api/approvals/${first.id}/decision`, { session: first.session, decision: 'approve' });
  assert.deepEqual([stale.status, stale.code], [401, 'invalid-session']);
  assert.equal((await resDoc(id)).currentStep, 0, 'nothing was decided');
  assert.equal((await call(null, 'GET', `/api/approvals/${first.id}`)).body.state, 'open', 'the request itself is intact');

  // A code that was issued before the next restart does not survive it either.
  h.advance(0.6);
  assert.equal((await call(null, 'POST', `/api/approvals/${first.id}/code`, {})).status, 200);
  await h.deliver();
  const before = h.codeFor(DEAN);
  await h.restart({ approvalKey: randomBytes(32) });
  const wrong = await call(null, 'POST', `/api/approvals/${first.id}/verify`, { code: before });
  assert.deepEqual([wrong.status, wrong.code], [401, 'wrong-code']);

  h.advance(0.6);
  assert.equal((await call(null, 'POST', `/api/approvals/${first.id}/code`, {})).status, 200);
  await h.deliver();
  const again = await call(null, 'POST', `/api/approvals/${first.id}/verify`, { code: h.codeFor(DEAN) });
  assert.equal(again.status, 200);
  assert.equal((await call(null, 'POST', `/api/approvals/${first.id}/decision`, { session: again.body.session, decision: 'approve' })).status, 200);
  assert.equal((await resDoc(id)).currentStep, 1);
});

test('queued mail, overdue requests and overdue stubs are all picked up by a restarted backend without any sweep having run', async () => {
  const student = await h.student();
  const id = (await reserve(student, { date: day(5) })).body.reservation.id; // its review email is queued, not yet delivered
  await db.doc('resources/seat-1').set({ type: 'silent-seat', label: 'Seat 1', status: 'active', allocation: { assigned: 0, occupied: 0, held: 0 } });
  const stub = (await call(student, 'POST', '/api/tickets', { service: 'silent-room' })).body.ticket;
  const queued = async () => (await db.collection('emailOutbox').where('status', '==', 'queued').get()).size;
  assert.equal(await queued(), 1);

  h.advance(60 * 49); // the server was "down" past every deadline
  await h.restart();
  assert.equal(await queued(), 1, 'the outbox survived intact');
  await h.deliver();
  assert.equal(h.mailsTo(DEAN, 'approval-request').length, 1, 'and the new process delivers it');

  const mine = (await call(student, 'GET', '/api/reservations')).body.reservations[0];
  assert.deepEqual([mine.id, mine.status, mine.endReason], [id, 'expired', 'approval_timeout']);
  assert.equal((await call(student, 'GET', `/api/tickets/${stub.id}`)).body.ticket.status, 'expired');
  assert.deepEqual((await db.doc('resources/seat-1').get()).get('allocation'), { assigned: 0, occupied: 0, held: 0 });
});

test('after a restart with a different voucher key a voucher shows "unavailable" instead of failing; the original key brings it back', async () => {
  const student = await h.student();
  const issued = (await call(student, 'POST', '/api/tickets', { service: 'wifi-voucher' })).body.ticket;
  const printed = () => call(student, 'GET', `/api/tickets/${issued.id}/print`).then((r) => r.body.voucher);
  const original = await printed();
  assert.equal(original.passwordAvailable, true);

  await h.restart({ voucherKey: randomBytes(32) });
  assert.deepEqual(await printed(), { demo: true, password: null, passwordAvailable: false });
  const again = await call(student, 'POST', '/api/tickets', { service: 'wifi-voucher' });
  assert.equal(again.body.created, false, 'the active voucher is still the student\'s one voucher');

  await h.restart();
  assert.deepEqual(await printed(), original);
});
