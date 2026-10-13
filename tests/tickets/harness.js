import { FieldValue } from 'firebase-admin/firestore';
import { setup } from '../server/helpers.js';

// Shared fixture for the stub tests. They run in their own emulator pass (npm run test:tickets, one file at a time)
// because they need exclusive control of the inventory and the settings document.
export function harness() {
  const time = { now: new Date() };
  const t = setup({ clock: () => new Date(time.now) });
  const { db, call } = t;

  const advance = (minutes) => { time.now = new Date(time.now.getTime() + minutes * 60_000); };

  async function reset() {
    for (const name of ['resources', 'tickets', 'ticketLocks', 'auditLogs', 'settings']) await db.recursiveDelete(db.collection(name));
    time.now = new Date();
  }
  const seed = (id, type, extra = {}) => db.doc(`resources/${id}`).set({
    type, label: id.toUpperCase(), capacity: type === 'discussion-room' ? 4 : null, status: 'active',
    allocation: { assigned: 0, occupied: 0, held: 0 },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'test', updatedBy: 'test', ...extra,
  });
  const seats = (...ids) => Promise.all(ids.map((id) => seed(id, 'silent-seat')));
  const pcs = (...ids) => Promise.all(ids.map((id) => seed(id, 'computer-station')));
  const setSettings = (values) => db.doc('settings/system').set({ values, version: 1, updatedBy: 'test' });

  const student = (extra = {}) => t.actor({ role: 'student', emailVerified: true, ...extra });
  const issue = (who, service, body = {}) => call(who, 'POST', '/api/tickets', { service, ...body });
  const resource = async (id) => (await db.doc(`resources/${id}`).get()).data();
  const ticketDoc = async (id) => (await db.doc(`tickets/${id}`).get()).data();
  const lock = async (uid) => (await db.doc(`ticketLocks/${uid}`).get()).data()?.byService ?? {};
  const allAudits = async () => (await db.collection('auditLogs').get()).docs.map((d) => d.data());

  return { ...t, time, advance, reset, seed, seats, pcs, setSettings, student, issue, resource, ticketDoc, lock, allAudits };
}
