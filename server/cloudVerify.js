// Read-only proof that this machine reaches the intended REAL project with working Admin credentials, run before the full
// application starts (server/scripts/cloud-verify.js). It lists one Auth user, lists collection names and asks whether an
// administrator exists. It writes nothing and returns counts and names only: no email, uid or document content.
export async function verifyConnection({ auth, db, config }) {
  const seen = { config: config.projectId, authApp: auth.app?.options?.projectId, firestore: db.projectId };
  if (new Set(Object.values(seen)).size !== 1) {
    throw new Error(`the project ids do not agree (${Object.entries(seen).map(([k, v]) => `${k}: ${v}`).join(', ')}); nothing was contacted.`);
  }
  const step = async (what, fn) => {
    try { return await fn(); } catch (err) { throw new Error(`${what} failed: ${String(err?.code ?? err?.message ?? err).slice(0, 160)}`); }
  };
  const users = await step('Authentication (listUsers)', () => auth.listUsers(1));
  const collections = await step('Firestore (listCollections)', () => db.listCollections());
  const admins = await step('Firestore (administrator lookup)', () => db.collection('users').where('role', '==', 'admin').limit(1).get());
  return { projectId: config.projectId, authHasUsers: users.users.length > 0, collections: collections.map((c) => c.id).sort(), adminExists: !admins.empty };
}
