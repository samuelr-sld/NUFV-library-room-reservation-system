import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { expireDue, transitionTicket, TRANSITIONS } from '../../server/tickets.js';

const h = harness();
const { db, call, issue, resource, ticketDoc, lock } = h;

before(() => h.start());
after(() => h.stop());
beforeEach(() => h.reset());

const transition = (ticketId, to, extra = {}) => transitionTicket({ db, ticketId, to, now: new Date(h.time.now), ...extra });
const FREE = { assigned: 0, occupied: 0, held: 0 };

// ---------------------------------------------------------------- lazy expiry (server time) and release

test('a no-show ticket is expired lazily on read: seat freed, lock cleared, history and audit kept', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const t = (await issue(s, 'silent-room')).body.ticket;

  h.advance(14);
  assert.equal((await call(s, 'GET', '/api/tickets/active')).body.tickets.length, 1, 'still valid inside the grace period');

  h.advance(2); // 16 minutes: past the 15 minute check-in deadline
  const active = await call(s, 'GET', '/api/tickets/active');
  assert.deepEqual(active.body.tickets, []);

  const doc = await ticketDoc(t.id);
  assert.equal(doc.status, 'expired');
  assert.equal(doc.endReason, 'no_show');
  assert.equal(doc.activeDeadline, undefined);
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.deepEqual(await lock(s.uid), {});

  const history = (await call(s, 'GET', '/api/tickets/history')).body.tickets;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, t.id);
  assert.equal(history[0].status, 'expired');
  const logs = (await db.collection('auditLogs').where('targetId', '==', t.id).get()).docs.map((d) => d.data()).map((l) => l.action).sort();
  assert.deepEqual(logs, ['ticket.expired', 'ticket.issued']);
});

test('time is the server clock: nothing a client sends can extend or shorten a ticket', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  await call(s, 'POST', '/api/tickets', { service: 'silent-room', now: '2099-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', durationMinutes: 99999 });
  const [active] = (await call(s, 'GET', '/api/tickets/active')).body.tickets;
  assert.equal((Date.parse(active.expiresAt) - Date.parse(active.issuedAt)) / 60_000, 120);
});

test('a ticket that was never checked in keeps its seat only until the grace period; a voucher has no grace', async () => {
  const s = await h.student();
  const v = (await issue(s, 'wifi-voucher')).body.ticket;
  h.advance(179);
  assert.equal((await call(s, 'GET', '/api/tickets/active')).body.tickets.length, 1);
  h.advance(2);
  assert.equal((await call(s, 'GET', '/api/tickets/active')).body.tickets.length, 0);
  const doc = await ticketDoc(v.id);
  assert.equal(doc.status, 'expired');
  assert.equal(doc.endReason, 'expired');
});

test('the freed seat is immediately assignable, and the same request that needs it releases it', async () => {
  await h.seats('silent-seat-01');
  const a = await h.student();
  const b = await h.student();
  const first = (await issue(a, 'silent-room')).body.ticket;
  assert.equal((await issue(b, 'silent-room')).code, 'no-resource-available');

  h.advance(20);
  const second = await issue(b, 'silent-room'); // nobody read /active in between: allocation sweeps by itself
  assert.equal(second.status, 201);
  assert.equal(second.body.ticket.resource.id, 'silent-seat-01');
  assert.equal((await ticketDoc(first.id)).status, 'expired');
  assert.equal((await resource('silent-seat-01')).allocation.ticketId, second.body.ticket.id);
  assert.deepEqual(await lock(a.uid), {});
});

test('a student whose stub expired can request a new one (the limit frees up in the same request)', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const first = (await issue(s, 'silent-room')).body.ticket;
  h.advance(30);
  const again = await issue(s, 'silent-room');
  assert.equal(again.status, 201);
  assert.notEqual(again.body.ticket.id, first.id);
  assert.equal((await call(s, 'GET', '/api/tickets/history')).body.tickets.length, 2);
});

