import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { transitionTicket } from '../../server/tickets.js';

const h = harness();
const { db, call, issue, resource, ticketDoc, lock } = h;
let admin;

before(async () => {
  await h.start();
  admin = await h.actor({ role: 'admin' });
});
after(() => h.stop());
beforeEach(() => h.reset());

const FREE = { assigned: 0, occupied: 0, held: 0 };
const resolve = (who, reference) => call(who, 'POST', '/api/admin/tickets/resolve', { reference });
const checkIn = (who, id, body = { identityChecked: true }) => call(who, 'POST', `/api/admin/tickets/${id}/check-in`, body);
const checkOut = (who, id) => call(who, 'POST', `/api/admin/tickets/${id}/check-out`, {});
const revoke = (who, id, reason = 'Left belongings unattended') => call(who, 'POST', `/api/admin/tickets/${id}/revoke`, { reason });
const audits = async (id) => (await db.collection('auditLogs').where('targetId', '==', id).get()).docs.map((d) => d.data());
const actions = async (id) => (await audits(id)).map((a) => a.action).sort();
const at = (date) => new Date(date);

// A student with a fresh stub for the given service.
async function stub(service = 'silent-room') {
  const student = await h.student();
  const ticket = (await issue(student, service)).body.ticket;
  return { student, ticket };
}

// ---------------------------------------------------------------- verification

test('a QR resolves to the ticket, student, assignment and next actions; ticket id and bare reference work too', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();

  for (const reference of [ticket.qrPayload, ticket.qrPayload.slice('NUFV1:'.length), `  ${ticket.qrPayload}  `, ticket.id, ticket.id.toLowerCase()]) {
    const r = await resolve(admin, reference);
    assert.equal(r.status, 200, reference);
    assert.equal(r.body.ticket.id, ticket.id);
    assert.equal(r.body.ticket.status, 'issued');
    assert.equal(r.body.ticket.service, 'silent-room');
    assert.deepEqual(r.body.ticket.resource, { id: 'silent-seat-01', label: 'SILENT-SEAT-01' });
    assert.deepEqual(r.body.student, { fullName: 'Test Person', studentNumber: '2023-000000', status: 'active' });
    assert.deepEqual(r.body.allowedActions, ['check_in', 'revoke']);
    assert.deepEqual(r.body.warnings, []);
    assert.equal(r.body.ticket.issuedAt, ticket.issuedAt);
    assert.equal(r.body.ticket.expiresAt, ticket.expiresAt);
  }
  // Nothing internal leaks: no uid, QR reference, deadlines used internally, or credential fields.
  const dump = JSON.stringify((await resolve(admin, ticket.qrPayload)).body);
  for (const secret of [student.uid, ticket.qrPayload.slice('NUFV1:'.length), 'credential', 'qrRef', 'activeDeadline', 'uid"']) assert.ok(!dump.includes(secret), `leaked ${secret}`);
});

test('malformed references are rejected with 400 before the database is touched', async () => {
  for (const reference of ['', '   ', 'hello', 'NUFV1:', 'NUFV1:short', 'NUFV2:' + 'a'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), 'abc+def/ghi=jklmnopqrstu', 'x'.repeat(5000), 12345, null, ['a'.repeat(24)], { reference: 'a'.repeat(24) }, 'SR-12345', "NUFV1:'; drop"]) {
    const r = await resolve(admin, reference);
    assert.equal(r.status, 400, JSON.stringify(reference));
    assert.equal(r.code, 'invalid-qr');
  }
  assert.equal((await call(admin, 'POST', '/api/admin/tickets/resolve', {})).code, 'invalid-qr');
  assert.equal((await call(admin, 'POST', '/api/admin/tickets/resolve', [])).status, 400);
});

test('a well-formed but unknown reference is a 404, and nothing says whether a ticket id exists elsewhere', async () => {
  for (const reference of ['A'.repeat(24), 'NUFV1:' + 'z'.repeat(24), 'SR-0000000000', 'WF-ZZZZZZZZZZ']) {
    const r = await resolve(admin, reference);
    assert.equal(r.status, 404, reference);
    assert.equal(r.code, 'unknown-qr');
  }
});

