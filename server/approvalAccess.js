import { randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { txn } from './tx.js';
import { enqueue } from './mail/outbox.js';
import { audit } from './audit.js';
import { formatLocalInstant } from './time.js';
import { applyReservation, dueReason } from './reservations.js';
import {
  CHALLENGE_ID, MAX_ATTEMPTS_PER_CODE, MAX_CODES, MAX_FAILED_TOTAL, MIN_RESEND_MS, OTP_TTL_MS, SESSION_TTL_MS,
  closeChallenge, mac, maskEmail, newCode, sameSecret,
} from './challenges.js';

// The public side of external approval (no Firebase account, no role). See challenges.js for the model. Everything an
// approver can see or do is scoped to ONE reservation's CURRENT step and ends when that step is decided or expires.

const ts = (date) => Timestamp.fromDate(date);
const iso = (t) => t?.toDate().toISOString() ?? null;
const notFound = () => new HttpError(404, 'not-found', 'This approval link is not valid.');
const closed = () => new HttpError(409, 'challenge-closed', 'This approval request is no longer open.');

async function load(db, id) {
  if (!CHALLENGE_ID.test(id ?? '')) throw notFound();
  const ch = await db.doc(`approvalChallenges/${id}`).get();
  if (!ch.exists) throw notFound();
  return ch;
}

// An overdue reservation closes itself before anyone is let in.
async function freshen({ db, config, reservationId, now }) {
  await applyReservation({ db, config, id: reservationId, now, op: 'expire_if_due', actor: { type: 'system' } }).catch(() => {});
}

// Open means: not decided, not expired, and still the reservation's current step.
function isOpen(ch, res, now) {
  return ch.status === 'open' && ch.expiresAt.toMillis() > now.getTime() && res.exists && res.get('status') === 'pending'
    && res.get('currentStep') === ch.stepIndex && res.get('activeChallengeId') === ch.id && !dueReason(res.data(), now);
}

// Sessions are compared as HMACs in constant time, bound to this challenge, and expire quickly.
function assertSession(config, id, data, session, now) {
  const stored = data.session;
  const ok = stored && typeof session === 'string' && session.length <= 80
    && sameSecret(stored.hash, mac(config.approvalKey, 'session', id, session)) && stored.expiresAt.toMillis() > now.getTime();
  if (!ok) throw new HttpError(401, 'invalid-session', 'Your verification has expired. Request a new code.');
}

// What the link alone can show: nothing about the reservation.
export async function publicChallenge({ db, config, id, now }) {
  const ch = await load(db, id);
  await freshen({ db, config, reservationId: ch.get('reservationId'), now });
  const res = await db.doc(`reservations/${ch.get('reservationId')}`).get();
  const open = isOpen({ ...ch.data(), id }, res, now);
  return open
    ? { state: 'open', stepLabel: res.get('workflow').steps[ch.get('stepIndex')].label, emailHint: maskEmail(ch.get('email')) }
    : { state: 'closed' };
}

// Sends a one-time code to the address this challenge is bound to. The code is never returned to the caller.
export async function requestCode({ db, config, id, now }) {
  const ch0 = await load(db, id);
  await freshen({ db, config, reservationId: ch0.get('reservationId'), now });
  return txn(db, async (tx) => {
    const ch = await tx.get(ch0.ref);
    const res = await tx.get(db.doc(`reservations/${ch.get('reservationId')}`));
    const c = ch.data();
    if (!isOpen({ ...c, id }, res, now)) throw closed();
    if (c.codesSent >= MAX_CODES) throw new HttpError(429, 'too-many-codes', 'Too many codes were requested. Ask the library to send the request again.');
    if (c.lastCodeAt && now.getTime() - c.lastCodeAt.toMillis() < MIN_RESEND_MS) throw new HttpError(429, 'wait-before-resending', 'A code was just sent. Wait a moment before asking for another.');

    const n = c.codesSent + 1;
    const code = newCode();
    const expires = new Date(Math.min(now.getTime() + OTP_TTL_MS, c.expiresAt.toMillis()));
    tx.update(ch.ref, {
      codesSent: n, lastCodeAt: ts(now), session: null,
      otp: { n, hash: mac(config.approvalKey, 'otp', id, n, code), issuedAt: ts(now), expiresAt: ts(expires), attempts: 0, consumed: false },
    });
    enqueue(db, tx, {
      dedupeKey: `approver-code:${id}:${n}`, kind: 'approval-code', to: c.email, now,
      subject: 'Your approval code',
      text: `Your one-time code is ${code}\n\nEnter it on the approval page to continue. It works once and expires at ${formatLocalInstant(expires)}.\nNever share it: the library will not ask you for it.`,
    });
    return { sent: true, expiresInSeconds: Math.round((expires.getTime() - now.getTime()) / 1000) };
  });
}

// Checks the code. Wrong guesses are counted and committed (so they cannot be retried for free); too many lock the challenge.
export async function verifyCode({ db, config, id, code, now }) {
  const ch0 = await load(db, id);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpError(400, 'invalid-argument', 'Enter the 6-digit code from the email.');
  const out = await txn(db, async (tx) => {
    const ch = await tx.get(ch0.ref);
    const res = await tx.get(db.doc(`reservations/${ch.get('reservationId')}`));
    const c = ch.data();
    if (!isOpen({ ...c, id }, res, now)) return { error: closed() };
    const otp = c.otp;
    if (!otp || otp.consumed || otp.expiresAt.toMillis() <= now.getTime()) return { error: new HttpError(409, 'code-expired', 'That code has expired or was already used. Ask for a new one.') };
    if (otp.attempts >= MAX_ATTEMPTS_PER_CODE) return { error: new HttpError(429, 'code-locked', 'Too many wrong attempts for this code. Ask for a new one.') };

    if (!sameSecret(mac(config.approvalKey, 'otp', id, otp.n, code), otp.hash)) {
      const failed = c.failedTotal + 1;
      tx.update(ch.ref, { 'otp.attempts': otp.attempts + 1, failedTotal: failed });
      if (failed >= MAX_FAILED_TOTAL) {
        closeChallenge(tx, ch.ref, 'locked', now);
        audit(db, tx, { actorUid: null, action: 'approval.locked', targetType: 'reservation', targetId: c.reservationId, details: { step: c.stepIndex, reason: 'too many wrong codes' } });
      }
      return { error: new HttpError(401, 'wrong-code', failed >= MAX_FAILED_TOTAL ? 'Too many wrong codes. This request is locked; ask the library to send it again.' : `That code is not right. ${Math.max(0, MAX_ATTEMPTS_PER_CODE - otp.attempts - 1)} attempt(s) left for this code.`) };
    }
    const session = randomBytes(24).toString('base64url');
    const expires = new Date(Math.min(now.getTime() + SESSION_TTL_MS, c.expiresAt.toMillis()));
    tx.update(ch.ref, { 'otp.consumed': true, session: { hash: mac(config.approvalKey, 'session', id, session), expiresAt: ts(expires) } }); // the code is single-use
    return { session, expiresInSeconds: Math.round((expires.getTime() - now.getTime()) / 1000) };
  });
  if (out.error) throw out.error;
  return out;
}

// The reservation under review and nothing else.
export async function review({ db, config, id, session, now }) {
  const ch = await load(db, id);
  await freshen({ db, config, reservationId: ch.get('reservationId'), now });
  const res = await db.doc(`reservations/${ch.get('reservationId')}`).get();
  if (!isOpen({ ...ch.data(), id }, res, now)) throw closed();
  assertSession(config, id, ch.data(), session, now);
  const r = res.data();
  return {
    stepLabel: r.workflow.steps[ch.get('stepIndex')].label,
    reservation: { room: r.room.label, date: r.localDate, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone, participantCount: r.participantCount, participants: r.participants, purpose: r.purpose, notes: r.notes },
    student: { fullName: r.studentName, studentNumber: r.studentNumber },
    previousApprovals: r.approvals.map((a) => ({ label: a.label, outcome: a.outcome })),
    expiresAt: iso(ch.get('expiresAt')),
  };
}

// One decision per challenge. The session is verified again inside the transaction that applies the decision and
// closes the challenge, so concurrent or repeated submissions can act at most once.
export async function decide({ db, config, id, session, decision, comment, now }) {
  const ch = await load(db, id);
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'invalid-argument', 'Choose approve or reject.');
  const note = comment === undefined || comment === null || comment === '' ? null : comment;
  if (note !== null && (typeof note !== 'string' || note.length > 300 || /[\u0000-\u001f]/.test(note))) throw new HttpError(400, 'invalid-argument', 'A comment can be at most 300 characters.');
  const check = (data) => {
    if (data.status !== 'open') throw closed();
    assertSession(config, id, data, session, now);
  };
  const result = await applyReservation({
    db, config, id: ch.get('reservationId'), now, op: decision, expectedStep: ch.get('stepIndex'), comment: note?.trim() ?? null,
    actor: { type: 'external', email: ch.get('email'), challengeId: id, check },
  });
  return { outcome: decision === 'approve' ? 'approved' : 'rejected', reservationStatus: result.status };
}
