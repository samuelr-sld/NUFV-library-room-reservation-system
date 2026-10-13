import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { QR_PREFIX } from '../../server/tickets.js';

const h = harness();
const { db, call, issue, resource, ticketDoc, lock } = h;

before(() => h.start());
after(() => h.stop());
beforeEach(() => h.reset());

const minutesBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 60_000;

// ---------------------------------------------------------------- issuing each service

test('silent room: the first free seat is assigned atomically, with ticket, lock, counter and audit record', async () => {
  await h.seats('silent-seat-02', 'silent-seat-01');
  const s = await h.student();
  const res = await issue(s, 'silent-room', { resourceId: 'silent-seat-02', seat: 'silent-seat-02' }); // a student cannot pick a seat
  assert.equal(res.status, 201);
  const t = res.body.ticket;
  assert.match(t.id, /^SR-[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(res.body.created, true);
  assert.deepEqual(t.resource, { id: 'silent-seat-01', label: 'SILENT-SEAT-01' });
  assert.equal(t.status, 'issued');
  assert.equal(minutesBetween(t.issuedAt, t.expiresAt), 120);
  assert.equal(minutesBetween(t.issuedAt, t.checkInDeadline), 15);
  assert.ok(t.qrPayload.startsWith(QR_PREFIX));

  assert.deepEqual(await resource('silent-seat-01').then((r) => r.allocation), { assigned: 1, occupied: 0, held: 0, ticketId: t.id });
  assert.deepEqual((await resource('silent-seat-02')).allocation, { assigned: 0, occupied: 0, held: 0 });
  assert.deepEqual(await lock(s.uid), { 'silent-room': t.id });
  const doc = await ticketDoc(t.id);
  assert.equal(doc.uid, s.uid);
  assert.equal(doc.resourceId, 'silent-seat-01');

  const logs = (await db.collection('auditLogs').where('targetId', '==', t.id).get()).docs.map((d) => d.data());
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'ticket.issued');
  assert.equal(logs[0].actorUid, s.uid);
  assert.equal(logs[0].details.resourceId, 'silent-seat-01');
});

test('computer station: same workflow, 60 minute ticket, first station by id', async () => {
  await h.pcs('pc-02', 'pc-01');
  const s = await h.student();
  const res = await issue(s, 'computer-station');
  assert.equal(res.status, 201);
  assert.match(res.body.ticket.id, /^CS-/);
  assert.equal(res.body.ticket.resource.id, 'pc-01');
  assert.equal(minutesBetween(res.body.ticket.issuedAt, res.body.ticket.expiresAt), 60);
  assert.equal((await resource('pc-01')).allocation.assigned, 1);
  assert.equal((await resource('pc-02')).allocation.assigned, 0);
});

test('wi-fi voucher: no resource, demo password only via print, ciphertext at rest, no password in audit', async () => {
  const s = await h.student();
  const res = await issue(s, 'wifi-voucher');
  assert.equal(res.status, 201);
  const t = res.body.ticket;
  assert.match(t.id, /^WF-/);
  assert.equal(t.resource, null);
  assert.equal(minutesBetween(t.issuedAt, t.expiresAt), 180);
  assert.equal(t.checkInDeadline, null);
  assert.doesNotMatch(JSON.stringify(res.body), /DEMO-/);

  const print = await call(s, 'GET', `/api/tickets/${t.id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.body.voucher.password, /^DEMO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(print.body.voucher.demo, true);
  const password = print.body.voucher.password;

  const stored = JSON.stringify(await ticketDoc(t.id));
  assert.ok(!stored.includes(password) && !stored.includes(password.slice(5)), 'plaintext password stored');
  assert.ok((await ticketDoc(t.id)).credential.ct);
  assert.ok(!JSON.stringify(await h.allAudits()).includes(password.slice(5)), 'password in audit log');
});

// ---------------------------------------------------------------- assignment order and exclusions

test('assignment is deterministic: lowest id first, regardless of creation order', async () => {
  await h.seats('silent-seat-03', 'silent-seat-01', 'silent-seat-02');
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await issue(await h.student(), 'silent-room')).body.ticket.resource.id);
  assert.deepEqual(got, ['silent-seat-01', 'silent-seat-02', 'silent-seat-03']);
  const none = await issue(await h.student(), 'silent-room');
  assert.equal(none.status, 409);
  assert.equal(none.code, 'no-resource-available');
});

test('maintenance, retired and already-allocated resources are never assigned', async () => {
  await h.seed('seat-a', 'silent-seat', { status: 'maintenance' });
  await h.seed('seat-b', 'silent-seat', { status: 'retired' });
  await h.seed('seat-c', 'silent-seat', { allocation: { assigned: 1, occupied: 0, held: 0 } });
  await h.seed('seat-d', 'silent-seat', { allocation: { assigned: 0, occupied: 1, held: 0 } });
  await h.seed('seat-e', 'silent-seat', { allocation: { assigned: 0, occupied: 0, held: 1 } });
  await h.seed('seat-f', 'silent-seat');
  const res = await issue(await h.student(), 'silent-room');
  assert.equal(res.body.ticket.resource.id, 'seat-f');
  for (const id of ['seat-a', 'seat-b']) assert.equal((await resource(id)).allocation.assigned, 0, id);
  assert.equal((await issue(await h.student(), 'silent-room')).code, 'no-resource-available');
});

test('only resources of the requested type are considered', async () => {
  await h.pcs('pc-01');
  assert.equal((await issue(await h.student(), 'silent-room')).code, 'no-resource-available');
  assert.equal((await issue(await h.student(), 'computer-station')).status, 201);
});

// ---------------------------------------------------------------- concurrency (real emulator transactions)

test('six students race for the last seat: exactly one wins, the rest get a clean 409', async () => {
  await h.seats('silent-seat-01');
  const students = await Promise.all(Array.from({ length: 6 }, () => h.student()));
  const results = await Promise.all(students.map((s) => issue(s, 'silent-room')));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 409 && r.code === 'no-resource-available').length, 5);
  assert.equal((await db.collection('tickets').get()).size, 1);
  assert.equal((await resource('silent-seat-01')).allocation.assigned, 1);
  const winner = results.find((r) => r.status === 201).body.ticket;
  assert.equal((await resource('silent-seat-01')).allocation.ticketId, winner.id);
});

test('eight students and three seats: three distinct seats are assigned, never one twice', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03');
  const students = await Promise.all(Array.from({ length: 8 }, () => h.student()));
  const results = await Promise.all(students.map((s) => issue(s, 'silent-room')));
  const won = results.filter((r) => r.status === 201);
  assert.equal(won.length, 3, JSON.stringify(results.map((r) => r.status)));
  assert.deepEqual(won.map((r) => r.body.ticket.resource.id).sort(), ['silent-seat-01', 'silent-seat-02', 'silent-seat-03']);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  for (const id of ['silent-seat-01', 'silent-seat-02', 'silent-seat-03']) assert.equal((await resource(id)).allocation.assigned, 1, id);
});

test('one student sending the same request five times at once gets one ticket (idempotent)', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const s = await h.student();
  const results = await Promise.all(Array.from({ length: 5 }, () => issue(s, 'silent-room')));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.body.ticket.id)).size, 1);
  assert.equal((await db.collection('tickets').get()).size, 1);
  assert.equal((await resource('silent-seat-02')).allocation.assigned, 0);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'ticket.issued').get()).size, 1);
});

test('one student asking for all three services at once with a limit of one gets exactly one stub', async () => {
  await h.seats('silent-seat-01');
  await h.pcs('pc-01');
  const s = await h.student();
  const results = await Promise.all(['silent-room', 'computer-station', 'wifi-voucher'].map((svc) => issue(s, svc)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.code === 'ticket-limit-reached').length, 2);
  assert.equal(Object.keys(await lock(s.uid)).length, 1);
  assert.equal((await db.collection('tickets').get()).size, 1);
  const used = [(await resource('silent-seat-01')), (await resource('pc-01'))].filter((r) => r.allocation.assigned).length;
  assert.equal(used, results.find((r) => r.status === 201).body.ticket.resource ? 1 : 0, 'allocation must match the single ticket');
});

// ---------------------------------------------------------------- limits and idempotency

test('the active-ticket limit counts every service type; the default is one', async () => {
  await h.seats('silent-seat-01');
  await h.pcs('pc-01');
  const s = await h.student();
  assert.equal((await issue(s, 'silent-room')).status, 201);
  for (const svc of ['computer-station', 'wifi-voucher']) {
    const r = await issue(s, svc);
    assert.equal(r.status, 409, svc);
    assert.equal(r.code, 'ticket-limit-reached');
  }
  assert.equal((await resource('pc-01')).allocation.assigned, 0, 'a refused request must not allocate');
});

test('raising the limit allows a mix of services, but never two of the same one', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  await h.pcs('pc-01');
  await h.setSettings({ maxActiveTicketsPerStudent: 2 });
  const s = await h.student();
  const first = await issue(s, 'silent-room');
  assert.equal((await issue(s, 'wifi-voucher')).status, 201);
  assert.equal((await issue(s, 'computer-station')).code, 'ticket-limit-reached'); // third distinct service, limit 2
  const again = await issue(s, 'silent-room');
  assert.equal(again.status, 200);
  assert.equal(again.body.ticket.id, first.body.ticket.id);
  assert.equal((await resource('silent-seat-02')).allocation.assigned, 0);

  await h.setSettings({ maxActiveTicketsPerStudent: 3 });
  assert.equal((await issue(s, 'computer-station')).status, 201);
  assert.equal(Object.keys(await lock(s.uid)).length, 3);
});

test('duplicate request for the same service returns the existing stub, unchanged and not re-audited', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const s = await h.student();
  const first = await issue(s, 'silent-room');
  const second = await issue(s, 'silent-room');
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.deepEqual(second.body.ticket, first.body.ticket);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'ticket.issued').get()).size, 1);
});

test('durations come from settings', async () => {
  await h.seats('silent-seat-01');
  await h.setSettings({ silentRoomTicketMinutes: 45, noShowGraceMinutes: 5 });
  const t = (await issue(await h.student(), 'silent-room')).body.ticket;
  assert.equal(minutesBetween(t.issuedAt, t.expiresAt), 45);
  assert.equal(minutesBetween(t.issuedAt, t.checkInDeadline), 5);
});

test('a grace period of zero switches the no-show rule off', async () => {
  await h.seats('silent-seat-01');
  await h.setSettings({ noShowGraceMinutes: 0 });
  const s = await h.student();
  const t = (await issue(s, 'silent-room')).body.ticket;
  assert.equal(t.checkInDeadline, null);
  h.advance(60); // well past the default 15 minute grace, still inside the 120 minute ticket
  assert.equal((await call(s, 'GET', '/api/tickets/active')).body.tickets.length, 1);
  assert.equal((await ticketDoc(t.id)).status, 'issued');
});

test('invalid requests: unknown service, missing service, wrong body', async () => {
  const s = await h.student();
  for (const body of [{ service: 'discussion-room' }, { service: 'laptop' }, {}, { service: 5 }, { service: ['silent-room'] }, []]) {
    const r = await call(s, 'POST', '/api/tickets', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await db.collection('tickets').get()).size, 0);
});
