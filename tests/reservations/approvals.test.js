import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { applyReservation, expireDueReservations } from '../../server/reservations.js';
import { decide as decideExternal } from '../../server/approvalAccess.js';

const h = harness();
const { db, call, reserve, day, resDoc, locksOf, audits, trail, mailsTo, adminDecide } = h;
const DEAN = 'dean@example.edu';
const ADVISER = 'adviser@example.edu';
let admin;

before(async () => {
  await h.start();
  admin = await h.actor({ role: 'admin' });
});
after(() => h.stop());
beforeEach(async () => {
  await h.reset();
  await h.room('room-a', { capacity: 4 });
  await h.setChain(DEAN, ADVISER);
});

const make = async (extra, who) => {
  const student = who ?? await h.student();
  const r = await reserve(student, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { student, id: r.body.reservation.id, reservation: r.body.reservation };
};
const state = async (id) => { const d = await resDoc(id); return [d.status, d.currentStep]; };
const view = (who, id) => call(who, 'GET', `/api/reservations/${id}`).then((r) => r.body.reservation);

// A verified approver session for a specific challenge (the code is read from the email the sink received).
async function session(challengeId, email) {
  assert.equal((await call(null, 'POST', `/api/approvals/${challengeId}/code`, {})).status, 200);
  await h.deliver();
  const v = await call(null, 'POST', `/api/approvals/${challengeId}/verify`, { code: h.codeFor(email) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body.session;
}
const act = (challengeId, sess, decision = 'approve', comment) => call(null, 'POST', `/api/approvals/${challengeId}/decision`, { session: sess, decision, comment });
const challengeOf = async (id) => (await resDoc(id)).activeChallengeId;

// ---------------------------------------------------------------- the whole chain

test('sequential approval end to end: each approver is notified only when their step is current; the final administrator confirms', async () => {
  const { student, id } = await make({ date: day(5) });
  await h.deliver();
  assert.equal(mailsTo(DEAN, 'approval-request').length, 1);
  assert.equal(mailsTo(ADVISER).length, 0, 'the second approver has not been told yet');
  assert.deepEqual(await state(id), ['pending', 0]);

  h.advance(10);
  const dean = await h.signIn(DEAN);
  const peek = await call(null, 'POST', `/api/approvals/${dean.id}/review`, { session: dean.session });
  assert.equal(peek.status, 200);
  assert.equal(peek.body.stepLabel, 'Approver 1');
  assert.equal(peek.body.reservation.room, 'ROOM-A');
  assert.equal(peek.body.reservation.purpose, 'Group study session');
  assert.equal(peek.body.student.fullName, 'Test Person');

  const before = (await locksOf(id))[0].get('expiresAt').toMillis();
  h.advance(10); // ten more minutes pass while the approver reads (the session lasts 30)
  const first = await act(dean.id, dean.session, 'approve', 'Looks fine');
  assert.deepEqual(first.body, { outcome: 'approved', reservationStatus: 'pending' });
  assert.deepEqual(await state(id), ['pending', 1]);
  assert.ok((await locksOf(id)).every((l) => l.get('expiresAt').toMillis() > before), 'the hold is extended for the next step');

  await h.deliver();
  assert.equal(mailsTo(ADVISER, 'approval-request').length, 1, 'only now is the second approver notified');
  assert.deepEqual((await view(student, id)).progress.map((p) => p.state), ['approved', 'current', 'waiting']);

  const adviser = await h.signIn(ADVISER);
  assert.equal((await act(adviser.id, adviser.session)).status, 200);
  assert.deepEqual(await state(id), ['pending', 2]);
  await h.deliver();
  assert.equal(mailsTo(DEAN).length + mailsTo(ADVISER).length, 4, 'two notices and two codes, nothing more');
  assert.equal((await db.collection('approvalChallenges').where('status', '==', 'open').get()).size, 0, 'no external challenge is open at the admin step');

  const waiting = (await call(admin, 'GET', '/api/admin/reservations')).body.reservations;
  assert.deepEqual(waiting.map((r) => [r.id, r.awaitingFinalApproval, r.student.fullName]), [[id, true, 'Test Person']]);

  assert.equal((await resDoc(id)).qrRef, undefined, 'no QR before the final approval');
  const final = await adminDecide(admin, id, 2);
  assert.equal(final.status, 200, JSON.stringify(final.body));
  const done = await resDoc(id);
  assert.equal(done.status, 'confirmed');
  assert.match(done.confirmationRef, /^RC-[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(done.qrRef.length, 24);
  assert.deepEqual(done.approvals.map((a) => [a.step, a.outcome, a.by.type]), [[0, 'approved', 'external'], [1, 'approved', 'external'], [2, 'approved', 'admin']]);
  assert.equal(done.approvals[0].by.ref, 'd***@example.edu', 'the trail never stores a full approver address in the clear');
  assert.equal(done.approvals[0].comment, 'Looks fine');
  const locks = await locksOf(id);
  assert.ok(locks.every((l) => l.get('kind') === 'booked' && l.get('expiresAt').toMillis() === done.endsAt.toMillis()));

  assert.deepEqual((await trail(id)).map((a) => [a.action, a.actorType]), [['submitted', 'student'], ['approved', 'external'], ['approved', 'external'], ['approved', 'admin']]);
  assert.equal((await audits(id)).filter((a) => a.action === 'reservation.approved').length, 3);

  await h.deliver();
  const studentEmail = (await db.doc(`users/${student.uid}`).get()).get('email');
  const mail = mailsTo(studentEmail, 'reservation-outcome');
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /confirmed \(RC-/);

  const mine = await view(student, id);
  assert.equal(mine.status, 'confirmed');
  assert.deepEqual(mine.progress.map((p) => p.state), ['approved', 'approved', 'approved']);
  assert.equal(mine.qrPayload, `NUFR1:${done.qrRef}`);
  const print = await call(student, 'GET', `/api/reservations/${id}/print`);
  assert.equal(print.status, 200);
  assert.ok(print.body.qrSvg.includes('<path'));
  assert.deepEqual(print.body.student, { fullName: 'Test Person', studentNumber: '2023-000000' });
  assert.equal(print.body.reservation.confirmationRef, done.confirmationRef);
});

test('a confirmation QR exists only after the final administrator approval: never for pending, rejected, cancelled or expired requests', async () => {
  const expired = await make({ startTime: '09:00', endTime: '10:00' });
  const rejected = await make({ startTime: '10:00', endTime: '11:00' });
  const cancelled = await make({ startTime: '11:00', endTime: '12:00' });
  await h.deliver();
  await applyReservation({ db, config: h.config, id: rejected.id, now: h.clock(), op: 'reject', expectedStep: 0, actor: { type: 'external', email: DEAN, challengeId: await challengeOf(rejected.id), check: () => {} } });
  await call(admin, 'POST', `/api/admin/reservations/${cancelled.id}/cancel`, { reason: 'test' });
  h.advance(60 * 25); // the first request's booking time has passed with no decision
  await expireDueReservations({ db, config: h.config, now: h.clock() });
  const pending = await make({ date: day(4), startTime: '09:00', endTime: '10:00' });

  const all = { pending, rejected, cancelled, expired };
  for (const [status, { student, id }] of Object.entries(all)) {
    const doc = await resDoc(id);
    assert.equal(doc.status, status);
    assert.equal(doc.qrRef, undefined, status);
    assert.equal(doc.confirmationRef, undefined, status);
    const r = await call(student, 'GET', `/api/reservations/${id}/print`);
    assert.equal(r.status, 409, status);
    assert.equal(r.code, 'not-confirmed');
    assert.equal((await view(student, id)).qrPayload, undefined, status);
  }
});

// ---------------------------------------------------------------- enforcement: order, actor, replay

test('no step can be skipped and nobody but the current approver can act', async () => {
  const { student, id } = await make();
  await h.deliver();
  // A final administrator cannot approve an external step for the approver, nor jump ahead.
  assert.equal((await adminDecide(admin, id, 0)).code, 'forbidden');
  assert.equal((await adminDecide(admin, id, 2)).code, 'not-current-step');
  assert.equal((await adminDecide(admin, id, 1)).code, 'not-current-step');
  assert.equal((await adminDecide(admin, id, 'zero')).status, 400);
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${id}/decision`, { decision: 'approve' })).status, 400);
  // The second approver cannot act on step 0, with their own email or anyone's.
  const actor = (email) => ({ type: 'external', email, challengeId: 'x'.repeat(24), check: () => {} });
  await assert.rejects(applyReservation({ db, config: h.config, id, now: h.clock(), op: 'approve', expectedStep: 1, actor: actor(ADVISER) }), { code: 'not-current-step' });
  await assert.rejects(applyReservation({ db, config: h.config, id, now: h.clock(), op: 'approve', expectedStep: 0, actor: actor(ADVISER) }), { code: 'forbidden' });
  await assert.rejects(applyReservation({ db, config: h.config, id, now: h.clock(), op: 'approve', expectedStep: 0, actor: { type: 'student', uid: student.uid } }), { code: 'forbidden' });
  await assert.rejects(applyReservation({ db, config: h.config, id, now: h.clock(), op: 'approve', expectedStep: 0, actor: { type: 'admin', uid: admin.uid } }), { code: 'forbidden' });
  // Students have no approval route at all, whatever they send.
  for (const path of [`/api/reservations/${id}/decision`, `/api/reservations/${id}/approve`, `/api/reservations/${id}`]) {
    assert.ok([404, 405].includes((await call(student, 'POST', path, { decision: 'approve', step: 0 })).status), path);
  }
  assert.deepEqual(await state(id), ['pending', 0]);
  assert.equal((await trail(id)).length, 1);
});

test("an earlier approver's link and session stop working once their step is decided", async () => {
  const { id } = await make();
  await h.deliver();
  const first = await challengeOf(id);
  const dean = await session(first, DEAN);
  assert.equal((await act(first, dean)).status, 200);
  const replay = await act(first, dean);
  assert.equal(replay.status, 409);
  assert.ok(['challenge-closed', 'not-current-step'].includes(replay.code), replay.code);
  assert.equal((await call(null, 'GET', `/api/approvals/${first}`)).body.state, 'closed');
  assert.equal((await call(null, 'POST', `/api/approvals/${first}/review`, { session: dean })).status, 409);
  assert.equal((await call(null, 'POST', `/api/approvals/${first}/code`, {})).status, 409);
  assert.deepEqual(await state(id), ['pending', 1]);
});

test('repeating or racing a decision advances the workflow exactly once', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const sess = await session(cid, DEAN);
  const results = await Promise.all(Array.from({ length: 4 }, () => act(cid, sess)));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.deepEqual(await state(id), ['pending', 1], 'one approval moved one step, not four');
  assert.equal((await resDoc(id)).approvals.length, 1);
  assert.equal((await trail(id)).filter((a) => a.action === 'approved').length, 1);
  await h.deliver();
  assert.equal(mailsTo(ADVISER, 'approval-request').length, 1, 'and exactly one notice went to the next approver');
});

test('the final decision needs a real administrator session; repeats and races confirm exactly once', async () => {
  await h.setChain(); // straight to the administrator
  const { student, id } = await make();
  assert.equal((await adminDecide(null, id, 0)).status, 401);
  assert.equal((await adminDecide(student, id, 0)).status, 403);
  const suspended = await h.actor({ role: 'admin', status: 'suspended' });
  assert.equal((await adminDecide(suspended, id, 0)).code, 'account-suspended');
  assert.deepEqual(await state(id), ['pending', 0]);

  const results = await Promise.all([adminDecide(admin, id, 0), adminDecide(admin, id, 0), adminDecide(admin, id, 0)]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.code === 'not-pending'));
  const done = await resDoc(id);
  assert.equal(done.status, 'confirmed');
  assert.equal((await trail(id)).filter((a) => a.action === 'approved').length, 1);
  assert.equal((await db.collection('emailOutbox').where('kind', '==', 'reservation-outcome').get()).size, 1);
  assert.equal((await adminDecide(admin, id, 0, 'reject')).code, 'not-pending', 'a confirmed booking cannot be rejected as a decision');
});

test('rejection ends the workflow, releases the hold, frees the slot for others and tells the student', async () => {
  const { student, id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const sess = await session(cid, DEAN);
  const r = await act(cid, sess, 'reject', 'Room is reserved for faculty');
  assert.deepEqual(r.body, { outcome: 'rejected', reservationStatus: 'rejected' });
  assert.deepEqual(await state(id), ['rejected', 0]);
  assert.equal((await locksOf(id)).length, 0);
  assert.equal((await db.collection('reservationLocks').get()).size, 0);

  const mine = await view(student, id);
  assert.deepEqual(mine.progress.map((p) => p.state), ['rejected', 'skipped', 'skipped']);
  assert.equal(mine.decision.comment, 'Room is reserved for faculty');
  await h.deliver();
  assert.equal(mailsTo(ADVISER).length, 0, 'later approvers are never contacted');
  const outcome = h.sink.messages.filter((m) => m.kind === 'reservation-outcome');
  assert.equal(outcome.length, 1);
  assert.match(outcome[0].subject, /was not approved/);

  assert.equal((await act(cid, sess)).status, 409);
  assert.equal((await adminDecide(admin, id, 0)).status, 409);
  assert.equal((await reserve(await h.student())).status, 201, 'someone else can now book the same slot');
  assert.equal((await trail(id)).at(-1).action, 'rejected');
});

test('the final administrator can reject too, which also releases the hold', async () => {
  await h.setChain();
  const { id } = await make();
  assert.equal((await adminDecide(admin, id, 0, 'reject', 'Not available')).status, 200);
  assert.deepEqual(await state(id), ['rejected', 0]);
  assert.equal((await locksOf(id)).length, 0);
});

// ---------------------------------------------------------------- workflow configuration

test('the admin chain editor: validated, versioned, audited, and the final step is always an administrator', async () => {
  const put = (body) => call(admin, 'PUT', '/api/admin/approval-workflow', body);
  const saved = await put({ steps: [{ label: 'Department head', email: 'Head@Example.edu', enabled: true }, { label: 'Dean', email: 'dean@example.edu', enabled: false }], stepHours: 24 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.chain.map((s) => [s.label, s.type, s.email]), [['Department head', 'external', 'head@example.edu'], ['Final administrator approval', 'admin', undefined]]);
  assert.deepEqual({ version: saved.body.version, hours: saved.body.stepHours, by: saved.body.updatedBy }, { version: 2, hours: 24, by: admin.uid });

  for (const bad of [{}, { steps: 'x' }, { steps: [{ label: '', email: 'a@b.co', enabled: true }] }, { steps: [{ label: 'x', email: 'nope', enabled: true }] },
    { steps: [{ label: 'x', email: 'a@b.co', enabled: true, type: 'admin' }] }, { steps: [], finalApprover: 'x@y.co' },
    { steps: [{ label: 'a', email: 'a@b.co', enabled: true }, { label: 'b', email: 'A@b.co', enabled: true }] }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(admin, 'GET', '/api/admin/approval-workflow')).body.version, 2, 'refused edits change nothing');
  const log = (await audits('current')).find((a) => a.action === 'workflow.update');
  assert.equal(log.actorUid, admin.uid);
  assert.equal(log.details.after.stepHours, 24);

  await put({ steps: [], stepHours: 48 });
  assert.deepEqual((await call(admin, 'GET', '/api/admin/approval-workflow')).body.chain.map((s) => s.type), ['admin'], 'even an empty chain ends with the administrator');
});

test('changing the chain never alters a request already submitted; new requests get the new chain', async () => {
  const old = await make({ startTime: '09:00', endTime: '10:00' });
  await h.deliver();
  const oldSteps = (await resDoc(old.id)).workflow.steps.map((s) => s.email ?? 'admin');
  assert.deepEqual(oldSteps, [DEAN, ADVISER, 'admin']);

  await call(admin, 'PUT', '/api/admin/approval-workflow', { steps: [{ label: 'Registrar', email: 'registrar@example.edu', enabled: true }], stepHours: 12 });
  assert.deepEqual((await resDoc(old.id)).workflow.steps.map((s) => s.email ?? 'admin'), oldSteps);
  assert.equal((await resDoc(old.id)).workflow.version, 1);

  const fresh = await make({ startTime: '11:00', endTime: '12:00' });
  assert.deepEqual((await resDoc(fresh.id)).workflow.steps.map((s) => s.email ?? 'admin'), ['registrar@example.edu', 'admin']);
  assert.equal((await resDoc(fresh.id)).workflow.version, 2);

  const dean = await h.signIn(DEAN); // the original approver still works for the original request
  assert.equal(dean.id, await challengeOf(old.id));
  assert.equal((await act(dean.id, dean.session)).status, 200);
  assert.deepEqual(await state(old.id), ['pending', 1]);
});

test('a disabled step is skipped from the chain and receives nothing', async () => {
  await db.doc('approvalWorkflows/current').set({ steps: [{ label: 'A', email: DEAN, enabled: false }, { label: 'B', email: ADVISER, enabled: true }], stepHours: 48, version: 3 });
  const { id } = await make();
  await h.deliver();
  assert.equal(mailsTo(DEAN).length, 0);
  assert.equal(mailsTo(ADVISER, 'approval-request').length, 1);
  assert.deepEqual((await resDoc(id)).workflow.steps.map((s) => s.type), ['external', 'admin']);
});

test('administrators can list and inspect reservations, with the full decision history, and re-send a notice', async () => {
  const { id } = await make();
  await h.deliver();
  const d = (await call(admin, 'GET', `/api/admin/reservations/${id}`)).body.reservation;
  assert.deepEqual(d.workflow.map((s) => s.email ?? 'admin'), [DEAN, ADVISER, 'admin']);
  assert.equal(d.awaitingFinalApproval, false);
  assert.deepEqual(d.history.map((x) => x.action), ['submitted']);
  assert.equal((await call(admin, 'GET', '/api/admin/reservations?status=confirmed')).body.reservations.length, 0);
  assert.equal((await call(admin, 'GET', '/api/admin/reservations?status=bogus')).status, 400);
  assert.equal((await call(admin, 'GET', '/api/admin/reservations/RS-ZZZZZZZZZZ')).status, 404);

  const oldId = await challengeOf(id);
  const resent = await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {});
  assert.equal(resent.status, 200);
  const newId = await challengeOf(id);
  assert.notEqual(newId, oldId);
  assert.equal((await call(null, 'GET', `/api/approvals/${oldId}`)).body.state, 'closed');
  assert.equal((await call(null, 'GET', `/api/approvals/${newId}`)).body.state, 'open');
  await h.deliver();
  assert.equal(mailsTo(DEAN, 'approval-request').length, 2);
  assert.equal((await act(newId, await session(newId, DEAN))).status, 200);

  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {})).status, 200, 'the second external step can be re-sent too');
  await h.setChain();
  const direct = await make({ startTime: '13:00', endTime: '14:00' });
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${direct.id}/resend`, {})).code, 'not-external-step');
  await call(admin, 'POST', `/api/admin/reservations/${direct.id}/cancel`, {});
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${direct.id}/resend`, {})).code, 'not-pending');
});

// ---------------------------------------------------------------- cancellation

test('a student can cancel a pending request: hold released, approver link dead, slot free, audited, repeatable', async () => {
  const { student, id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const r = await call(student, 'POST', `/api/reservations/${id}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.reservation.status, 'cancelled');
  assert.equal((await locksOf(id)).length, 0);
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`)).body.state, 'closed');
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).status, 409);
  assert.equal((await reserve(await h.student())).status, 201, 'the slot is bookable again');

  const again = await call(student, 'POST', `/api/reservations/${id}/cancel`, {});
  assert.equal(again.status, 200);
  assert.equal((await audits(id)).filter((a) => a.action === 'reservation.cancelled').length, 1, 'repeating changes nothing');
  assert.equal((await trail(id)).filter((a) => a.action === 'cancelled').length, 1);
  assert.equal((await trail(id)).find((a) => a.action === 'cancelled').actorRef, student.uid);
});

test('a confirmed reservation can be cancelled before it starts (student) or before it ends (administrator), not after', async () => {
  await h.setChain();
  const a = await make({ startTime: '09:00', endTime: '10:00' });
  const b = await make({ startTime: '11:00', endTime: '12:00' }, a.student);
  const c = await make({ startTime: '14:00', endTime: '15:00' }, a.student);
  for (const x of [a, b, c]) assert.equal((await adminDecide(admin, x.id, 0)).status, 200);

  assert.equal((await call(a.student, 'POST', `/api/reservations/${a.id}/cancel`, {})).status, 200);
  assert.equal((await locksOf(a.id)).length, 0, 'a confirmed booking releases its slots too');
  assert.equal((await reserve(await h.student(), { startTime: '09:00', endTime: '10:00' })).status, 201);

  h.advance(60 * 23); // the next day, 09:00: the booking B (11:00) is still ahead, C too
  assert.equal((await call(a.student, 'POST', `/api/reservations/${b.id}/cancel`, {})).status, 200);
  h.advance(60 * 4); // 13:00: C (14:00) not started
  assert.equal((await call(a.student, 'POST', `/api/reservations/${c.id}/cancel`, {})).status, 200);
});

test('after a confirmed booking starts a student cannot cancel it; an administrator can until it ends', async () => {
  await h.setChain();
  const a = await make({ startTime: '09:00', endTime: '11:00' });
  const b = await make({ startTime: '13:00', endTime: '14:00' }, a.student);
  await adminDecide(admin, a.id, 0);
  await adminDecide(admin, b.id, 0);
  h.advance(60 * 24); // 09:00 next day: A has just started
  const late = await call(a.student, 'POST', `/api/reservations/${a.id}/cancel`, {});
  assert.equal(late.status, 409);
  assert.equal(late.code, 'not-cancellable');
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${a.id}/cancel`, { reason: 'Fire drill' })).status, 200);
  h.advance(60 * 6); // 15:00: B has ended
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${b.id}/cancel`, {})).code, 'not-cancellable');
  assert.equal((await resDoc(b.id)).status, 'confirmed');
});

test('only the owner or an administrator can cancel; terminal requests cannot be cancelled again as a new transition', async () => {
  const { student, id } = await make();
  const other = await h.student();
  assert.equal((await call(other, 'POST', `/api/reservations/${id}/cancel`, {})).status, 404);
  assert.equal((await resDoc(id)).status, 'pending');
  await h.deliver();
  const cid = await challengeOf(id);
  await act(cid, await session(cid, DEAN), 'reject');
  const r = await call(student, 'POST', `/api/reservations/${id}/cancel`, {});
  assert.equal(r.status, 409);
  assert.equal(r.code, 'not-cancellable');
  assert.equal((await resDoc(id)).status, 'rejected');
});

// ---------------------------------------------------------------- time: approval timeouts and expiry

test('an unanswered step times out on server time: the request expires, the hold lapses, the approver link dies', async () => {
  const { student, id } = await make({ date: day(5) });
  await h.deliver();
  const cid = await challengeOf(id);
  h.advance(60 * 47);
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`)).body.state, 'open');
  h.advance(60 * 2); // 49 h: past the 48 h step deadline

  const mine = (await call(student, 'GET', '/api/reservations')).body.reservations[0];
  assert.equal(mine.status, 'expired');
  assert.equal(mine.endReason, 'approval_timeout');
  assert.deepEqual(mine.progress.map((p) => p.state), ['stopped', 'skipped', 'skipped']);
  assert.equal((await locksOf(id)).length, 0);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).status, 409);
  const log = (await trail(id)).at(-1);
  assert.deepEqual([log.action, log.actorType, log.reason], ['expired', 'system', 'approval_timeout']);
  assert.equal((await audits(id)).find((a) => a.action === 'reservation.expired').actorUid, null);
  await h.deliver();
  assert.match(h.sink.messages.find((m) => m.kind === 'reservation-outcome').subject, /ran out of time/);
});

