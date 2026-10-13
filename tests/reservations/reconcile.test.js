import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { harness } from './harness.js';
import { reconcile } from '../../server/reconcile.js';

// Consistency checks between seats, stubs, room holds and approval links; operator-controlled repairs; and the oracle use
// of the checker after ordinary traffic.
const h = harness();
const { db, call, reserve, day, resDoc, adminDecide } = h;
const DEAN = 'dean@example.edu';
const ts = (ms) => Timestamp.fromMillis(ms);
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

const seat = (id) => db.doc(`resources/${id}`).set({ type: 'silent-seat', label: id, status: 'active', allocation: { assigned: 0, occupied: 0, held: 0 } });
const check = (apply = false) => reconcile({ db, now: h.clock(), apply, operator: 'test' });
// Inconsistencies only: leftovers that are merely old (expiredLocks, expiredRateLimits) are housekeeping, not disagreement.
const counts = (r) => Object.fromEntries(Object.entries(r.findings).filter(([k]) => !k.startsWith('expired')).map(([k, v]) => [k, v.count]));
const CLEAN = { staleAllocations: 0, activeTicketsWithoutSeat: 0, orphanLocks: 0, reservationsWithoutHold: 0, orphanChallenges: 0 };
const allocation = async (id) => (await db.doc(`resources/${id}`).get()).get('allocation');

test('after every kind of ordinary traffic and every terminal action, the stored records agree', async () => {
  await seat('seat-1');
  await seat('seat-2');
  await h.setChain(DEAN);
  const [a, b, c, d] = [await h.student(), await h.student(), await h.student(), await h.student()];

  // Stubs: issue, check in, check out, revoke, no-show and natural expiry, each releasing its seat.
  const issue = async (who, service = 'silent-room') => (await call(who, 'POST', '/api/tickets', { service })).body.ticket;
  const t1 = await issue(a);
  const t2 = await issue(b);
  assert.equal((await call(admin, 'POST', `/api/admin/tickets/${t1.id}/check-in`, { identityChecked: true })).status, 200);
  assert.deepEqual(counts(await check()), CLEAN, 'issued and checked-in stubs');
  assert.equal((await call(admin, 'POST', `/api/admin/tickets/${t1.id}/check-out`, {})).status, 200);
  assert.equal((await call(admin, 'POST', `/api/admin/tickets/${t2.id}/revoke`, { reason: 'wrong person' })).status, 200);
  assert.deepEqual(counts(await check()), CLEAN, 'checked-out and revoked stubs');
  assert.deepEqual([await allocation('seat-1'), await allocation('seat-2')].map((x) => x.assigned + x.occupied), [0, 0]);
  const t3 = await issue(c);
  h.advance(60); // past the no-show grace
  await call(admin, 'GET', '/api/admin/summary');
  assert.equal((await db.doc(`tickets/${t3.id}`).get()).get('endReason'), 'no_show');
  const t4 = await issue(d);
  h.advance(60 * 5);
  await call(admin, 'GET', '/api/admin/summary');
  assert.equal((await db.doc(`tickets/${t4.id}`).get()).get('status'), 'expired');
  assert.deepEqual(counts(await check()), CLEAN, 'no-show and expired stubs');
  assert.ok((await Promise.all(['seat-1', 'seat-2'].map(allocation))).every((x) => !x.ticketId && !x.assigned && !x.occupied));

  // Reservations: pending at each step, confirmed, cancelled by student and by administrator, cancelled after confirmation, expired.
  const made = [];
  for (const [who, extra] of [[a, { startTime: '09:00', endTime: '10:00' }], [b, { startTime: '10:00', endTime: '11:00' }], [c, { startTime: '11:00', endTime: '12:00' }], [d, { startTime: '12:00', endTime: '13:00' }]]) {
    const r = await reserve(who, { date: day(5), ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    made.push({ id: r.body.reservation.id, who });
  }
  await h.deliver();
  assert.deepEqual(counts(await check()), CLEAN, 'four pending at the external step');
  assert.equal((await h.decide(DEAN)).status, 200); // answers whichever request was mailed last
  const steps = await Promise.all(made.map(async (m) => (await resDoc(m.id)).currentStep));
  const advanced = made[steps.indexOf(1)];
  const [byStudent, byAdmin, left] = made.filter((m) => m !== advanced);
  assert.equal((await call(byStudent.who, 'POST', `/api/reservations/${byStudent.id}/cancel`)).status, 200);
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${byAdmin.id}/cancel`, { reason: 'maintenance' })).status, 200);
  assert.deepEqual(counts(await check()), CLEAN, 'cancelled and advanced');
  assert.equal((await adminDecide(admin, advanced.id, 1)).status, 200);
  assert.deepEqual(counts(await check()), CLEAN, 'confirmed');
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${advanced.id}/cancel`, {})).status, 200);
  h.advance(60 * 24 * 3); // the one still waiting times out
  await call(admin, 'GET', '/api/admin/ops/approvals');
  assert.equal((await resDoc(left.id)).status, 'expired');
  assert.deepEqual(counts(await check()), CLEAN, 'expired and cancelled-after-confirmed');
});

