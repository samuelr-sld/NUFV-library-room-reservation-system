import { HttpError } from './errors.js';

// Transactions on contended documents (many students, one last seat or slot) can exhaust Firestore's own retries.
// Retrying the whole transaction is safe because every operation in this system is idempotent; if it still cannot
// get through, say "busy" (503), not 500.
const contention = (err) => err?.code === 10 || /ABORTED|contention|Transaction is invalid or closed/i.test(String(err?.message)); // the last one: a lock wait that timed out

export async function txn(db, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.runTransaction(fn, { maxAttempts: 10 });
    } catch (err) {
      if (!contention(err)) throw err;
      if (attempt >= 4) throw new HttpError(503, 'busy', 'The system is busy right now. Please try again in a moment.');
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt + Math.random() * 120));
    }
  }
}

// Requests sharing a key run one at a time inside this process (a double click, a retry), which removes self-inflicted
// contention. Correctness across processes always comes from the transaction itself, never from this queue.
const inFlight = new Map();
export function serialize(key, fn) {
  const next = (inFlight.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  inFlight.set(key, next);
  next.finally(() => { if (inFlight.get(key) === next) inFlight.delete(key); }).catch(() => {});
  return next;
}
