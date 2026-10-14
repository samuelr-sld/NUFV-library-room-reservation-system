import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { issueTicket, QR_PREFIX } from '../../server/tickets.js';
import { encryptSecret } from '../../server/voucher.js';

const h = harness();
const { db, call, issue, resource, ticketDoc, lock } = h;

before(() => h.start());
after(() => h.stop());
beforeEach(() => h.reset());

const ROUTES = [
  ['GET', '/api/tickets/availability'],
  ['POST', '/api/tickets', { service: 'wifi-voucher' }],
  ['GET', '/api/tickets/active'],
  ['GET', '/api/tickets/history'],
  ['GET', '/api/tickets/SR-0000000000'],
  ['GET', '/api/tickets/SR-0000000000/print'],
];

// ---------------------------------------------------------------- who may use the stub routes

test('anonymous callers and invalid tokens get 401 everywhere', async () => {
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(null, method, path, body)).status, 401, `${method} ${path}`);
    assert.equal((await call('not-a-token', method, path, body)).status, 401);
  }
});

test('unverified students are refused everywhere and nothing is allocated', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student({ emailVerified: false });
  for (const [method, path, body] of ROUTES) {
    const r = await call(s, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.code, 'email-not-verified');
  }
  const r = await issue(s, 'silent-room');
  assert.equal(r.code, 'email-not-verified');
  assert.equal((await db.collection('tickets').get()).size, 0);
  assert.equal((await resource('silent-seat-01')).allocation.assigned, 0);
});

test('suspended, orphaned, profile-less and administrator accounts cannot generate stubs', async () => {
  await h.seats('silent-seat-01');
  for (const [who, code] of [
    [await h.student({ status: 'suspended' }), 'account-suspended'],
    [await h.student({ status: 'orphaned' }), 'account-suspended'],
    [await h.actor({ role: null, emailVerified: true }), 'no-profile'],
    [await h.actor({ role: 'admin', emailVerified: true }), 'forbidden'],
  ]) {
    const r = await issue(who, 'silent-room');
    assert.equal(r.status, 403);
    assert.equal(r.code, code);
  }
  assert.equal((await db.collection('tickets').get()).size, 0);
});

test('a student suspended after sign-in is refused on the very next call', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  assert.equal((await call(s, 'GET', '/api/tickets/availability')).status, 200);
  await db.doc(`users/${s.uid}`).update({ status: 'suspended' });
  assert.equal((await issue(s, 'silent-room')).code, 'account-suspended');
});

test('suspension is also re-checked inside the allocation transaction', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  await db.doc(`users/${s.uid}`).update({ status: 'suspended' });
  await assert.rejects(
    issueTicket({ db, config: h.config, uid: s.uid, service: 'silent-room', now: new Date() }), // skips the HTTP middleware entirely
    { code: 'account-suspended' },
  );
  assert.equal((await resource('silent-seat-01')).allocation.assigned, 0);
});

// ---------------------------------------------------------------- identity and isolation

test('identity comes from the token: student ids in the body, query or headers are ignored', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const victim = await h.student();
  const attacker = await h.student();
  const r = await call(attacker, 'POST', '/api/tickets?uid=' + victim.uid, { service: 'silent-room', uid: victim.uid, studentId: victim.uid, userId: victim.uid });
  assert.equal(r.status, 201);
  assert.equal((await ticketDoc(r.body.ticket.id)).uid, attacker.uid);
  assert.deepEqual(await lock(victim.uid), {});
  assert.deepEqual((await call(victim, 'GET', '/api/tickets/active')).body.tickets, []);
});

test("students cannot see, fetch or print each other's tickets; lists contain only their own", async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  const [a, b] = await Promise.all([h.student(), h.student()]);
  const ta = (await issue(a, 'silent-room')).body.ticket;
  const tb = (await issue(b, 'silent-room')).body.ticket;

  for (const path of [`/api/tickets/${ta.id}`, `/api/tickets/${ta.id}/print`]) {
    const r = await call(b, 'GET', path);
    assert.equal(r.status, 404, path);
    assert.equal(r.code, 'not-found');
  }
  const missing = await call(b, 'GET', '/api/tickets/SR-ZZZZZZZZZZ');
  assert.deepEqual([missing.status, missing.code], [404, 'not-found']); // same answer as a ticket that exists but is not yours
  assert.equal((await call(b, 'GET', '/api/tickets/not-a-ticket-id')).status, 404);

  assert.deepEqual((await call(a, 'GET', '/api/tickets/active')).body.tickets.map((t) => t.id), [ta.id]);
  assert.deepEqual((await call(b, 'GET', '/api/tickets/history')).body.tickets.map((t) => t.id), [tb.id]);
  assert.equal((await call(a, 'GET', `/api/tickets/${ta.id}`)).status, 200);
});

