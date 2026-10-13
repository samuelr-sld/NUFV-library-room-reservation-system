import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

let env;

before(async () => {
  // Host/port come from FIRESTORE_EMULATOR_HOST, set by `firebase emulators:exec`.
  env = await initializeTestEnvironment({
    projectId: 'demo-nufv',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(() => env.cleanup());

test('signed-out users cannot read or write', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users/anyone')));
  await assertFails(setDoc(doc(db, 'users/anyone'), { role: 'admin' }));
});

test('signed-in users cannot touch collections that are not opened yet', async () => {
  const db = env.authenticatedContext('alice').firestore();
  await assertFails(getDoc(doc(db, 'reservations/r1')));
  await assertFails(setDoc(doc(db, 'reservations/r1'), { status: 'confirmed' }));
});

test('even an admin-claim token is denied until rules open a collection', async () => {
  const db = env.authenticatedContext('mallory', { role: 'admin' }).firestore();
  await assertFails(getDoc(doc(db, 'auditLogs/x')));
});

test('harness can seed data with rules bypassed', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await assertSucceeds(setDoc(doc(ctx.firestore(), 'users/seed'), { ok: true }));
  });
});
