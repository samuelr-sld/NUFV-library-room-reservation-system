import { randomBytes, randomInt } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import QRCode from 'qrcode';
import { HttpError } from './errors.js';
import { serialize, txn } from './tx.js';
import { audit } from './audit.js';
import { view as settingsView } from './settings.js';
import { inUse } from './resources.js';
import { decryptSecret, encryptSecret, generateVoucherPassword } from './voucher.js';

// Stubs (tickets) for the three library services. Everything here runs on the server with the Admin SDK; Firestore
// rules deny clients every read and write of tickets and ticketLocks. See README "Generate Stubs" for the design.
//
//   tickets/{id}        one document per stub, kept forever (history). Voucher passwords exist only as ciphertext.
//   ticketLocks/{uid}   { byService: { service: ticketId } }  the student's ACTIVE tickets: at most one per service,
//                       and at most settings.maxActiveTicketsPerStudent in total. Read and written in the same
//                       transaction as the ticket and the resource, so concurrent requests serialize on it.
//   resources/{id}      allocation { assigned, occupied, held, ticketId } is changed only here, in those transactions.

export const SERVICES = {
  'silent-room': { prefix: 'SR', label: 'Silent Room', resourceType: 'silent-seat', durationKey: 'silentRoomTicketMinutes' },
  'computer-station': { prefix: 'CS', label: 'Computer Station', resourceType: 'computer-station', durationKey: 'computerTicketMinutes' },
  'wifi-voucher': { prefix: 'WF', label: 'Wi-Fi Voucher (DEMO)', resourceType: null, durationKey: 'wifiVoucherMinutes' },
};
export const ACTIVE = ['issued', 'checked_in'];
export const TRANSITIONS = { issued: ['checked_in', 'expired', 'revoked'], checked_in: ['checked_out', 'expired', 'revoked'], checked_out: [], expired: [], revoked: [] };
export const TICKET_ID = /^(SR|CS|WF)-[0-9A-HJKMNP-TV-Z]{10}$/;
export const QR_PREFIX = 'NUFV1:'; // the QR carries only this opaque reference, never a password or a student identifier

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newTicketId = (prefix) => `${prefix}-${Array.from({ length: 10 }, () => CROCKFORD[randomInt(32)]).join('')}`; // 50 bits: a collision would fail tx.create, not corrupt anything
const ticketRef = (db, id) => db.doc(`tickets/${id}`);
const lockRef = (db, uid) => db.doc(`ticketLocks/${uid}`);
const resourceRef = (db, id) => db.doc(`resources/${id}`);
const ts = (date) => Timestamp.fromDate(date);
const iso = (t) => t?.toDate().toISOString() ?? null;
const minutes = (date, n) => new Date(date.getTime() + n * 60_000);

const allocation = (a = {}) => ({ assigned: a.assigned ?? 0, occupied: a.occupied ?? 0, held: a.held ?? 0, ...(a.ticketId ? { ticketId: a.ticketId } : {}) });

// The allocation after a ticket in state `from` lets go of its resource. Only the ticket that holds the resource
// (allocation.ticketId) may release it, so a stale or replayed ticket can never free a seat that now belongs to
// someone else, and releasing twice is harmless.
function released(a, from, ticketId) {
  const next = allocation(a);
  if (next.ticketId !== ticketId) return next;
  if (from === 'issued') next.assigned = Math.max(0, next.assigned - 1);
  if (from === 'checked_in') next.occupied = Math.max(0, next.occupied - 1);
  delete next.ticketId;
  return next;
}

// Why an active ticket is overdue at `now` (server time), or null. An issued ticket that was never checked in
// loses the seat after the no-show grace period; any active ticket ends at expiresAt.
// Boundary rule: a deadline is the first instant that is too late. Check-in works strictly BEFORE checkInDeadline;
// at that instant (or later) the ticket is a no_show. The same holds for expiresAt.
export function dueReason(t, now) {
  const ms = now.getTime();
  if (t.status === 'issued' && t.checkInDeadline && t.checkInDeadline.toMillis() <= ms) return 'no_show';
  return t.expiresAt.toMillis() <= ms ? 'expired' : null;
}

