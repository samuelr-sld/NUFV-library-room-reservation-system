import { FieldValue } from 'firebase-admin/firestore';

// The academic demonstration environment: demo accounts and a small inventory, written to the LOCAL EMULATORS only.
//
// Safety: every entry point refuses anything but the emulators. loadConfig() already rejects a production mode, a project
// that is not demo-*, emulator hosts that are not loopback, and GOOGLE_APPLICATION_CREDENTIALS; assertDemoEnvironment() below
// says the same in one place for the launcher and the seed script, and resetDemo() talks only to the emulator hosts it was given.
// All passwords here are demonstration-only and public by design.

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_DOMAIN = 'demo.nufv.test'; // .test is reserved: no real mailbox can exist
export const DEMO_ACCOUNTS = [
  { email: `admin@${DEMO_DOMAIN}`, name: 'Demo Administrator', role: 'admin', studentNumber: null },
  { email: `ana.reyes@${DEMO_DOMAIN}`, name: 'Ana Reyes', role: 'student', studentNumber: 'DEMO-0001' },
  { email: `ben.cruz@${DEMO_DOMAIN}`, name: 'Ben Cruz', role: 'student', studentNumber: 'DEMO-0002' },
  { email: `carla.lim@${DEMO_DOMAIN}`, name: 'Carla Lim', role: 'student', studentNumber: 'DEMO-0003' },
  { email: `dev.patel@${DEMO_DOMAIN}`, name: 'Dev Patel', role: 'student', studentNumber: 'DEMO-0004' },
  { email: `eli.tan@${DEMO_DOMAIN}`, name: 'Eli Tan', role: 'student', studentNumber: 'DEMO-0005' },
  { email: `una.unverified@${DEMO_DOMAIN}`, name: 'Una Unverified', role: 'student', studentNumber: 'DEMO-0006', emailVerified: false },
  { email: `sam.suspended@${DEMO_DOMAIN}`, name: 'Sam Suspended', role: 'student', studentNumber: 'DEMO-0007', status: 'suspended' },
  // A sign-in account that never finished registering: it has no library profile, so every service refuses it.
  { email: `nina.noprofile@${DEMO_DOMAIN}`, name: 'Nina Noprofile', role: null, studentNumber: null, profile: false },
];
// External approvers have no account: they are only email addresses (the local mail sink shows what they receive).
export const DEMO_APPROVERS = [
  { label: 'College Dean', email: `dean@${DEMO_DOMAIN}`, enabled: true },
  { label: 'Library Adviser', email: `adviser@${DEMO_DOMAIN}`, enabled: true },
];
export const DEMO_RESOURCES = [
  ...['silent-01', 'silent-02', 'silent-03'].map((id, i) => ({ id, type: 'silent-seat', label: `Silent Seat ${i + 1}` })),
  ...['pc-01', 'pc-02'].map((id, i) => ({ id, type: 'computer-station', label: `Computer ${i + 1}` })),
  { id: 'room-a', type: 'discussion-room', label: 'Discussion Room A', capacity: 6 },
  { id: 'room-b', type: 'discussion-room', label: 'Discussion Room B', capacity: 4 },
  { id: 'room-c', type: 'discussion-room', label: 'Discussion Room C', capacity: 10 },
];

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}$/;

// Throws unless the environment is the local emulators of a demo-* project. Pure, so it is unit-tested.
// The demonstration only ever uses the in-memory email sink, even if a developer has SMTP settings in their shell.
export function scrubMailEnv(env) {
  for (const k of Object.keys(env)) if (/^(MAIL_|SMTP_)/.test(k)) delete env[k];
  return env;
}

export function assertDemoEnvironment(env) {
  const fail = (why) => { throw new Error(`Refusing to run the demonstration: ${why}`); };
  if (!['development', 'test'].includes(env.NODE_ENV)) fail(`NODE_ENV is "${env.NODE_ENV ?? ''}", not development or test (production and cloud-dev use a real project).`);
  if (!String(env.FIREBASE_PROJECT_ID ?? '').startsWith('demo-')) fail('FIREBASE_PROJECT_ID must be a demo-* project.');
  if (!LOOPBACK.test(env.FIRESTORE_EMULATOR_HOST ?? '') || !LOOPBACK.test(env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) fail('both emulator hosts must be set to loopback addresses.');
  if (env.MAIL_TRANSPORT === 'smtp') fail('MAIL_TRANSPORT=smtp is set; the demonstration never sends real email (unset it, or use `npm run server:mail` for live mail against the emulators).');
  if (env.GOOGLE_APPLICATION_CREDENTIALS) fail('GOOGLE_APPLICATION_CREDENTIALS is set; the demonstration never uses real credentials.');
}

// Erases everything in the local emulators (Authentication accounts and every Firestore document).
export async function resetDemo(env) {
  assertDemoEnvironment(env);
  const p = env.FIREBASE_PROJECT_ID;
  for (const url of [`http://${env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${p}/databases/(default)/documents`, `http://${env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${p}/accounts`]) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Could not reset the emulator (${res.status}) at ${url}`);
  }
}

// Creates what is missing and leaves what exists alone, so running it twice changes nothing. A clean slate is resetDemo() first.
export async function seedDemo({ auth, db, config }) {
  assertDemoEnvironment({ ...process.env, NODE_ENV: config.mode, FIREBASE_PROJECT_ID: config.projectId });
  const made = { accounts: 0, resources: 0, workflow: false };

  for (const a of DEMO_ACCOUNTS) {
    let user = await auth.getUserByEmail(a.email).catch((err) => (err.code === 'auth/user-not-found' ? null : Promise.reject(err)));
    if (!user) {
      user = await auth.createUser({ email: a.email, password: DEMO_PASSWORD, displayName: a.name, emailVerified: a.emailVerified ?? true });
      made.accounts++;
    }
    if (a.profile === false) continue;
    const ref = db.doc(`users/${user.uid}`);
    if (!(await ref.get()).exists) {
      await db.runTransaction(async (tx) => {
        tx.create(ref, {
          email: a.email, fullName: a.name, studentNumber: a.studentNumber, program: '', yearLevel: null,
          role: a.role, status: a.status ?? 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
        if (a.studentNumber) tx.create(db.doc(`studentNumbers/${a.studentNumber}`), { uid: user.uid });
      });
    }
    await auth.setCustomUserClaims(user.uid, { role: a.role });
  }

  for (const r of DEMO_RESOURCES) {
    const ref = db.doc(`resources/${r.id}`);
    if ((await ref.get()).exists) continue;
    await ref.create({
      type: r.type, label: r.label, ...(r.capacity ? { capacity: r.capacity } : {}), status: 'active',
      allocation: { assigned: 0, occupied: 0, held: 0 },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'demo-seed', updatedBy: 'demo-seed',
    });
    made.resources++;
  }

  const chain = db.doc('approvalWorkflows/current');
  if (!(await chain.get()).exists) {
    await chain.create({ steps: DEMO_APPROVERS, stepHours: 48, version: 1, updatedBy: 'demo-seed', updatedAt: FieldValue.serverTimestamp() });
    made.workflow = true;
  }
  return made;
}
