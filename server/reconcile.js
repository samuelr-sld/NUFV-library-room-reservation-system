import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { audit } from './audit.js';
import { txn } from './tx.js';
import { closeChallenge } from './challenges.js';
import { inUse } from './resources.js';

// Consistency check between the documents that must agree with each other. Every transaction in this system keeps them in
// step, so findings mean a bug, a manual edit or a crash between systems; this is how an operator finds out.
//
//   report-only   (needs a human decision, never repaired here)
//     activeTicketsWithoutSeat       an issued/checked-in stub whose seat no longer points back at it
//     reservationsWithoutHold        a pending/confirmed reservation that does not own all of its slot locks
//   repairable    (only with apply: each is re-verified inside its own transaction, then audited)
//     staleAllocations               a seat marked used by a stub that is not active (the seat would stay blocked)
//     orphanLocks                    a live slot lock whose reservation is gone, finished, or does not list that slot
//     orphanChallenges               an open approval challenge that is not its reservation's current one
//   housekeeping  (only with apply; one summary audit entry for the whole run)
//     expiredLocks                   slot locks that ended more than a day ago, and expired rate-limit counters
//
// The dry run is read-only and safe to run any time (it also backs the administrator "diagnostics" view).

const ts = (date) => Timestamp.fromDate(date);
const ACTIVE = ['issued', 'checked_in'];
const SAMPLE = 50;
const DAY = 86_400_000;

const finding = (items) => ({ count: items.length, items: items.slice(0, SAMPLE) });

