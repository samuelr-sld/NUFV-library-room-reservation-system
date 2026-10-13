import { spawn, spawnSync } from 'node:child_process';
import { createServer as probeServer } from 'node:net';
import { assertDemoEnvironment, DEMO_ACCOUNTS, DEMO_PASSWORD, scrubMailEnv, seedDemo } from '../demo.js';
import { loadConfig } from '../config.js';
import { initFirebase } from '../firebase.js';
import { createStaticHost } from '../staticHost.js';

// One command for the academic demonstration:  npm run demo
// Starts the Firebase Authentication and Firestore EMULATORS, the Express API (with the in-memory email sink), and the website
// on http://localhost:5000 under its real security headers; seeds demo accounts and inventory; and prints what to open.
// Nothing here can reach a real Firebase project: the environment is fixed below and checked again before anything starts.
const env = {
  ...process.env,
  NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', PORT: '3000',
};
delete env.GOOGLE_APPLICATION_CREDENTIALS;
scrubMailEnv(env); // the email sink only: nothing is ever sent, whatever the developer's shell holds
scrubMailEnv(process.env);
assertDemoEnvironment(env);
Object.assign(process.env, env);
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

// A demonstration still running from before is the usual reason for a failed start: say so, before starting anything.
const busy = [];
for (const port of [3000, 4000, 5000, 8080, 9099]) {
  if (!(await new Promise((resolve) => { const t = probeServer().once('error', () => resolve(false)).once('listening', () => t.close(() => resolve(true))); t.listen(port, '127.0.0.1'); }))) busy.push(port);
}
if (busy.length) {
  console.error(`Cannot start: port(s) ${busy.join(', ')} already in use. Another demonstration (or emulator) is probably still running: press Ctrl+C in its terminal, or close that terminal, and try again.`);
  process.exit(1);
}

const children = [];
const stop = () => {
  for (const c of children) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
};
process.on('SIGINT', () => { console.log('\nStopping the demonstration...'); stop(); process.exit(0); });
process.on('exit', stop);

const waitFor = async (url, what, ms = 90_000) => {
  for (let t = 0; t < ms; t += 500) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start within ${ms / 1000} s. Is Java 21 on PATH? (see README, "Local development on Windows")`);
};

console.log('Starting the Firebase emulators (Authentication, Firestore)...');
const emulators = spawn('npx firebase emulators:start --only auth,firestore --project demo-nufv', { env, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
children.push(emulators);
await waitFor('http://127.0.0.1:9099/', 'The Authentication emulator');
await waitFor('http://127.0.0.1:8080/', 'The Firestore emulator');

console.log('Starting the API on http://localhost:3000 ...');
const api = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
children.push(api);
await waitFor('http://localhost:3000/api/health', 'The API');

const site = createStaticHost().listen(5000, '127.0.0.1');
await new Promise((resolve, reject) => { site.once('listening', resolve); site.once('error', reject); });

const config = loadConfig(process.env);
const made = await seedDemo({ ...initFirebase(config), config });

console.log(`
=====================================================================
 NUFV Library Services: demonstration environment is running
=====================================================================
  Website            http://localhost:5000/login%20page/login.html
  Email sink viewer  http://localhost:3000/api/dev/mail/view   (what approvers and students would receive)
  Emulator console   http://localhost:4000

  Seeded: ${made.accounts} accounts, ${made.resources} resources, approval chain (Dean, then Adviser).
  Password for every demo account: ${DEMO_PASSWORD}
${DEMO_ACCOUNTS.map((a) => `    ${(a.role ?? 'no profile').padEnd(10)} ${a.email.padEnd(34)} ${a.name}`).join('\n')}
    approver (no account)  dean@demo.nufv.test, adviser@demo.nufv.test  (they act from the links in the email sink)

  Everything runs locally against emulators; no real Firebase project and no real email.
  Press Ctrl+C to stop. Starting again gives a clean slate.
`);