test('a stale seat allocation is found, left alone by a dry run, and released by an explicit repair that leaves live seats untouched', async () => {
  await seat('seat-1');
  await seat('seat-2');
  const student = await h.student();
  const live = (await call(student, 'POST', '/api/tickets', { service: 'silent-room' })).body.ticket; // takes seat-1
  assert.equal(live.resource.id, 'seat-1');
  await db.doc('resources/seat-2').update({ allocation: { assigned: 1, occupied: 0, held: 0, ticketId: 'SR-GHOST00000' } }); // a seat leaked by a bug or a manual edit

  const dry = await check(false);
  assert.deepEqual(counts(dry), { ...CLEAN, staleAllocations: 1 });
  assert.deepEqual(dry.findings.staleAllocations.items, [{ resourceId: 'seat-2', ticketId: 'SR-GHOST00000', allocation: { assigned: 1, occupied: 0, held: 0 } }]);
  assert.equal((await allocation('seat-2')).assigned, 1, 'a dry run changes nothing');
  const blocked = await call(await h.student(), 'POST', '/api/tickets', { service: 'silent-room' });
  assert.equal(blocked.code, 'no-resource-available', 'the leaked seat is really lost to students');

  const fixed = await check(true);
  assert.equal(fixed.repaired.staleAllocations, 1);
  assert.deepEqual(await allocation('seat-2'), { assigned: 0, occupied: 0, held: 0 });
  assert.equal((await allocation('seat-1')).ticketId, live.id, 'the seat of a live stub is never touched');
  assert.equal((await call(await h.student(), 'POST', '/api/tickets', { service: 'silent-room' })).status, 201, 'the seat can be used again');
  const log = (await db.collection('auditLogs').where('action', '==', 'reconcile.allocation_released').get()).docs.map((d) => d.data());
  assert.deepEqual(log.map((e) => [e.actorUid, e.targetId, e.details.operator, e.details.ticketId]), [[null, 'seat-2', 'test', 'SR-GHOST00000']]);
  assert.deepEqual(counts(await check()), CLEAN);
});

test('a room hold that no active reservation owns blocks the room until an operator releases it; real holds are never released', async () => {
  const student = await h.student();
  const real = (await reserve(student, { date: day(5), startTime: '09:00', endTime: '10:00' })).body.reservation.id;
  const slot = `room-a__${day(5).replaceAll('-', '')}__1000`;
  await db.doc(`reservationLocks/${slot}`).set({ reservationId: 'RS-GHOST00000', roomId: 'room-a', date: day(5), slotStart: ts(h.clock().getTime()), kind: 'hold', expiresAt: ts(h.clock().getTime() + 86_400_000 * 6) });

  const r = await reserve(await h.student(), { date: day(5), startTime: '10:00', endTime: '11:00' });
  assert.equal(r.code, 'slot-taken');
  assert.deepEqual(counts(await check()), { ...CLEAN, orphanLocks: 1 });

  const fixed = await check(true);
  assert.equal(fixed.repaired.orphanLocks, 1);
  assert.equal((await db.doc(`reservationLocks/${slot}`).get()).exists, false);
  assert.equal((await h.locksOf(real)).length, 4, 'the real reservation keeps every one of its slots');
  assert.equal((await reserve(await h.student(), { date: day(5), startTime: '10:00', endTime: '11:00' })).status, 201);
  assert.deepEqual(counts(await check()), CLEAN);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'reconcile.lock_released').get()).size, 1);
});

