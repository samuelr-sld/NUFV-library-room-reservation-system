import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { DEFAULTS } from '../../server/settings.js';

const t = setup();
const { db, call, audits, id } = t;
let admin;
let student;

before(async () => {
  await t.start();
  await db.doc('settings/system').delete(); // this file is the only user of the settings document
  admin = await t.actor({ role: 'admin' });
  student = await t.actor({ role: 'student' });
});
after(() => t.stop());

const seat = (rid, extra = {}) => ({ id: rid, type: 'silent-seat', label: 'Seat 1', ...extra });
const create = async (body) => call(admin, 'POST', '/api/admin/resources', body);
const setAllocation = (rid, allocation) => db.doc(`resources/${rid}`).update({ allocation });

// ---------------------------------------------------------------- authorization

const ADMIN_ROUTES = [
  ['GET', '/api/admin/summary'],
  ['GET', '/api/admin/resources'],
  ['POST', '/api/admin/resources', { id: 'denied-01', type: 'silent-seat', label: 'x' }],
  ['GET', '/api/admin/resources/denied-01'],
  ['PATCH', '/api/admin/resources/denied-01', { label: 'y' }],
  ['DELETE', '/api/admin/resources/denied-01'],
  ['GET', '/api/admin/settings'],
  ['PATCH', '/api/admin/settings', { noShowGraceMinutes: 5 }],
];

test('anonymous callers get 401 on every admin route', async () => {
  for (const [method, path, body] of ADMIN_ROUTES) assert.equal((await call(null, method, path, body)).status, 401, `${method} ${path}`);
  assert.equal((await call('not-a-token', 'GET', '/api/admin/summary')).status, 401);
});

test('students are denied every admin route and nothing is written', async () => {
  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await call(student, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.code, 'forbidden');
  }
  assert.equal((await db.doc('resources/denied-01').get()).exists, false, 'resource written');
  assert.equal((await db.doc('settings/system').get()).exists, false, 'settings written');
});

test('a forged admin claim, a missing profile or a suspended administrator is denied', async () => {
  const forged = await t.actor({ role: 'student', claim: 'admin' });
  assert.equal((await call(forged, 'GET', '/api/admin/summary')).status, 403);

  const noProfile = await t.actor({ role: null });
  assert.equal((await call(noProfile, 'GET', '/api/admin/summary')).status, 403);

  const suspended = await t.actor({ role: 'admin', status: 'suspended' });
  const res = await call(suspended, 'POST', '/api/admin/resources', seat(id('seat')));
  assert.equal(res.status, 403);
  assert.equal(res.code, 'account-suspended');

  const orphaned = await t.actor({ role: 'admin', status: 'orphaned' });
  assert.equal((await call(orphaned, 'GET', '/api/admin/summary')).status, 403);
});

test('an administrator suspended after sign-in loses access immediately', async () => {
  const a = await t.actor({ role: 'admin' });
  assert.equal((await call(a, 'GET', '/api/admin/summary')).status, 200);
  await db.doc(`users/${a.uid}`).update({ status: 'suspended' });
  assert.equal((await call(a, 'GET', '/api/admin/summary')).status, 403);
});

// ---------------------------------------------------------------- resource CRUD

test('an administrator creates, reads, lists and audits a resource', async () => {
  const rid = id('silent-seat');
  const res = await create(seat(rid, { label: '  Seat 12  ' }));
  assert.equal(res.status, 201);
  const r = res.body.resource;
  assert.deepEqual({ id: r.id, type: r.type, label: r.label, status: r.status, capacity: r.capacity }, { id: rid, type: 'silent-seat', label: 'Seat 12', status: 'active', capacity: null });
  assert.deepEqual(r.allocation, { assigned: 0, occupied: 0, held: 0 });
  assert.equal(r.available, true);
  assert.equal(r.createdBy, admin.uid);
  assert.equal(r.updatedBy, admin.uid);
  assert.ok(Date.parse(r.createdAt) && Date.parse(r.updatedAt));

  assert.deepEqual((await call(admin, 'GET', `/api/admin/resources/${rid}`)).body.resource, r);
  assert.ok((await call(admin, 'GET', '/api/admin/resources')).body.resources.some((x) => x.id === rid));

  const logs = await audits(rid, 'resource.create');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actorUid, admin.uid);
  assert.deepEqual(logs[0].details, { type: 'silent-seat', label: 'Seat 12', capacity: null, status: 'active' });
});

