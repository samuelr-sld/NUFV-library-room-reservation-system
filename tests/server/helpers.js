import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { loadConfig } from '../../server/config.js';
import { initFirebase } from '../../server/firebase.js';
import { createApp } from '../../server/app.js';

// Shared by emulator-backed API tests: a real app on an ephemeral port, plus real ID tokens from the Auth emulator.
export function setup({ clock, mailer, limits, env } = {}) {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', ...env });
  const { auth, db } = initFirebase(config);
  const mail = typeof mailer === 'function' ? mailer({ db }) : mailer; // a factory, because the mailer needs the db created here
  const clients = [];
  let server;
  let base;

  // `over` replaces parts of the configuration for this run of the server (a "restart" with different keys, for example);
  // `lim` replaces the per-IP limits, which also resets the in-memory counters like a new process would.
  const start = async (over = {}, lim = limits) => {
    server = createApp({ config: { ...config, ...over }, auth, db, ...(clock ? { clock } : {}), ...(lim ? { limits: lim } : {}), ...(mail ? { mailer: mail } : {}) }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const halt = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  const stop = async () => {
    await halt();
    await Promise.all(clients.map(deleteApp));
  };
  // A new process on the same database: everything held in memory is gone, everything stored stays.
  const restart = async (over, lim) => { await halt(); await start(over, lim); };

  // role/status become the Firestore profile; role null means "signed-in account with no profile at all".
  async function actor({ role = 'student', status = 'active', emailVerified = false, claim } = {}) {
    const email = `${randomUUID()}@example.com`;
    const record = await auth.createUser({ email, password: 'secret123', emailVerified });
    if (role) {
      await db.doc(`users/${record.uid}`).set({
        email, fullName: 'Test Person', studentNumber: role === 'student' ? '2023-000000' : null, role, status,
      });
    }
    if (claim) await auth.setCustomUserClaims(record.uid, { role: claim });

    const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-nufv' }, randomUUID());
    clients.push(app);
    const clientAuth = getAuth(app);
    connectAuthEmulator(clientAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    const { user } = await signInWithEmailAndPassword(clientAuth, email, 'secret123');
    return { uid: record.uid, email, user, token: (fresh = false) => user.getIdToken(fresh) };
  }

  async function call(who, method, path, body, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (who) headers.Authorization = `Bearer ${typeof who === 'string' ? who : await who.token()}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body: json, code: json?.error?.code, headers: res.headers };
  }

  const audits = async (targetId, action) => {
    let q = db.collection('auditLogs').where('targetId', '==', targetId);
    if (action) q = q.where('action', '==', action);
    return (await q.get()).docs.map((d) => d.data());
  };

  return { config, auth, db, start, stop, restart, actor, call, audits, id: (prefix) => `${prefix}-${randomUUID().slice(0, 8)}` };
}
