import { randomBytes, randomInt } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import QRCode from 'qrcode';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { serialize, txn } from './tx.js';
import { view as settingsView } from './settings.js';
import { snapshotFrom } from './workflow.js';
import { createChallenge, closeChallenge, maskEmail } from './challenges.js';
import { enqueue } from './mail/outbox.js';
import { isValidId } from './resources.js';
import { STUDENT_NUMBER, normalizeStudentNumber } from './policy.js';
import {
  CLOSE_MINUTES, MAX_BOOKING_MINUTES, OPEN_MINUTES, SLOT_MINUTES, TIMEZONE,
  compactDate, formatMinutes, instantToLocal, localDatePlusDays, localToInstant, parseLocalDate, parseLocalTime,
} from './time.js';

// Discussion room reservations with sequential approval. Staff-facing summary in README "Discussion room reservations".
//
//   reservations/{id}            the request, its frozen approval chain, progress and final decision
//   reservationLocks/{room__date__HHMM}   one document per 15-minute slot a pending or confirmed reservation holds
//   approvalChallenges/{id}      step-scoped access for an external approver (see challenges.js)
//   approvalActions/{id}         immutable decision trail (create-only)
//   emailOutbox/{id}             notifications, written in the same transaction as the change that causes them
//
// Conflict prevention: a booking is a set of at most 16 slot locks. Submitting reads all of them in one transaction and
// creates them only if none is live, so two overlapping requests cannot both commit; adjacent bookings share no slot.
// A lock is live until its expiresAt (the current step's deadline while pending, the end of the booking once
// confirmed), so a lapsed hold frees its slots by itself, with no cleanup job. A reservation releases only locks that
// still carry ITS id, so a stale action can never free someone else's slot.

export const RES_ID = /^RS-[0-9A-HJKMNP-TV-Z]{10}$/;
export const QR_PREFIX = 'NUFR1:'; // reservation confirmation QR: opaque reference only, distinct from stub QR codes
const QR_REF = /^[A-Za-z0-9_-]{24}$/;
const CONFIRMATION_REF = /^RC-[0-9A-HJKMNP-TV-Z]{10}$/;
export const MAX_ACTIVE_PER_STUDENT = 3; // pending or upcoming confirmed reservations at once; stops one account hoarding rooms
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (prefix) => `${prefix}-${Array.from({ length: 10 }, () => CROCKFORD[randomInt(32)]).join('')}`;

const resRef = (db, id) => db.doc(`reservations/${id}`);
const ts = (date) => Timestamp.fromDate(date);
const iso = (t) => t?.toDate().toISOString() ?? null;
const invalid = (message) => new HttpError(400, 'invalid-argument', message);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ booking rules

export const slotKeys = (roomId, date, startMin, endMin) => {
  const keys = [];
  for (let m = startMin; m < endMin; m += SLOT_MINUTES) keys.push(`${roomId}__${compactDate(date)}__${formatMinutes(m).replace(':', '')}`);
  return keys;
};

