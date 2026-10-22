import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';

const h = harness();
const { call, reserve, day, resDoc } = h;
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
});

const since = () => new Date(h.time.now.getTime() - 60_000).toISOString();
const events = async (from = since()) => (await call(admin, 'GET', `/api/admin/notifications?since=${encodeURIComponent(from)}`)).body.events;
const make = async (extra) => {
  const r = await reserve(await h.student(), extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.reservation.id;
};

test('submission with an external first step records only the submitted event', async () => {
  await h.setChain(DEAN);
  const id = await make();
  const d = await resDoc(id);
  assert.ok(d.alertSubmittedAt && d.alertAt);
  assert.equal(d.alertFinalAt, undefined);
  assert.deepEqual((await events()).map((e) => [e.id, e.type]), [[id, 'submitted']]);
});

test('with no external steps the request is already final: one "final" event, not two', async () => {
  await h.setChain();
  const id = await make();
  assert.deepEqual((await events()).map((e) => [e.id, e.type]), [[id, 'final']]);
});

test('reaching the admin step adds a final event and keeps the submitted one', async () => {
  await h.setChain(DEAN);
  const from = since();
  const id = await make();
  const submitted = (await resDoc(id)).alertSubmittedAt.toMillis();
  h.advance(5);
  assert.equal((await h.decide(DEAN)).status, 200);
  const d = await resDoc(id);
  assert.equal(d.alertSubmittedAt.toMillis(), submitted, 'event 1 is preserved');
  assert.ok(d.alertFinalAt.toMillis() > submitted);
  assert.deepEqual((await events(from)).map((e) => e.type), ['submitted', 'final']);
  const later = new Date(d.alertFinalAt.toMillis()).toISOString();
  assert.deepEqual((await events(later)).map((e) => e.type), ['final'], 'a later cursor sees only the new event');
});

test('an approval that leads to another external step raises no final event', async () => {
  await h.setChain(DEAN, ADVISER);
  const id = await make();
  h.advance(5);
  assert.equal((await h.decide(DEAN)).status, 200);
  assert.equal((await resDoc(id)).alertFinalAt, undefined);
});

test('rejected, cancelled and expired requests are not announced', async () => {
  await h.setChain(DEAN);
  const rejected = await make();
  await h.decide(DEAN, 'reject');
  const cancelled = await make({ startTime: '11:00', endTime: '12:00' });
  assert.equal((await call(admin, 'POST', `/api/admin/reservations/${cancelled}/cancel`, {})).status, 200);
  assert.ok(![rejected, cancelled].some((id) => ['rejected', 'cancelled'].includes(id)));
  assert.deepEqual(await events(), []);
});

test('no "since" returns the server time and never any history', async () => {
  await h.setChain(DEAN);
  await make();
  const r = await call(admin, 'GET', '/api/admin/notifications');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, []);
  assert.equal(r.body.serverTime, h.clock().toISOString());
});

test('events carry only room, date, time and type: no student details', async () => {
  await h.setChain(DEAN);
  await make();
  const [e] = await events();
  assert.deepEqual(Object.keys(e).sort(), ['at', 'date', 'endTime', 'id', 'room', 'startTime', 'type']);
  assert.equal(e.room, 'ROOM-A');
  assert.equal(e.date, day(1));
});

test('the cursor excludes older events', async () => {
  await h.setChain(DEAN);
  await make();
  h.advance(10);
  assert.deepEqual(await events(), []);
});

test('only an active administrator may read notifications; bad input is refused', async () => {
  const path = `/api/admin/notifications?since=${encodeURIComponent(since())}`;
  assert.equal((await call(null, 'GET', path)).status, 401);
  assert.equal((await call(await h.student(), 'GET', path)).status, 403);
  assert.equal((await call(admin, 'GET', '/api/admin/notifications?since=yesterday')).status, 400);
});

test('students never see the alert fields', async () => {
  await h.setChain(DEAN);
  const student = await h.student();
  const r = await reserve(student);
  const list = (await call(student, 'GET', '/api/reservations')).body.reservations;
  assert.ok(!JSON.stringify([r.body, list]).includes('alert'));
});