test('each later step gets a fresh deadline from the moment it becomes current', async () => {
  const { id } = await make({ date: day(5) });
  await h.deliver();
  const cid = await challengeOf(id);
  h.advance(60 * 40);
  const sess = await session(cid, DEAN);
  assert.equal((await act(cid, sess)).status, 200);
  h.advance(60 * 47); // 87 h after submission, but only 47 h into the second step
  await h.deliver();
  const second = await challengeOf(id);
  assert.equal((await call(null, 'GET', `/api/approvals/${second}`)).body.state, 'open');
  h.advance(60 * 2);
  assert.equal((await call(null, 'GET', `/api/approvals/${second}`)).body.state, 'closed');
  assert.equal((await resDoc(id)).status, 'expired');
});

test('a request whose booking time arrives without a decision expires', async () => {
  const { student, id } = await make();
  h.advance(60 * 24); // 09:00 next day = the start time
  const mine = (await call(student, 'GET', '/api/reservations')).body.reservations[0];
  assert.deepEqual([mine.status, mine.endReason], ['expired', 'start_passed']);
});

test('a lapsed hold frees its slots without any cleanup job, and a stale action can never release the new holder', async () => {
  const date = day(5);
  const first = await make({ date });
  await h.deliver();
  const cid = await challengeOf(first.id);
  const sess = await session(cid, DEAN);
  h.advance(60 * 49);
  assert.equal((await resDoc(first.id)).status, 'pending', 'nothing has touched it: the record is stale');

  const second = await make({ date }); // the slot is free because the lock lapsed
  assert.equal((await locksOf(second.id)).length, 4);

  const stale = await act(cid, sess); // the first approver finally clicks
  assert.equal(stale.status, 409);
  assert.equal((await resDoc(first.id)).status, 'expired');
  assert.equal((await locksOf(second.id)).length, 4, "the stale action did not release the new holder's slots");
  assert.deepEqual(await state(second.id), ['pending', 0]);
  assert.equal((await db.collection('reservationLocks').get()).size, 4);
});

