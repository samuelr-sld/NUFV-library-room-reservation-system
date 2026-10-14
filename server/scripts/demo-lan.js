import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import { loadConfig } from '../config.js';

// Usage: npm run demo:lan              starts serve:cloud:lan (website :5001) and server:cloud:mail:lan (API :3001) together
//        npm run demo:lan -- --check   validates the configuration and the ports only, starts nothing
// Same-Wi-Fi approver test, docs/cloud-setup.md section 7. Ctrl+C stops both.

const ENV_FILES = ['server/.env.cloud', 'server/.env.cloud.mail', 'server/.env.cloud.lan'];
const SERVICES = [
  { label: 'frontend', script: 'serve:cloud:lan', port: 5001 },
  { label: 'backend ', script: 'server:cloud:mail:lan', port: 3001 },
];
const quit = (msg) => { console.error(`demo:lan: ${msg}`); process.exit(1); };

// 1. The same three files the backend loads, merged the way node --env-file merges them (later files win).
const missing = ENV_FILES.filter((f) => !existsSync(f));
if (missing.length) quit(`missing ${missing.join(', ')}. See docs/cloud-setup.md section 7 (server/.env.cloud.example lists the LAN lines).`);
const env = Object.assign({}, ...ENV_FILES.map((f) => parseEnv(readFileSync(f, 'utf8'))));
if (env.LISTEN_LAN !== 'yes') quit('server/.env.cloud.lan must contain LISTEN_LAN=yes.');
let config;
try { config = loadConfig(env); } catch (err) { quit(err.message); } // the server's own checks; names settings, never values
if (config.mode !== 'cloud-dev') quit('server/.env.cloud must set NODE_ENV=cloud-dev.');
const base = new URL(config.appBaseUrl);
if (base.hostname === 'localhost' || base.port !== '5001') quit(`APP_BASE_URL must be http://<this laptop's LAN IP>:5001 (got ${config.appBaseUrl}); emailed links would not open on phones.`);
if (!config.corsOrigins.includes(config.appBaseUrl)) quit('CORS_ORIGINS must include APP_BASE_URL, or the approval page cannot reach the API.');
if (config.mail.transport !== 'smtp') quit('server/.env.cloud.mail must configure Gmail SMTP (MAIL_TRANSPORT=smtp).');

// 2. Something already answering on a port means the services (or something else) are running: never start a duplicate.
const inUse = (port) => new Promise((resolve) => {
  const s = connect({ port, host: '127.0.0.1' });
  s.setTimeout(1000);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});
const busy = [];
for (const s of SERVICES) if (await inUse(s.port)) busy.push(s.port);
if (busy.length) quit(`port ${busy.join(' and ')} already in use. Stop the running ${busy.length > 1 ? 'services' : 'service'} first (or close the other terminal).`);

console.log(`demo:lan: configuration OK. Approval links: ${config.appBaseUrl}/approve/approve.html#… ; students and admin: http://localhost:5001`);
if (process.argv.includes('--check')) process.exit(0);

// 3. Run each package.json script's node command directly (no npm or shell layer, so there is no grandchild to orphan on Windows).
// shortcut: splits the script on spaces, fine while its arguments contain none; use a real parser if one ever does.
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const children = SERVICES.map(({ label, script }) => {
  const [cmd, ...args] = scripts[script].split(' ');
  if (cmd !== 'node') quit(`script "${script}" no longer starts with node; update ${import.meta.filename}.`);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', (line) => console.log(`[${label}] ${line}`));
  child.label = label;
  return child;
});

let stopping = false;
const alive = () => children.filter((c) => c.exitCode === null && c.signalCode === null);
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  // Ctrl+C already reached the children through the shared console; this covers the other cases (one service died, SIGTERM).
  for (const c of alive()) c.kill('SIGINT');
  setTimeout(() => { for (const c of alive()) c.kill('SIGKILL'); }, 12_000).unref(); // the API drains for at most 10 s
}
for (const c of children) {
  c.on('exit', (code, signal) => {
    if (!stopping) { console.error(`demo:lan: ${c.label.trim()} stopped (${signal ?? `exit ${code}`}); stopping the other service.`); stop(1); }
    if (!alive().length) process.exit(process.exitCode ?? 0);
  });
}
process.on('SIGINT', () => { console.log('demo:lan: stopping both services…'); stop(0); });
process.on('SIGTERM', () => stop(0));