export function present(snap) {
  const t = snap.data();
  return {
    id: snap.id, service: t.service, serviceLabel: SERVICES[t.service].label, status: t.status,
    resource: t.resourceId ? { id: t.resourceId, label: t.resourceLabel } : null,
    issuedAt: iso(t.issuedAt), expiresAt: iso(t.expiresAt), checkInDeadline: iso(t.checkInDeadline),
    checkedInAt: iso(t.checkedInAt), endedAt: iso(t.endedAt), endReason: t.endReason ?? null,
    qrPayload: `${QR_PREFIX}${t.qrRef}`,
  };
}

// ------------------------------------------------------------------ issuing

export const issueTicket = (args) => serialize(args.uid, () => issueOnce(args));

async function issueOnce({ db, config, uid, service, now }) {
  const spec = typeof service === 'string' && Object.hasOwn(SERVICES, service) ? SERVICES[service] : null; // not SERVICES[x]: an array or '__proto__' must not resolve
  if (!spec) throw new HttpError(400, 'invalid-argument', `service must be one of ${Object.keys(SERVICES).join(', ')}.`);

  // Free seats held by overdue tickets first, so the transaction below sees an accurate inventory. Best effort.
  await expireDue({ db, now }).catch((err) => console.error('expiry sweep failed', err));

  const id = newTicketId(spec.prefix);
  const qrRef = randomBytes(18).toString('base64url');
  const credential = service === 'wifi-voucher' ? encryptSecret(config.voucherKey, generateVoucherPassword(), id) : null;

  const outcome = await txn(db, async (tx) => {
    // ---- all reads first (Firestore requires it) ----
    const [profile, settingsSnap, lockSnap] = await Promise.all([tx.get(db.doc(`users/${uid}`)), tx.get(db.doc('settings/system')), tx.get(lockRef(db, uid))]);
    if (!profile.exists || profile.get('role') !== 'student') throw new HttpError(403, 'forbidden', 'This service is for students.');
    if (profile.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
    const settings = settingsView(settingsSnap).settings;

    const byService = { ...(lockSnap.get('byService') ?? {}) };
    const held = await Promise.all(Object.entries(byService).map(async ([svc, tid]) => ({ svc, tid, snap: await tx.get(ticketRef(db, tid)) })));
    const live = [];
    const closing = [];
    let lockChanged = false;
    for (const h of held) {
      if (!h.snap.exists || !ACTIVE.includes(h.snap.get('status')) || h.snap.get('uid') !== uid) {
        delete byService[h.svc]; // stale lock entry
        lockChanged = true;
      } else if (dueReason(h.snap.data(), now)) closing.push(h);
      else live.push(h);
    }
    const closingResources = await Promise.all(closing.map((c) => (c.snap.get('resourceId') ? tx.get(resourceRef(db, c.snap.get('resourceId'))) : null)));

    const existing = live.find((h) => h.svc === service);
    if (!existing && live.length >= settings.maxActiveTicketsPerStudent) {
      throw new HttpError(409, 'ticket-limit-reached', `You already have the maximum of ${settings.maxActiveTicketsPerStudent} active stub(s). Wait for one to expire, or ask library staff.`);
    }
    const candidates = !existing && spec.resourceType
      ? (await tx.get(db.collection('resources').where('type', '==', spec.resourceType).where('status', '==', 'active'))).docs : [];

    // ---- decide, still without writing ----
    const state = new Map(); // resourceId -> { ref, alloc, label }
    for (const d of candidates) state.set(d.id, { ref: d.ref, alloc: allocation(d.get('allocation')), label: d.get('label') });
    const dirty = new Set();
    closing.forEach((c, i) => {
      const rs = closingResources[i];
      if (!rs?.exists) return;
      const entry = state.get(rs.id) ?? { ref: rs.ref, alloc: allocation(rs.get('allocation')), label: rs.get('label') };
      entry.alloc = released(entry.alloc, c.snap.get('status'), c.tid);
      state.set(rs.id, entry);
      dirty.add(rs.id);
    });

    let chosen = null;
    if (!existing && spec.resourceType) {
      // Deterministic: the lowest resource id that is active and has no assignment, occupancy or hold.
      chosen = candidates.map((d) => d.id).sort().find((rid) => inUse(state.get(rid).alloc) === 0) ?? null;
      if (!chosen) throw new HttpError(409, 'no-resource-available', `No ${spec.label.toLowerCase()} seat is free right now. Please try again later.`);
    }

    // ---- writes ----
    for (const c of closing) {
      delete byService[c.svc];
      lockChanged = true;
      tx.update(c.snap.ref, { status: 'expired', endedAt: ts(now), endReason: dueReason(c.snap.data(), now), activeDeadline: FieldValue.delete() });
      audit(db, tx, { actorUid: null, action: 'ticket.expired', targetType: 'ticket', targetId: c.tid, details: { service: c.svc, resourceId: c.snap.get('resourceId') ?? null, reason: dueReason(c.snap.data(), now) } });
    }
    if (existing) {
      if (lockChanged) tx.set(lockRef(db, uid), { byService, updatedAt: ts(now) });
      for (const rid of dirty) tx.update(state.get(rid).ref, { allocation: state.get(rid).alloc });
      return { id: existing.tid, created: false };
    }

    if (chosen) {
      state.get(chosen).alloc = { ...state.get(chosen).alloc, assigned: 1, ticketId: id };
      dirty.add(chosen);
    }
    for (const rid of dirty) tx.update(state.get(rid).ref, { allocation: state.get(rid).alloc });

    const minutesValid = settings[spec.durationKey];
    const expiresAt = minutes(now, minutesValid);
    const grace = spec.resourceType && settings.noShowGraceMinutes > 0 ? minutes(now, settings.noShowGraceMinutes) : null; // 0 turns the no-show rule off
    const activeDeadline = grace && grace < expiresAt ? grace : expiresAt;
    tx.create(ticketRef(db, id), {
      service, uid, status: 'issued',
      resourceId: chosen, resourceLabel: chosen ? state.get(chosen).label : null,
      issuedAt: ts(now), expiresAt: ts(expiresAt), checkInDeadline: grace ? ts(grace) : null, activeDeadline: ts(activeDeadline),
      durationMinutes: minutesValid, qrRef, ...(credential ? { credential } : {}),
      endedAt: null, endReason: null,
    });
    byService[service] = id;
    tx.set(lockRef(db, uid), { byService, updatedAt: ts(now) });
    audit(db, tx, {
      actorUid: uid, action: 'ticket.issued', targetType: 'ticket', targetId: id,
      details: { service, resourceId: chosen, expiresAt: expiresAt.toISOString() }, // never any credential
    });
    return { id, created: true };
  });

  return { ticket: present(await ticketRef(db, outcome.id).get()), created: outcome.created };
}

// ------------------------------------------------------------------ lifecycle

// The one place a ticket changes state and lets go of its resource and its lock. Every step is a single transaction.
//
//  - Server time rules: if the ticket is overdue at `now`, the only possible outcome is expiry (reason no_show or
//    expired), whatever was asked for; the caller learns this from `preempted`. So a check-in racing the deadline has
//    exactly one outcome, and an expired ticket can never be checked in even if no cleanup has run.
//  - Repeating a terminal transition (or a check-in of a checked-in ticket) changes nothing: { changed: false }.
//  - Check-in moves the seat assigned -> occupied only if the resource still points at THIS ticket.
//  - Release is guarded by the same ticket id, so nothing here can free or corrupt another student's allocation.
// onlyIfDue: expire the ticket if (and only if) it is overdue at `now`; otherwise do nothing.
export async function transitionTicket({ db, ticketId, to, now, actorUid = null, reason = null, onlyIfDue = false, details = {} }) {
  return txn(db, async (tx) => {
    const snap = await tx.get(ticketRef(db, ticketId));
    if (!snap.exists) throw new HttpError(404, 'not-found', 'Ticket not found.');
    const t = snap.data();
    const due = ACTIVE.includes(t.status) ? dueReason(t, now) : null;

    let preempted = false;
    if (onlyIfDue) {
      if (!due) return { changed: false, status: t.status };
      [to, reason] = ['expired', due];
    } else if (due && to !== 'expired') {
      [to, reason, preempted] = ['expired', due, true];
    } else if (t.status === to && (!ACTIVE.includes(to) || to === 'checked_in')) {
      return { changed: false, status: t.status };
    } else if (!TRANSITIONS[t.status]?.includes(to)) {
      throw new HttpError(409, 'invalid-transition', `A ${t.status.replace('_', ' ')} stub cannot become ${to.replace('_', ' ')}.`);
    }
    if (to === 'checked_in' && !t.resourceId) throw new HttpError(409, 'check-in-not-required', 'Wi-Fi vouchers are not checked in.');

    const [resource, lock, profile] = await Promise.all([
      t.resourceId ? tx.get(resourceRef(db, t.resourceId)) : null,
      tx.get(lockRef(db, t.uid)),
      to === 'checked_in' ? tx.get(db.doc(`users/${t.uid}`)) : null,
    ]);
    const held = allocation(resource?.exists ? resource.get('allocation') : {});

    if (to === 'checked_in') {
      if (!profile.exists || profile.get('role') !== 'student' || profile.get('status') !== 'active') {
        throw new HttpError(409, 'student-not-active', 'This student account is not active.');
      }
      if (held.ticketId !== snap.id || held.assigned < 1) {
        throw new HttpError(409, 'resource-mismatch', 'The assigned seat is no longer held for this ticket.');
      }
      tx.update(resource.ref, { allocation: { ...held, assigned: held.assigned - 1, occupied: held.occupied + 1 } });
      tx.update(snap.ref, { status: to, checkedInAt: ts(now), checkedInBy: actorUid, activeDeadline: t.expiresAt }); // occupancy lasts until the original expiry
    } else {
      if (resource?.exists) tx.update(resource.ref, { allocation: released(resource.get('allocation'), t.status, snap.id) });
      const byService = { ...(lock.get('byService') ?? {}) };
      if (byService[t.service] === snap.id) {
        delete byService[t.service];
        tx.set(lock.ref, { byService, updatedAt: ts(now) });
      }
      tx.update(snap.ref, {
        status: to, endedAt: ts(now), endedBy: actorUid, endReason: reason ?? to, activeDeadline: FieldValue.delete(),
        ...(details.revokeReason ? { revokeReason: details.revokeReason } : {}),
      });
    }
    audit(db, tx, {
      actorUid, action: `ticket.${to}`, targetType: 'ticket', targetId: snap.id,
      details: { service: t.service, resourceId: t.resourceId ?? null, from: t.status, reason, ...details }, // never any credential
    });
    return { changed: true, status: to, preempted, reason };
  });
}

// Eventual cleanup, safe to run any time and as often as wanted (cron, server timer, or opportunistically per request).
export async function expireDue({ db, now, limit = 50 }) {
  const due = await db.collection('tickets').where('activeDeadline', '<=', ts(now)).limit(limit).get();
  let expired = 0;
  for (const d of due.docs) {
    try {
      if ((await transitionTicket({ db, ticketId: d.id, to: 'expired', now, onlyIfDue: true })).changed) expired++;
    } catch (err) {
      console.error(`could not expire ${d.id}`, err);
    }
  }
  return expired;
}

// Lazy expiry for one student's own tickets, so anything they read is already current.
async function expireFor({ db, uid, now }) {
  const lock = await lockRef(db, uid).get();
  for (const id of Object.values(lock.get('byService') ?? {})) await transitionTicket({ db, ticketId: id, to: 'expired', now, onlyIfDue: true });
}

// ------------------------------------------------------------------ reading (owner only)

export async function activeTickets({ db, uid, now }) {
  await expireFor({ db, uid, now });
  const lock = await lockRef(db, uid).get();
  const snaps = await Promise.all(Object.values(lock.get('byService') ?? {}).map((id) => ticketRef(db, id).get()));
  return snaps.filter((s) => s.exists && s.get('uid') === uid && ACTIVE.includes(s.get('status'))).map(present);
}

export async function ticketHistory({ db, uid, now, limit = 20 }) {
  await expireFor({ db, uid, now });
  const snaps = await db.collection('tickets').where('uid', '==', uid).orderBy('issuedAt', 'desc').limit(limit).get();
  return snaps.docs.map(present);
}

async function ownedTicket({ db, uid, id, now }) {
  if (!TICKET_ID.test(id)) throw new HttpError(404, 'not-found', 'Ticket not found.');
  await expireFor({ db, uid, now });
  const snap = await ticketRef(db, id).get();
  // Someone else's ticket is indistinguishable from a missing one.
  if (!snap.exists || snap.get('uid') !== uid) throw new HttpError(404, 'not-found', 'Ticket not found.');
  return snap;
}

export async function getTicket(args) {
  return present(await ownedTicket(args));
}

// Everything the printable stub needs. The only response that can contain a voucher password.
export async function printableTicket({ db, config, uid, id, now }) {
  const snap = await ownedTicket({ db, uid, id, now });
  const t = snap.data();
  const profile = await db.doc(`users/${uid}`).get();
  const out = {
    ticket: present(snap),
    student: { fullName: profile.get('fullName') ?? '', studentNumber: profile.get('studentNumber') ?? '' },
    qrSvg: await QRCode.toString(`${QR_PREFIX}${t.qrRef}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
  if (t.service === 'wifi-voucher') {
    const password = ACTIVE.includes(t.status) && t.credential ? decryptSecret(config.voucherKey, t.credential, snap.id) : null;
    out.voucher = { demo: true, password, passwordAvailable: password !== null };
  }
  return out;
}

// ------------------------------------------------------------------ availability (advisory only)

export async function availability({ db, uid, now }) {
  await expireDue({ db, now }).catch(() => {});
  const [settingsSnap, active, resources] = await Promise.all([db.doc('settings/system').get(), activeTickets({ db, uid, now }), db.collection('resources').where('status', '==', 'active').get()]);
  const services = {};
  for (const [key, spec] of Object.entries(SERVICES)) {
    if (!spec.resourceType) { services[key] = { label: spec.label, total: null, available: null, unlimited: true }; continue; }
    const mine = resources.docs.filter((d) => d.get('type') === spec.resourceType);
    services[key] = { label: spec.label, total: mine.length, available: mine.filter((d) => inUse(d.get('allocation')) === 0).length, unlimited: false,
      // Individual seats and stations. No allocation detail: whose stub holds a seat is not for other students.
      resources: mine.map((d) => ({ id: d.id, label: d.get('label'), description: d.get('description') ?? '', available: inUse(d.get('allocation')) === 0 }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })) };
  }
  return { services, limit: settingsView(settingsSnap).settings.maxActiveTicketsPerStudent, active: active.length };
}

// ------------------------------------------------------------------ administrator operations

const QR_REF = /^[A-Za-z0-9_-]{24}$/;

// Accepts what a scanner or a person can supply: the full QR payload (NUFV1:<ref>), the bare reference, or the ticket
// id printed on the stub. Anything else is rejected before touching the database.
export function parseReference(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text.length > 64) return null;
  const ref = text.startsWith(QR_PREFIX) ? text.slice(QR_PREFIX.length) : text;
  if (QR_REF.test(ref)) return { by: 'qr', value: ref };
  if (TICKET_ID.test(text.toUpperCase())) return { by: 'id', value: text.toUpperCase() };
  return null;
}

// The only ticket shape administrators see. No uid, no QR reference, no credential, no internal deadlines.
export async function adminTicketView({ db, id }) {
  const snap = await ticketRef(db, id).get();
  const t = snap.data();
  const [student, resource] = await Promise.all([db.doc(`users/${t.uid}`).get(), t.resourceId ? resourceRef(db, t.resourceId).get() : null]);
  const studentActive = student.exists && student.get('role') === 'student' && student.get('status') === 'active';
  const held = resource?.exists && allocation(resource.get('allocation')).ticketId === snap.id;

  const warnings = [];
  if (!studentActive) warnings.push('student-not-active');
  if (t.resourceId && ACTIVE.includes(t.status) && !held) warnings.push('resource-mismatch');

  let actions = [];
  if (t.status === 'issued') actions = t.resourceId ? [...(studentActive && held ? ['check_in'] : []), 'revoke'] : ['revoke'];
  if (t.status === 'checked_in') actions = ['check_out', 'revoke'];

  return {
    ticket: {
      id: snap.id, service: t.service, serviceLabel: SERVICES[t.service].label, status: t.status,
      resource: t.resourceId ? { id: t.resourceId, label: t.resourceLabel } : null,
      issuedAt: iso(t.issuedAt), expiresAt: iso(t.expiresAt), checkInDeadline: iso(t.checkInDeadline), checkedInAt: iso(t.checkedInAt),
      endedAt: iso(t.endedAt), endReason: t.endReason ?? null, revokeReason: t.revokeReason ?? null,
    },
    student: { fullName: student.get('fullName') ?? '', studentNumber: student.get('studentNumber') ?? '', status: student.get('status') ?? 'unknown' },
    allowedActions: actions,
    warnings,
  };
}

// Possession of a QR proves nothing about who holds it: this only tells an administrator what the code refers to.
export async function resolveTicket({ db, reference, now }) {
  const parsed = parseReference(reference);
  if (!parsed) throw new HttpError(400, 'invalid-qr', 'That is not a library stub code.');
  let id = parsed.value;
  if (parsed.by === 'qr') {
    const found = await db.collection('tickets').where('qrRef', '==', parsed.value).limit(1).get();
    if (found.empty) throw new HttpError(404, 'unknown-qr', 'No stub matches this code.');
    id = found.docs[0].id;
  } else if (!(await ticketRef(db, id).get()).exists) {
    throw new HttpError(404, 'unknown-qr', 'No stub matches this code.');
  }
  await transitionTicket({ db, ticketId: id, to: 'expired', now, onlyIfDue: true }); // judge the ticket as it is NOW, not as it was last swept
  return adminTicketView({ db, id });
}

const preemptedError = (r) => new HttpError(409, r.reason === 'no_show' ? 'no-show' : 'ticket-expired',
  r.reason === 'no_show' ? 'The check-in deadline has passed: this ticket was released as a no-show.' : 'This ticket has expired.');

// Double scans and repeated clicks for one ticket run one at a time in this process, only to cut contention;
// correctness comes from the transaction in transitionTicket.
function operate({ db, id, to, now, actorUid, reason, details }) {
  if (!TICKET_ID.test(id ?? '')) throw new HttpError(404, 'not-found', 'Ticket not found.');
  return serialize(`ticket:${id}`, async () => {
    const result = await transitionTicket({ db, ticketId: id, to, now, actorUid, reason, details });
    if (result.preempted) throw preemptedError(result); // the expiry was committed; the requested action did not happen
    return { changed: result.changed, ...(await adminTicketView({ db, id })) };
  });
}

export const checkInTicket = ({ identityChecked, ...args }) => operate({ ...args, to: 'checked_in', details: { identityChecked: identityChecked === true } });
export const checkOutTicket = (args) => operate({ ...args, to: 'checked_out' });
export function revokeTicket({ reason, ...args }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3 || text.length > 200 || /[\u0000-\u001f]/.test(text)) throw new HttpError(400, 'invalid-argument', 'A reason of 3 to 200 characters is required.');
  return operate({ ...args, to: 'revoked', reason: 'revoked', details: { revokeReason: text } });
}
