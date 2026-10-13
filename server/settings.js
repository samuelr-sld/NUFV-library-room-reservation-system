import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { audit } from './audit.js';

// System-wide limits, stored in settings/system and written only by this module (Admin SDK). Rules deny all client access.
// Changes apply to tickets and reservations created afterwards; nothing already issued is rewritten.
export const SETTINGS = {
  silentRoomTicketMinutes: { default: 120, min: 15, max: 480 },
  computerTicketMinutes: { default: 60, min: 15, max: 240 },
  noShowGraceMinutes: { default: 15, min: 0, max: 60 },
  maxActiveTicketsPerStudent: { default: 1, min: 1, max: 5 },
  discussionRoomBookingIntervalMinutes: { default: 60, allowed: [15, 30, 60] },
  reservationAdvanceBookingDays: { default: 7, min: 1, max: 60 },
  wifiVoucherMinutes: { default: 180, min: 15, max: 1440 },
};
export const DEFAULTS = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.default]));

const invalid = (message) => new HttpError(400, 'invalid-argument', message);

// Validates a partial update; returns it unchanged if valid.
export function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Settings must be a JSON object.');
  const keys = Object.keys(patch);
  if (!keys.length) throw invalid('Provide at least one setting to change.');
  for (const key of keys) {
    const spec = SETTINGS[key];
    if (!spec) throw invalid(`Unknown setting "${key}".`);
    const value = patch[key];
    if (!Number.isInteger(value)) throw invalid(`${key} must be a whole number.`);
    if (spec.allowed ? !spec.allowed.includes(value) : value < spec.min || value > spec.max) {
      throw invalid(spec.allowed ? `${key} must be one of ${spec.allowed.join(', ')}.` : `${key} must be between ${spec.min} and ${spec.max}.`);
    }
  }
  return patch;
}

// Cross-field rule on the merged result: a student must be able to claim a ticket before the grace period ends it.
export function validateMerged(values) {
  if (values.noShowGraceMinutes >= Math.min(values.silentRoomTicketMinutes, values.computerTicketMinutes)) {
    throw invalid('noShowGraceMinutes must be shorter than both ticket durations.');
  }
}

const ref = (db) => db.doc('settings/system');
const iso = (t) => t?.toDate().toISOString() ?? null;

export function view(snap) {
  // Stored values are re-merged over the defaults, so a missing or partial document still yields a complete, safe result.
  const stored = snap.exists ? snap.get('values') ?? {} : {};
  return {
    settings: { ...DEFAULTS, ...stored },
    defaults: DEFAULTS,
    limits: SETTINGS, // lets the admin UI build its fields and hints from the same rules the server enforces
    customized: snap.exists,
    version: snap.get('version') ?? 0,
    updatedAt: iso(snap.get('updatedAt')),
    updatedBy: snap.get('updatedBy') ?? null,
  };
}

export async function getSettings(db) {
  return view(await ref(db).get());
}

export async function updateSettings({ db, uid, patch }) {
  validatePatch(patch);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(db));
    const current = view(snap).settings;
    const changes = {};
    for (const [key, to] of Object.entries(patch)) if (current[key] !== to) changes[key] = { from: current[key], to };
    if (!Object.keys(changes).length) return false;

    const next = { ...current, ...patch };
    validateMerged(next);
    const version = (snap.get('version') ?? 0) + 1;
    tx.set(ref(db), { values: next, version, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    audit(db, tx, { actorUid: uid, action: 'settings.update', targetType: 'settings', targetId: 'system', details: { changes, version } });
    return true;
  });
  return { changed: outcome, ...(await getSettings(db)) };
}