// Validates everything about a request that does not need the database; returns the normalized booking.
export function parseBooking(body, { now, interval, advanceDays }) {
  if (!plain(body)) throw invalid('Request body must be a JSON object.');
  for (const key of Object.keys(body)) if (!['roomId', 'date', 'startTime', 'endTime', 'participants', 'purpose', 'notes'].includes(key)) throw invalid(`Unknown field "${key}".`);
  if (!isValidId(body.roomId)) throw invalid('Choose a room.');
  const date = parseLocalDate(body.date);
  const startMin = parseLocalTime(body.startTime);
  const endMin = parseLocalTime(body.endTime);
  if (!date) throw invalid('Choose a valid date.');
  if (startMin === null || endMin === null) throw invalid('Choose a start and an end time.');
  if (endMin <= startMin) throw invalid('The end time must be after the start time.');
  if (startMin % interval !== 0 || endMin % interval !== 0) throw invalid(`Times must fall on ${interval}-minute marks.`);
  if (startMin < OPEN_MINUTES || endMin > CLOSE_MINUTES) throw invalid(`Bookings must be between ${formatMinutes(OPEN_MINUTES)} and ${formatMinutes(CLOSE_MINUTES)} (${TIMEZONE}).`);
  if (endMin - startMin > MAX_BOOKING_MINUTES) throw invalid(`A booking can last at most ${MAX_BOOKING_MINUTES / 60} hours.`);

  const startsAt = localToInstant(date, startMin);
  const endsAt = localToInstant(date, endMin);
  const localDate = body.date;
  if (startsAt.getTime() <= now.getTime()) throw invalid('The start time must be in the future.');
  if (localDate > localDatePlusDays(now, advanceDays)) throw invalid(`Rooms can be booked at most ${advanceDays} day(s) ahead.`);

  if (!Array.isArray(body.participants) || body.participants.length > 49) throw invalid('participants must be a list of the other participants.');
  const participants = body.participants.map((p, i) => {
    if (!plain(p)) throw invalid(`Participant ${i + 1} must be an object.`);
    for (const key of Object.keys(p)) if (!['name', 'studentNumber'].includes(key)) throw invalid(`Participant ${i + 1}: unknown field "${key}".`);
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (name.length < 2 || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw invalid(`Participant ${i + 1}: enter a name of 2 to 80 characters.`);
    const studentNumber = p.studentNumber === undefined || p.studentNumber === '' ? '' : normalizeStudentNumber(p.studentNumber);
    if (studentNumber !== '' && !STUDENT_NUMBER.test(studentNumber)) throw invalid(`Participant ${i + 1}: enter the student number as 3 to 24 letters, digits or hyphens, or leave it empty.`);
    return { name, studentNumber };
  });
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
  if (purpose.length < 3 || purpose.length > 200 || /[\u0000-\u001f]/.test(purpose)) throw invalid('Describe the purpose in 3 to 200 characters.');
  const notes = body.notes === undefined || body.notes === '' ? '' : body.notes;
  if (typeof notes !== 'string' || notes.length > 200 || /[\u0000-\u001f]/.test(notes)) throw invalid('Special requests can be at most 200 characters.');

  return { roomId: body.roomId, localDate, startMin, endMin, startsAt, endsAt, participants, participantCount: participants.length + 1, purpose, notes: notes.trim() };
}

// Why a pending reservation is overdue at `now` (server time), or null.
export function dueReason(r, now) {
  if (r.status !== 'pending') return null;
  const ms = now.getTime();
  if (r.startsAt.toMillis() <= ms) return 'start_passed';
  return r.stepDeadline && r.stepDeadline.toMillis() <= ms ? 'approval_timeout' : null;
}

const deadlineFor = (r, now, stepHours) => new Date(Math.min(now.getTime() + stepHours * 3_600_000, r.startsAt.toMillis()));
const summaryOf = (r, studentName, studentNumber) =>
  `Room: ${r.room.label}\nWhen: ${r.localDate} ${r.startTime}-${r.endTime} (${TIMEZONE})\nRequested by: ${studentName} (${studentNumber || 'no student number'})\nParticipants: ${r.participantCount}\nPurpose: ${r.purpose}`;

// ------------------------------------------------------------------ submitting

export const submitReservation = (args) => serialize(`reservation-submit:${args.uid}`, () => submitOnce(args));

async function submitOnce({ db, config, uid, body, now }) {
  const id = newId('RS');
  const outcome = await txn(db, async (tx) => {
    // ---- reads ----
    const [profile, settingsSnap, workflowSnap] = await Promise.all([tx.get(db.doc(`users/${uid}`)), tx.get(db.doc('settings/system')), tx.get(db.doc('approvalWorkflows/current'))]);
    if (!profile.exists || profile.get('role') !== 'student') throw new HttpError(403, 'forbidden', 'This service is for students.');
    if (profile.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
    const { settings } = settingsView(settingsSnap);
    const booking = parseBooking(body, { now, interval: settings.discussionRoomBookingIntervalMinutes, advanceDays: settings.reservationAdvanceBookingDays });

    const room = await tx.get(db.doc(`resources/${booking.roomId}`));
    if (!room.exists || room.get('type') !== 'discussion-room') throw new HttpError(404, 'not-found', 'Room not found.');
    if (room.get('status') !== 'active') throw new HttpError(409, 'room-unavailable', 'This room is not available for booking.');
    if (booking.participantCount > room.get('capacity')) throw invalid(`This room holds at most ${room.get('capacity')} people.`);

    const keys = slotKeys(booking.roomId, booking.localDate, booking.startMin, booking.endMin);
    const lockRefs = keys.map((k) => db.doc(`reservationLocks/${k}`));
    const [locks, mine] = await Promise.all([tx.getAll(...lockRefs), tx.get(db.collection('reservations').where('uid', '==', uid).where('status', 'in', ['pending', 'confirmed']))]);

    // ---- checks ----
    if (mine.docs.filter((d) => d.get('endsAt').toMillis() > now.getTime()).length >= MAX_ACTIVE_PER_STUDENT) {
      throw new HttpError(409, 'reservation-limit', `You can have at most ${MAX_ACTIVE_PER_STUDENT} open reservations at a time.`);
    }
    if (locks.some((l) => l.exists && l.get('expiresAt').toMillis() > now.getTime())) {
      throw new HttpError(409, 'slot-taken', 'That room is already reserved or being reviewed for part of this time. Choose another time or room.');
    }

    // ---- writes ----
    const workflow = snapshotFrom(workflowSnap);
    const r = {
      uid, studentName: profile.get('fullName') ?? '', studentNumber: profile.get('studentNumber') ?? '',
      roomId: booking.roomId, room: { label: room.get('label'), capacity: room.get('capacity') },
      localDate: booking.localDate, startTime: formatMinutes(booking.startMin), endTime: formatMinutes(booking.endMin), timezone: TIMEZONE,
      startsAt: ts(booking.startsAt), endsAt: ts(booking.endsAt),
      participantCount: booking.participantCount, participants: booking.participants, purpose: booking.purpose, notes: booking.notes,
      status: 'pending', currentStep: 0, workflow, approvals: [], slotKeys: keys,
      createdAt: ts(now), submittedAt: ts(now), updatedAt: ts(now), endedAt: null, endReason: null, decision: null,
    };
    const deadline = deadlineFor(r, now, workflow.stepHours);
    r.stepDeadline = ts(deadline);
    r.activeChallengeId = workflow.steps[0].type === 'external'
      ? createChallenge(db, tx, { reservationId: id, stepIndex: 0, stepLabel: workflow.steps[0].label, email: workflow.steps[0].email, deadline, now, config, summary: summaryOf(r, r.studentName, r.studentNumber) })
      : null;

    keys.forEach((k, i) => tx.set(lockRefs[i], { reservationId: id, roomId: booking.roomId, date: booking.localDate, slotStart: ts(new Date(booking.startsAt.getTime() + i * SLOT_MINUTES * 60_000)), kind: 'hold', expiresAt: ts(deadline) }));
    tx.create(resRef(db, id), r);
    tx.create(db.collection('approvalActions').doc(), { reservationId: id, stepIndex: 0, stepLabel: workflow.steps[0].label, action: 'submitted', seq: 0, actorType: 'student', actorRef: uid, comment: null, at: ts(now) });
    audit(db, tx, { actorUid: uid, action: 'reservation.submitted', targetType: 'reservation', targetId: id, details: { roomId: booking.roomId, date: booking.localDate, start: r.startTime, end: r.endTime, steps: workflow.steps.length } });
    return id;
  });
  return presentStudent(await resRef(db, outcome).get());
}

// ------------------------------------------------------------------ the state machine

// One transaction per move. op: approve | reject | cancel | expire_if_due.
//  - Server time decides: an overdue pending reservation can only expire, whatever was asked (`preempted`).
//  - Only the CURRENT step can act (expectedStep), and only its own kind of actor: the bound external approver for an
//    external step, an authenticated administrator for the final step. No step can be skipped; students can never approve.
//  - A decision closes the step's challenge in the same commit, so replays find nothing to act on.
//  - Locks are released/extended only when they still carry this reservation's id.
export async function applyReservation({ db, config, id, now, op, actor, expectedStep = null, comment = null }) {
  if (!RES_ID.test(id ?? '')) throw new HttpError(404, 'not-found', 'Reservation not found.');
  const result = await serialize(`reservation:${id}`, () => txn(db, (tx) => transition(tx, { db, config, id, now, op, actor, expectedStep, comment })));
  if (result.preempted) {
    throw new HttpError(409, 'reservation-expired', result.reason === 'hold_lost'
      ? 'This request no longer holds the room, so it was closed.'
      : 'This request ran out of time before it was decided, so the room was released.');
  }
  return result;
}

async function transition(tx, { db, config, id, now, op, actor, expectedStep, comment }) {
  const snap = await tx.get(resRef(db, id));
  if (!snap.exists) throw new HttpError(404, 'not-found', 'Reservation not found.');
  const r = snap.data();

  // ---- decide what this call really is (no writes yet) ----
  let mode = op;
  let reason = null;
  let preempted = false;
  const due = dueReason(r, now);
  if (op === 'expire_if_due') {
    if (!due) return { changed: false, status: r.status };
    [mode, reason] = ['expire', due];
  } else if (due) {
    [mode, reason, preempted] = ['expire', due, true];
  } else if (op === 'cancel') {
    if (actor.type === 'student' && actor.uid !== r.uid) throw new HttpError(404, 'not-found', 'Reservation not found.');
    if (r.status === 'cancelled') return { changed: false, status: 'cancelled' };
    const lastMoment = r.status === 'confirmed' ? (actor.type === 'admin' ? r.endsAt : r.startsAt) : null;
    if (!['pending', 'confirmed'].includes(r.status) || (lastMoment && lastMoment.toMillis() <= now.getTime())) {
      throw new HttpError(409, 'not-cancellable', 'This reservation can no longer be cancelled.');
    }
  } else {
    if (r.status !== 'pending') throw new HttpError(409, 'not-pending', 'This request has already been decided.');
    if (expectedStep !== r.currentStep) throw new HttpError(409, 'not-current-step', 'This step is not the one waiting for a decision.');
    const step = r.workflow.steps[r.currentStep];
    if (step.type === 'external' ? actor.type !== 'external' || actor.email !== step.email : actor.type !== 'admin') {
      throw new HttpError(403, 'forbidden', 'You cannot act on this step.');
    }
  }

  // ---- reads ----
  const finalApproval = mode === 'approve' && r.currentStep === r.workflow.steps.length - 1;
  const [locks, challenge, student] = await Promise.all([
    tx.getAll(...r.slotKeys.map((k) => db.doc(`reservationLocks/${k}`))),
    r.activeChallengeId ? tx.get(db.doc(`approvalChallenges/${r.activeChallengeId}`)) : null,
    tx.get(db.doc(`users/${r.uid}`)), // for the outcome email
  ]);
  const ours = (l) => l.exists && l.get('reservationId') === id;

  if (mode === 'approve' || mode === 'reject') {
    if (actor.type === 'external') { // the session is re-checked INSIDE the transaction that consumes it
      if (!challenge?.exists || challenge.id !== actor.challengeId) throw new HttpError(409, 'not-current-step', 'This approval link is no longer current.');
      actor.check(challenge.data());
    }
    if (mode === 'approve' && !locks.every((l) => ours(l) && l.get('expiresAt').toMillis() > now.getTime())) [mode, reason, preempted] = ['expire', 'hold_lost', true];
  }

  // ---- writes ----
  const by = { type: actor.type, ref: actor.type === 'external' ? maskEmail(actor.email) : actor.type === 'system' ? 'system' : actor.uid };
  const step = r.workflow.steps[r.currentStep];
  const base = { updatedAt: ts(now) };
  const record = (action, extra = {}) => {
    // seq orders the trail exactly, even when two actions share a timestamp: one decision per step, then at most one ending.
    tx.create(db.collection('approvalActions').doc(), { reservationId: id, seq: r.approvals.length + 1, stepIndex: r.currentStep, stepLabel: step.label, action, actorType: by.type, actorRef: by.ref, comment: comment ?? null, reason, at: ts(now), ...extra });
    audit(db, tx, { actorUid: by.type === 'system' ? null : (actor.uid ?? null), action: `reservation.${action}`, targetType: 'reservation', targetId: id, details: { step: r.currentStep, actor: by, reason, comment: comment ?? null } });
  };
  const mail = (subject, text) => {
    const to = student?.exists ? student.get('email') : null;
    if (to) enqueue(db, tx, { dedupeKey: `reservation-outcome:${id}:${mode}`, kind: 'reservation-outcome', to, subject, text, now });
  };

  if (mode === 'approve') {
    const entry = { step: r.currentStep, label: step.label, outcome: 'approved', by, at: now.toISOString(), comment: comment ?? null };
    if (challenge?.exists) closeChallenge(tx, challenge.ref, 'approved', now);
    if (!finalApproval) {
      const next = r.currentStep + 1;
      const deadline = deadlineFor(r, now, r.workflow.stepHours);
      locks.forEach((l) => tx.update(l.ref, { expiresAt: ts(deadline) }));
      const nextStep = r.workflow.steps[next];
      const challengeId = nextStep.type === 'external'
        ? createChallenge(db, tx, { reservationId: id, stepIndex: next, stepLabel: nextStep.label, email: nextStep.email, deadline, now, config, summary: summaryOf(r, r.studentName, r.studentNumber) })
        : null;
      tx.update(snap.ref, { ...base, currentStep: next, stepDeadline: ts(deadline), activeChallengeId: challengeId, approvals: [...r.approvals, entry] });
      record('approved');
      return { changed: true, status: 'pending', currentStep: next };
    }
    // Final administrator approval: the booking is confirmed, and only now does a confirmation reference and QR exist.
    locks.forEach((l) => tx.update(l.ref, { kind: 'booked', expiresAt: r.endsAt }));
    const confirmationRef = newId('RC');
    tx.update(snap.ref, {
      ...base, status: 'confirmed', confirmedAt: ts(now), confirmationRef, qrRef: randomBytes(18).toString('base64url'),
      stepDeadline: FieldValue.delete(), activeChallengeId: null, approvals: [...r.approvals, entry],
      decision: { outcome: 'confirmed', by, at: ts(now), comment: comment ?? null },
    });
    record('approved');
    mail(`Your discussion room reservation is confirmed (${confirmationRef})`, `${summaryOf(r, r.studentName, r.studentNumber)}\n\nConfirmation reference: ${confirmationRef}\nOpen "My Reservations" to view and print your confirmation.`);
    return { changed: true, status: 'confirmed', currentStep: r.currentStep };
  }

  const status = { reject: 'rejected', cancel: 'cancelled', expire: 'expired' }[mode];
  locks.forEach((l) => { if (ours(l)) tx.delete(l.ref); }); // guarded: another reservation's slot is never touched
  if (challenge?.exists && challenge.get('status') === 'open') closeChallenge(tx, challenge.ref, status, now);
  tx.update(snap.ref, {
    ...base, status, endedAt: ts(now), endReason: reason ?? mode, stepDeadline: FieldValue.delete(), activeChallengeId: null,
    decision: { outcome: status, by, at: ts(now), comment: comment ?? null },
    ...(mode === 'reject' ? { approvals: [...r.approvals, { step: r.currentStep, label: step.label, outcome: 'rejected', by, at: now.toISOString(), comment: comment ?? null }] } : {}),
  });
  record({ reject: 'rejected', cancel: 'cancelled', expire: 'expired' }[mode]);
  const why = { rejected: 'was not approved', cancelled: 'was cancelled', expired: 'ran out of time before it was decided' }[status];
  mail(`Your discussion room reservation ${why}`, `${summaryOf(r, r.studentName, r.studentNumber)}\n\nYour reservation ${why}${comment ? ` (${comment})` : ''}. The room is free for others.`);
  return { changed: true, status, preempted, reason };
}

// Re-sends the review request for the current external step with a fresh challenge (the old one stops working).
export async function resendNotice({ db, config, id, now, adminUid }) {
  if (!RES_ID.test(id ?? '')) throw new HttpError(404, 'not-found', 'Reservation not found.');
  await serialize(`reservation:${id}`, () => txn(db, async (tx) => {
    const snap = await tx.get(resRef(db, id));
    if (!snap.exists) throw new HttpError(404, 'not-found', 'Reservation not found.');
    const r = snap.data();
    if (r.status !== 'pending' || dueReason(r, now)) throw new HttpError(409, 'not-pending', 'Only a request that is waiting for a decision can be re-sent.');
    const step = r.workflow.steps[r.currentStep];
    if (step.type !== 'external') throw new HttpError(409, 'not-external-step', 'The current step is the final administrator approval.');
    const old = r.activeChallengeId ? await tx.get(db.doc(`approvalChallenges/${r.activeChallengeId}`)) : null;
    if (old?.exists && old.get('status') === 'open') closeChallenge(tx, old.ref, 'resent', now);
    const challengeId = createChallenge(db, tx, { reservationId: id, stepIndex: r.currentStep, stepLabel: step.label, email: step.email, deadline: r.stepDeadline.toDate(), now, config, summary: summaryOf(r, r.studentName, r.studentNumber) });
    tx.update(snap.ref, { activeChallengeId: challengeId, updatedAt: ts(now) });
    audit(db, tx, { actorUid: adminUid, action: 'reservation.notice_resent', targetType: 'reservation', targetId: id, details: { step: r.currentStep } });
  }));
}

// Eventual cleanup of overdue requests; every read and every action also expires what it touches, so this is optional.
export async function expireDueReservations({ db, config, now, limit = 50 }) {
  const due = await db.collection('reservations').where('stepDeadline', '<=', ts(now)).limit(limit).get();
  let expired = 0;
  for (const d of due.docs) {
    try {
      if ((await applyReservation({ db, config, id: d.id, now, op: 'expire_if_due', actor: { type: 'system' } })).changed) expired++;
    } catch (err) {
      console.error(`could not expire ${d.id}`, err);
    }
  }
  return expired;
}

// ------------------------------------------------------------------ students

const progressOf = (r) => {
  const done = new Map(r.approvals.map((a) => [a.step, a.outcome]));
  return r.workflow.steps.map((s, i) => ({
    label: s.label, type: s.type,
    state: done.get(i) ?? (r.status === 'pending' ? (i === r.currentStep ? 'current' : 'waiting') : i === r.currentStep ? 'stopped' : 'skipped'),
  }));
};

export function presentStudent(snap) {
  const r = snap.data();
  return {
    id: snap.id, status: r.status, room: { id: r.roomId, ...r.room },
    date: r.localDate, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone, startsAt: iso(r.startsAt), endsAt: iso(r.endsAt),
    participantCount: r.participantCount, participants: r.participants, purpose: r.purpose, notes: r.notes,
    progress: progressOf(r), currentStepLabel: r.status === 'pending' ? r.workflow.steps[r.currentStep].label : null, stepDeadline: iso(r.stepDeadline),
    decision: r.decision ? { outcome: r.decision.outcome, at: iso(r.decision.at), comment: r.decision.comment } : null,
    endReason: r.endReason ?? null, createdAt: iso(r.createdAt), endedAt: iso(r.endedAt),
    // Present only once the final administrator approved.
    ...(r.status === 'confirmed' ? { confirmationRef: r.confirmationRef, qrPayload: `${QR_PREFIX}${r.qrRef}`, confirmedAt: iso(r.confirmedAt) } : {}),
  };
}

async function expireMine({ db, config, uid, now }) {
  const open = await db.collection('reservations').where('uid', '==', uid).where('status', '==', 'pending').get();
  for (const d of open.docs) await applyReservation({ db, config, id: d.id, now, op: 'expire_if_due', actor: { type: 'system' } });
}

export async function listMine({ db, config, uid, now, limit = 30 }) {
  await expireMine({ db, config, uid, now });
  const snaps = await db.collection('reservations').where('uid', '==', uid).orderBy('startsAt', 'desc').limit(limit).get();
  return snaps.docs.map(presentStudent);
}

async function ownedSnap({ db, config, uid, id, now }) {
  if (!RES_ID.test(id ?? '')) throw new HttpError(404, 'not-found', 'Reservation not found.');
  await expireMine({ db, config, uid, now });
  const snap = await resRef(db, id).get();
  if (!snap.exists || snap.get('uid') !== uid) throw new HttpError(404, 'not-found', 'Reservation not found.'); // someone else's looks the same as a missing one
  return snap;
}

export async function getMine(args) {
  return presentStudent(await ownedSnap(args));
}

export async function cancelMine({ db, config, uid, id, now }) {
  await ownedSnap({ db, config, uid, id, now });
  await applyReservation({ db, config, id, now, op: 'cancel', actor: { type: 'student', uid } });
  return getMine({ db, config, uid, id, now });
}

// Confirmed reservations only: pending, rejected, cancelled or expired requests never get a QR.
export async function printableReservation({ db, config, uid, id, now }) {
  const snap = await ownedSnap({ db, config, uid, id, now });
  if (snap.get('status') !== 'confirmed') throw new HttpError(409, 'not-confirmed', 'Only a confirmed reservation can be printed.');
  return {
    reservation: presentStudent(snap),
    student: { fullName: snap.get('studentName'), studentNumber: snap.get('studentNumber') },
    qrSvg: await QRCode.toString(`${QR_PREFIX}${snap.get('qrRef')}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
}

// ------------------------------------------------------------------ rooms, availability, rules (advisory views)

export async function bookingRules({ db, now }) {
  const { settings } = settingsView(await db.doc('settings/system').get());
  return {
    timezone: TIMEZONE, intervalMinutes: settings.discussionRoomBookingIntervalMinutes, advanceDays: settings.reservationAdvanceBookingDays,
    open: formatMinutes(OPEN_MINUTES), close: formatMinutes(CLOSE_MINUTES), maxHours: MAX_BOOKING_MINUTES / 60, maxOpenReservations: MAX_ACTIVE_PER_STUDENT,
    today: instantToLocal(now).date, lastDate: localDatePlusDays(now, settings.reservationAdvanceBookingDays),
  };
}

export async function listRooms(db) {
  const rooms = await db.collection('resources').where('type', '==', 'discussion-room').where('status', '==', 'active').get();
  return rooms.docs.map((d) => ({ id: d.id, label: d.get('label'), description: d.get('description') ?? '', capacity: d.get('capacity') })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// Taken time per room on one local date. Advisory: the transaction in submitReservation is what decides.
export async function availability({ db, date, now }) {
  if (!parseLocalDate(date)) throw invalid('Choose a valid date.');
  const [rooms, locks] = await Promise.all([listRooms(db), db.collection('reservationLocks').where('date', '==', date).get()]);
  const busy = new Map(rooms.map((r) => [r.id, []]));
  for (const l of locks.docs.filter((x) => x.get('expiresAt').toMillis() > now.getTime())) busy.get(l.get('roomId'))?.push(l.get('slotStart').toMillis());
  return {
    date,
    rooms: rooms.map((room) => {
      const taken = busy.get(room.id).sort((a, b) => a - b);
      const intervals = [];
      for (const start of taken) {
        const last = intervals.at(-1);
        if (last && last.end === start) last.end = start + SLOT_MINUTES * 60_000;
        else intervals.push({ start, end: start + SLOT_MINUTES * 60_000 });
      }
      return { ...room, busy: intervals.map((i) => ({ start: instantToLocal(new Date(i.start)).minutes, end: instantToLocal(new Date(i.end)).minutes })) };
    }),
  };
}

// ------------------------------------------------------------------ administrators

export async function adminReservation({ db, id }) {
  const snap = await resRef(db, id).get();
  if (!snap.exists) throw new HttpError(404, 'not-found', 'Reservation not found.');
  const r = snap.data();
  const actions = await db.collection('approvalActions').where('reservationId', '==', id).get();
  return {
    ...presentStudent(snap),
    student: { fullName: r.studentName, studentNumber: r.studentNumber },
    currentStep: r.currentStep,
    workflow: r.workflow.steps.map((s) => ({ label: s.label, type: s.type, ...(s.email ? { email: s.email } : {}) })),
    approvals: r.approvals.map((a) => ({ step: a.step, label: a.label, outcome: a.outcome, by: a.by, at: a.at, comment: a.comment })),
    history: actions.docs.map((d) => d.data()).sort((a, b) => a.seq - b.seq || a.at.toMillis() - b.at.toMillis())
      .map((a) => ({ action: a.action, stepLabel: a.stepLabel, actorType: a.actorType, actorRef: a.actorRef, reason: a.reason ?? null, comment: a.comment, at: iso(a.at) })),
    awaitingFinalApproval: r.status === 'pending' && r.workflow.steps[r.currentStep].type === 'admin',
  };
}

export async function adminList({ db, config, now, status = 'pending', limit = 100 }) {
  if (!['pending', 'confirmed', 'rejected', 'cancelled', 'expired'].includes(status)) throw invalid('status must be pending, confirmed, rejected, cancelled or expired.');
  await expireDueReservations({ db, config, now });
  // Ordered in the query so the page is the right 100 (soonest pending first, latest history first), not an arbitrary 100.
  const snaps = await db.collection('reservations').where('status', '==', status).orderBy('startsAt', status === 'pending' ? 'asc' : 'desc').limit(limit).get();
  return snaps.docs.map((d) => ({ ...presentStudent(d), student: { fullName: d.get('studentName'), studentNumber: d.get('studentNumber') }, awaitingFinalApproval: d.get('status') === 'pending' && d.get('workflow').steps[d.get('currentStep')].type === 'admin' }));
}

// ------------------------------------------------------------------ administrator QR verification

// What a scanner or a person can supply for a reservation: the QR payload (NUFR1:<ref>) or the confirmation reference
// printed on the confirmation (RC-...). A bare 24-character reference is NOT accepted: it is ambiguous with a stub's.
export function parseReservationReference(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text.length === 0 || text.length > 64) return null;
  if (text.startsWith(QR_PREFIX)) return QR_REF.test(text.slice(QR_PREFIX.length)) ? { field: 'qrRef', value: text.slice(QR_PREFIX.length) } : null;
  return CONFIRMATION_REF.test(text.toUpperCase()) ? { field: 'confirmationRef', value: text.toUpperCase() } : null;
}
export const isReservationReference = (input) => typeof input === 'string' && (input.trim().startsWith(QR_PREFIX) || /^RC-/i.test(input.trim()));

// Read-only: tells an administrator what the code refers to and whether the booking is valid right now. Possession of the
// code proves nothing about who holds it, and no attendance state exists for reservations (that needs an approved policy),
// so there are no actions here. Shows no approver addresses, challenge ids or QR references.
export async function resolveReservation({ db, config, reference, now }) {
  const parsed = parseReservationReference(reference);
  if (!parsed) throw new HttpError(400, 'invalid-qr', 'That is not a library reservation code.');
  const found = await db.collection('reservations').where(parsed.field, '==', parsed.value).limit(1).get();
  if (found.empty) throw new HttpError(404, 'unknown-qr', 'No reservation matches this code.');
  const id = found.docs[0].id;
  await applyReservation({ db, config, id, now, op: 'expire_if_due', actor: { type: 'system' } }); // judge it as of NOW
  const snap = await resRef(db, id).get();
  const r = snap.data();
  const student = await db.doc(`users/${r.uid}`).get();

  const ms = now.getTime();
  const period = ms < r.startsAt.toMillis() ? 'upcoming' : ms < r.endsAt.toMillis() ? 'in_progress' : 'ended';
  const warnings = [];
  if (!(student.exists && student.get('role') === 'student' && student.get('status') === 'active')) warnings.push('student-not-active');
  return {
    reservation: {
      id, status: r.status, confirmationRef: r.confirmationRef ?? null, room: r.room.label,
      date: r.localDate, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone, startsAt: iso(r.startsAt), endsAt: iso(r.endsAt),
      participantCount: r.participantCount, endReason: r.endReason ?? null, endedAt: iso(r.endedAt),
    },
    student: { fullName: r.studentName, studentNumber: r.studentNumber, status: student.get('status') ?? 'unknown' },
    period,
    validNow: r.status === 'confirmed' && period === 'in_progress' && warnings.length === 0,
    warnings,
  };
}