test('the reference is only ever accepted in the request body, never from the URL', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  assert.equal((await call(admin, 'GET', `/api/admin/tickets/resolve?reference=${encodeURIComponent(ticket.qrPayload)}`)).status, 404);
  assert.equal((await call(admin, 'GET', `/api/admin/tickets/${ticket.id}`)).status, 404);
});

// ---------------------------------------------------------------- who may operate

test('anonymous callers, students, unverified students, suspended or profile-less admins and forged claims are all refused', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  const unverified = await h.student({ emailVerified: false });
  const suspendedAdmin = await h.actor({ role: 'admin', status: 'suspended' });
  const noProfile = await h.actor({ role: null });
  const forged = await h.actor({ role: 'student', emailVerified: true, claim: 'admin' });

  const routes = [
    ['POST', '/api/admin/tickets/resolve', { reference: ticket.qrPayload }],
    ['POST', `/api/admin/tickets/${ticket.id}/check-in`, { identityChecked: true }],
    ['POST', `/api/admin/tickets/${ticket.id}/check-out`, {}],
    ['POST', `/api/admin/tickets/${ticket.id}/revoke`, { reason: 'because I can' }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await call(null, method, path, body)).status, 401, `anon ${path}`);
    for (const who of [student, unverified, forged, noProfile]) assert.equal((await call(who, method, path, body)).status, 403, `${path}`);
    const s = await call(suspendedAdmin, method, path, body);
    assert.equal(s.status, 403);
    assert.equal(s.code, 'account-suspended');
  }
  assert.equal((await ticketDoc(ticket.id)).status, 'issued');
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: ticket.id });
  assert.equal(await actions(ticket.id).then((a) => a.length), 1); // only the original issue
});

test('an administrator suspended after sign-in is refused on the next scan', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  const a = await h.actor({ role: 'admin' });
  assert.equal((await resolve(a, ticket.qrPayload)).status, 200);
  await db.doc(`users/${a.uid}`).update({ status: 'suspended' });
  assert.equal((await resolve(a, ticket.qrPayload)).code, 'account-suspended');
  assert.equal((await checkIn(a, ticket.id)).code, 'account-suspended');
});

// ---------------------------------------------------------------- check-in

test('check-in: assigned -> occupied, lock kept, original expiry kept, audited with the administrator', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  h.advance(5);
  const r = await checkIn(admin, ticket.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.ticket.status, 'checked_in');
  assert.ok(r.body.ticket.checkedInAt);
  assert.equal(r.body.ticket.expiresAt, ticket.expiresAt, 'occupancy lasts until the original expiry');
  assert.deepEqual(r.body.allowedActions, ['check_out', 'revoke']);

  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 1, held: 0, ticketId: ticket.id });
  assert.deepEqual(await lock(student.uid), { 'silent-room': ticket.id });
  const doc = await ticketDoc(ticket.id);
  assert.equal(doc.checkedInBy, admin.uid);
  assert.equal(doc.activeDeadline.toMillis(), doc.expiresAt.toMillis());

  const log = (await audits(ticket.id)).find((a) => a.action === 'ticket.checked_in');
  assert.equal(log.actorUid, admin.uid);
  assert.deepEqual({ ...log.details }, { service: 'silent-room', resourceId: 'silent-seat-01', from: 'issued', reason: null, identityChecked: true });
});

test('check-in works for computer stations too', async () => {
  await h.pcs('pc-01');
  const { ticket } = await stub('computer-station');
  assert.equal((await checkIn(admin, ticket.id)).body.ticket.status, 'checked_in');
  assert.equal((await resource('pc-01')).allocation.occupied, 1);
});

test('check-in needs the administrator to confirm the student identity check', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  for (const body of [{}, { identityChecked: false }, { identityChecked: 'true' }, { identityChecked: 1 }, []]) {
    const r = await checkIn(admin, ticket.id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await ticketDoc(ticket.id)).status, 'issued');
});

test('repeated and simultaneous check-ins occupy the seat exactly once', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  const results = await Promise.all(Array.from({ length: 5 }, () => checkIn(admin, ticket.id)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.body.changed).length, 1);
  const again = await checkIn(admin, ticket.id);
  assert.equal(again.body.changed, false);
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 1, held: 0, ticketId: ticket.id });
  assert.equal((await audits(ticket.id)).filter((a) => a.action === 'ticket.checked_in').length, 1);
});