test('all three resource types can be created; discussion rooms need a capacity, others must not have one', async () => {
  const room = await create({ id: id('room'), type: 'discussion-room', label: 'Discussion Room 9', capacity: 8 });
  assert.equal(room.status, 201);
  assert.equal(room.body.resource.capacity, 8);
  assert.equal((await create({ id: id('pc'), type: 'computer-station', label: 'PC 1' })).status, 201);
  assert.equal((await create({ id: id('room'), type: 'discussion-room', label: 'No capacity' })).status, 400);
  assert.equal((await create({ id: id('room'), type: 'discussion-room', label: 'Too big', capacity: 51 })).status, 400);
  assert.equal((await create({ id: id('room'), type: 'discussion-room', label: 'Float', capacity: 2.5 })).status, 400);
  assert.equal((await create({ id: id('pc'), type: 'computer-station', label: 'PC', capacity: 4 })).status, 400);
});

test('duplicate resource ids are rejected, including two simultaneous creates', async () => {
  const rid = id('seat');
  assert.equal((await create(seat(rid, { label: 'Original' }))).status, 201);
  const dup = await create(seat(rid, { label: 'Impostor', type: 'computer-station' }));
  assert.equal(dup.status, 409);
  assert.equal(dup.code, 'already-exists');
  const stored = (await db.doc(`resources/${rid}`).get()).data();
  assert.equal(stored.label, 'Original');
  assert.equal(stored.type, 'silent-seat');
  assert.equal((await audits(rid, 'resource.create')).length, 1);

  const raced = id('seat');
  const statuses = (await Promise.all([create(seat(raced)), create(seat(raced))])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal((await audits(raced, 'resource.create')).length, 1);
});

test('invalid create requests are rejected with 400 and write nothing', async () => {
  const bad = [
    {}, [],
    seat('ab'), seat('UPPER-case'), seat('has space'), seat('-lead-01'), seat('trail-'), seat('dou--ble'), seat('../users/x'), seat('x'.repeat(41)), seat(123),
    { ...seat('bad-type-01'), type: 'laptop' },
    seat('bad-label-01', { label: '' }), seat('bad-label-02', { label: '   ' }), seat('bad-label-03', { label: 'x'.repeat(81) }),
    seat('bad-label-04', { label: 'tab\there' }), seat('bad-label-05', { label: { a: 1 } }),
    seat('bad-status-01', { status: 'retired' }), seat('bad-status-02', { status: 'weird' }),
    seat('extra-field-01', { allocation: { held: 0 } }), seat('extra-field-02', { createdBy: 'someone' }), seat('extra-field-03', { available: true }),
  ];
  for (const body of bad) {
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.code, 'invalid-argument');
  }
  for (const rid of ['bad-type-01', 'bad-label-01', 'bad-status-01', 'extra-field-01', 'extra-field-02', 'extra-field-03']) {
    assert.equal((await db.doc(`resources/${rid}`).get()).exists, false, rid);
  }
});

test('updates record changes in the audit log; no-op updates write nothing', async () => {
  const rid = id('room');
  await create({ id: rid, type: 'discussion-room', label: 'Room A', capacity: 4 });
  const res = await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { label: 'Room B', capacity: 6 });
  assert.equal(res.status, 200);
  assert.equal(res.body.resource.label, 'Room B');
  assert.equal(res.body.resource.capacity, 6);
  assert.equal(res.body.resource.updatedBy, admin.uid);

  const [log] = await audits(rid, 'resource.update');
  assert.deepEqual(log.details.changes, { label: { from: 'Room A', to: 'Room B' }, capacity: { from: 4, to: 6 } });

  assert.equal((await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { label: 'Room B' })).status, 200);
  assert.equal((await audits(rid, 'resource.update')).length, 1);
});

