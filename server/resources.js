import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';

// Inventory of reservable resources (resources/{id}). Written only here, by administrators, through the Admin SDK.
//
// State is kept in separate dimensions so no single flag can be flipped to bypass an allocation:
//   status      operational state, admin-controlled: active | maintenance | retired
//   allocation  { assigned, occupied, held } counters, maintained ONLY by the server transactions that issue tickets and
//               reservations (a later phase), in the same transaction that reads this document. Never writable here.
//   available   derived on read: status === 'active' and no assignment, occupancy or hold. Never stored.
// Resources are never hard-deleted: audit records, tickets and reservations refer to them by id. "Delete" retires.

export const TYPES = ['silent-seat', 'computer-station', 'discussion-room'];
export const STATUSES = ['active', 'maintenance', 'retired'];
const TRANSITIONS = { active: ['maintenance', 'retired'], maintenance: ['active', 'retired'], retired: [] };
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const invalid = (message) => new HttpError(400, 'invalid-argument', message);
const iso = (t) => t?.toDate().toISOString() ?? null;
const ref = (db, id) => db.doc(`resources/${id}`);
export const inUse = (a = {}) => (a.assigned ?? 0) + (a.occupied ?? 0) + (a.held ?? 0);

export const isValidId = (id) => typeof id === 'string' && id.length >= 3 && id.length <= 40 && ID.test(id);

export function present(snap) {
  const d = snap.data();
  const allocation = { assigned: 0, occupied: 0, held: 0, ...d.allocation };
  return {
    id: snap.id, type: d.type, label: d.label, capacity: d.capacity ?? null, status: d.status,
    allocation, available: d.status === 'active' && inUse(allocation) === 0,
    createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt), createdBy: d.createdBy, updatedBy: d.updatedBy,
  };
}

function checkLabel(label) {
  if (typeof label !== 'string') throw invalid('label must be text.');
  const v = label.trim();
  if (v.length < 1 || v.length > 80 || /[\u0000-\u001f]/.test(v)) throw invalid('label must be 1 to 80 characters.');
  return v;
}

function checkCapacity(type, capacity) {
  if (type === 'discussion-room') {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw invalid('capacity must be a whole number from 1 to 50 for discussion rooms.');
    return capacity;
  }
  if (capacity !== undefined && capacity !== null) throw invalid('capacity applies to discussion rooms only.');
  return null;
}

const plainObject = (b) => b !== null && typeof b === 'object' && !Array.isArray(b);

