import { createHmac } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { txn } from './tx.js';

// Per-IP throttling for the PUBLIC approval endpoints (the only routes anyone can call without an account). Two layers:
//
//   memory       every /api/approvals request, counted in this process. Cheap flood guard: it keeps an anonymous caller
//                from burning Firestore reads. shortcut: each Express instance counts on its own, so N instances allow
//                N times the limit; move to a shared store (or a proxy/CDN rate limit) if the API is ever scaled out.
//   persistent   code and verify requests, counted in Firestore (rateLimits/{name}_{ip hash}), so the limit holds across
//                instances and restarts. It costs one read and one write per limited request.
//
// The per-challenge limits (codes per request, attempts per code, total wrong guesses) live in challenges.js and are the
// real guard against guessing a code; these limits add the "one source hammering many requests" dimension.
// A client address is only as trustworthy as the proxy setup: see TRUST_PROXY_HOPS in config.js.

export const DEFAULT_LIMITS = {
  ip: { windowMs: 60_000, max: 120 },
  code: { windowMs: 15 * 60_000, max: 20 },
  verify: { windowMs: 15 * 60_000, max: 40 },
  submit: { windowMs: 60 * 60_000, max: 20 }, // reservation requests per student: each success emails the first approver
};

const tooMany = (retryAfterSeconds) => {
  const err = new HttpError(429, 'rate-limited', 'Too many requests. Please wait a few minutes and try again.');
  err.retryAfter = Math.max(1, retryAfterSeconds);
  return err;
};

export function memoryLimiter({ windowMs, max }, clock) {
  const hits = new Map(); // ip -> { windowStart, count }
  return (req, res, next) => {
    const now = clock().getTime();
    if (hits.size > 10_000) for (const [ip, h] of hits) if (now - h.windowStart >= windowMs) hits.delete(ip);
    let h = hits.get(req.ip);
    if (!h || now - h.windowStart >= windowMs) hits.set(req.ip, (h = { windowStart: now, count: 0 }));
    if (++h.count > max) return next(tooMany(Math.ceil((h.windowStart + windowMs - now) / 1000)));
    next();
  };
}

// Fixed windows aligned to the epoch. The address is stored only as a keyed hash.
// `by` picks what is counted: the client address by default, or the signed-in student. Either way only a keyed hash is stored.
export const persistentLimiter = ({ db, config, name, limit, clock, by = (req) => req.ip }) => async (req, res, next) => {
  const now = clock().getTime();
  const window = Math.floor(now / limit.windowMs);
  const key = createHmac('sha256', config.approvalKey).update(`${name}\u0000${by(req)}`).digest('hex').slice(0, 32);
  const ref = db.doc(`rateLimits/${name}_${key}`);
  await txn(db, async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists && snap.get('window') === window ? snap.get('count') : 0;
    if (count >= limit.max) throw tooMany(Math.ceil(((window + 1) * limit.windowMs - now) / 1000));
    tx.set(ref, { window, count: count + 1, expiresAt: Timestamp.fromMillis((window + 1) * limit.windowMs) });
  });
  next();
};