test('expiry is idempotent and never frees a seat that now belongs to someone else', async () => {
  await h.seats('silent-seat-01');
  const a = await h.student();
  const b = await h.student();
  const old = (await issue(a, 'silent-room')).body.ticket;
  h.advance(20);
  assert.equal(await expireDue({ db, now: new Date(h.time.now) }), 1);
  assert.equal(await expireDue({ db, now: new Date(h.time.now) }), 0);

  const current = (await issue(b, 'silent-room')).body.ticket;
  // Replaying the expiry of the old ticket (a retry, a second sweeper) must leave B's allocation alone.
  assert.deepEqual(await transition(old.id, 'expired', { onlyIfDue: true }), { changed: false, status: 'expired' });
  assert.deepEqual(await transition(old.id, 'expired'), { changed: false, status: 'expired' });
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: current.id });
  assert.deepEqual(await lock(b.uid), { 'silent-room': current.id });
  assert.equal((await db.collection('auditLogs').where('targetId', '==', old.id).where('action', '==', 'ticket.expired').get()).size, 1);
});

test('concurrent sweeps release a ticket exactly once', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  await issue(s, 'silent-room');
  h.advance(20);
  const counts = await Promise.all(Array.from({ length: 5 }, () => expireDue({ db, now: new Date(h.time.now) })));
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'ticket.expired').get()).size, 1);
});

test('the sweeper expires every overdue ticket in batches and leaves live ones alone', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03');
  const students = await Promise.all([h.student(), h.student(), h.student()]);
  const tickets = [];
  for (const s of students) tickets.push((await issue(s, 'silent-room')).body.ticket);
  h.advance(20); // all three are now overdue, none has been read since

  const now = () => new Date(h.time.now);
  assert.equal(await expireDue({ db, now: now(), limit: 2 }), 2);
  assert.equal(await expireDue({ db, now: now(), limit: 5 }), 1);
  assert.equal(await expireDue({ db, now: now() }), 0);
  assert.equal((await db.collection('tickets').where('status', '==', 'expired').get()).size, 3);
  for (const id of ['silent-seat-01', 'silent-seat-02', 'silent-seat-03']) assert.deepEqual((await resource(id)).allocation, FREE, id);

  const fresh = (await issue(students[0], 'silent-room')).body.ticket;
  assert.equal(await expireDue({ db, now: now() }), 0, 'a live ticket is not touched');
  assert.equal((await ticketDoc(fresh.id)).status, 'issued');
});

// ---------------------------------------------------------------- lifecycle transitions

test('the transition table allows only the documented moves', () => {
  assert.deepEqual(TRANSITIONS, {
    issued: ['checked_in', 'expired', 'revoked'],
    checked_in: ['checked_out', 'expired', 'revoked'],
    checked_out: [], expired: [], revoked: [],
  });
});

test('issued -> checked_in moves the seat from assigned to occupied; checked_out releases everything', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const t = (await issue(s, 'silent-room')).body.ticket;

  await transition(t.id, 'checked_in', { actorUid: 'admin-1' });
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 1, held: 0, ticketId: t.id });
  assert.equal((await ticketDoc(t.id)).status, 'checked_in');
  assert.deepEqual(await lock(s.uid), { 'silent-room': t.id }, 'still counts as active');

  // Past the no-show deadline but checked in: the seat stays until the ticket itself ends.
  h.advance(30);
  assert.equal(await expireDue({ db, now: new Date(h.time.now) }), 0);
  assert.equal((await ticketDoc(t.id)).status, 'checked_in');

  await transition(t.id, 'checked_out');
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.deepEqual(await lock(s.uid), {});
  assert.equal((await ticketDoc(t.id)).status, 'checked_out');
});

test('a checked-in ticket expires at its end time and releases the occupied seat', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const t = (await issue(s, 'silent-room')).body.ticket;
  await transition(t.id, 'checked_in');
  h.advance(121);
  assert.equal(await expireDue({ db, now: new Date(h.time.now) }), 1);
  assert.deepEqual((await resource('silent-seat-01')).allocation, FREE);
  assert.equal((await ticketDoc(t.id)).endReason, 'expired');
});

test('revoking releases the seat and the lock', async () => {
  await h.pcs('pc-01');
  const s = await h.student();
  const t = (await issue(s, 'computer-station')).body.ticket;
  await transition(t.id, 'revoked', { actorUid: 'admin-1', reason: 'misuse' });
  assert.deepEqual((await resource('pc-01')).allocation, FREE);
  assert.deepEqual(await lock(s.uid), {});
  const doc = await ticketDoc(t.id);
  assert.equal(doc.status, 'revoked');
  assert.equal(doc.endReason, 'misuse');
});

