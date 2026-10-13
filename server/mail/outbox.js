import { createHash, randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { txn } from '../tx.js';

// A transactional outbox: notifications are written in the SAME transaction as the state change that causes them, so
// a change and its email exist together or not at all. A separate processor delivers them through a pluggable adapter.
//
// Delivery guarantee: AT LEAST ONCE, not exactly once. A message is claimed with a lease; if the process dies after
// the adapter accepted it but before "sent" was recorded, the lease expires and the message is sent again. Recipients
// can therefore, rarely, get a duplicate; nothing is ever silently lost. Dedupe keys stop the system itself from
// queueing the same notification twice.
//
//   queued --claim--> sending --ok--> sent
//                        |--transient error--> queued (backoff)   --after MAX_ATTEMPTS--> failed
//                        |--permanent error--> failed
//                        |--lease expired (crash)--> claimable again
//
// History stays on the document forever. One-time-code bodies are blanked once delivery ends, so a secret does not
// outlive its use in the database.

export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 60_000;
export const backoffMs = (attempt) => Math.min(30 * 60_000, 15_000 * 2 ** (attempt - 1)); // 15 s, 30 s, 60 s, ...

const ts = (date) => Timestamp.fromDate(date);
export const outboxId = (dedupeKey) => createHash('sha256').update(dedupeKey).digest('hex').slice(0, 32);
const SECRET_KINDS = new Set(['approval-code']);

// Call inside the transaction that causes the email. A repeated dedupeKey would be a bug: tx.create then fails loudly.
export function enqueue(db, tx, { dedupeKey, kind, to, subject, text, now }) {
  tx.create(db.doc(`emailOutbox/${outboxId(dedupeKey)}`), {
    dedupeKey, kind, to, subject, text,
    status: 'queued', attempts: 0, nextAttemptAt: ts(now), leaseUntil: null, claimedBy: null,
    lastError: null, createdAt: ts(now), sentAt: null, history: [],
  });
}

export const trimHistory = (history, entry) => [...history, entry].slice(-10);

async function claim({ db, id, workerId, now, leaseMs }) {
  return txn(db, async (tx) => {
    const ref = db.doc(`emailOutbox/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const m = snap.data();
    const queued = m.status === 'queued' && m.nextAttemptAt.toMillis() <= now.getTime();
    const abandoned = m.status === 'sending' && m.leaseUntil.toMillis() <= now.getTime(); // a worker died holding it
    if (!queued && !abandoned) return null;
    if (m.attempts >= MAX_ATTEMPTS) {
      tx.update(ref, { status: 'failed', lastError: 'gave up after too many attempts', leaseUntil: null, ...(SECRET_KINDS.has(m.kind) ? { text: null } : {}) });
      return null;
    }
    tx.update(ref, { status: 'sending', attempts: m.attempts + 1, claimedBy: workerId, leaseUntil: ts(new Date(now.getTime() + leaseMs)) });
    return { id, kind: m.kind, to: m.to, subject: m.subject, text: m.text, attempt: m.attempts + 1 };
  });
}

async function finish({ db, id, workerId, now, outcome, error, permanent }) {
  return txn(db, async (tx) => {
    const ref = db.doc(`emailOutbox/${id}`);
    const m = (await tx.get(ref)).data();
    const mine = m.status === 'sending' && m.claimedBy === workerId;
    const entry = { at: now.toISOString(), attempt: m.attempts, outcome, ...(error ? { error } : {}), ...(mine ? {} : { note: 'lease had expired; possible duplicate delivery' }) };
    if (!mine) { // someone else owns it now; record what happened and leave the state to them
      tx.update(ref, { history: trimHistory(m.history, entry), ...(outcome === 'sent' && m.status !== 'sent' ? { status: 'sent', sentAt: ts(now), leaseUntil: null } : {}) });
      return;
    }
    if (outcome === 'sent') {
      tx.update(ref, { status: 'sent', sentAt: ts(now), leaseUntil: null, lastError: null, history: trimHistory(m.history, entry), ...(SECRET_KINDS.has(m.kind) ? { text: null } : {}) });
    } else if (permanent || m.attempts >= MAX_ATTEMPTS) {
      tx.update(ref, { status: 'failed', leaseUntil: null, lastError: error, history: trimHistory(m.history, entry), ...(SECRET_KINDS.has(m.kind) ? { text: null } : {}) });
    } else {
      tx.update(ref, { status: 'queued', leaseUntil: null, claimedBy: null, lastError: error, nextAttemptAt: ts(new Date(now.getTime() + backoffMs(m.attempts))), history: trimHistory(m.history, entry) });
    }
  });
}

// Delivers what is due. Safe to run from many places at once (server timer, a script, tests): claims are transactional.
export async function processOutbox({ db, adapter, now = new Date(), workerId = randomUUID(), limit = 10, leaseMs = LEASE_MS }) {
  const t = ts(now);
  const [queued, abandoned] = await Promise.all([
    db.collection('emailOutbox').where('status', '==', 'queued').where('nextAttemptAt', '<=', t).limit(limit).get(),
    db.collection('emailOutbox').where('status', '==', 'sending').where('leaseUntil', '<=', t).limit(limit).get(),
  ]);
  const result = { sent: 0, retried: 0, failed: 0 };
  for (const id of new Set([...queued.docs, ...abandoned.docs].map((d) => d.id))) {
    const message = await claim({ db, id, workerId, now, leaseMs });
    if (!message) continue;
    try {
      await adapter.send(message);
    } catch (err) {
      const permanent = err?.permanent === true;
      await finish({ db, id, workerId, now, outcome: permanent ? 'failed' : 'retry', error: String(err?.message ?? err).slice(0, 200), permanent });
      result[permanent || message.attempt >= MAX_ATTEMPTS ? 'failed' : 'retried']++;
      continue;
    }
    await finish({ db, id, workerId, now, outcome: 'sent' });
    result.sent++;
  }
  return result;
}