test('the sweeper is optional, idempotent, and expires only what is due', async () => {
  const due = await make({ date: day(5), startTime: '09:00', endTime: '10:00' });
  const later = await make({ date: day(6), startTime: '09:00', endTime: '10:00' });
  h.advance(60 * 49);
  const fresh = await make({ date: day(5), startTime: '11:00', endTime: '12:00' });
  assert.equal(await expireDueReservations({ db, config: h.config, now: h.clock() }), 2);
  assert.equal(await expireDueReservations({ db, config: h.config, now: h.clock() }), 0);
  assert.deepEqual(await Promise.all([due, later, fresh].map(async (x) => (await resDoc(x.id)).status)), ['expired', 'expired', 'pending']);
  assert.equal((await audits(due.id)).filter((a) => a.action === 'reservation.expired').length, 1);
});

// ---------------------------------------------------------------- external approver verification

test('the link alone shows and approves nothing', async () => {
  const { id } = await make({ purpose: 'Top secret thesis defence prep' });
  await h.deliver();
  const cid = await challengeOf(id);
  const peek = await call(null, 'GET', `/api/approvals/${cid}`);
  assert.deepEqual(peek.body, { state: 'open', stepLabel: 'Approver 1', emailHint: 'd***@example.edu' });
  const asText = JSON.stringify(peek.body);
  for (const secret of ['Top secret', 'Test Person', 'ROOM-A', '2023-000000', id]) assert.ok(!asText.includes(secret), secret);

  for (const body of [{}, { session: 'guess' }, { session: '' }, { session: 'a'.repeat(5000) }, { session: 12 }]) {
    assert.equal((await call(null, 'POST', `/api/approvals/${cid}/review`, body)).status, 401, JSON.stringify(body).slice(0, 40));
    assert.equal((await call(null, 'POST', `/api/approvals/${cid}/decision`, { ...body, decision: 'approve' })).status, 401);
  }
  assert.deepEqual(await state(id), ['pending', 0]);
  assert.equal((await call(null, 'GET', '/api/approvals/short')).status, 404);
  assert.equal((await call(null, 'GET', `/api/approvals/${'A'.repeat(24)}`)).status, 404);
});