test('boundary rule: check-in works strictly before the deadline; at the deadline instant it is a no-show', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const early = await stub();
  const late = await stub();
  const deadline = Date.parse(early.ticket.checkInDeadline);

  h.time.now = at(deadline - 1);
  assert.equal((await checkIn(admin, early.ticket.id)).status, 200, '1 ms before the deadline');

  h.time.now = at(deadline);
  const r = await checkIn(admin, late.ticket.id);
  assert.equal(r.status, 409, 'exactly at the deadline');
  assert.equal(r.code, 'no-show');
  const doc = await ticketDoc(late.ticket.id);
  assert.equal(doc.status, 'expired');
  assert.equal(doc.endReason, 'no_show');
  assert.deepEqual((await resource('silent-seat-02')).allocation, FREE, 'the rejected check-in still releases the seat');
});

test('late check-in is rejected even though no cleanup ever ran, and later still is the same', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  h.advance(16);
  const r = await checkIn(admin, ticket.id);
  assert.equal(r.code, 'no-show');
  assert.equal((await ticketDoc(ticket.id)).endReason, 'no_show');
  assert.deepEqual(await lock(student.uid), {});
  assert.equal((await checkIn(admin, ticket.id)).status, 409);
  assert.equal((await actions(ticket.id)).filter((a) => a === 'ticket.expired').length, 1);
});

test('a grace period of zero disables no-show: check-in works any time before the full expiry', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  await h.setSettings({ noShowGraceMinutes: 0 });
  const { ticket } = await stub();
  h.advance(119);
  assert.equal((await checkIn(admin, ticket.id)).status, 200);
  const other = await stub();
  assert.equal(other.ticket.checkInDeadline, null);
});

test('check-in is refused for Wi-Fi vouchers, inactive students, lost seats, and non-issued tickets', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03', 'silent-seat-04');
  const voucher = (await stub('wifi-voucher')).ticket;
  const r = await checkIn(admin, voucher.id);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'check-in-not-required');
  assert.equal((await ticketDoc(voucher.id)).status, 'issued');

  const suspended = await stub();
  await db.doc(`users/${suspended.student.uid}`).update({ status: 'suspended' });
  assert.equal((await checkIn(admin, suspended.ticket.id)).code, 'student-not-active');
  assert.equal((await resolve(admin, suspended.ticket.qrPayload)).body.warnings[0], 'student-not-active');
  assert.deepEqual((await resolve(admin, suspended.ticket.qrPayload)).body.allowedActions, ['revoke']);
  assert.equal((await ticketDoc(suspended.ticket.id)).status, 'issued');

  const lost = await stub();
  await db.doc(`resources/${lost.ticket.resource.id.toLowerCase()}`).update({ 'allocation.ticketId': 'SR-SOMEONEELSE' });
  assert.equal((await checkIn(admin, lost.ticket.id)).code, 'resource-mismatch');
  assert.equal((await ticketDoc(lost.ticket.id)).status, 'issued');
  assert.equal((await resource(lost.ticket.resource.id.toLowerCase())).allocation.occupied, 0);

  const done = await stub();
  await checkIn(admin, done.ticket.id);
  await checkOut(admin, done.ticket.id);
  const again = await checkIn(admin, done.ticket.id);
  assert.equal(again.status, 409);
  assert.equal(again.code, 'invalid-transition');
});

// ---------------------------------------------------------------- check-out

test('check-out releases the seat and the lock, keeps the history and frees the student for a new stub', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  await checkIn(admin, ticket.id);
  h.advance(30);
  const r = await checkOut(admin, ticket.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.ticket.status, 'checked_out');
  assert.deepEqual(r.body.allowedActions, []);

  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.deepEqual(await lock(student.uid), {});
  const doc = await ticketDoc(ticket.id);
  assert.equal(doc.endedBy, admin.uid);
  assert.equal(doc.endReason, 'checked_out');
  assert.equal(doc.activeDeadline, undefined);

  const history = (await call(student, 'GET', '/api/tickets/history')).body.tickets;
  assert.deepEqual(history.map((t) => [t.id, t.status]), [[ticket.id, 'checked_out']]);
  assert.equal((await issue(student, 'silent-room')).status, 201);
  assert.deepEqual((await actions(ticket.id)), ['ticket.checked_in', 'ticket.checked_out', 'ticket.issued']);
});