test('an open approval link that is not the current one is closed by the repair; the current one keeps working', async () => {
  await h.setChain(DEAN);
  const id = (await reserve(await h.student(), { date: day(5) })).body.reservation.id;
  await h.deliver();
  const current = (await resDoc(id)).activeChallengeId;
  await db.doc('approvalChallenges/' + 'S'.repeat(24)).set({ reservationId: id, stepIndex: 0, email: DEAN, status: 'open', createdAt: ts(h.clock().getTime()), expiresAt: ts(h.clock().getTime() + 3_600_000), codesSent: 0, lastCodeAt: null, otp: null, failedTotal: 0, session: null });

  assert.deepEqual(counts(await check()), { ...CLEAN, orphanChallenges: 1 });
  assert.equal((await check(true)).repaired.orphanChallenges, 1);
  const stray = (await db.doc('approvalChallenges/' + 'S'.repeat(24)).get()).data();
  assert.deepEqual([stray.status, stray.closedReason], ['closed', 'reconciled']);
  assert.equal((await db.doc(`approvalChallenges/${current}`).get()).get('status'), 'open');
  assert.equal((await h.decide(DEAN)).status, 200);
  assert.deepEqual(counts(await check()), CLEAN);
});

test('a reservation that lost part of its hold is reported but never "repaired": that is a decision for a person', async () => {
  const id = (await reserve(await h.student(), { date: day(5) })).body.reservation.id;
  const [first] = await h.locksOf(id);
  await first.ref.delete();
  const dry = await check(true);
  assert.deepEqual(counts(dry), { ...CLEAN, reservationsWithoutHold: 1 });
  assert.deepEqual(dry.findings.reservationsWithoutHold.items, [{ reservationId: id }]);
  assert.equal((await h.locksOf(id)).length, 3, 'apply did not invent a lock');
  assert.equal((await resDoc(id)).status, 'pending');
  // The system itself refuses to confirm it, so nothing double-books.
  assert.equal((await adminDecide(admin, id, 0)).code, 'reservation-expired');
  assert.equal((await resDoc(id)).status, 'expired');
});

test('housekeeping removes only holds that ended more than a day ago and counters whose window is over', async () => {
  const now = h.clock().getTime();
  const lock = (id, expiresAt) => db.doc(`reservationLocks/${id}`).set({ reservationId: 'RS-OLD0000000', roomId: 'room-a', date: '2030-01-01', slotStart: ts(now), kind: 'booked', expiresAt: ts(expiresAt) });
  await lock('old', now - 2 * 86_400_000);
  await lock('recent', now - 3_600_000);
  await db.doc('rateLimits/code_old').set({ window: 1, count: 3, expiresAt: ts(now - 1000) });
  await db.doc('rateLimits/code_live').set({ window: 2, count: 1, expiresAt: ts(now + 600_000) });

  const dry = await check(false);
  assert.deepEqual([dry.findings.expiredLocks.count, dry.findings.expiredRateLimits.count], [1, 1]);
  assert.equal((await db.doc('reservationLocks/old').get()).exists, true);
  const done = await check(true);
  assert.deepEqual(done.pruned, { expiredLocks: 1, expiredRateLimits: 1 });
  const left = async (path) => (await db.doc(path).get()).exists;
  assert.deepEqual(await Promise.all(['reservationLocks/old', 'reservationLocks/recent', 'rateLimits/code_old', 'rateLimits/code_live'].map(left)), [false, true, false, true]);
  const log = (await db.collection('auditLogs').where('action', '==', 'reconcile.pruned').get()).docs.map((d) => d.data());
  assert.deepEqual(log.map((e) => [e.details.expiredLocks, e.details.expiredRateLimits, e.details.operator]), [[1, 1, 'test']], 'what the tool deleted is on the record');
  assert.equal((await check(true)).pruned.expiredLocks, 0);
  assert.equal((await db.collection('auditLogs').where('action', '==', 'reconcile.pruned').get()).size, 1, 'a run that deletes nothing writes nothing');
});

