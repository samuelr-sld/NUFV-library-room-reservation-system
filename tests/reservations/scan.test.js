import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { harness } from './harness.js';

// The administrator scanner: NUFV1 (physical stubs) and NUFR1 (discussion room reservations) through one entry point,
// plus authorization across every workflow's routes.
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
  await h.room('room-a', { capacity: 4 });
  await h.setChain();
});

const scan = (who, reference) => call(who, 'POST', '/api/admin/qr/resolve', { reference });
const randomRef = () => randomBytes(18).toString('base64url');

// A confirmed booking tomorrow 09:00-10:00 (the fake clock starts at 10:00 today, Manila time).
async function confirmed(extra, who) {
  const student = who ?? await h.student();
  const r = await reserve(student, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.reservation.id;
  assert.equal((await adminDecide(admin, id, 0)).status, 200);
  const doc = await resDoc(id);
  return { student, id, doc, payload: `NUFR1:${doc.qrRef}` };
}

test('both code formats resolve through the one scanner, each with its own shape; stubs behave exactly as before', async () => {
  const { student, payload } = await confirmed();
  const issued = await call(student, 'POST', '/api/tickets', { service: 'wifi-voucher' });
  assert.equal(issued.status, 201);

  const stub = await scan(admin, issued.body.ticket.qrPayload);
  assert.equal(stub.status, 200);
  assert.equal(stub.body.kind, 'ticket');
  assert.equal(stub.body.ticket.id, issued.body.ticket.id);
  assert.deepEqual(stub.body.allowedActions, ['revoke']);

  const res = await scan(admin, payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'reservation');
  assert.equal(res.body.reservation.status, 'confirmed');
  assert.equal(res.body.reservation.room, 'ROOM-A');
  assert.deepEqual([res.body.reservation.date, res.body.reservation.startTime, res.body.reservation.endTime, res.body.reservation.timezone], [day(1), '09:00', '10:00', 'Asia/Manila']);
  assert.deepEqual(res.body.student, { fullName: 'Test Person', studentNumber: '2023-000000', status: 'active' });
  assert.equal(res.body.allowedActions, undefined, 'no attendance transitions exist for reservations');

  // The original stub route is untouched and does not accept reservation codes.
  assert.equal((await call(admin, 'POST', '/api/admin/tickets/resolve', { reference: issued.body.ticket.qrPayload })).status, 200);
  assert.equal((await call(admin, 'POST', '/api/admin/tickets/resolve', { reference: payload })).code, 'invalid-qr');
});

test('the confirmation reference printed on the confirmation works like its QR; a bare 24-character reference is a stub reference only', async () => {
  const { doc, id } = await confirmed();
  const byRef = await scan(admin, doc.confirmationRef.toLowerCase());
  assert.equal(byRef.status, 200);
  assert.equal(byRef.body.reservation.id, id);
  const bare = await scan(admin, doc.qrRef);
  assert.equal(bare.code, 'unknown-qr', 'looked up as a stub, where it does not exist');
  assert.match(bare.body.error.message, /stub/);
  assert.equal((await scan(admin, `NUFV1:${doc.qrRef}`)).code, 'unknown-qr', 'a reservation reference under the stub prefix is not a reservation');
});

test('a confirmed booking is valid only within its approved time, judged on the server clock', async () => {
  const { payload } = await confirmed();
  const at = async () => (await scan(admin, payload)).body;

  let v = await at();
  assert.deepEqual([v.period, v.validNow], ['upcoming', false]);
  h.advance(23 * 60 - 1); // one minute before the start
  assert.equal((await at()).validNow, false);
  h.advance(1); // exactly the start
  v = await at();
  assert.deepEqual([v.period, v.validNow], ['in_progress', true]);
  h.advance(59);
  assert.equal((await at()).validNow, true);
  h.advance(1); // exactly the end: the first instant too late
  v = await at();
  assert.deepEqual([v.period, v.validNow, v.reservation.status], ['ended', false, 'confirmed']);
});

test('cancelled, rejected and expired reservations are shown as such and are never valid; unknown and malformed codes are refused', async () => {
  const { student, id, doc, payload } = await confirmed();
  assert.equal((await call(student, 'POST', `/api/reservations/${id}/cancel`)).status, 200);
  const cancelled = (await scan(admin, payload)).body;
  assert.deepEqual([cancelled.reservation.status, cancelled.validNow, cancelled.reservation.endReason], ['cancelled', false, 'cancel']);
  assert.equal((await scan(admin, doc.confirmationRef)).body.reservation.status, 'cancelled');

  // Rejected and expired requests never receive a code, so their state is reached here by giving them one.
  for (const [status, startTime, endTime] of [['rejected', '13:00', '14:00'], ['expired', '15:00', '16:00']]) {
    const made = await reserve(await h.student(), { startTime, endTime });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const other = made.body.reservation.id;
    const qrRef = randomRef();
    await db.doc(`reservations/${other}`).update({ status, qrRef, endReason: status === 'expired' ? 'approval_timeout' : 'reject' });
    const v = (await scan(admin, `NUFR1:${qrRef}`)).body;
    assert.deepEqual([v.reservation.status, v.validNow], [status, false]);
  }

  assert.equal((await scan(admin, `NUFR1:${randomRef()}`)).code, 'unknown-qr');
  assert.equal((await scan(admin, 'RC-0000000000')).code, 'unknown-qr');
  for (const bad of ['NUFR1:', 'NUFR1:short', `NUFR1:${'a'.repeat(25)}`, 'RC-ILOU000000', 'NUFR1:' + "x'; drop", '', 42, null, ['NUFR1:x']]) {
    const r = await scan(admin, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('a reservation scan never exposes approval secrets, approver addresses or workflow internals', async () => {
  await h.setChain(DEAN);
  const student = await h.student();
  const r = await reserve(student);
  const id = r.body.reservation.id;
  await h.deliver();
  assert.equal((await h.decide(DEAN)).status, 200);
  assert.equal((await adminDecide(admin, id, 1)).status, 200);
  const doc = await resDoc(id);

  const res = await scan(admin, `NUFR1:${doc.qrRef}`);
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  for (const secret of [doc.qrRef, DEAN, 'dean', h.challengeOf(DEAN), 'activeChallengeId', 'workflow', 'approvals', 'session', 'otp', 'hash', student.uid, 'uid']) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('every administrator route refuses anonymous callers, students, suspended administrators and approver sessions', async () => {
  const student = await h.student();
  const suspended = await h.actor({ role: 'admin', status: 'suspended' });
  const routes = [
    ['POST', '/api/admin/qr/resolve', { reference: 'NUFR1:' + randomRef() }],
    ['GET', '/api/admin/ops/approvals'],
    ['GET', '/api/admin/ops/emails'],
    ['POST', `/api/admin/ops/emails/${'0'.repeat(32)}/requeue`, {}],
    ['GET', '/api/admin/ops/diagnostics'],
    ['GET', '/api/admin/audit'],
    ['POST', '/api/admin/tickets/resolve', { reference: 'SR-0123456789' }],
    ['GET', '/api/admin/reservations'],
    ['PUT', '/api/admin/approval-workflow', { steps: [], stepHours: 48 }],
    ['GET', '/api/admin/a-route-nobody-has-written-yet'], // the guard is structural: it covers routes added later too
    ['DELETE', '/api/admin/ops/emails/x/y/z'],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await call(null, method, path, body)).status, 401, `anonymous ${path}`);
    assert.equal((await call(student, method, path, body)).status, 403, `student ${path}`);
    assert.equal((await call(suspended, method, path, body)).status, 403, `suspended ${path}`);
    assert.equal((await call('not-a-token', method, path, body)).status, 401, `forged ${path}`);
  }

  // An approver's session secret is not an identity anywhere else.
  await h.setChain(DEAN);
  await reserve(student);
  await h.deliver();
  const { session } = await h.signIn(DEAN);
  assert.equal((await call(session, 'GET', '/api/admin/ops/approvals')).status, 401);
  assert.equal((await call(session, 'GET', '/api/reservations')).status, 401);
});

test('administrators and approvers cannot use the student workflows either', async () => {
  const student = await h.student();
  const { id } = await confirmed({}, student);
  const verifiedAdmin = await h.actor({ role: 'admin', emailVerified: true }); // verified, so only the role stands in the way
  for (const [method, path, body] of [
    ['POST', '/api/reservations', { roomId: 'room-a' }], ['GET', '/api/reservations'], ['GET', `/api/reservations/${id}/print`],
    ['POST', `/api/reservations/${id}/cancel`], ['POST', '/api/tickets', { service: 'wifi-voucher' }], ['GET', '/api/tickets/active'],
  ]) {
    assert.equal((await call(verifiedAdmin, method, path, body)).status, 403, `admin ${method} ${path}`);
  }
  // Another student cannot see or cancel this student's reservation.
  const other = await h.student();
  assert.equal((await call(other, 'GET', `/api/reservations/${id}`)).status, 404);
  assert.equal((await call(other, 'POST', `/api/reservations/${id}/cancel`)).status, 404);
  // An approver link cannot decide the administrator's final step.
  assert.equal((await call(null, 'POST', `/api/admin/reservations/${id}/decision`, { decision: 'reject', step: 0 })).status, 401);
});

test('the printable confirmation carries the same reference the scanner accepts', async () => {
  const { student, id, payload } = await confirmed();
  const print = await call(student, 'GET', `/api/reservations/${id}/print`);
  assert.equal(print.status, 200);
  assert.equal(print.body.qrSvg, await QRCode.toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  assert.equal(print.body.reservation.qrPayload, payload);
  assert.equal((await scan(admin, print.body.reservation.qrPayload)).body.reservation.id, id);
  // No printable confirmation exists for a request that is not confirmed.
  const mine = await h.student();
  const pending = await reserve(mine, { startTime: '13:00', endTime: '14:00' });
  assert.equal((await call(mine, 'GET', `/api/reservations/${pending.body.reservation.id}/print`)).code, 'not-confirmed');
});