export async function createResource({ db, uid, body }) {
  if (!plainObject(body)) throw invalid('Request body must be a JSON object.');
  const allowed = ['id', 'type', 'label', 'capacity', 'status'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(`Unknown field "${k}".`);

  const { id, type } = body;
  if (!isValidId(id)) throw invalid('id must be 3 to 40 characters: lowercase letters, digits and single hyphens, e.g. silent-seat-01.');
  if (!TYPES.includes(type)) throw invalid(`type must be one of ${TYPES.join(', ')}.`);
  const label = checkLabel(body.label);
  const capacity = checkCapacity(type, body.capacity);
  const status = body.status ?? 'active';
  if (!['active', 'maintenance'].includes(status)) throw invalid('A new resource must start as active or maintenance.');

  await db.runTransaction(async (tx) => {
    // create() fails if the id exists, so two admins racing for the same id cannot both succeed.
    if ((await tx.get(ref(db, id))).exists) throw new HttpError(409, 'already-exists', 'A resource with this id already exists.');
    tx.create(ref(db, id), {
      type, label, capacity, status,
      allocation: { assigned: 0, occupied: 0, held: 0 },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid,
    });
    audit(db, tx, { actorUid: uid, action: 'resource.create', targetType: 'resource', targetId: id, details: { type, label, capacity, status } });
  });
  return present(await ref(db, id).get());
}

// patch: any of label, capacity, status. action names the audit entry ('resource.update' or 'resource.retire').
export async function changeResource({ db, uid, id, patch, action = 'resource.update', now = new Date() }) {
  if (!isValidId(id)) throw new HttpError(404, 'not-found', 'Resource not found.');
  if (!plainObject(patch)) throw invalid('Request body must be a JSON object.');
  for (const k of Object.keys(patch)) {
    if (k === 'id' || k === 'type') throw invalid(`${k} cannot be changed.`);
    if (!['label', 'capacity', 'status'].includes(k)) throw invalid(`Unknown field "${k}".`);
  }
  if (!Object.keys(patch).length) throw invalid('Provide at least one field to change.');
  if ('status' in patch && !STATUSES.includes(patch.status)) throw invalid(`status must be one of ${STATUSES.join(', ')}.`);

  const changed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(db, id));
    if (!snap.exists) throw new HttpError(404, 'not-found', 'Resource not found.');
    const current = snap.data();
    if (current.status === 'retired') throw new HttpError(409, 'resource-retired', 'A retired resource cannot be changed.');

    const next = {};
    const changes = {};
    const set = (k, v) => { if (v !== (current[k] ?? null)) { next[k] = v; changes[k] = { from: current[k] ?? null, to: v }; } };
    if ('label' in patch) set('label', checkLabel(patch.label));
    if ('capacity' in patch) set('capacity', checkCapacity(current.type, patch.capacity));
    if ('status' in patch && patch.status !== current.status) {
      if (!TRANSITIONS[current.status].includes(patch.status)) {
        throw new HttpError(409, 'invalid-transition', `A resource cannot move from ${current.status} to ${patch.status}.`);
      }
      // Taking a resource out of service must never strand a ticket, occupant or reservation hold.
      const a = current.allocation ?? {};
      if (patch.status !== 'active' && inUse(a)) {
        throw new HttpError(409, 'resource-in-use',
          `This resource has ${a.assigned ?? 0} assigned, ${a.occupied ?? 0} occupied and ${a.held ?? 0} held allocation(s). Release them first.`);
      }
      // A discussion room with pending or upcoming reservations must not be taken out of service silently either.
      if (patch.status !== 'active' && current.type === 'discussion-room') {
        const open = (await tx.get(db.collection('reservations').where('roomId', '==', id).where('status', 'in', ['pending', 'confirmed']))).docs
          .filter((d) => d.get('endsAt').toMillis() > now.getTime()).length;
        if (open) throw new HttpError(409, 'resource-in-use', `This room has ${open} pending or upcoming reservation(s). Cancel or finish them first.`);
      }
      set('status', patch.status);
    } else if (patch.status === current.status && Object.keys(patch).length === 1) {
      throw new HttpError(409, 'invalid-transition', `The resource is already ${current.status}.`);
    }

    if (!Object.keys(changes).length) return false;
    tx.update(ref(db, id), { ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    audit(db, tx, { actorUid: uid, action, targetType: 'resource', targetId: id, details: { changes } });
    return true;
  });
  return { changed, resource: present(await ref(db, id).get()) };
}

export const retireResource = (args) => changeResource({ ...args, patch: { status: 'retired' }, action: 'resource.retire' });

export async function getResource(db, id) {
  const snap = isValidId(id) ? await ref(db, id).get() : null;
  if (!snap?.exists) throw new HttpError(404, 'not-found', 'Resource not found.');
  return present(snap);
}

// shortcut: reads every resource and filters in memory; fine for a library's inventory (hundreds). Move to indexed queries or counters beyond ~1000.
const LIMIT = 1000;
async function all(db) {
  return (await db.collection('resources').limit(LIMIT).get()).docs.map(present);
}

export async function listResources(db, { type, status } = {}) {
  if (type !== undefined && !TYPES.includes(type)) throw invalid(`type must be one of ${TYPES.join(', ')}.`);
  if (status !== undefined && !STATUSES.includes(status)) throw invalid(`status must be one of ${STATUSES.join(', ')}.`);
  return (await all(db)).filter((r) => (!type || r.type === type) && (!status || r.status === status))
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export async function summary(db) {
  const byType = Object.fromEntries(TYPES.map((t) => [t, { total: 0, active: 0, maintenance: 0, retired: 0, inUse: 0, available: 0, assigned: 0, occupied: 0 }]));
  const resources = await all(db);
  for (const r of resources) {
    const s = byType[r.type];
    s.total++;
    s[r.status]++;
    if (inUse(r.allocation)) s.inUse++;
    if (r.allocation.assigned) s.assigned++; // handed out, student not yet at the seat
    if (r.allocation.occupied) s.occupied++; // checked in
    if (r.available) s.available++;
  }
  return { total: resources.length, byType, settings: await getSettings(db) };
}
