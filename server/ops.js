import { Timestamp } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { txn } from './tx.js';
import { MAX_ATTEMPTS, outboxId, trimHistory } from './mail/outbox.js';
import { expireDueReservations } from './reservations.js';

// Administrator visibility and safe recovery for approvals and email. Nothing here decides an approval, skips a step or
// resets a workflow: the only writes are "send this failed message again" (same message, same recipient, fresh attempts)
// and the existing "send the request again" on a reservation. Message bodies are never returned (they can carry a
// one-time code or an approval link).

const ts = (date) => Timestamp.fromDate(date);
const iso = (t) => t?.toDate().toISOString() ?? null;
export const EMAIL_STATUSES = ['queued', 'sending', 'failed', 'sent'];

// Pending approval steps (with the state of the current step's challenge and review email) and recently expired requests.
export async function approvalsOverview({ db, config, now, limit = 100 }) {
  await expireDueReservations({ db, config, now }); // judge everything as of now
  const [pending, expired] = await Promise.all([
    db.collection('reservations').where('status', '==', 'pending').limit(limit).get(),
    db.collection('reservations').where('status', '==', 'expired').orderBy('endedAt', 'desc').limit(25).get(),
  ]);
  const withChallenge = pending.docs.filter((d) => d.get('activeChallengeId'));
  const [challenges, notices] = await Promise.all([
    withChallenge.length ? db.getAll(...withChallenge.map((d) => db.doc(`approvalChallenges/${d.get('activeChallengeId')}`))) : [],
    withChallenge.length ? db.getAll(...withChallenge.map((d) => db.doc(`emailOutbox/${outboxId(`approver-notice:${d.get('activeChallengeId')}`)}`))) : [],
  ]);
  const challengeOf = new Map(withChallenge.map((d, i) => [d.id, challenges[i]]));
  const noticeOf = new Map(withChallenge.map((d, i) => [d.id, notices[i]]));

  const row = (d) => ({
    id: d.id, student: { fullName: d.get('studentName'), studentNumber: d.get('studentNumber') }, room: d.get('room').label,
    date: d.get('localDate'), startTime: d.get('startTime'), endTime: d.get('endTime'),
  });
  return {
    generatedAt: now.toISOString(),
    pending: pending.docs.map((d) => {
      const step = d.get('workflow').steps[d.get('currentStep')];
      const ch = challengeOf.get(d.id);
      const notice = noticeOf.get(d.id);
      const challenge = ch?.exists ? { state: ch.get('status') === 'open' ? 'open' : (ch.get('closedReason') ?? 'closed'), codesSent: ch.get('codesSent'), failedTotal: ch.get('failedTotal') } : null;
      const attention = [];
      if (challenge && challenge.state !== 'open') attention.push(challenge.state === 'locked' ? 'locked' : 'challenge-closed');
      if (notice?.exists && notice.get('status') === 'failed') attention.push('notice-failed');
      return {
        ...row(d), currentStep: d.get('currentStep'), stepLabel: step.label, stepType: step.type, approverEmail: step.email ?? null,
        stepDeadline: iso(d.get('stepDeadline')), challenge, notice: notice?.exists ? notice.get('status') : null, attention,
      };
    }).sort((a, b) => a.stepDeadline.localeCompare(b.stepDeadline)),
    expired: expired.docs.map((d) => ({ ...row(d), endReason: d.get('endReason'), endedAt: iso(d.get('endedAt')) })),
  };
}

// Counts per delivery state, plus one bounded page of messages in the chosen state (newest first). No bodies.
export async function emailOverview({ db, status = 'failed', limit = 50 }) {
  if (!EMAIL_STATUSES.includes(status)) throw new HttpError(400, 'invalid-argument', `status must be one of ${EMAIL_STATUSES.join(', ')}.`);
  const outbox = db.collection('emailOutbox');
  const [counts, page] = await Promise.all([
    Promise.all(EMAIL_STATUSES.map(async (s) => [s, (await outbox.where('status', '==', s).count().get()).data().count])),
    outbox.where('status', '==', status).orderBy('createdAt', 'desc').limit(limit).get(),
  ]);
  return {
    counts: Object.fromEntries(counts), status, maxAttempts: MAX_ATTEMPTS,
    messages: page.docs.map((d) => {
      const m = d.data();
      return {
        id: d.id, kind: m.kind, to: m.to, subject: m.subject, status: m.status, attempts: m.attempts, lastError: m.lastError,
        createdAt: iso(m.createdAt), nextAttemptAt: iso(m.nextAttemptAt), sentAt: iso(m.sentAt), history: m.history,
        willRetry: m.status === 'queued' && m.attempts > 0,
        requeueable: m.status === 'failed' && m.text !== null,
      };
    }),
  };
}

// Puts a FAILED message back in the queue with fresh attempts. Delivery stays at-least-once: if the earlier attempt actually
// reached the recipient, they may get it twice. Refused when the body was discarded (one-time codes: the approver asks for a
// new one) or when the review link inside is no longer the live one (use "send the request again" on the reservation).
export async function requeueEmail({ db, id, now, adminUid }) {
  if (!/^[0-9a-f]{32}$/.test(id ?? '')) throw new HttpError(404, 'not-found', 'Message not found.');
  await txn(db, async (tx) => {
    const ref = db.doc(`emailOutbox/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'not-found', 'Message not found.');
    const m = snap.data();
    if (m.status !== 'failed') throw new HttpError(409, 'not-failed', 'Only a failed message can be sent again.');
    if (m.text === null) throw new HttpError(409, 'body-discarded', 'This message held a one-time code that was discarded once delivery ended. The approver can ask for a new code on the approval page.');
    if (m.kind === 'approval-request') {
      const challenge = await tx.get(db.doc(`approvalChallenges/${m.dedupeKey.split(':')[1]}`));
      if (!challenge.exists || challenge.get('status') !== 'open') {
        throw new HttpError(409, 'superseded', 'The review link in this message is no longer current. Use "Send the request again" on the reservation instead.');
      }
    }
    tx.update(ref, {
      status: 'queued', attempts: 0, nextAttemptAt: ts(now), leaseUntil: null, claimedBy: null, lastError: null,
      history: trimHistory(m.history, { at: now.toISOString(), attempt: m.attempts, outcome: 'requeued', by: adminUid }),
    });
    audit(db, tx, { actorUid: adminUid, action: 'email.requeued', targetType: 'email', targetId: id, details: { kind: m.kind, previousAttempts: m.attempts } });
  });
}