test('history is newest first, limited, validated, and survives expiry', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await issue(s, 'silent-room')).body.ticket.id);
    h.advance(20); // lapses; the next issue starts fresh
  }
  const history = (await call(s, 'GET', '/api/tickets/history')).body.tickets;
  assert.deepEqual(history.map((t) => t.id), [...ids].reverse());
  assert.ok(history.every((t) => t.status === 'expired'));
  assert.equal((await call(s, 'GET', '/api/tickets/history?limit=2')).body.tickets.length, 2);
  for (const bad of ['0', '51', 'abc', '1.5']) assert.equal((await call(s, 'GET', `/api/tickets/history?limit=${bad}`)).status, 400, bad);
});

test('availability is advisory and accurate: counts free seats, ignores maintenance, reports the limit', async () => {
  await h.seats('silent-seat-01', 'silent-seat-02');
  await h.seed('silent-seat-03', 'silent-seat', { status: 'maintenance' });
  await h.seed('silent-seat-04', 'silent-seat', { description: 'Window side' });
  await h.pcs('pc-01');
  const s = await h.student();
  await issue(s, 'silent-room');
  const a = (await call(s, 'GET', '/api/tickets/availability')).body;
  const silent = a.services['silent-room'];
  assert.deepEqual({ total: silent.total, available: silent.available }, { total: 3, available: 2 });
  // Every active seat is listed with its own status; maintenance seats are not, and no allocation detail leaks.
  assert.equal(silent.resources.length, 3);
  assert.deepEqual(silent.resources.map((r) => r.id).sort(), ['silent-seat-01', 'silent-seat-02', 'silent-seat-04']);
  assert.equal(silent.resources.filter((r) => !r.available).length, 1);
  assert.deepEqual(silent.resources.find((r) => r.id === 'silent-seat-04'), { id: 'silent-seat-04', label: 'SILENT-SEAT-04', description: 'Window side', available: true });
  assert.equal(a.services['computer-station'].total, 1);
  assert.equal(a.services['computer-station'].resources[0].available, true);
  assert.equal(a.services['wifi-voucher'].unlimited, true);
  assert.deepEqual({ limit: a.limit, active: a.active }, { limit: 1, active: 1 });
});

test('availability is not what protects the seat: a stale "available" view still cannot double-book', async () => {
  await h.seats('silent-seat-01');
  const [a, b] = await Promise.all([h.student(), h.student()]);
  assert.equal((await call(a, 'GET', '/api/tickets/availability')).body.services['silent-room'].available, 1);
  assert.equal((await call(b, 'GET', '/api/tickets/availability')).body.services['silent-room'].available, 1);
  assert.equal((await issue(a, 'silent-room')).status, 201);
  assert.equal((await issue(b, 'silent-room')).code, 'no-resource-available');
});

// ---------------------------------------------------------------- Wi-Fi voucher confidentiality

test('the demo password is returned only by the owner\'s print request, never by any other response', async () => {
  const s = await h.student();
  const other = await h.student();
  const issued = await issue(s, 'wifi-voucher');
  const id = issued.body.ticket.id;
  const print = await call(s, 'GET', `/api/tickets/${id}/print`);
  const password = print.body.voucher.password;
  assert.match(password, /^DEMO-/);
  const secret = password.slice(5);

  const everythingElse = JSON.stringify([
    issued.body,
    (await issue(s, 'wifi-voucher')).body, // idempotent repeat
    (await call(s, 'GET', '/api/tickets/active')).body,
    (await call(s, 'GET', '/api/tickets/history')).body,
    (await call(s, 'GET', `/api/tickets/${id}`)).body,
    (await call(s, 'GET', '/api/tickets/availability')).body,
    (await call(other, 'GET', `/api/tickets/${id}/print`)).body,
  ]);
  assert.ok(!everythingElse.includes(secret), 'password leaked outside the print response');
  assert.equal((await call(other, 'GET', `/api/tickets/${id}/print`)).status, 404);
  assert.equal(print.body.voucher.demo, true);
});

test('ticket and voucher responses are marked no-store so they are never cached', async () => {
  const s = await h.student();
  const id = (await issue(s, 'wifi-voucher')).body.ticket.id;
  for (const path of [`/api/tickets/${id}/print`, `/api/tickets/${id}`, '/api/tickets/active', '/api/tickets/history']) {
    assert.equal((await call(s, 'GET', path)).headers.get('cache-control'), 'no-store', path);
  }
});

test('at rest the password is ciphertext bound to its ticket; plaintext appears in no stored document or audit record', async () => {
  const s = await h.student();
  const id = (await issue(s, 'wifi-voucher')).body.ticket.id;
  const secret = (await call(s, 'GET', `/api/tickets/${id}/print`)).body.voucher.password.slice(5);

  const dump = JSON.stringify([
    ...(await db.collection('tickets').get()).docs.map((d) => d.data()),
    ...(await db.collection('ticketLocks').get()).docs.map((d) => d.data()),
    await h.allAudits(),
  ]);
  assert.ok(!dump.includes(secret));
  const { credential } = await ticketDoc(id);
  assert.deepEqual(Object.keys(credential).sort(), ['ct', 'iv', 'tag', 'v']);

});