test('the code goes only to the bound address, is never returned by the API, and is stored only as a keyed hash', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const sent = await call(null, 'POST', `/api/approvals/${cid}/code`, { email: 'attacker@example.com', to: 'attacker@example.com' });
  assert.deepEqual(Object.keys(sent.body).sort(), ['expiresInSeconds', 'sent']);
  await h.deliver();
  const codeMail = mailsTo(DEAN, 'approval-code');
  assert.equal(codeMail.length, 1);
  assert.equal(h.sink.messages.filter((m) => m.to === 'attacker@example.com').length, 0);
  const code = h.codeFor(DEAN);
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(sent.body).includes(code));

  const challenge = JSON.stringify((await db.doc(`approvalChallenges/${cid}`).get()).data());
  assert.ok(!challenge.includes(`"${code}"`), 'plaintext code stored');
  const verified = await call(null, 'POST', `/api/approvals/${cid}/verify`, { code });
  assert.equal(verified.status, 200);
  const after = JSON.stringify((await db.doc(`approvalChallenges/${cid}`).get()).data());
  assert.ok(!after.includes(verified.body.session), 'plaintext session stored');
  assert.match((await db.doc(`approvalChallenges/${cid}`).get()).get('otp.hash'), /^[0-9a-f]{64}$/);

  const outbox = (await db.collection('emailOutbox').where('kind', '==', 'approval-code').get()).docs[0].data();
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.text, null, 'the code is blanked from the outbox once delivered');
});