test('id, type, allocation counters, ownership and unknown fields cannot be changed through the API', async () => {
  const rid = id('seat');
  await create(seat(rid));
  for (const patch of [
    { id: 'other-id' }, { type: 'computer-station' }, { allocation: { assigned: 0, occupied: 0, held: 0 } }, { allocation: { held: 5 } },
    { createdBy: 'x' }, { available: true }, { label: 'ok', surprise: 1 }, {}, [],
  ]) {
    const res = await call(admin, 'PATCH', `/api/admin/resources/${rid}`, patch);
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  const stored = (await db.doc(`resources/${rid}`).get()).data();
  assert.equal(stored.type, 'silent-seat');
  assert.deepEqual(stored.allocation, { assigned: 0, occupied: 0, held: 0 });
  assert.equal((await audits(rid, 'resource.update')).length, 0);
});

test('missing resources return 404 and malformed ids never reach the database', async () => {
  for (const [method, body] of [['GET'], ['PATCH', { label: 'x' }], ['DELETE']]) {
    assert.equal((await call(admin, method, '/api/admin/resources/does-not-exist-01', body)).status, 404, method);
    assert.equal((await call(admin, method, '/api/admin/resources/..%2Fusers', body)).status, 404, `${method} traversal`);
  }
});

// ---------------------------------------------------------------- operational transitions

test('valid transitions: active <-> maintenance, then retire; every one is audited', async () => {
  const rid = id('pc');
  await create({ id: rid, type: 'computer-station', label: 'PC 7' });
  const patch = (status) => call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status });
  assert.equal((await patch('maintenance')).body.resource.status, 'maintenance');
  assert.equal((await patch('active')).body.resource.status, 'active');
  assert.equal((await patch('maintenance')).status, 200);
  const del = await call(admin, 'DELETE', `/api/admin/resources/${rid}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.resource.status, 'retired');
  assert.equal((await audits(rid, 'resource.update')).length, 3);
  assert.equal((await audits(rid, 'resource.retire')).length, 1);
});

test('invalid transitions are rejected: same state, unknown state, and anything out of retired', async () => {
  const rid = id('seat');
  await create(seat(rid));
  const patch = (body) => call(admin, 'PATCH', `/api/admin/resources/${rid}`, body);
  assert.equal((await patch({ status: 'active' })).code, 'invalid-transition');
  assert.equal((await patch({ status: 'broken' })).status, 400);
  assert.equal((await patch({ status: 5 })).status, 400);

  await call(admin, 'DELETE', `/api/admin/resources/${rid}`);
  for (const body of [{ status: 'active' }, { status: 'maintenance' }, { status: 'retired' }, { label: 'Renamed' }]) {
    const res = await patch(body);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(res.code, 'resource-retired');
  }
  assert.equal((await call(admin, 'DELETE', `/api/admin/resources/${rid}`)).code, 'resource-retired');
  const stored = (await db.doc(`resources/${rid}`).get()).data();
  assert.equal(stored.status, 'retired');
  assert.equal(stored.label, 'Seat 1');
});

test('retiring never hard-deletes: the document and its audit trail remain', async () => {
  const rid = id('seat');
  await create(seat(rid));
  await call(admin, 'DELETE', `/api/admin/resources/${rid}`);
  assert.equal((await db.doc(`resources/${rid}`).get()).exists, true);
  assert.equal((await audits(rid)).length, 2);
});

// ---------------------------------------------------------------- allocation safety

test('a resource with any assignment, occupancy or hold cannot go to maintenance or be retired', async () => {
  for (const kind of ['assigned', 'occupied', 'held']) {
    const rid = id('room');
    await create({ id: rid, type: 'discussion-room', label: `In use (${kind})`, capacity: 4 });
    await setAllocation(rid, { assigned: 0, occupied: 0, held: 0, [kind]: 1 });
    const before = (await db.doc(`resources/${rid}`).get()).get('updatedAt');

    const maintenance = await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'maintenance' });
    assert.equal(maintenance.status, 409, kind);
    assert.equal(maintenance.code, 'resource-in-use');
    assert.match(maintenance.body.error.message, new RegExp(`1 ${kind}`));
    const retire = await call(admin, 'DELETE', `/api/admin/resources/${rid}`);
    assert.equal(retire.code, 'resource-in-use', kind);

    const stored = (await db.doc(`resources/${rid}`).get()).data();
    assert.equal(stored.status, 'active');
    assert.ok(stored.updatedAt.isEqual(before), 'a refused change must not touch the document');
    assert.equal((await audits(rid, 'resource.update')).length, 0);
    assert.equal((await audits(rid, 'resource.retire')).length, 0);
    assert.equal((await call(admin, 'GET', `/api/admin/resources/${rid}`)).body.resource.available, false);
  }
});

test('harmless edits stay possible while a resource is in use, and release unblocks maintenance', async () => {
  const rid = id('room');
  await create({ id: rid, type: 'discussion-room', label: 'Busy', capacity: 4 });
  await setAllocation(rid, { assigned: 0, occupied: 1, held: 2 });
  assert.equal((await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { label: 'Busy (renamed)', capacity: 5 })).status, 200);
  assert.equal((await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'maintenance' })).code, 'resource-in-use');

  await setAllocation(rid, { assigned: 0, occupied: 0, held: 0 });
  assert.equal((await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'maintenance' })).status, 200);
});

test('availability is derived from operational status AND allocations, never stored', async () => {
  const rid = id('seat');
  await create(seat(rid));
  const get = async () => (await call(admin, 'GET', `/api/admin/resources/${rid}`)).body.resource;
  assert.equal((await get()).available, true);
  await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'maintenance' });
  assert.equal((await get()).available, false);
  await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'active' });
  await setAllocation(rid, { assigned: 1, occupied: 0, held: 0 });
  assert.equal((await get()).available, false);
  assert.equal('available' in (await db.doc(`resources/${rid}`).get()).data(), false);
});

test('a status change racing an allocation never leaves an allocated resource out of service', async () => {
  // Stand-in for the future allocator: it reads the resource and writes its counter in one transaction, as that code must.
  const allocate = (rid) => db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc(`resources/${rid}`));
    if (snap.get('status') !== 'active') return false;
    tx.update(db.doc(`resources/${rid}`), { 'allocation.held': (snap.get('allocation.held') ?? 0) + 1 });
    return true;
  });
  for (let i = 0; i < 6; i++) {
    const rid = id('seat');
    await create(seat(rid));
    const [allocated, patched] = await Promise.all([allocate(rid), call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'maintenance' })]);
    const stored = (await db.doc(`resources/${rid}`).get()).data();
    assert.ok(!(stored.status !== 'active' && stored.allocation.held > 0), `round ${i}: ${stored.status} with ${stored.allocation.held} held`);
    assert.equal(allocated, stored.allocation.held === 1);
    assert.ok([200, 409].includes(patched.status));
  }
});

// ---------------------------------------------------------------- listing and summary

test('list filters by type and status, rejects unknown filters, and sorts predictably', async () => {
  const prefix = id('zz');
  const ids = [`${prefix}-b`, `${prefix}-a`];
  await create({ id: ids[0], type: 'computer-station', label: 'PC 10' });
  await create({ id: ids[1], type: 'computer-station', label: 'PC 2' });
  await call(admin, 'PATCH', `/api/admin/resources/${ids[0]}`, { status: 'maintenance' });

  const mine = (list) => list.filter((r) => ids.includes(r.id));
  const all = await call(admin, 'GET', '/api/admin/resources?type=computer-station');
  assert.deepEqual(mine(all.body.resources).map((r) => r.label), ['PC 2', 'PC 10']);
  assert.ok(all.body.resources.every((r) => r.type === 'computer-station'));
  assert.deepEqual(mine((await call(admin, 'GET', '/api/admin/resources?status=maintenance')).body.resources).map((r) => r.id), [ids[0]]);
  assert.equal((await call(admin, 'GET', '/api/admin/resources?type=laptop')).status, 400);
  assert.equal((await call(admin, 'GET', '/api/admin/resources?status=gone')).status, 400);
  assert.equal((await call(admin, 'GET', '/api/admin/resources?type=a&type=b')).status, 400);
});

test('summary counts resources by type and status and reports in-use and available', async () => {
  const before = (await call(admin, 'GET', '/api/admin/summary')).body.byType['silent-seat'];
  const [a, b, c] = [id('sum'), id('sum'), id('sum')];
  for (const rid of [a, b, c]) await create(seat(rid));
  await call(admin, 'PATCH', `/api/admin/resources/${b}`, { status: 'maintenance' });
  await setAllocation(c, { assigned: 1, occupied: 0, held: 0 });

  const res = await call(admin, 'GET', '/api/admin/summary');
  const after = res.body.byType['silent-seat'];
  assert.deepEqual(
    { total: after.total - before.total, active: after.active - before.active, maintenance: after.maintenance - before.maintenance, inUse: after.inUse - before.inUse, available: after.available - before.available },
    { total: 3, active: 2, maintenance: 1, inUse: 1, available: 1 },
  );
  assert.ok(res.body.byType['discussion-room'] && res.body.byType['computer-station']);
  assert.equal(typeof res.body.settings.settings.noShowGraceMinutes, 'number');
});

// ---------------------------------------------------------------- settings

test('settings start at safe defaults without writing anything', async () => {
  const res = await call(admin, 'GET', '/api/admin/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.settings, DEFAULTS);
  assert.equal(res.body.customized, false);
  assert.equal(res.body.version, 0);
  assert.equal((await db.doc('settings/system').get()).exists, false, JSON.stringify((await db.doc('settings/system').get()).data()));
});

test('a valid settings change is stored, versioned and audited with before and after values', async () => {
  const res = await call(admin, 'PATCH', '/api/admin/settings', { silentRoomTicketMinutes: 90, noShowGraceMinutes: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.silentRoomTicketMinutes, 90);
  assert.equal(res.body.settings.noShowGraceMinutes, 10);
  assert.equal(res.body.settings.maxActiveTicketsPerStudent, DEFAULTS.maxActiveTicketsPerStudent);
  assert.equal(res.body.version, 1);
  assert.equal(res.body.updatedBy, admin.uid);
  assert.equal(res.body.customized, true);
  assert.deepEqual((await call(admin, 'GET', '/api/admin/settings')).body.settings, res.body.settings);

  const second = await call(admin, 'PATCH', '/api/admin/settings', { reservationAdvanceBookingDays: 14, discussionRoomBookingIntervalMinutes: 30 });
  assert.equal(second.body.version, 2);
  const logs = (await audits('system', 'settings.update')).sort((x, y) => x.details.version - y.details.version);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0].details.changes, { silentRoomTicketMinutes: { from: 120, to: 90 }, noShowGraceMinutes: { from: 15, to: 10 } });
  assert.deepEqual(logs[1].details.changes.reservationAdvanceBookingDays, { from: 7, to: 14 });
  assert.equal(logs[0].actorUid, admin.uid);
});

test('settings validation rejects out-of-range, non-integer, unknown and cross-field-inconsistent values', async () => {
  const bad = [
    { silentRoomTicketMinutes: 14 }, { silentRoomTicketMinutes: 481 }, { computerTicketMinutes: 241 }, { computerTicketMinutes: 0 },
    { noShowGraceMinutes: -1 }, { noShowGraceMinutes: 61 }, { maxActiveTicketsPerStudent: 0 }, { maxActiveTicketsPerStudent: 6 },
    { discussionRoomBookingIntervalMinutes: 45 }, { discussionRoomBookingIntervalMinutes: 0 },
    { reservationAdvanceBookingDays: 0 }, { reservationAdvanceBookingDays: 61 },
    { silentRoomTicketMinutes: '90' }, { silentRoomTicketMinutes: 90.5 }, { silentRoomTicketMinutes: null }, { silentRoomTicketMinutes: true }, { noShowGraceMinutes: NaN },
    { unknownSetting: 1 }, { version: 99 }, { silentRoomTicketMinutes: 90, extra: 1 }, {}, [],
    { noShowGraceMinutes: 60, computerTicketMinutes: 60 }, // grace must be shorter than every ticket duration
    { noShowGraceMinutes: 15, computerTicketMinutes: 15 }, // equal is not shorter
  ];
  const before = (await call(admin, 'GET', '/api/admin/settings')).body;
  const logsBefore = (await audits('system', 'settings.update')).length;
  for (const patch of bad) {
    const res = await call(admin, 'PATCH', '/api/admin/settings', patch);
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.equal(res.code, 'invalid-argument');
  }
  const after = (await call(admin, 'GET', '/api/admin/settings')).body;
  assert.deepEqual(after.settings, before.settings);
  assert.equal(after.version, before.version);
  assert.equal((await audits('system', 'settings.update')).length, logsBefore);
});

test('re-submitting identical settings changes nothing and writes no audit entry', async () => {
  const current = (await call(admin, 'GET', '/api/admin/settings')).body;
  const logsBefore = (await audits('system', 'settings.update')).length;
  const res = await call(admin, 'PATCH', '/api/admin/settings', { silentRoomTicketMinutes: current.settings.silentRoomTicketMinutes });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, false);
  assert.equal(res.body.version, current.version);
  assert.equal((await audits('system', 'settings.update')).length, logsBefore);
});

test('students cannot change settings or inventory, directly or through the API', async () => {
  const before = (await call(admin, 'GET', '/api/admin/settings')).body;
  const res = await call(student, 'PATCH', '/api/admin/settings', { maxActiveTicketsPerStudent: 5 });
  assert.equal(res.status, 403);
  assert.deepEqual((await call(admin, 'GET', '/api/admin/settings')).body.settings, before.settings);
  assert.equal((await call(student, 'POST', '/api/admin/resources', seat(id('sneaky')))).status, 403);
});

test('concurrent settings changes serialize: versions are unique and the final state is one of the writes', async () => {
  const start = (await call(admin, 'GET', '/api/admin/settings')).body.version;
  const results = await Promise.all([
    call(admin, 'PATCH', '/api/admin/settings', { maxActiveTicketsPerStudent: 2 }),
    call(admin, 'PATCH', '/api/admin/settings', { maxActiveTicketsPerStudent: 3 }),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  const end = (await call(admin, 'GET', '/api/admin/settings')).body;
  assert.equal(end.version, start + 2);
  assert.ok([2, 3].includes(end.settings.maxActiveTicketsPerStudent));
});

// ---------------------------------------------------------------- audit integrity

test('failed administrative requests leave no audit trail and successful ones always name the actor', async () => {
  const rid = id('seat');
  await create(seat(rid));
  await call(student, 'PATCH', `/api/admin/resources/${rid}`, { label: 'hacked' });
  await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { status: 'active' }); // invalid transition
  await call(admin, 'PATCH', `/api/admin/resources/${rid}`, { label: '' }); // invalid input
  assert.equal((await audits(rid, 'resource.update')).length, 0);
  assert.equal((await audits(rid)).length, 1);
  assert.ok((await audits(rid)).every((l) => l.actorUid === admin.uid));
});