test('a voucher whose credential cannot be decrypted degrades to "password unavailable" instead of failing', async () => {
  const s = await h.student();
  const id = (await issue(s, 'wifi-voucher')).body.ticket.id;
  await db.doc(`tickets/${id}`).update({ credential: encryptSecret(Buffer.alloc(32, 7), 'DEMO-AAAA-BBBB-CCCC', id) }); // wrong key
  const r = await call(s, 'GET', `/api/tickets/${id}/print`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.voucher, { demo: true, password: null, passwordAvailable: false });

  await db.doc(`tickets/${id}`).update({ credential: encryptSecret(h.config.voucherKey, 'DEMO-AAAA-BBBB-CCCC', 'WF-SOMEOTHERID') }); // belongs to another ticket
  assert.equal((await call(s, 'GET', `/api/tickets/${id}/print`)).body.voucher.passwordAvailable, false);
});

test('once a voucher is no longer active its password is no longer returned', async () => {
  const s = await h.student();
  const id = (await issue(s, 'wifi-voucher')).body.ticket.id;
  assert.equal((await call(s, 'GET', `/api/tickets/${id}/print`)).body.voucher.passwordAvailable, true);
  h.advance(181);
  const r = await call(s, 'GET', `/api/tickets/${id}/print`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.status, 'expired');
  assert.deepEqual(r.body.voucher, { demo: true, password: null, passwordAvailable: false });
});

test('wi-fi vouchers count toward the active-ticket limit', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  assert.equal((await issue(s, 'wifi-voucher')).status, 201);
  assert.equal((await issue(s, 'silent-room')).code, 'ticket-limit-reached');
  assert.equal((await resource('silent-seat-01')).allocation.assigned, 0);
});

// ---------------------------------------------------------------- QR payload

test('the QR carries only an opaque reference: no password, ticket id, student, email or seat', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const seatTicket = (await issue(s, 'silent-room')).body.ticket;
  const wifi = await h.student();
  const voucher = (await issue(wifi, 'wifi-voucher')).body.ticket;
  const password = (await call(wifi, 'GET', `/api/tickets/${voucher.id}/print`)).body.voucher.password;

  for (const [t, who, extra] of [[seatTicket, s, ['SILENT-SEAT-01']], [voucher, wifi, [password, password.slice(5), 'DEMO']]]) {
    assert.ok(t.qrPayload.startsWith(QR_PREFIX));
    const ref = t.qrPayload.slice(QR_PREFIX.length);
    assert.match(ref, /^[A-Za-z0-9_-]{24}$/);
    for (const forbidden of [t.id, who.uid, who.email, ...extra]) assert.ok(!t.qrPayload.includes(forbidden), `QR contains ${forbidden}`);
    assert.equal((await ticketDoc(t.id)).qrRef, ref);
  }
  assert.notEqual(seatTicket.qrPayload, voucher.qrPayload);
});

test('print data has the student identity, a rendered QR image and the same opaque payload', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();
  const t = (await issue(s, 'silent-room')).body.ticket;
  const r = await call(s, 'GET', `/api/tickets/${t.id}/print`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.student, { fullName: 'Test Person', studentNumber: '2023-000000' });
  assert.match(r.body.qrSvg, /^<\?xml|^<svg/);
  assert.ok(r.body.qrSvg.includes('<path'));
  assert.equal(r.body.ticket.qrPayload, t.qrPayload);
  assert.equal(r.body.voucher, undefined, 'only vouchers carry a voucher block');
  assert.ok(!r.body.qrSvg.includes(t.qrPayload), 'the svg is a picture, not the text');
});

// ---------------------------------------------------------------- transaction rollback

test('a failure at the last step of the transaction rolls everything back: no ticket, counter, lock or audit', async () => {
  await h.seats('silent-seat-01');
  const s = await h.student();

  // A db whose transactions throw when the audit record is written, i.e. after every other write was queued.
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

  await assert.rejects(issueTicket({ db: failing, config: h.config, uid: s.uid, service: 'silent-room', now: new Date() }), /injected failure/);
  assert.equal((await db.collection('tickets').get()).size, 0);
  assert.deepEqual((await resource('silent-seat-01')).allocation, { assigned: 0, occupied: 0, held: 0 });
  assert.deepEqual(await lock(s.uid), {});
  assert.equal((await db.collection('auditLogs').where('action', '==', 'ticket.issued').get()).size, 0);

  // ...and the seat is still fully usable afterwards.
  assert.equal((await issue(s, 'silent-room')).status, 201);
});

test('a failed request leaves existing stubs untouched', async () => {
  await h.seats('silent-seat-01');
  await h.pcs('pc-01');
  const s = await h.student();
  const first = (await issue(s, 'silent-room')).body.ticket;
  assert.equal((await issue(s, 'computer-station')).code, 'ticket-limit-reached');
  assert.deepEqual(await lock(s.uid), { 'silent-room': first.id });
  assert.equal((await ticketDoc(first.id)).status, 'issued');
  assert.equal((await db.collection('tickets').get()).size, 1);
});
