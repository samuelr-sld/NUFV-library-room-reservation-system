import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-nufv',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/rules-alice'), { role: 'student', status: 'active', studentNumber: '2023-000001' });
    await setDoc(doc(db, 'users/rules-bob'), { role: 'student', status: 'active', studentNumber: '2023-000002' });
    await setDoc(doc(db, 'studentNumbers/2023-000001'), { uid: 'rules-alice' });
  });
});

after(() => env.cleanup());

test('a student can read their own profile', async () => {
  const db = env.authenticatedContext('rules-alice').firestore();
  await assertSucceeds(getDoc(doc(db, 'users/rules-alice')));
});

test("a student cannot read someone else's profile", async () => {
  const db = env.authenticatedContext('rules-alice').firestore();
  await assertFails(getDoc(doc(db, 'users/rules-bob')));
});

test('signed-out users cannot read profiles', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users/rules-alice')));
});

test('a student cannot promote, edit, create or delete their profile directly', async () => {
  const db = env.authenticatedContext('rules-alice').firestore();
  await assertFails(updateDoc(doc(db, 'users/rules-alice'), { role: 'admin' }));
  await assertFails(updateDoc(doc(db, 'users/rules-alice'), { fullName: 'New Name' }));
  await assertFails(setDoc(doc(db, 'users/rules-new'), { role: 'student' }));
  await assertFails(deleteDoc(doc(db, 'users/rules-alice')));
});

test('student number locks and audit logs are closed to clients', async () => {
  const db = env.authenticatedContext('rules-alice').firestore();
  await assertFails(getDoc(doc(db, 'studentNumbers/2023-000001')));
  await assertFails(setDoc(doc(db, 'studentNumbers/2023-999999'), { uid: 'rules-alice' }));
  await assertFails(setDoc(doc(db, 'auditLogs/x'), { action: 'fake' }));
});

test('an admin claim in the token does not let a client read other profiles or write roles', async () => {
  const db = env.authenticatedContext('rules-mallory', { role: 'admin' }).firestore();
  await assertFails(getDoc(doc(db, 'users/rules-bob')));
  await assertFails(setDoc(doc(db, 'users/rules-mallory'), { role: 'admin', status: 'active' }));
});

test('inventory, settings and audit collections are closed to every client, administrators included', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/rules-admin'), { role: 'admin', status: 'active' });
    await setDoc(doc(db, 'resources/rules-probe-seat'), { type: 'silent-seat', status: 'active' });
    await setDoc(doc(db, 'settings/rules-probe'), { values: {} });
    await setDoc(doc(db, 'tickets/rules-probe-ticket'), { uid: 'rules-alice', status: 'issued', qrRef: 'x', credential: { ct: 'x' } });
    await setDoc(doc(db, 'ticketLocks/rules-alice'), { byService: {} });
    for (const name of ['reservations', 'reservationLocks', 'approvalWorkflows', 'approvalChallenges', 'approvalActions', 'emailOutbox']) {
      await setDoc(doc(db, `${name}/rules-probe`), { uid: 'rules-alice', status: 'pending', otp: { hash: 'x' } });
    }
  });
  const clients = [
    env.unauthenticatedContext(),
    env.authenticatedContext('rules-alice', { role: 'student' }),
    env.authenticatedContext('rules-admin', { role: 'admin' }), // real admin profile AND admin claim
  ];
  for (const ctx of clients) {
    const db = ctx.firestore();
    for (const path of ['resources/rules-probe-seat', 'settings/rules-probe', 'auditLogs/x', 'studentNumbers/2023-000001', 'tickets/rules-probe-ticket', 'ticketLocks/rules-alice',
      ...['reservations', 'reservationLocks', 'approvalWorkflows', 'approvalChallenges', 'approvalActions', 'emailOutbox'].map((c) => `${c}/rules-probe`)]) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { status: 'active' }));
      await assertFails(updateDoc(doc(db, path), { status: 'retired' }));
      await assertFails(deleteDoc(doc(db, path)));
    }
  }
});
