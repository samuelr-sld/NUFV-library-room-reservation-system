import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';

const h = harness();
const { db, call, reserve, day, resDoc, locksOf, audits, trail } = h;
let admin;

before(async () => {
  await h.start();
  admin = await h.actor({ role: 'admin' });
});
after(() => h.stop());
beforeEach(async () => {
  await h.reset();
  await h.room('room-a', { capacity: 4 });
  await h.room('room-b', { capacity: 6 });
});

const ok = async (who, extra) => {
  const r = await reserve(who, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.reservation;
};

// ---------------------------------------------------------------- creating a reservation

test('a valid request becomes a pending reservation holding its slots, with the chain frozen and a trail started', async () => {
  await h.setChain('dean@example.edu', 'adviser@example.edu');
  const s = await h.student();
  const r = await ok(s, { participants: [{ name: 'Maria Santos', studentNumber: '2023-111111' }, { name: 'Jo Lim' }], notes: 'Whiteboard please' });

  assert.match(r.id, /^RS-[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(r.status, 'pending');
  assert.deepEqual({ date: r.date, start: r.startTime, end: r.endTime, tz: r.timezone }, { date: day(1), start: '09:00', end: '10:00', tz: 'Asia/Manila' });
  assert.equal(r.startsAt, `${day(1)}T01:00:00.000Z`, '09:00 in Manila is 01:00 UTC');
  assert.equal(r.participantCount, 3);
  assert.deepEqual(r.room, { id: 'room-a', label: 'ROOM-A', capacity: 4 });
  assert.deepEqual(r.progress.map((p) => [p.label, p.state]), [['Approver 1', 'current'], ['Approver 2', 'waiting'], ['Final administrator approval', 'waiting']]);
  assert.equal(r.currentStepLabel, 'Approver 1');
  assert.equal(r.qrPayload, undefined);
  assert.equal(r.confirmationRef, undefined);

  const doc = await resDoc(r.id);
  assert.equal(doc.uid, s.uid);
  assert.equal(doc.currentStep, 0);
  assert.deepEqual(doc.workflow.steps.map((x) => x.type), ['external', 'external', 'admin']);
  assert.equal(doc.qrRef, undefined);
  assert.equal(doc.slotKeys.length, 4);
  const locks = await locksOf(r.id);
  assert.equal(locks.length, 4);
  assert.ok(locks.every((l) => l.get('kind') === 'hold' && l.get('roomId') === 'room-a'));
  assert.equal((await trail(r.id)).map((a) => a.action).join(), 'submitted');
  assert.equal((await audits(r.id))[0].action, 'reservation.submitted');
});

test('the first approver is notified (and only the first), in the same commit as the request', async () => {
  await h.setChain('dean@example.edu', 'adviser@example.edu');
  const s = await h.student();
  await ok(s);
  assert.equal((await db.collection('emailOutbox').get()).size, 1);
  await h.deliver();
  assert.equal(h.mailsTo('dean@example.edu', 'approval-request').length, 1);
  assert.equal(h.mailsTo('adviser@example.edu').length, 0);
  const text = h.mailsTo('dean@example.edu')[0].text;
  assert.match(text, /approve\.html#[A-Za-z0-9_-]{24}/);
  assert.match(text, /does not approve or reject anything/);
  assert.doesNotMatch(text, /one-time code is/i, 'the first email carries no code');
});

test('with no external approvers configured the request goes straight to the final administrator', async () => {
  const r = await ok(await h.student());
  assert.deepEqual(r.progress.map((p) => p.type), ['admin']);
  await h.deliver();
  assert.equal(h.sink.messages.length, 0);
  assert.equal((await db.collection('approvalChallenges').get()).size, 0);
});

test('only students with an active profile and a verified email can reserve; identity comes from the token', async () => {
  const unverified = await h.student({ emailVerified: false });
  assert.equal((await reserve(unverified)).code, 'email-not-verified');
  const suspended = await h.student({ status: 'suspended' });
  assert.equal((await reserve(suspended)).code, 'account-suspended');
  assert.equal((await reserve(admin)).status, 403);
  assert.equal((await reserve(null)).status, 401);
  assert.equal((await reserve('garbage')).status, 401);
  const noProfile = await h.actor({ role: null, emailVerified: true });
  assert.equal((await reserve(noProfile)).code, 'no-profile');

  const victim = await h.student();
  const attacker = await h.student();
  const r = await call(attacker, 'POST', '/api/reservations', { ...h.body(), uid: victim.uid, status: 'confirmed', currentStep: 9 });
  assert.equal(r.status, 400, 'extra fields are refused rather than ignored');
  const good = await ok(attacker);
  assert.equal((await resDoc(good.id)).uid, attacker.uid);
  assert.equal((await call(victim, 'GET', '/api/reservations')).body.reservations.length, 0);
  assert.equal((await db.collection('reservations').get()).size, 1);
  assert.equal((await db.collection('reservations').where('uid', '==', victim.uid).get()).size, 0);
});

// ---------------------------------------------------------------- validation against the room and the rules

test('capacity: the requester counts as a participant and the room limit is enforced', async () => {
  const s = await h.student();
  const three = [{ name: 'Ana Cruz' }, { name: 'Ben Cruz' }, { name: 'Cy Cruz' }];
  await ok(s, { participants: three }); // 4 people in a room for 4
  const tooMany = await reserve(await h.student(), { startTime: '11:00', endTime: '12:00', participants: [...three, { name: 'Di Cruz' }] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error.message, /holds at most 4/);
  assert.equal((await reserve(await h.student(), { roomId: 'room-b', participants: [...three, { name: 'Di Cruz' }, { name: 'Ed Cruz' }] })).status, 201, 'room-b holds 6');
});

test('room must exist, be a discussion room, and be operational', async () => {
  const s = await h.student();
  await h.room('room-c', { status: 'maintenance' });
  await h.room('room-d', { status: 'retired' });
  await db.doc('resources/seat-1').set({ type: 'silent-seat', label: 'Seat', status: 'active', capacity: null });
  assert.equal((await reserve(s, { roomId: 'room-c' })).code, 'room-unavailable');
  assert.equal((await reserve(s, { roomId: 'room-d' })).code, 'room-unavailable');
  assert.equal((await reserve(s, { roomId: 'seat-1' })).status, 404);
  assert.equal((await reserve(s, { roomId: 'no-such-room' })).status, 404);
  assert.equal((await db.collection('reservationLocks').get()).size, 0);
});

test('booking window and rules: future only, within the advance window, on the configured interval, inside library hours', async () => {
  const s = await h.student();
  const refused = async (extra, re) => {
    const r = await reserve(s, extra);
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.body.error.message, re);
  };
  await refused({ date: day(0), startTime: '09:00', endTime: '10:00' }, /in the future/); // it is already 10:00
  await refused({ date: day(-1) }, /in the future/);
  await refused({ date: day(8) }, /at most 7 day/);
  await refused({ startTime: '09:30', endTime: '10:30' }, /60-minute marks/);
  await refused({ startTime: '07:00', endTime: '08:00' }, /between 08:00 and 20:00/);
  await refused({ startTime: '08:00', endTime: '13:00' }, /at most 4 hours/);
  await refused({ date: '2030-02-30' }, /valid date/);
  await refused({ purpose: 'x' }, /3 to 200/);
  assert.equal((await db.collection('reservationLocks').get()).size, 0);

  assert.equal((await reserve(s, { date: day(7), roomId: 'room-b' })).status, 201, 'the last allowed day');
  await h.setSettings({ discussionRoomBookingIntervalMinutes: 30, reservationAdvanceBookingDays: 2 });
  assert.equal((await reserve(s, { startTime: '11:30', endTime: '12:30' })).status, 201, 'a 30-minute interval allows :30 marks');
  const late = await reserve(s, { date: day(3), roomId: 'room-b', startTime: '15:00', endTime: '16:00' });
  assert.match(late.body.error.message, /at most 2 day/);
});

test('the limit on open reservations per student stops one account hoarding rooms', async () => {
  const s = await h.student();
  for (const start of ['09:00', '10:00', '11:00']) await ok(s, { startTime: start, endTime: `${Number(start.slice(0, 2)) + 1}:00`.padStart(5, '0') });
  const r = await reserve(s, { startTime: '14:00', endTime: '15:00' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'reservation-limit');
  assert.equal((await reserve(await h.student(), { startTime: '14:00', endTime: '15:00' })).status, 201, 'other students are unaffected');
});

// ---------------------------------------------------------------- conflicts

test('adjacent bookings are valid; overlaps are refused; other rooms and dates are independent', async () => {
  const [a, b, c] = await Promise.all([h.student(), h.student(), h.student()]);
  await ok(a, { startTime: '09:00', endTime: '10:00' });
  await ok(b, { startTime: '10:00', endTime: '11:00' }); // starts exactly when A ends
  await ok(c, { startTime: '08:00', endTime: '09:00' }); // ends exactly when A starts

  for (const extra of [{ startTime: '09:00', endTime: '10:00' }, { startTime: '08:00', endTime: '10:00' }, { startTime: '09:00', endTime: '11:00' }, { startTime: '08:00', endTime: '12:00' }]) {
    const r = await reserve(await h.student(), extra);
    assert.equal(r.status, 409, JSON.stringify(extra));
    assert.equal(r.code, 'slot-taken');
  }
  assert.equal((await reserve(await h.student(), { roomId: 'room-b', startTime: '09:00', endTime: '10:00' })).status, 201);
  assert.equal((await reserve(await h.student(), { date: day(2), startTime: '09:00', endTime: '10:00' })).status, 201);
});

test('overlap variants at 15-minute granularity: identical, contained, straddling either edge, and enclosing', async () => {
  await h.setSettings({ discussionRoomBookingIntervalMinutes: 15 });
  const owner = await h.student();
  await ok(owner, { startTime: '10:00', endTime: '11:00' });
  const cases = [['10:00', '11:00'], ['10:15', '10:45'], ['09:30', '10:15'], ['10:45', '11:30'], ['09:00', '12:00'], ['10:00', '10:15'], ['10:45', '11:00']];
  for (const [startTime, endTime] of cases) {
    const r = await reserve(await h.student(), { startTime, endTime });
    assert.equal(r.code, 'slot-taken', `${startTime}-${endTime}`);
  }
  for (const [startTime, endTime] of [['09:00', '10:00'], ['11:00', '12:00']]) {
    assert.equal((await reserve(await h.student(), { startTime, endTime })).status, 201, `${startTime}-${endTime} touches but does not overlap`);
  }
  assert.equal((await reserve(await h.student(), { roomId: 'room-b', startTime: '10:00', endTime: '11:00' })).status, 201, 'another room');
  assert.equal((await reserve(await h.student(), { date: day(2), startTime: '10:00', endTime: '11:00' })).status, 201, 'another day');
});

test('six students submit the same room and time at once: exactly one wins and exactly its slots are locked', async () => {
  const students = await Promise.all(Array.from({ length: 6 }, () => h.student()));
  const results = await Promise.all(students.map((s) => reserve(s)));
  const won = results.filter((r) => r.status === 201);
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.code === 'slot-taken').length, 5);
  assert.equal((await db.collection('reservations').get()).size, 1);
  const locks = await db.collection('reservationLocks').get();
  assert.equal(locks.size, 4);
  assert.ok(locks.docs.every((l) => l.get('reservationId') === won[0].body.reservation.id));
  assert.equal((await db.collection('approvalActions').get()).size, 1, 'losers leave no trail');
});

test('simultaneous partly-overlapping requests: the survivors never overlap each other', async () => {
  await h.setSettings({ discussionRoomBookingIntervalMinutes: 15 });
  const times = [['09:00', '10:00'], ['09:30', '10:30'], ['10:00', '11:00'], ['10:30', '11:30'], ['09:15', '09:45'], ['11:00', '12:00']];
  const students = await Promise.all(times.map(() => h.student()));
  const results = await Promise.all(students.map((s, i) => reserve(s, { startTime: times[i][0], endTime: times[i][1] })));
  const taken = new Set();
  for (const r of results.filter((x) => x.status === 201)) {
    const { startTime, endTime } = r.body.reservation;
    for (let m = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)); m < Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3)); m += 15) {
      assert.ok(!taken.has(m), `minute ${m} was granted twice`);
      taken.add(m);
    }
  }
  assert.ok(results.some((r) => r.status === 201));
  assert.ok(results.every((r) => [201, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  const locks = await db.collection('reservationLocks').get();
  assert.equal(locks.size, taken.size, 'exactly one lock per granted 15-minute slot');
});

test('the same student sending the same request many times at once is held to the rules, not duplicated', async () => {
  const s = await h.student();
  const results = await Promise.all(Array.from({ length: 5 }, () => reserve(s)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.code === 'slot-taken').length, 4);
  assert.equal((await db.collection('reservations').get()).size, 1);
});

test('availability shows taken time per room as merged intervals; it is advisory only', async () => {
  await ok(await h.student(), { startTime: '09:00', endTime: '10:00' });
  await ok(await h.student(), { startTime: '10:00', endTime: '11:00' });
  await ok(await h.student(), { startTime: '14:00', endTime: '15:00' });
  const s = await h.student();
  const a = (await call(s, 'GET', `/api/reservations/availability?date=${day(1)}`)).body;
  const roomA = a.rooms.find((r) => r.id === 'room-a');
  assert.deepEqual(roomA.busy, [{ start: 540, end: 660 }, { start: 840, end: 900 }]);
  assert.deepEqual(a.rooms.find((r) => r.id === 'room-b').busy, []);
  assert.equal((await call(s, 'GET', '/api/reservations/availability?date=nope')).status, 400);
  assert.equal((await call(s, 'GET', '/api/reservations/availability')).status, 400);

  // A stale view cannot double-book: the transaction decides.
  assert.equal((await reserve(s, { startTime: '09:00', endTime: '10:00' })).code, 'slot-taken');
  const rules = (await call(s, 'GET', '/api/reservations/config')).body;
  assert.deepEqual({ tz: rules.timezone, interval: rules.intervalMinutes, ahead: rules.advanceDays, open: rules.open, close: rules.close, today: rules.today, last: rules.lastDate }, { tz: 'Asia/Manila', interval: 60, ahead: 7, open: '08:00', close: '20:00', today: day(0), last: day(7) });
  assert.deepEqual((await call(s, 'GET', '/api/reservations/rooms')).body.rooms.map((r) => [r.id, r.capacity]), [['room-a', 4], ['room-b', 6]]);
});

// ---------------------------------------------------------------- ownership and isolation

test("students see and open only their own reservations; others' look like missing ones", async () => {
  const [a, b] = await Promise.all([h.student(), h.student()]);
  const ra = await ok(a);
  const rb = await ok(b, { startTime: '11:00', endTime: '12:00' });
  assert.deepEqual((await call(a, 'GET', '/api/reservations')).body.reservations.map((r) => r.id), [ra.id]);
  assert.equal((await call(a, 'GET', `/api/reservations/${ra.id}`)).status, 200);
  for (const path of [`/api/reservations/${rb.id}`, `/api/reservations/${rb.id}/print`]) assert.equal((await call(a, 'GET', path)).status, 404, path);
  assert.equal((await call(a, 'POST', `/api/reservations/${rb.id}/cancel`, {})).status, 404);
  assert.equal((await call(a, 'GET', '/api/reservations/RS-ZZZZZZZZZZ')).status, 404);
  assert.equal((await call(a, 'GET', '/api/reservations/not-an-id')).status, 404);
  assert.equal((await resDoc(rb.id)).status, 'pending');
});

test('history is newest-start first and survives cancellation and expiry', async () => {
  const s = await h.student();
  const first = await ok(s, { startTime: '09:00', endTime: '10:00' });
  const second = await ok(s, { startTime: '13:00', endTime: '14:00' });
  await call(s, 'POST', `/api/reservations/${first.id}/cancel`, {});
  const list = (await call(s, 'GET', '/api/reservations')).body.reservations;
  assert.deepEqual(list.map((r) => [r.id, r.status]), [[second.id, 'pending'], [first.id, 'cancelled']]);
});

// ---------------------------------------------------------------- administrators

test('students cannot reach any administrator reservation route', async () => {
  const s = await h.student();
  const r = await ok(s);
  for (const [method, path, body] of [
    ['GET', '/api/admin/approval-workflow'], ['PUT', '/api/admin/approval-workflow', { steps: [] }], ['GET', '/api/admin/reservations'],
    ['GET', `/api/admin/reservations/${r.id}`], ['POST', `/api/admin/reservations/${r.id}/decision`, { decision: 'approve', step: 0 }],
    ['POST', `/api/admin/reservations/${r.id}/cancel`, {}], ['POST', `/api/admin/reservations/${r.id}/resend`, {}],
  ]) {
    assert.equal((await call(s, method, path, body)).status, 403, `${method} ${path}`);
    assert.equal((await call(null, method, path, body)).status, 401, `anon ${path}`);
  }
  assert.equal((await resDoc(r.id)).status, 'pending');
});

test('a room with pending or upcoming reservations cannot be taken out of service silently', async () => {
  const r = await ok(await h.student());
  const down = await call(admin, 'PATCH', '/api/admin/resources/room-a', { status: 'maintenance' });
  assert.equal(down.status, 409);
  assert.equal(down.code, 'resource-in-use');
  assert.match(down.body.error.message, /1 pending or upcoming reservation/);
  assert.equal((await call(admin, 'DELETE', '/api/admin/resources/room-a')).code, 'resource-in-use');
  assert.equal((await call(admin, 'PATCH', '/api/admin/resources/room-b', { status: 'maintenance' })).status, 200, 'an unused room is fine');

  await call(admin, 'POST', `/api/admin/reservations/${r.id}/cancel`, { reason: 'Room needed for repairs' });
  assert.equal((await call(admin, 'PATCH', '/api/admin/resources/room-a', { status: 'maintenance' })).status, 200);
  assert.equal((await reserve(await h.student())).code, 'room-unavailable');
});

test('a booking racing a room going into maintenance never leaves a reservation in a closed room', async () => {
  for (let i = 0; i < 3; i++) {
    await h.reset();
    await h.room('room-a');
    const s = await h.student();
    const [made, patched] = await Promise.all([reserve(s), call(admin, 'PATCH', '/api/admin/resources/room-a', { status: 'maintenance' })]);
    const room = (await db.doc('resources/room-a').get()).data();
    const open = (await db.collection('reservations').get()).size;
    assert.ok(!(room.status !== 'active' && open > 0), `round ${i}: ${room.status} with ${open} reservation(s)`);
    assert.equal(made.status === 201, open === 1);
    assert.ok([200, 409].includes(patched.status));
  }
});

test('transaction rollback: a failure at the last step leaves no reservation, lock, challenge, email or trail', async () => {
  await h.setChain('dean@example.edu');
  const s = await h.student();
  const { submitReservation } = await import('../../server/reservations.js');
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
  await assert.rejects(submitReservation({ db: failing, config: h.config, uid: s.uid, body: h.body(), now: h.clock() }), /injected failure/);
  for (const name of ['reservations', 'reservationLocks', 'approvalChallenges', 'approvalActions', 'emailOutbox', 'auditLogs']) {
    assert.equal((await db.collection(name).get()).size, 0, name);
  }
  assert.equal((await reserve(s)).status, 201, 'the slot is still free afterwards');
});