test('invalid transitions are rejected with 409 and change nothing', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02', 'silent-seat-03');
  const [a, b, c] = await Promise.all([h.student(), h.student(), h.student()]);
  const issued = (await issue(a, 'silent-room')).body.ticket;
  const out = (await issue(b, 'silent-room')).body.ticket;
  await transition(out.id, 'checked_in');
  await transition(out.id, 'checked_out');
  const gone = (await issue(c, 'silent-room')).body.ticket;
  await transition(gone.id, 'revoked');

  const bad = [[issued.id, 'checked_out'], [issued.id, 'issued'], [out.id, 'checked_in'], [out.id, 'issued'], [out.id, 'expired'], [out.id, 'revoked'], [gone.id, 'checked_in'], [gone.id, 'expired'], [gone.id, 'issued']];
  for (const [id, to] of bad) {
    await assert.rejects(transition(id, to), (e) => e.status === 409 && e.code === 'invalid-transition', `${id} -> ${to}`);
  }
  assert.equal((await ticketDoc(issued.id)).status, 'issued');
  assert.equal((await ticketDoc(out.id)).status, 'checked_out');
  assert.equal((await ticketDoc(gone.id)).status, 'revoked');
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 1, occupied: 0, held: 0, ticketId: issued.id });
  await assert.rejects(transition('SR-0000000000', 'expired'), { status: 404 });
});

test('terminal states are idempotent: repeating the same terminal transition is a quiet no-op', async () => {
  await h.seats('silent-seat-01');
  const t = (await issue(await h.student(), 'silent-room')).body.ticket;
  assert.equal((await transition(t.id, 'revoked')).changed, true);
  assert.equal((await transition(t.id, 'revoked')).changed, false);
  assert.equal((await db.collection('auditLogs').where('targetId', '==', t.id).where('action', '==', 'ticket.revoked').get()).size, 1);
});

// ---------------------------------------------------------------- admin inventory reflects allocation

test('admin inventory shows the allocation, blocks maintenance while a stub holds the seat, and sees expiry release it', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const admin = await h.actor({ role: 'admin' });
  const t = (await issue(s, 'silent-room')).body.ticket;

  let seat = (await call(admin, 'GET', '/api/admin/resources/silent-seat-01')).body.resource;
  assert.deepEqual({ assigned: seat.allocation.assigned, available: seat.available, ticketId: seat.allocation.ticketId }, { assigned: 1, available: false, ticketId: t.id });
  const summary = (await call(admin, 'GET', '/api/admin/summary')).body.byType['silent-seat'];
  assert.deepEqual({ total: summary.total, inUse: summary.inUse, available: summary.available }, { total: 1, inUse: 1, available: 0 });

  const blocked = await call(admin, 'PATCH', '/api/admin/resources/silent-seat-01', { status: 'maintenance' });
  assert.equal(blocked.code, 'resource-in-use');
  assert.equal((await call(admin, 'DELETE', '/api/admin/resources/silent-seat-01')).code, 'resource-in-use');

  h.advance(20); // the stub lapses; nobody has touched it since, but the admin's request releases it first
  const afterExpiry = (await call(admin, 'GET', '/api/admin/resources')).body.resources[0];
  assert.equal(afterExpiry.available, true);
  assert.equal((await call(admin, 'PATCH', '/api/admin/resources/silent-seat-01', { status: 'maintenance' })).status, 200);
  assert.equal((await ticketDoc(t.id)).status, 'expired');
});

test('a seat put into maintenance by an admin is not assigned, and a racing issue never leaves an allocated seat out of service', async () => {
  const admin = await h.actor({ role: 'admin' });
  for (let i = 0; i < 4; i++) {
    await h.reset();
    await h.seats('silent-seat-01');
    const s = await h.student();
    const [issued, patched] = await Promise.all([issue(s, 'silent-room'), call(admin, 'PATCH', '/api/admin/resources/silent-seat-01', { status: 'maintenance' })]);
    const seat = await resource('silent-seat-01');
    assert.ok(!(seat.status !== 'active' && seat.allocation.assigned > 0), `round ${i}: ${seat.status} with ${seat.allocation.assigned} assigned`);
    assert.equal(issued.status === 201, seat.allocation.assigned === 1);
    assert.ok([200, 409].includes(patched.status));
  }
});
