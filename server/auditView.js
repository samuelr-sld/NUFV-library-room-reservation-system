import { HttpError } from './errors.js';

// Read-only, administrator-only view of auditLogs. Bounded: one page of at most 100 rows, newest first, continued with the
// id of the last row. At most one filter (action or target id) so every query is served by a single composite index.
// The log is written without secrets (see audit.js); the redaction below is a second lock on that door, not the first.

export const MAX_PAGE = 100;
const SECRET_KEY = /pass(word)?|secret|token|credential|session|hash|otp|^code$|qrref/i;
const ACTION = /^[a-z_]+(\.[a-z_]+)*$/;
const TARGET = /^[A-Za-z0-9_-]{1,80}$/;
const iso = (t) => t?.toDate().toISOString() ?? null;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[hidden]' : redact(v)]));
}

export async function listAudit({ db, query = {} }) {
  const { action, target, before } = query;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, 'invalid-argument', `limit must be a whole number from 1 to ${MAX_PAGE}.`);
  if (action !== undefined && !(typeof action === 'string' && action.length <= 60 && ACTION.test(action))) throw new HttpError(400, 'invalid-argument', 'action must look like reservation.approved.');
  if (target !== undefined && !(typeof target === 'string' && TARGET.test(target))) throw new HttpError(400, 'invalid-argument', 'target must be a reservation, ticket or user id.');
  if (action !== undefined && target !== undefined) throw new HttpError(400, 'invalid-argument', 'Filter by an action or by a target, not both.');
  if (before !== undefined && !(typeof before === 'string' && /^[A-Za-z0-9]{20}$/.test(before))) throw new HttpError(400, 'invalid-argument', 'before is not a valid cursor.');

  let q = db.collection('auditLogs');
  if (action !== undefined) q = q.where('action', '==', action);
  if (target !== undefined) q = q.where('targetId', '==', target);
  q = q.orderBy('at', 'desc');
  if (before !== undefined) {
    const cursor = await db.doc(`auditLogs/${before}`).get();
    if (!cursor.exists) throw new HttpError(400, 'invalid-argument', 'before is not a valid cursor.');
    q = q.startAfter(cursor);
  }
  const docs = (await q.limit(limit + 1).get()).docs;
  const page = docs.slice(0, limit);

  const uids = [...new Set(page.map((d) => d.get('actorUid')).filter(Boolean))];
  const profiles = new Map((uids.length ? await db.getAll(...uids.map((u) => db.doc(`users/${u}`))) : []).map((p) => [p.id, p]));

  return {
    entries: page.map((d) => {
      const a = d.data();
      const details = redact(a.details ?? null);
      const profile = profiles.get(a.actorUid);
      const actor = a.actorUid
        ? { uid: a.actorUid, label: profile?.exists ? `${profile.get('fullName')} (${profile.get('role')})` : 'Unknown account' }
        : { uid: null, label: details?.actor?.type === 'external' ? `External approver ${details.actor.ref}` : 'System' };
      return {
        id: d.id, at: iso(a.at), action: a.action, actor, target: { type: a.targetType, id: a.targetId },
        outcome: a.action.split('.').pop(),
        // what a person wrote (a revoke reason, a comment) is more useful than the system's own word for it ("revoked", "no_show")
        reason: [details?.revokeReason, details?.comment, details?.reason].find((x) => typeof x === 'string' && x) ?? null,
        details,
      };
    }),
    next: docs.length > limit ? page.at(-1).id : null,
  };
}
