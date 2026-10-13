import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { enqueue } from './mail/outbox.js';
import { formatLocalInstant } from './time.js';

// Step-scoped access for EXTERNAL approvers, who have no account and no role. A challenge is created when a
// reservation reaches an external step and is bound to one reservation, one step and one email address.
//
//   email 1  "review requested"   carries a link with the challenge id only. Opening it shows nothing sensitive and
//                                  cannot approve anything (mail scanners and forwards are harmless).
//   email 2  one-time code         sent only when the approver asks for it, to the bound address, never returned by the API.
//   then     session               a successful code check yields a short-lived session secret, usable for review and
//                                  a single decision on THIS step. The decision closes the challenge (replay is refused).
//
// Codes and sessions are stored only as HMAC-SHA256 with a server key, so database access alone cannot reveal or forge them.

export const OTP_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_CODES = 5; // codes per challenge
export const MIN_RESEND_MS = 30_000;
export const MAX_ATTEMPTS_PER_CODE = 5;
export const MAX_FAILED_TOTAL = 10; // wrong guesses across all codes; then the challenge locks until an administrator re-sends it
export const CHALLENGE_ID = /^[A-Za-z0-9_-]{24}$/;

const ts = (date) => Timestamp.fromDate(date);
export const mac = (key, ...parts) => createHmac('sha256', key).update(parts.join('\u0000')).digest('hex');
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name[0]}***@${domain}`;
}

export const newCode = () => String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0'); // 6 digits, uniform enough for a 5-guess limit

// Inside the transaction that makes the step current. Also queues the "review requested" email (same commit).
export function createChallenge(db, tx, { reservationId, stepIndex, stepLabel, email, deadline, now, config, summary }) {
  const id = randomBytes(18).toString('base64url');
  tx.create(db.doc(`approvalChallenges/${id}`), {
    reservationId, stepIndex, email, status: 'open',
    createdAt: ts(now), expiresAt: ts(deadline),
    codesSent: 0, lastCodeAt: null, otp: null, failedTotal: 0, session: null,
  });
  const base = config?.appBaseUrl ?? 'http://localhost:5000';
  enqueue(db, tx, {
    dedupeKey: `approver-notice:${id}`, kind: 'approval-request', to: email, now,
    subject: `Approval requested: ${stepLabel}`,
    text: [
      `A discussion room reservation is waiting for your decision (${stepLabel}).`,
      '', summary, '',
      `Open this page to review it: ${base}/approve/approve.html#${id}`,
      '',
      'You will be asked for a one-time code, which the page can send to this email address. Opening the link alone does not approve or reject anything.',
      `This request expires on ${formatLocalInstant(deadline)}.`,
    ].join('\n'),
  });
  return id;
}

export function closeChallenge(tx, ref, reason, now) {
  tx.update(ref, { status: 'closed', closedReason: reason, closedAt: ts(now), otp: null, session: null });
}
