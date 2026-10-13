import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';

// Per-IP throttling of the public approval endpoints, with deliberately small limits. One proxy hop is trusted, so a test
// can be a different client by sending X-Forwarded-For (the same way a real reverse proxy would).
const STRICT = {
  ip: { windowMs: 60_000, max: 1000 },
  code: { windowMs: 15 * 60_000, max: 3 },
  verify: { windowMs: 15 * 60_000, max: 4 },
  submit: { windowMs: 60 * 60_000, max: 3 },
};
const h = harness({ limits: STRICT, env: { TRUST_PROXY_HOPS: '1' } });
const { db, call, reserve, day, resDoc } = h;
const DEAN = 'dean@example.edu';
const from = (ip) => ({ 'X-Forwarded-For': ip });

before(async () => { await h.start(); });
after(() => h.stop());
beforeEach(async () => {
  await h.reset();
  await h.room('room-a', { capacity: 4 });
  await h.setChain(DEAN);
  await h.restart({}, STRICT); // fresh in-memory counters, like a new process
});

const challenge = async (date = day(5), extra = {}) => {
  const r = await reserve(await h.student(), { date, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await h.deliver();
  return (await resDoc(r.body.reservation.id)).activeChallengeId;
};
const code = (cid, ip) => call(null, 'POST', `/api/approvals/${cid}/code`, {}, from(ip));
const verify = (cid, ip, c = '000000') => call(null, 'POST', `/api/approvals/${cid}/verify`, { code: c }, from(ip));

test('code requests are limited per client address across all requests, with Retry-After; other clients are unaffected', async () => {
  const cids = [await challenge(day(5)), await challenge(day(6)), await challenge(day(7), { startTime: '13:00', endTime: '14:00' })];
  for (const cid of cids) assert.equal((await code(cid, '203.0.113.7')).status, 200, 'three different requests, three codes');
  const blocked = await code(cids[0], '203.0.113.7');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.code, 'rate-limited');
  assert.match(blocked.headers.get('retry-after'), /^\d+$/);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0 && Number(blocked.headers.get('retry-after')) <= 900);
  assert.equal(blocked.headers.get('cache-control'), 'no-store');

  h.advance(0.6); // past the per-request resend wait, so only the address limit is in play
  assert.equal((await code(cids[0], '198.51.100.9')).status, 200, 'a different client address is counted separately');
  assert.equal((await call(null, 'GET', `/api/approvals/${cids[0]}`, undefined, from('203.0.113.7'))).status, 200, 'reading the public status is not a code request');
});

test('a throttled request spends nothing from the request\'s own budget, and a real approver from another address still gets through', async () => {
  const cid = await challenge();
  for (let i = 0; i < 4; i++) assert.equal((await verify(cid, '203.0.113.7')).status, 409, 'no code was requested yet, so the check cannot start');
  assert.equal((await verify(cid, '203.0.113.7')).status, 429);
  assert.equal((await db.doc(`approvalChallenges/${cid}`).get()).get('failedTotal'), 0);

  assert.equal((await code(cid, '198.51.100.9')).status, 200);
  await h.deliver();
  const ok = await verify(cid, '198.51.100.9', h.codeFor(DEAN));
  assert.equal(ok.status, 200);
  assert.ok(ok.body.session);
});