test('a seat that any active stub still points at is never released, even when its counters look stale', async () => {
  await seat('seat-1');
  const student = await h.student();
  const live = (await call(student, 'POST', '/api/tickets', { service: 'silent-room' })).body.ticket;
  // Damage the seat so it looks leaked (no ticketId, assigned counter set) while the stub is still active and names it.
  await db.doc('resources/seat-1').update({ allocation: { assigned: 1, occupied: 0, held: 0 } });
  const dry = await check(false);
  assert.equal(dry.findings.staleAllocations.count, 1, 'the check reports it');
  const done = await check(true);
  assert.equal(done.repaired.staleAllocations, 0);
  assert.deepEqual(done.skipped, [{ check: 'staleAllocations', resourceId: 'seat-1', reason: 'claimed' }]);
  assert.deepEqual(await allocation('seat-1'), { assigned: 1, occupied: 0, held: 0 }, 'untouched');
  assert.equal((await db.collection('auditLogs').where('action', '==', 'reconcile.allocation_released').get()).size, 0);
  // Once a person revokes the stub, nothing claims the seat any more and the repair is allowed to release it.
  assert.equal((await call(admin, 'POST', `/api/admin/tickets/${live.id}/revoke`, { reason: 'seat damaged' })).status, 200);
  assert.equal((await check(true)).repaired.staleAllocations, 1);
  assert.deepEqual(counts(await check()), CLEAN);
});

test('repairs run only when asked for, only from the operator script path, and never over HTTP', async () => {
  await seat('seat-1');
  await db.doc('resources/seat-1').update({ allocation: { assigned: 1, occupied: 0, held: 0, ticketId: 'SR-GHOST00000' } });
  assert.equal((await reconcile({ db, now: h.clock() })).apply, false, 'the default is a dry run');
  assert.equal((await allocation('seat-1')).assigned, 1);
  const { readFile } = await import('node:fs/promises');
  const script = await readFile('server/scripts/reconcile.js', 'utf8');
  assert.match(script, /apply: !!values\.apply/);
  assert.match(script, /config\.cloud && values\['confirm-project'\] !== config\.projectId/, 'a real project (cloud-dev or production) needs --confirm-project');
  const routes = await readFile('server/routes/adminOps.js', 'utf8');
  assert.doesNotMatch(routes, /apply:\s*true|reconcile\(\{[^}]*apply: (?!false)/, 'no HTTP route applies repairs');
});

test('the administrator diagnostics view is read-only, whatever the request says, and administrator-only', async () => {
  await seat('seat-1');
  await db.doc('resources/seat-1').update({ allocation: { assigned: 1, occupied: 0, held: 0, ticketId: 'SR-GHOST00000' } });
  const res = await call(admin, 'GET', '/api/admin/ops/diagnostics?apply=true&apply=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.apply, false);
  assert.equal(res.body.findings.staleAllocations.count, 1);
  assert.equal((await allocation('seat-1')).assigned, 1, 'nothing was repaired over HTTP');
  assert.equal((await call(admin, 'POST', '/api/admin/ops/diagnostics', { apply: true })).status, 404, 'no write route exists');
  assert.equal((await call(await h.student(), 'GET', '/api/admin/ops/diagnostics')).status, 403);
  assert.ok(res.body.findings.staleAllocations.items.length <= 50, 'bounded output');
});