test('wrong codes are counted and limited per code and in total', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  await call(null, 'POST', `/api/approvals/${cid}/code`, {});
  await h.deliver();
  const right = h.codeFor(DEAN);
  const wrong = right === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 5; i++) {
    const r = await call(null, 'POST', `/api/approvals/${cid}/verify`, { code: wrong });
    assert.equal(r.status, 401, `attempt ${i}`);
    assert.equal(r.code, 'wrong-code');
  }
  const locked = await call(null, 'POST', `/api/approvals/${cid}/verify`, { code: right });
  assert.equal(locked.status, 429, 'even the right code is refused after five wrong guesses');
  assert.equal(locked.code, 'code-locked');

  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).code, 'wait-before-resending');
  h.advance(0.6);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).status, 200);
  await h.deliver();
  const fresh = h.codeFor(DEAN);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/verify`, { code: fresh })).status, 200, 'a new code works');
});

test('too many wrong guesses lock the whole request until an administrator re-sends it', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  for (let round = 0; round < 2; round++) {
    h.advance(0.6);
    await call(null, 'POST', `/api/approvals/${cid}/code`, {});
    await h.deliver();
    const wrong = h.codeFor(DEAN) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await call(null, 'POST', `/api/approvals/${cid}/verify`, { code: wrong });
  }
  const ch = (await db.doc(`approvalChallenges/${cid}`).get()).data();
  assert.deepEqual([ch.status, ch.closedReason], ['closed', 'locked']);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).code, 'challenge-closed');
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`)).body.state, 'closed');

  await call(admin, 'POST', `/api/admin/reservations/${id}/resend`, {});
  const next = await challengeOf(id);
  assert.equal((await act(next, await session(next, DEAN))).status, 200);
});