test('guessing is capped by the request itself no matter how many addresses are used', async () => {
  const cid = await challenge();
  assert.equal((await code(cid, '198.51.100.9')).status, 200);
  await h.deliver();
  const wrong = h.codeFor(DEAN) === '000000' ? '111111' : '000000';
  const results = [];
  for (let i = 0; i < 8; i++) results.push((await verify(cid, `192.0.2.${i + 1}`, wrong)).status); // eight addresses, none throttled
  assert.deepEqual(results.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.ok(results.slice(5).every((s) => s === 429 || s === 409), `locked after the per-code limit: ${results}`);
  const ch = (await db.doc(`approvalChallenges/${cid}`).get()).data();
  assert.ok(ch.failedTotal <= 5);
});

test('the window rolls over on the server clock, and the limit survives a restart', async () => {
  const cid = await challenge();
  for (let i = 0; i < 3; i++) { h.advance(0.6); assert.equal((await code(cid, '203.0.113.7')).status, 200); }
  assert.equal((await code(cid, '203.0.113.7')).status, 429);
  await h.restart({}, STRICT);
  assert.equal((await code(cid, '203.0.113.7')).status, 429, 'counted in Firestore, not in the process');
  h.advance(15); // next 15-minute window
  await h.restart({}, STRICT);
  assert.equal((await code(cid, '203.0.113.7')).status, 200);
});

test('client addresses are stored only as keyed hashes, and a spoofed header is ignored when no proxy is trusted', async () => {
  const cid = await challenge();
  await code(cid, '203.0.113.7');
  const docs = (await db.collection('rateLimits').get()).docs.filter((d) => d.id.startsWith('code_'));
  assert.equal(docs.length, 1);
  assert.match(docs[0].id, /^code_[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify([docs[0].id, docs[0].data()]).includes('203.0.113'));
  assert.ok(docs[0].get('expiresAt').toMillis() > h.clock().getTime(), 'carries an expiry so housekeeping can remove it');

  // With no trusted proxy the header is just noise: every request counts against the real socket address.
  await h.restart({ trustProxy: 0 }, STRICT);
  const other = await challenge(day(6));
  for (let i = 0; i < 3; i++) { h.advance(0.6); assert.equal((await code(other, `10.0.0.${i}`)).status, 200); }
  h.advance(0.6);
  const limited = await code(other, '10.0.0.99');
  assert.deepEqual([limited.status, limited.code], [429, 'rate-limited'], 'rotating X-Forwarded-For does not evade the limit');
});

test('the in-memory flood guard stops an address that hammers the public endpoints, and is per process', async () => {
  const cid = await challenge();
  await h.restart({}, { ...STRICT, ip: { windowMs: 60_000, max: 5 } });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await call(null, 'GET', `/api/approvals/${cid}`, undefined, from('203.0.113.50'))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`, undefined, from('203.0.113.51'))).status, 200);
  h.advance(1.1);
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`, undefined, from('203.0.113.50'))).status, 200, 'a new window starts after a minute');
  await h.restart({}, { ...STRICT, ip: { windowMs: 60_000, max: 5 } });
  assert.equal((await call(null, 'GET', `/api/approvals/${cid}`, undefined, from('203.0.113.50'))).status, 200, 'shortcut by design: a restart (or a second instance) starts counting again');
});

test('the health probe and the other APIs are not throttled by the approval limits', async () => {
  const health = await call(null, 'GET', '/api/health');
  assert.deepEqual([health.status, health.body, health.headers.get('x-content-type-options')], [200, { ok: true }, 'nosniff']);
  const student = await h.student();
  for (let i = 0; i < 10; i++) assert.equal((await call(student, 'GET', '/api/reservations/config', undefined, from('203.0.113.7'))).status, 200);
});

test('one student cannot make the server mail the approver without end: submissions are limited per student, counted even when cancelled', async () => {
  const student = await h.student();
  const other = await h.student();
  const slots = [['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00']];
  for (const [startTime, endTime] of slots) {
    const made = await reserve(student, { date: day(5), startTime, endTime });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call(student, 'POST', `/api/reservations/${made.body.reservation.id}/cancel`)).status, 200, 'cancelling frees the open-reservation limit but not the submission budget');
  }
  const blocked = await reserve(student, { date: day(5), startTime: '12:00', endTime: '13:00' });
  assert.deepEqual([blocked.status, blocked.code], [429, 'rate-limited']);
  assert.match(blocked.headers.get('retry-after'), /^\d+$/);
  await h.deliver();
  assert.equal(h.mailsTo(DEAN, 'approval-request').length, 3, 'the approver got three notices, not four');
  const fine = await reserve(other, { date: day(5), startTime: '12:00', endTime: '13:00' });
  assert.equal(fine.status, 201, `another student is unaffected: ${JSON.stringify(fine.body)}`);
  h.advance(61);
  assert.equal((await reserve(student, { date: day(5), startTime: '14:00', endTime: '15:00' })).status, 201, 'the next hour starts fresh');
  assert.equal((await db.collection('rateLimits').get()).docs.filter((d) => d.id.startsWith('submit_')).length, 2);
});
