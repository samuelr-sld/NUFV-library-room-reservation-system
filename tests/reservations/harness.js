import { FieldValue } from 'firebase-admin/firestore';
import { setup } from '../server/helpers.js';
import { createMailer, createSinkAdapter } from '../../server/mail/adapters.js';
import { DEFAULT_LIMITS } from '../../server/rateLimit.js';
import { instantToLocal, localDatePlusDays } from '../../server/time.js';

// Fixture for the reservation tests. They run in their own emulator pass (npm run test:reservations, one file at a
// time) because they need exclusive control of the inventory, settings, workflow and outbox.
//
// The server clock is fake and starts at 2030-06-10 10:00 in Manila, so "tomorrow" and the booking window are stable.
// Email goes to an in-memory sink and is delivered only when a test calls deliver().
// Per-IP limits: the persistent counters keep their real defaults (reset() clears them between tests); the in-memory
// counter is lifted because the fake clock replays the same minute in every test. rateLimit.test.js uses strict ones.
export function harness({ limits = { ...DEFAULT_LIMITS, ip: { windowMs: 60_000, max: 1e9 } }, env } = {}) {
  const time = { now: new Date('2030-06-10T02:00:00Z') };
  const clock = () => new Date(time.now);
  const sink = createSinkAdapter();
  // Delivery that can be switched to fail, to prove recovery: `mail.failing = 'permanent' | 'transient' | false`.
  const mail = { failing: false };
  const adapter = {
    name: 'sink', messages: sink.messages,
    async send(message) {
      if (mail.failing) throw Object.assign(new Error('smtp: 550 mailbox unavailable'), { permanent: mail.failing === 'permanent' });
      return sink.send(message);
    },
  };
  let mailer;
  const t = setup({ clock, limits, env, mailer: ({ db }) => (mailer = createMailer({ db, adapter, clock, autoKick: false })) });
  const { db, call } = t;

  const advance = (minutes) => { time.now = new Date(time.now.getTime() + minutes * 60_000); };
  const day = (n) => localDatePlusDays(time.now, n); // local date n days from "now"
  const deliver = async () => { for (let i = 0; i < 3; i++) await mailer.drain(); }; // a few rounds: delivering can enqueue nothing new, but stay safe

  async function reset() {
    for (const name of ['resources', 'reservations', 'reservationLocks', 'approvalWorkflows', 'approvalChallenges', 'approvalActions', 'emailOutbox', 'auditLogs', 'rateLimits', 'settings', 'tickets', 'ticketLocks']) {
      await db.recursiveDelete(db.collection(name));
    }
    sink.messages.length = 0;
    time.now = new Date('2030-06-10T02:00:00Z');
  }
  const room = (id, extra = {}) => db.doc(`resources/${id}`).set({
    type: 'discussion-room', label: id.toUpperCase(), capacity: 4, status: 'active', allocation: { assigned: 0, occupied: 0, held: 0 },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'test', updatedBy: 'test', ...extra,
  });
  const setSettings = (values) => db.doc('settings/system').set({ values, version: 1, updatedBy: 'test' });
  const setChain = (...emails) => db.doc('approvalWorkflows/current').set({
    steps: emails.map((email, i) => ({ label: `Approver ${i + 1}`, email, enabled: true })), stepHours: 48, version: 1, updatedBy: 'test',
  });

  const student = (extra = {}) => t.actor({ role: 'student', emailVerified: true, ...extra });
  const body = (extra = {}) => ({ roomId: 'room-a', date: day(1), startTime: '09:00', endTime: '10:00', participants: [{ name: 'Maria Santos' }], purpose: 'Group study session', ...extra });
  const reserve = (who, extra) => call(who, 'POST', '/api/reservations', body(extra));

  // ---- external approver helpers (the real public API, driven from the emails the sink "sent") ----
  const mailsTo = (email, kind) => sink.messages.filter((m) => m.to === email && (!kind || m.kind === kind));
  const challengeOf = (email) => /#([A-Za-z0-9_-]{24})/.exec(mailsTo(email, 'approval-request').at(-1)?.text ?? '')?.[1];
  const codeFor = (email) => /code is (\d{6})/.exec(mailsTo(email, 'approval-code').at(-1)?.text ?? '')?.[1];
  const open = async (email) => { await deliver(); return challengeOf(email); };

  // Walks an approver through request code -> verify and returns { id, session }.
  async function signIn(email) {
    const id = await open(email);
    const sent = await call(null, 'POST', `/api/approvals/${id}/code`, {});
    if (sent.status !== 200) return { id, error: sent };
    await deliver();
    const verified = await call(null, 'POST', `/api/approvals/${id}/verify`, { code: codeFor(email) });
    return { id, session: verified.body?.session, verified };
  }
  async function decide(email, decision = 'approve', comment) {
    const { id, session, error } = await signIn(email);
    if (error) return error;
    return call(null, 'POST', `/api/approvals/${id}/decision`, { session, decision, comment });
  }
  const adminDecide = (admin, id, step, decision = 'approve', comment) => call(admin, 'POST', `/api/admin/reservations/${id}/decision`, { decision, step, comment });

  const resDoc = async (id) => (await db.doc(`reservations/${id}`).get()).data();
  const locksOf = async (id) => (await db.collection('reservationLocks').where('reservationId', '==', id).get()).docs;
  const audits = async (id) => (await db.collection('auditLogs').where('targetId', '==', id).get()).docs.map((d) => d.data());
  const trail = async (id) => (await db.collection('approvalActions').where('reservationId', '==', id).get()).docs.map((d) => d.data()).sort((a, b) => a.seq - b.seq);

  return {
    ...t, mail, time, clock, advance, day, deliver, reset, room, setSettings, setChain, student, body, reserve, sink, outbox: () => mailer,
    mailsTo, challengeOf, codeFor, signIn, decide, adminDecide, resDoc, locksOf, audits, trail, instantToLocal,
  };
}