test('at most five codes per request; codes and sessions expire; a code works once', async () => {
  const { id } = await make({ date: day(5) });
  await h.deliver();
  const cid = await challengeOf(id);
  for (let i = 0; i < 5; i++) {
    h.advance(0.6);
    assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).status, 200, `code ${i + 1}`);
  }
  h.advance(0.6);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/code`, {})).code, 'too-many-codes');
  await h.deliver();

  const code = h.codeFor(DEAN);
  h.advance(11); // the code lives 10 minutes
  const stale = await call(null, 'POST', `/api/approvals/${cid}/verify`, { code });
  assert.deepEqual([stale.status, stale.code], [409, 'code-expired']);
});

test('a verified session is single-use for its decision, short-lived, and tied to its own request', async () => {
  const a = await make({ startTime: '09:00', endTime: '10:00' });
  const b = await make({ startTime: '11:00', endTime: '12:00' });
  await h.deliver();
  const [ca, cb] = [await challengeOf(a.id), await challengeOf(b.id)];
  const sa = await session(ca, DEAN);
  assert.equal((await call(null, 'POST', `/api/approvals/${cb}/review`, { session: sa })).status, 401, "request A's session does not open request B");
  assert.equal((await act(cb, sa)).status, 401);
  assert.deepEqual([await state(a.id), await state(b.id)], [['pending', 0], ['pending', 0]]);
  assert.equal((await call(null, 'POST', `/api/approvals/${ca}/review`, { session: sa })).status, 200);

  h.advance(31); // sessions live 30 minutes
  assert.equal((await call(null, 'POST', `/api/approvals/${ca}/review`, { session: sa })).status, 401);
  assert.equal((await act(ca, sa)).status, 401);
  const sb = await session(cb, DEAN);
  assert.equal((await act(cb, sb, 'approve')).status, 200);
  assert.equal((await act(cb, sb, 'approve')).status, 409);
});

test('a code check rejects malformed input without spending an attempt, and a used code cannot be replayed', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  await call(null, 'POST', `/api/approvals/${cid}/code`, {});
  await h.deliver();
  for (const code of ['12345', '1234567', 'abcdef', '12 456', '', null, 123456, ['123456']]) {
    assert.equal((await call(null, 'POST', `/api/approvals/${cid}/verify`, { code })).status, 400, JSON.stringify(code));
  }
  assert.equal((await db.doc(`approvalChallenges/${cid}`).get()).get('otp.attempts'), 0);
  const code = h.codeFor(DEAN);
  assert.equal((await call(null, 'POST', `/api/approvals/${cid}/verify`, { code })).status, 200);
  const replay = await call(null, 'POST', `/api/approvals/${cid}/verify`, { code });
  assert.deepEqual([replay.status, replay.code], [409, 'code-expired']);
});

test('an approver sees only the request under review, never other reservations or students', async () => {
  const mine = await make({ startTime: '09:00', endTime: '10:00', purpose: 'Visible purpose', participants: [{ name: 'Maria Santos', studentNumber: '2023-111111' }] });
  await make({ startTime: '11:00', endTime: '12:00', purpose: 'ZZZ-UNRELATED-PURPOSE' }, await h.student());
  await h.deliver();
  const cid = await challengeOf(mine.id);
  const r = await call(null, 'POST', `/api/approvals/${cid}/review`, { session: await session(cid, DEAN) });
  const text = JSON.stringify(r.body);
  assert.ok(text.includes('Visible purpose') && text.includes('Maria Santos'));
  assert.ok(!text.includes('ZZZ-UNRELATED-PURPOSE'));
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'previousApprovals', 'reservation', 'stepLabel', 'student']);
  assert.ok(!text.includes('uid') && !text.includes('qrRef') && !text.includes(mine.student.uid));
});

test('decisions validate their input: only approve or reject, and a bounded comment', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const sess = await session(cid, DEAN);
  for (const body of [{ decision: 'maybe' }, { decision: '' }, { decision: null }, { decision: 'approve', comment: 'x'.repeat(301) }, { decision: 'approve', comment: 5 }, { decision: 'approve', comment: 'bad\ncomment' }]) {
    assert.equal((await call(null, 'POST', `/api/approvals/${cid}/decision`, { session: sess, ...body })).status, 400, JSON.stringify(body).slice(0, 50));
  }
  assert.deepEqual(await state(id), ['pending', 0]);
  assert.equal((await act(cid, sess, 'approve')).status, 200, 'the session survives validation errors');
});

// ---------------------------------------------------------------- rollback

test('a failure while applying a decision rolls it back completely and leaves the approver able to retry', async () => {
  const { id } = await make();
  await h.deliver();
  const cid = await challengeOf(id);
  const sess = await session(cid, DEAN);
  const outboxBefore = (await db.collection('emailOutbox').get()).size;

  const failing = new Proxy(db, {
    get(target, prop) {
      if (prop !== 'runTransaction') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      return (fn, opts) => target.runTransaction((tx) => fn(new Proxy(tx, {
        get(t, p) {
          if (p === 'create') return (ref, data) => { if (ref.parent.id === 'auditLogs') throw new Error('injected failure'); return t.create(ref, data); };
          return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
        },
      })), opts);
    },
  });
  await assert.rejects(decideExternal({ db: failing, config: h.config, id: cid, session: sess, decision: 'approve', now: h.clock() }), /injected failure/);
  assert.deepEqual(await state(id), ['pending', 0]);
  assert.equal((await resDoc(id)).approvals.length, 0);
  assert.equal((await db.doc(`approvalChallenges/${cid}`).get()).get('status'), 'open');
  assert.equal((await db.collection('emailOutbox').get()).size, outboxBefore, 'no notification for a step that never happened');
  assert.equal((await trail(id)).length, 1);

  assert.equal((await act(cid, sess)).status, 200, 'the same session still works afterwards');
  assert.deepEqual(await state(id), ['pending', 1]);
});

test('a failure during the final approval confirms nothing: no QR, no confirmation, holds unchanged', async () => {
  await h.setChain();
  const { id } = await make();
  const failing = new Proxy(db, {
    get(target, prop) {
      if (prop !== 'runTransaction') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      return (fn, opts) => target.runTransaction((tx) => fn(new Proxy(tx, {
        get(t, p) {
          if (p === 'create') return (ref, data) => { if (ref.parent.id === 'approvalActions') throw new Error('injected failure'); return t.create(ref, data); };
          return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
        },
      })), opts);
    },
  });
  await assert.rejects(applyReservation({ db: failing, config: h.config, id, now: h.clock(), op: 'approve', expectedStep: 0, actor: { type: 'admin', uid: admin.uid } }), /injected failure/);
  const doc = await resDoc(id);
  assert.deepEqual([doc.status, doc.qrRef, doc.confirmationRef], ['pending', undefined, undefined]);
  assert.ok((await locksOf(id)).every((l) => l.get('kind') === 'hold'));
  assert.equal((await adminDecide(admin, id, 0)).status, 200);
});

// ---------------------------------------------------------------- development email sink

test('the dev mail viewer lists what the sink received, and is not mounted in production', async () => {
  const s = await h.student();
  await reserve(s);
  await h.deliver();
  const seen = await call(null, 'GET', `/api/dev/mail?to=${DEAN}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.messages.length, 1);
  assert.equal(seen.body.messages[0].kind, 'approval-request');

  const { createApp } = await import('../../server/app.js');
  const prod = createApp({ config: { production: true, corsOrigins: [] }, auth: h.auth, db, clock: h.clock }).listen(0);
  await new Promise((r) => prod.once('listening', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${prod.address().port}/api/dev/mail`)).status, 404);
  } finally {
    prod.close();
  }
});
