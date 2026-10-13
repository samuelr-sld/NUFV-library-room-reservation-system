import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { txn } from './tx.js';

// The approval chain for discussion room reservations, edited by administrators (approvalWorkflows/current).
// Admins configure ORDERED EXTERNAL approvers (an email address and a label each, individually enable-able). The final
// step is not configurable: the system always appends "final administrator approval", which only an authenticated
// administrator can perform. A reservation copies the effective chain when it is submitted, so changing this
// configuration never alters a request already in flight.

export const MAX_EXTERNAL_STEPS = 5;
export const DEFAULT_STEP_HOURS = 48;
export const FINAL_LABEL = 'Final administrator approval';

const invalid = (message) => new HttpError(400, 'invalid-argument', message);
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ref = (db) => db.doc('approvalWorkflows/current');
const iso = (t) => t?.toDate().toISOString() ?? null;

export function validateConfig(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object.');
  for (const key of Object.keys(body)) if (!['steps', 'stepHours'].includes(key)) throw invalid(`Unknown field "${key}".`);
  if (!Array.isArray(body.steps) || body.steps.length > MAX_EXTERNAL_STEPS) throw invalid(`steps must be a list of at most ${MAX_EXTERNAL_STEPS} approvers.`);
  const stepHours = body.stepHours === undefined ? DEFAULT_STEP_HOURS : body.stepHours;
  if (!Number.isInteger(stepHours) || stepHours < 1 || stepHours > 168) throw invalid('stepHours must be a whole number from 1 to 168.');

  const steps = body.steps.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw invalid(`Step ${i + 1} must be an object.`);
    for (const key of Object.keys(s)) if (!['label', 'email', 'enabled'].includes(key)) throw invalid(`Step ${i + 1}: unknown field "${key}".`);
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    const email = typeof s.email === 'string' ? s.email.trim().toLowerCase() : '';
    if (label.length < 1 || label.length > 60 || /[\u0000-\u001f]/.test(label)) throw invalid(`Step ${i + 1}: the label must be 1 to 60 characters.`);
    if (email.length > 100 || !EMAIL.test(email)) throw invalid(`Step ${i + 1}: a valid approver email address is required.`);
    if (typeof s.enabled !== 'boolean') throw invalid(`Step ${i + 1}: enabled must be true or false.`);
    return { label, email, enabled: s.enabled };
  });
  const active = steps.filter((s) => s.enabled).map((s) => s.email);
  if (new Set(active).size !== active.length) throw invalid('The same email address cannot approve two enabled steps.');
  return { steps, stepHours };
}

// The chain a new reservation would get: enabled external steps in order, then the final administrator step.
export function effectiveChain(config) {
  return [
    ...config.steps.filter((s) => s.enabled).map((s) => ({ label: s.label, type: 'external', email: s.email })),
    { label: FINAL_LABEL, type: 'admin' },
  ];
}

export function viewConfig(snap) {
  const d = snap.exists ? snap.data() : { steps: [], stepHours: DEFAULT_STEP_HOURS };
  const config = { steps: d.steps ?? [], stepHours: d.stepHours ?? DEFAULT_STEP_HOURS };
  return { ...config, chain: effectiveChain(config), version: d.version ?? 0, updatedAt: iso(d.updatedAt), updatedBy: d.updatedBy ?? null };
}

// What a reservation stores at submission: frozen, with the version it came from.
export function snapshotFrom(snap) {
  const v = viewConfig(snap);
  return { version: v.version, stepHours: v.stepHours, steps: v.chain };
}

export async function getWorkflow(db) {
  return viewConfig(await ref(db).get());
}

export async function saveWorkflow({ db, uid, body }) {
  const config = validateConfig(body);
  await txn(db, async (tx) => {
    const snap = await tx.get(ref(db));
    const before = viewConfig(snap);
    tx.set(ref(db), { ...config, version: before.version + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    audit(db, tx, {
      actorUid: uid, action: 'workflow.update', targetType: 'workflow', targetId: 'current',
      details: { version: before.version + 1, before: { steps: before.steps, stepHours: before.stepHours }, after: config },
    });
  });
  return getWorkflow(db);
}