export async function reconcile({ db, now = new Date(), apply = false, operator = 'unknown' }) {
  const report = { generatedAt: now.toISOString(), apply, findings: {}, repaired: {}, pruned: {}, skipped: [] };

  // ---- seats and stubs ----
  const [resources, active] = await Promise.all([db.collection('resources').get(), db.collection('tickets').where('status', 'in', ACTIVE).get()]);
  const activeById = new Map(active.docs.map((d) => [d.id, d]));
  const stale = [];
  for (const r of resources.docs) {
    const a = r.get('allocation') ?? {};
    if (r.get('type') === 'discussion-room' || !(a.ticketId || a.assigned || a.occupied)) continue;
    const t = a.ticketId ? activeById.get(a.ticketId) : null;
    const consistent = t && t.get('resourceId') === r.id && (t.get('status') === 'issued' ? a.assigned === 1 && !a.occupied : a.occupied === 1 && !a.assigned);
    if (!consistent) stale.push({ resourceId: r.id, ticketId: a.ticketId ?? null, allocation: { assigned: a.assigned ?? 0, occupied: a.occupied ?? 0, held: a.held ?? 0 } });
  }
  report.findings.staleAllocations = finding(stale);
  const resourceById = new Map(resources.docs.map((d) => [d.id, d]));
  report.findings.activeTicketsWithoutSeat = finding(active.docs.filter((t) => t.get('resourceId') && resourceById.get(t.get('resourceId'))?.get('allocation')?.ticketId !== t.id).map((t) => ({ ticketId: t.id, resourceId: t.get('resourceId') })));

  // ---- reservation holds ----
  const [liveLocks, liveReservations, openChallenges] = await Promise.all([
    db.collection('reservationLocks').where('expiresAt', '>', ts(now)).get(),
    db.collection('reservations').where('status', 'in', ['pending', 'confirmed']).where('endsAt', '>', ts(now)).get(),
    db.collection('approvalChallenges').where('status', '==', 'open').get(),
  ]);
  const reservationById = new Map(liveReservations.docs.map((d) => [d.id, d]));
  const orphanLocks = [];
  for (const l of liveLocks.docs) {
    const r = reservationById.get(l.get('reservationId'));
    if (!r || !r.get('slotKeys').includes(l.id)) orphanLocks.push({ lockId: l.id, reservationId: l.get('reservationId') });
  }
  report.findings.orphanLocks = finding(orphanLocks);
  const lockOwner = new Map(liveLocks.docs.map((l) => [l.id, l.get('reservationId')]));
  // A pending request past its step deadline has (correctly) lost its locks and is only waiting to be swept: not a finding.
  const holdsExpected = liveReservations.docs.filter((r) => r.get('status') === 'confirmed' || r.get('stepDeadline').toMillis() > now.getTime());
  report.findings.reservationsWithoutHold = finding(holdsExpected.filter((r) => r.get('slotKeys').some((k) => lockOwner.get(k) !== r.id)).map((r) => ({ reservationId: r.id })));
  const orphanChallenges = openChallenges.docs.filter((c) => {
    const r = reservationById.get(c.get('reservationId'));
    return !r || r.get('status') !== 'pending' || r.get('activeChallengeId') !== c.id;
  });
  report.findings.orphanChallenges = finding(orphanChallenges.map((c) => ({ reservationId: c.get('reservationId'), stepIndex: c.get('stepIndex') })));

  // ---- housekeeping candidates ----
  const [oldLocks, oldCounters] = await Promise.all([
    db.collection('reservationLocks').where('expiresAt', '<', ts(new Date(now.getTime() - DAY))).limit(500).get(),
    db.collection('rateLimits').where('expiresAt', '<', ts(now)).limit(500).get(),
  ]);
  report.findings.expiredLocks = { count: oldLocks.size, items: [] };
  report.findings.expiredRateLimits = { count: oldCounters.size, items: [] };

  if (!apply) return report;

  // ---- repairs: each one re-checks its own condition inside the transaction, so a repair never acts on stale data ----
  let n = 0;
  for (const s of stale) {
    const outcome = await txn(db, async (tx) => {
      const ref = db.doc(`resources/${s.resourceId}`);
      const [r, t, claimants] = await Promise.all([
        tx.get(ref), s.ticketId ? tx.get(db.doc(`tickets/${s.ticketId}`)) : null,
        tx.get(db.collection('tickets').where('resourceId', '==', s.resourceId).where('status', 'in', ACTIVE)),
      ]);
      const a = r.get('allocation') ?? {};
      if ((a.ticketId ?? null) !== s.ticketId) return 'changed'; // somebody else moved it since the scan
      // Never release a seat any active stub still points at, even if the counters disagree about it: that stub's holder
      // would be sitting on a seat the system now offers to someone else. A person decides those (revoke the stub first).
      if ((t?.exists && ACTIVE.includes(t.get('status')) && t.get('resourceId') === r.id) || !claimants.empty) return 'claimed';
      tx.update(ref, { allocation: { assigned: 0, occupied: 0, held: a.held ?? 0 } });
      audit(db, tx, { actorUid: null, action: 'reconcile.allocation_released', targetType: 'resource', targetId: r.id, details: { ticketId: s.ticketId, operator, was: s.allocation } });
      return 'released';
    });
    if (outcome === 'released') n++;
    else report.skipped.push({ check: 'staleAllocations', resourceId: s.resourceId, reason: outcome });
  }
  report.repaired.staleAllocations = n;

  n = 0;
  for (const o of orphanLocks) {
    n += await txn(db, async (tx) => {
      const ref = db.doc(`reservationLocks/${o.lockId}`);
      const [l, r] = await Promise.all([tx.get(ref), tx.get(db.doc(`reservations/${o.reservationId}`))]);
      const owned = r.exists && ['pending', 'confirmed'].includes(r.get('status')) && r.get('slotKeys').includes(o.lockId);
      if (!l.exists || l.get('reservationId') !== o.reservationId || owned) return 0;
      tx.delete(ref);
      audit(db, tx, { actorUid: null, action: 'reconcile.lock_released', targetType: 'reservation', targetId: o.reservationId, details: { lockId: o.lockId, operator } });
      return 1;
    });
  }
  report.repaired.orphanLocks = n;

  n = 0;
  for (const c of orphanChallenges) {
    n += await txn(db, async (tx) => {
      const [ch, r] = await Promise.all([tx.get(c.ref), tx.get(db.doc(`reservations/${c.get('reservationId')}`))]);
      if (ch.get('status') !== 'open' || (r.exists && r.get('status') === 'pending' && r.get('activeChallengeId') === c.id)) return 0;
      closeChallenge(tx, c.ref, 'reconciled', now);
      audit(db, tx, { actorUid: null, action: 'reconcile.challenge_closed', targetType: 'reservation', targetId: c.get('reservationId'), details: { step: c.get('stepIndex'), operator } });
      return 1;
    });
  }
  report.repaired.orphanChallenges = n;

  // Expired locks and counters are absent by definition (their expiry already passed), so deleting them changes no behavior.
  for (const [name, snap] of [['expiredLocks', oldLocks], ['expiredRateLimits', oldCounters]]) {
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (snap.size) await batch.commit();
    report.pruned[name] = snap.size;
  }
  // One audit entry for the housekeeping as a whole, so that nothing this tool deletes goes unrecorded.
  if (report.pruned.expiredLocks || report.pruned.expiredRateLimits) {
    await db.collection('auditLogs').add({ actorUid: null, action: 'reconcile.pruned', targetType: 'system', targetId: 'housekeeping', details: { ...report.pruned, operator }, at: FieldValue.serverTimestamp() });
  }
  return report;
}