test('only a checked-in ticket can be checked out', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  const r = await checkOut(admin, ticket.id);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'invalid-transition');
  assert.equal((await ticketDoc(ticket.id)).status, 'issued');
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: ticket.id });
});

test('repeated check-outs change nothing, and never release a seat that was given to someone else', async () => {
  await h.seats('silent-seat-01');
  const a = await stub();
  await checkIn(admin, a.ticket.id);
  const results = await Promise.all([checkOut(admin, a.ticket.id), checkOut(admin, a.ticket.id), checkOut(admin, a.ticket.id)]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.body.changed).length, 1);

  const b = await stub(); // the seat now belongs to B
  assert.equal(b.ticket.resource.id, 'silent-seat-01');
  const replay = await checkOut(admin, a.ticket.id);
  assert.equal(replay.body.changed, false);
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: b.ticket.id });
  assert.deepEqual(await lock(b.student.uid), { 'silent-room': b.ticket.id });
  assert.equal((await audits(a.ticket.id)).filter((x) => x.action === 'ticket.checked_out').length, 1);
});

// ---------------------------------------------------------------- revocation

test('revoking an issued ticket releases the seat and lock and records who, when and why', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  const r = await revoke(admin, ticket.id, '  Seat was reported damaged  ');
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.status, 'revoked');
  assert.equal(r.body.ticket.revokeReason, 'Seat was reported damaged');
  assert.ok(r.body.ticket.endedAt);
  assert.deepEqual(r.body.allowedActions, []);

  const doc = await ticketDoc(ticket.id);
  assert.equal(doc.endedBy, admin.uid);
  assert.equal(doc.endReason, 'revoked');
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.deepEqual(await lock(student.uid), {});

  const log = (await audits(ticket.id)).find((a) => a.action === 'ticket.revoked');
  assert.equal(log.actorUid, admin.uid);
  assert.equal(log.details.revokeReason, 'Seat was reported damaged');
  assert.equal(log.details.from, 'issued');
  assert.ok(log.at, 'audit entries carry a timestamp');
  assert.equal((await call(student, 'GET', '/api/tickets/history')).body.tickets[0].status, 'revoked');
});

test('revoking a checked-in ticket releases the occupied seat', async () => {
  await h.pcs('pc-01');
  const { ticket } = await stub('computer-station');
  await checkIn(admin, ticket.id);
  assert.equal((await revoke(admin, ticket.id)).status, 200);
  assert.deepEqual((await resource('pc-01')).allocation, FREE);
});

test('revoking an active Wi-Fi voucher releases its lock and ends password access, without exposing the password', async () => {
  const { student, ticket } = await stub('wifi-voucher');
  const printed = await call(student, 'GET', `/api/tickets/${ticket.id}/print`);
  const secret = printed.body.voucher.password.slice(5);

  const looked = await resolve(admin, ticket.qrPayload);
  assert.deepEqual(looked.body.allowedActions, ['revoke']);
  const r = await revoke(admin, ticket.id, 'Shared outside the library');
  assert.equal(r.body.ticket.status, 'revoked');
  assert.deepEqual(await lock(student.uid), {});

  assert.deepEqual((await call(student, 'GET', `/api/tickets/${ticket.id}/print`)).body.voucher, { demo: true, password: null, passwordAvailable: false });
  const everything = JSON.stringify([looked.body, r.body, await audits(ticket.id), await resolve(admin, ticket.id).then((x) => x.body)]);
  assert.ok(!everything.includes(secret), 'voucher password leaked through admin operations');
  assert.ok(!everything.includes('"ct"') && !everything.includes('credential'));
  assert.equal((await issue(student, 'wifi-voucher')).status, 201, 'the lock is free again');
});

test('a reason is required and validated; students cannot revoke', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  for (const reason of [undefined, '', '   ', 'ab', 'x'.repeat(201), 'line\nbreak', 5, null, ['reason'], { a: 1 }]) {
    const r = await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/revoke`, { reason });
    assert.equal(r.status, 400, JSON.stringify(reason));
  }
  assert.equal((await revoke(student, ticket.id)).status, 403);
  assert.equal((await ticketDoc(ticket.id)).status, 'issued');
  assert.equal((await audits(ticket.id)).filter((a) => a.action === 'ticket.revoked').length, 0);
});

test('terminal tickets cannot be revoked as a new transition; repeating the same revocation is a quiet no-op', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03');
  const out = await stub();
  await checkIn(admin, out.ticket.id);
  await checkOut(admin, out.ticket.id);
  const gone = await stub();
  h.advance(20);
  await resolve(admin, gone.ticket.qrPayload); // lazily expired
  const dead = await stub();
  await revoke(admin, dead.ticket.id);

  for (const id of [out.ticket.id, gone.ticket.id]) {
    const r = await revoke(admin, id);
    assert.equal(r.status, 409, id);
    assert.equal(r.code, 'invalid-transition');
  }
  const again = await revoke(admin, dead.ticket.id, 'A different reason this time');
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal((await ticketDoc(dead.ticket.id)).revokeReason, 'Left belongings unattended');
  assert.equal((await audits(dead.ticket.id)).filter((a) => a.action === 'ticket.revoked').length, 1);
  assert.equal((await ticketDoc(out.ticket.id)).status, 'checked_out');
  assert.equal((await ticketDoc(gone.ticket.id)).status, 'expired');
});

// ---------------------------------------------------------------- expiry and no-show

test('no-show: scanning an overdue ticket releases the assigned seat with reason no_show, no cleanup job needed', async () => {
  await h.seats('silent-seat-01');
  const { student, ticket } = await stub();
  h.advance(16);
  const r = await resolve(admin, ticket.qrPayload);
  assert.equal(r.body.ticket.status, 'expired');
  assert.equal(r.body.ticket.endReason, 'no_show');
  assert.deepEqual(r.body.allowedActions, []);
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.deepEqual(await lock(student.uid), {});
  const log = (await audits(ticket.id)).find((a) => a.action === 'ticket.expired');
  assert.equal(log.actorUid, null);
  assert.equal(log.details.reason, 'no_show');
});

test('an occupied seat is released at the original full expiry, with reason expired', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  await checkIn(admin, ticket.id);
  h.advance(119);
  assert.equal((await resolve(admin, ticket.qrPayload)).body.ticket.status, 'checked_in');
  h.advance(2);
  const r = await resolve(admin, ticket.qrPayload);
  assert.equal(r.body.ticket.status, 'expired');
  assert.equal(r.body.ticket.endReason, 'expired');
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
});

test('no-show applies to physical stubs only: a voucher runs for wifiVoucherMinutes with no grace', async () => {
  await h.setSettings({ wifiVoucherMinutes: 30 });
  const { ticket } = await stub('wifi-voucher');
  assert.equal(ticket.checkInDeadline, null);
  assert.equal((Date.parse(ticket.expiresAt) - Date.parse(ticket.issuedAt)) / 60_000, 30);
  h.advance(29);
  assert.equal((await resolve(admin, ticket.qrPayload)).body.ticket.status, 'issued');
  h.advance(2);
  const r = await resolve(admin, ticket.qrPayload);
  assert.equal(r.body.ticket.endReason, 'expired');
});

test('check-out of an overdue ticket loses to expiry: server time decides, and the seat is released once', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  await checkIn(admin, ticket.id);
  h.advance(121);
  const r = await checkOut(admin, ticket.id);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'ticket-expired');
  assert.equal((await ticketDoc(ticket.id)).status, 'expired');
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
});

// ---------------------------------------------------------------- races (real transactions, different server clocks)

const settled = (promises) => Promise.allSettled(promises).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason })));

// Contention can make a raw transaction give up with a clean 503 "busy" (the caller retries). That must leave the
// data untouched, so these races assert the invariants on the FINAL state rather than who won.
const okOrClean = (r) => r.error === undefined || [409, 503].includes(r.error.status) || (console.error('UNEXPECTED', r.error?.code, r.error?.message), false);

test('check-in racing the no-show deadline always ends in one consistent state', async () => {
  for (let round = 0; round < 4; round++) {
    await h.reset();
    await h.seats('silent-seat-01');
    const { student, ticket } = await stub();
    const deadline = Date.parse(ticket.checkInDeadline);
    const results = await settled([
      transitionTicket({ db, ticketId: ticket.id, to: 'checked_in', now: at(deadline - 1000), actorUid: 'admin' }), // admin's clock: still in time
      transitionTicket({ db, ticketId: ticket.id, to: 'expired', now: at(deadline + 1000), onlyIfDue: true }), // sweeper's clock: already late
    ]);
    assert.ok(results.every(okOrClean), `round ${round}: ${JSON.stringify(results.map((r) => r.error?.status ?? r.status))}`);

    const doc = await ticketDoc(ticket.id);
    const seat = (await resource('silent-seat-01')).allocation;
    const lockNow = await lock(student.uid);
    const terminal = (await actions(ticket.id)).filter((x) => x !== 'ticket.issued');
    if (doc.status === 'checked_in') {
      assert.deepEqual(seat, { assigned: 0, occupied: 1, held: 0, ticketId: ticket.id }, `round ${round}`);
      assert.deepEqual(lockNow, { 'silent-room': ticket.id });
      assert.deepEqual(terminal, ['ticket.checked_in']);
    } else if (doc.status === 'expired') {
      assert.deepEqual(seat, FREE, `round ${round}`);
      assert.deepEqual(lockNow, {});
      assert.deepEqual(terminal, ['ticket.expired']);
    } else { // both attempts were told to retry: nothing may have changed
      assert.equal(doc.status, 'issued');
      assert.deepEqual(seat, { assigned: 1, occupied: 0, held: 0, ticketId: ticket.id });
      assert.deepEqual(lockNow, { 'silent-room': ticket.id });
      assert.deepEqual(terminal, []);
    }
  }
});

test('check-in and expiry that both see the deadline as passed produce exactly one expiry', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  const late = at(Date.parse(ticket.checkInDeadline) + 1);
  const results = await settled([
    transitionTicket({ db, ticketId: ticket.id, to: 'checked_in', now: late }),
    transitionTicket({ db, ticketId: ticket.id, to: 'expired', now: late, onlyIfDue: true }),
    transitionTicket({ db, ticketId: ticket.id, to: 'checked_in', now: late }),
    transitionTicket({ db, ticketId: ticket.id, to: 'expired', now: late, onlyIfDue: true }),
  ]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.equal((await ticketDoc(ticket.id)).status, 'expired');
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.equal((await actions(ticket.id)).filter((x) => x === 'ticket.expired').length, 1);
});

test('check-out racing full expiry never double-releases, even when the seat is reassigned in between', async () => {
  for (let round = 0; round < 4; round++) {
    await h.reset();
    await h.seats('silent-seat-01');
    const a = await stub();
    await checkIn(admin, a.ticket.id);
    const end = Date.parse(a.ticket.expiresAt);
    const results = await settled([
      transitionTicket({ db, ticketId: a.ticket.id, to: 'checked_out', now: at(end - 1000), actorUid: 'admin' }),
      transitionTicket({ db, ticketId: a.ticket.id, to: 'expired', now: at(end + 1000), onlyIfDue: true }),
    ]);
    assert.ok(results.every(okOrClean), `round ${round}`);
    assert.ok(results.filter((r) => r.changed === true).length <= 1, `round ${round}: both claimed the release`);

    const doc = await ticketDoc(a.ticket.id);
    if (doc.status === 'checked_in') { // both were told to retry; the seat must still be occupied by A
      assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 1, held: 0, ticketId: a.ticket.id });
      continue;
    }
    assert.ok(['checked_out', 'expired'].includes(doc.status), `round ${round}: ${doc.status}`);
    assert.deepEqual((await resource('silent-seat-01')).allocation, FREE, `round ${round}`);

    h.time.now = at(end - 60_000); // back inside everyone's validity: B takes the freed seat
    const b = await stub();
    assert.equal(b.ticket.resource.id, 'silent-seat-01');
    // Both operations are replayed late, as a retrying client or a second sweeper might.
    await settled([
      transitionTicket({ db, ticketId: a.ticket.id, to: 'checked_out', now: at(end + 5000) }),
      transitionTicket({ db, ticketId: a.ticket.id, to: 'expired', now: at(end + 5000), onlyIfDue: true }),
    ]);
    assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: b.ticket.id }, `round ${round}: replay touched B`);
    assert.deepEqual(await lock(b.student.uid), { 'silent-room': b.ticket.id });
  }
});

test('revocation racing check-out leaves consistent counters and exactly one terminal outcome', async () => {
  for (let round = 0; round < 4; round++) {
    await h.reset();
    await h.seats('silent-seat-01');
    const { student, ticket } = await stub();
    await checkIn(admin, ticket.id);
    const [out, rev] = await Promise.all([checkOut(admin, ticket.id), revoke(admin, ticket.id)]);
    assert.deepEqual([out.status, rev.status].sort(), [200, 409], `round ${round}: ${out.status}/${rev.status}`);
    const doc = await ticketDoc(ticket.id);
    assert.equal(doc.status, out.status === 200 ? 'checked_out' : 'revoked');
    assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
    assert.deepEqual(await lock(student.uid), {});
    const terminal = (await actions(ticket.id)).filter((x) => x === 'ticket.checked_out' || x === 'ticket.revoked');
    assert.equal(terminal.length, 1);
  }
});

test('many operations at once on many tickets keep every counter exact', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03', 'silent-seat-04');
  const stubs = await Promise.all([stub(), stub(), stub(), stub()]);
  await Promise.all(stubs.map((s) => checkIn(admin, s.ticket.id)));
  await Promise.all([
    checkOut(admin, stubs[0].ticket.id), checkOut(admin, stubs[0].ticket.id),
    revoke(admin, stubs[1].ticket.id), revoke(admin, stubs[1].ticket.id),
    checkOut(admin, stubs[2].ticket.id),
  ]);
  const seatOf = (s) => resource(s.ticket.resource.id).then((r) => r.allocation); // seats were handed out concurrently, so look each one up
  for (const s of stubs.slice(0, 3)) assert.deepEqual(await seatOf(s), FREE, s.ticket.id);
  assert.deepEqual(await seatOf(stubs[3]), { assigned: 0, occupied: 1, held: 0, ticketId: stubs[3].ticket.id });
});

// ---------------------------------------------------------------- stale QR replay

test('a stale QR cannot act on a seat that was later given to someone else', async () => {
  await h.seats('silent-seat-01');
  const a = await stub();
  h.advance(20);
  const b = await stub(); // A is released (no-show) as part of issuing; B now holds seat 01
  assert.equal(b.ticket.resource.id, 'silent-seat-01');

  const staleView = await resolve(admin, a.ticket.qrPayload);
  assert.equal(staleView.body.ticket.status, 'expired');
  assert.deepEqual(staleView.body.allowedActions, []);
  for (const r of [await checkIn(admin, a.ticket.id), await checkOut(admin, a.ticket.id), await revoke(admin, a.ticket.id)]) assert.equal(r.status, 409);
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: b.ticket.id });
  assert.deepEqual(await lock(b.student.uid), { 'silent-room': b.ticket.id });
  assert.equal((await ticketDoc(b.ticket.id)).status, 'issued');
});

test('even if a stale ticket were wrongly still active, it can neither occupy nor release the new owner\'s seat', async () => {
  await h.seats('silent-seat-01');
  const a = await stub();
  h.advance(20);
  const b = await stub();
  // Corrupt A back to "issued" with a far deadline: the worst case a replayed or inconsistent record could present.
  await db.doc(`tickets/${a.ticket.id}`).update({ status: 'issued', endedAt: null, endReason: null, checkInDeadline: null, activeDeadline: (await ticketDoc(b.ticket.id)).expiresAt, expiresAt: (await ticketDoc(b.ticket.id)).expiresAt });

  const view = await resolve(admin, a.ticket.qrPayload);
  assert.deepEqual(view.body.warnings, ['resource-mismatch']);
  assert.ok(!view.body.allowedActions.includes('check_in'));
  assert.equal((await checkIn(admin, a.ticket.id)).code, 'resource-mismatch');
  assert.equal((await revoke(admin, a.ticket.id)).status, 200); // may be ended, but...
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: b.ticket.id }); // ...never frees B's seat
  assert.deepEqual(await lock(b.student.uid), { 'silent-room': b.ticket.id });
});

// ---------------------------------------------------------------- audit and rollback

test('every administrative action is audited with actor and detail; refused requests leave no trace', async () => {
  await h.seats('silent-seat-01');
  const { ticket } = await stub();
  await checkOut(admin, ticket.id); // refused: not checked in
  await checkIn(admin, ticket.id, {}); // refused: identity not confirmed
  await revoke(admin, ticket.id, 'x'); // refused: reason too short
  assert.deepEqual(await actions(ticket.id), ['ticket.issued']);

  await checkIn(admin, ticket.id);
  await checkOut(admin, ticket.id);
  const logs = await audits(ticket.id);
  assert.deepEqual(logs.map((l) => l.action).sort(), ['ticket.checked_in', 'ticket.checked_out', 'ticket.issued']);
  for (const l of logs.filter((x) => x.action !== 'ticket.issued')) assert.equal(l.actorUid, admin.uid);
  assert.equal(logs.find((l) => l.action === 'ticket.checked_out').details.from, 'checked_in');
});

function failingAudit() {
  return new Proxy(db, {
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
}

test('a failure at the last step rolls a check-in, check-out and revocation back completely', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const a = await stub();
  const broken = failingAudit();
  const now = new Date(h.time.now);

  await assert.rejects(transitionTicket({ db: broken, ticketId: a.ticket.id, to: 'checked_in', now, actorUid: 'admin' }), /injected failure/);
  assert.equal((await ticketDoc(a.ticket.id)).status, 'issued');
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: a.ticket.id });

  await checkIn(admin, a.ticket.id);
  await assert.rejects(transitionTicket({ db: broken, ticketId: a.ticket.id, to: 'checked_out', now, actorUid: 'admin' }), /injected failure/);
  assert.equal((await ticketDoc(a.ticket.id)).status, 'checked_in');
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 1, held: 0, ticketId: a.ticket.id });
  assert.deepEqual(await lock(a.student.uid), { 'silent-room': a.ticket.id });

  await assert.rejects(transitionTicket({ db: broken, ticketId: a.ticket.id, to: 'revoked', now, actorUid: 'admin', details: { revokeReason: 'test' } }), /injected failure/);
  assert.equal((await ticketDoc(a.ticket.id)).status, 'checked_in');
  assert.equal((await ticketDoc(a.ticket.id)).revokeReason, undefined);
  assert.deepEqual(await actions(a.ticket.id), ['ticket.checked_in', 'ticket.issued']);

  assert.equal((await checkOut(admin, a.ticket.id)).status, 200, 'the ticket is still fully usable afterwards');
});

// ---------------------------------------------------------------- inventory reflects assigned vs occupied

test('the admin summary and resource list separate assigned from occupied seats', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03');
  const a = await stub();
  const b = await stub();
  await checkIn(admin, a.ticket.id);

  const s = (await call(admin, 'GET', '/api/admin/summary')).body.byType['silent-seat'];
  assert.deepEqual({ total: s.total, assigned: s.assigned, occupied: s.occupied, inUse: s.inUse, available: s.available }, { total: 3, assigned: 1, occupied: 1, inUse: 2, available: 1 });
  const list = (await call(admin, 'GET', '/api/admin/resources?type=silent-seat')).body.resources;
  assert.deepEqual(list.map((r) => [r.id, r.allocation.assigned, r.allocation.occupied]), [['silent-seat-01', 0, 1], ['silent-seat-02', 1, 0], ['silent-seat-03', 0, 0]]);

  await checkOut(admin, a.ticket.id);
  const after = (await call(admin, 'GET', '/api/admin/summary')).body.byType['silent-seat'];
  assert.deepEqual({ assigned: after.assigned, occupied: after.occupied, available: after.available }, { assigned: 1, occupied: 0, available: 2 });
  void b;
});
