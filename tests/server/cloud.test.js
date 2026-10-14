import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../server/config.js';
import { assertDemoEnvironment } from '../../server/demo.js';
import { PROD_CONFIG } from '../../public/js/firebase-config.js';

// Cloud-connected development (NODE_ENV=cloud-dev) and its isolation from the emulator demo. Nothing here contacts Firebase or
// a mail server: configuration is checked as data, and the CLI cases are refused before any connection is made.

const dir = mkdtempSync(join(tmpdir(), 'nufv-cloud-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const keyFile = (name, body) => { const p = join(dir, name); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p; };
const KEY = keyFile('ok.json', { type: 'service_account', project_id: PROD_CONFIG.projectId });

const CLOUD = {
  NODE_ENV: 'cloud-dev', FIREBASE_PROJECT_ID: PROD_CONFIG.projectId, GOOGLE_APPLICATION_CREDENTIALS: KEY,
  VOUCHER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), APPROVAL_SECRET: Buffer.alloc(32, 2).toString('base64'),
};
const bad = (env, re) => assert.throws(() => loadConfig(env), re, JSON.stringify(Object.keys(env)));

test('cloud-dev: the real project, local-only API, own port and origin, application email in the sink', () => {
  const c = loadConfig(CLOUD);
  assert.deepEqual([c.cloud, c.production, c.projectId, c.port, c.host], [true, false, PROD_CONFIG.projectId, 3001, '127.0.0.1']);
  assert.deepEqual(c.corsOrigins, ['http://localhost:5001']);
  assert.equal(c.appBaseUrl, 'http://localhost:5001');
  assert.equal(c.mail.transport, 'sink');
  assert.equal(loadConfig({ ...CLOUD, PORT: '3055' }).port, 3055);
});

test('cloud-dev listens on the network only with LISTEN_LAN=yes, and only in cloud-dev', () => {
  assert.equal(loadConfig({ ...CLOUD, LISTEN_LAN: 'yes' }).host, '0.0.0.0');
  for (const v of ['', 'no', 'true', 'YES']) bad({ ...CLOUD, LISTEN_LAN: v }, /LISTEN_LAN must be/);
  bad({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', LISTEN_LAN: 'yes' }, /only for cloud-dev/);
});

test('the emulator modes are not cloud and still need the emulators', () => {
  const dev = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  assert.deepEqual([loadConfig(dev).cloud, loadConfig(dev).host], [false, undefined]);
  bad({ ...CLOUD, NODE_ENV: 'development' }, /demo-\*/); // a cloud-dev file run as development is refused, not silently emulated
});

test('cloud-dev never mixes with the emulators or a demo project', () => {
  for (const k of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) bad({ ...CLOUD, [k]: '127.0.0.1:9099' }, /emulator hosts/);
  bad({ ...CLOUD, FIREBASE_PROJECT_ID: 'demo-nufv' }, /demo project/);
});

test('project id mismatch is refused: server vs. website config, and between the variables that name it', () => {
  bad({ ...CLOUD, FIREBASE_PROJECT_ID: 'some-other-project' }, /differs from the project the website is configured for/);
  bad({ ...CLOUD, NODE_ENV: 'production', GOOGLE_APPLICATION_CREDENTIALS: undefined, FIREBASE_PROJECT_ID: 'some-other-project', CORS_ORIGINS: 'https://x.web.app', APP_BASE_URL: 'https://x.web.app', MAIL_TRANSPORT: 'smtp' }, /differs from the project/);
  bad({ ...CLOUD, GCLOUD_PROJECT: 'some-other-project' }, /disagree/);
  bad({ ...CLOUD, GOOGLE_CLOUD_PROJECT: 'some-other-project' }, /disagree/);
  bad({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: keyFile('other.json', { type: 'service_account', project_id: 'some-other-project' }) }, /belongs to project "some-other-project"/);
});

test('missing or unusable credentials are refused without echoing the file', () => {
  bad({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: undefined }, /requires GOOGLE_APPLICATION_CREDENTIALS/);
  bad({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'missing.json') }, /readable JSON key file/);
  bad({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: keyFile('junk.json', 'not json: s3cr3t-token') }, /readable JSON key file/);
  bad({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: keyFile('user.json', { type: 'authorized_user', project_id: PROD_CONFIG.projectId }) }, /service-account/);
  assert.throws(() => loadConfig({ ...CLOUD, GOOGLE_APPLICATION_CREDENTIALS: keyFile('junk2.json', 's3cr3t-token') }), (e) => !/s3cr3t/.test(e.message));
});

test('cloud-dev needs the keys that keep real data readable after a restart', () => {
  bad({ ...CLOUD, VOUCHER_ENCRYPTION_KEY: undefined }, /VOUCHER_ENCRYPTION_KEY is required/);
  bad({ ...CLOUD, APPROVAL_SECRET: undefined }, /APPROVAL_SECRET is required/);
});

test('live Gmail stays gated in cloud-dev: credentials alone send nothing, and every setting plus the approval is needed', () => {
  const smtp = { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'lib@example.com', SMTP_PASS: 'x', MAIL_FROM: 'lib@example.com' };
  assert.equal(loadConfig({ ...CLOUD, ...smtp }).mail.transport, 'sink');
  bad({ ...CLOUD, ...smtp, MAIL_TRANSPORT: 'smtp' }, /MAIL_LIVE_APPROVED=yes/);
  bad({ ...CLOUD, ...smtp, MAIL_TRANSPORT: 'smtp', MAIL_LIVE_APPROVED: 'true' }, /MAIL_LIVE_APPROVED=yes/);
  bad({ ...CLOUD, MAIL_TRANSPORT: 'smtp', MAIL_LIVE_APPROVED: 'yes' }, /SMTP_HOST/);
  assert.equal(loadConfig({ ...CLOUD, ...smtp, MAIL_TRANSPORT: 'smtp', MAIL_LIVE_APPROVED: 'yes' }).mail.transport, 'smtp');
});

test('the demonstration code refuses cloud-dev and any real project', () => {
  const ok = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
  assert.doesNotThrow(() => assertDemoEnvironment(ok));
  for (const change of [{ NODE_ENV: 'cloud-dev' }, { NODE_ENV: undefined }, { FIREBASE_PROJECT_ID: PROD_CONFIG.projectId }]) assert.throws(() => assertDemoEnvironment({ ...ok, ...change }), /Refusing/);
  assert.throws(() => assertDemoEnvironment({ NODE_ENV: 'cloud-dev', ...CLOUD }), /Refusing/);
});

test('the demo seed and reset commands, and a bootstrap without the typed project, are refused before any connection', () => {
  const run = (script, args, env = CLOUD) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000 });
  for (const args of [[], ['--reset']]) {
    const r = run('server/scripts/seed-demo.js', args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Refusing to run the demonstration seed against a real Firebase project/);
    assert.doesNotMatch(r.stdout, /erased|Seeded/);
  }
  const noConfirm = run('server/scripts/bootstrap-admin.js', ['--email', 'a@example.com', '--name', 'Admin']);
  assert.equal(noConfirm.status, 1);
  assert.match(noConfirm.stderr, new RegExp(`--confirm-project ${PROD_CONFIG.projectId}`));
  const wrong = run('server/scripts/bootstrap-admin.js', ['--email', 'a@example.com', '--name', 'Admin', '--confirm-project', 'demo-nufv']);
  assert.match(wrong.stderr, /--confirm-project/);
  const check = run('server/scripts/cloud-check.js', []);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Nothing was contacted/);
  assert.doesNotMatch(check.stdout, /AAAA|private_key/); // no secret reaches the output
});

test('npm scripts: only the cloud commands load .env.cloud, and no demo, seed, reset or test command can', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  for (const [name, cmd] of Object.entries(scripts)) {
    const cloud = /\.env\.cloud/.test(cmd) || name.includes('cloud');
    if (/^(demo|test|emulators)/.test(name)) assert.equal(cloud, false, name);
    if (/^demo/.test(name)) assert.doesNotMatch(cmd, /server:cloud|cloud/, name);
  }
  assert.match(scripts['server:cloud'], /--env-file=server\/\.env\.cloud server\/index\.js/);
  assert.doesNotMatch(scripts['server:cloud'], /env\.cloud\.mail/); // Gmail needs its own, deliberately chosen command
  assert.match(scripts['server:cloud:mail'], /\.env\.cloud\.mail/);
  assert.match(readFileSync('server/scripts/demo.js', 'utf8'), /NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv'/);
});

// ---------------------------------------------------------------- read-only connectivity check, polling

import { verifyConnection } from '../../server/cloudVerify.js';

const fakeFirebase = ({ project = PROD_CONFIG.projectId, authProject = project, fail = {}, admin = false } = {}) => {
  const calls = [];
  const boom = (k) => { if (fail[k]) throw Object.assign(new Error('secret-detail ' + k), { code: fail[k] }); };
  return {
    calls,
    auth: { app: { options: { projectId: authProject } }, listUsers: async () => { calls.push('listUsers'); boom('auth'); return { users: [{ email: 'x@y.z' }] }; } },
    db: {
      projectId: project,
      listCollections: async () => { calls.push('listCollections'); boom('collections'); return [{ id: 'users' }, { id: 'resources' }]; },
      collection: (n) => ({ where: (...w) => ({ limit: () => ({ get: async () => { calls.push(`query ${n} ${w.join(' ')}`); boom('query'); return { empty: !admin }; } }) }) }),
    },
  };
};
const cfg = { projectId: PROD_CONFIG.projectId };

test('cloud:verify reads only, returns names and booleans (never an email), and the project ids must all agree first', async () => {
  const f = fakeFirebase({ admin: true });
  const r = await verifyConnection({ auth: f.auth, db: f.db, config: cfg });
  assert.deepEqual(r, { projectId: PROD_CONFIG.projectId, authHasUsers: true, collections: ['resources', 'users'], adminExists: true });
  assert.deepEqual(f.calls, ['listUsers', 'listCollections', 'query users role == admin']);
  assert.doesNotMatch(JSON.stringify(r), /x@y\.z/);

  for (const bad of [fakeFirebase({ project: 'other-project', authProject: PROD_CONFIG.projectId }), fakeFirebase({ authProject: 'other-project' })]) {
    await assert.rejects(verifyConnection({ auth: bad.auth, db: bad.db, config: cfg }), /do not agree/);
    assert.deepEqual(bad.calls, [], 'nothing was contacted');
  }
  await assert.rejects(verifyConnection({ auth: fakeFirebase().auth, db: fakeFirebase().db, config: { projectId: 'other-project' } }), /do not agree/);
});

test('cloud:verify names the failing service without leaking error text', async () => {
  for (const [k, what] of [['auth', /Authentication/], ['collections', /listCollections/], ['query', /administrator lookup/]]) {
    const f = fakeFirebase({ fail: { [k]: 'permission-denied' } });
    await assert.rejects(verifyConnection({ auth: f.auth, db: f.db, config: cfg }), (e) => what.test(e.message) && /permission-denied/.test(e.message) && !/secret-detail/.test(e.message), k);
  }
});

test('cloud:verify refuses to connect without the typed project or outside a real-project environment', () => {
  const run = (args, env) => spawnSync(process.execPath, ['server/scripts/cloud-verify.js', ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000 });
  for (const args of [[], ['--confirm-project', 'demo-nufv'], ['--confirm-project', 'other-project']]) {
    const r = run(args, CLOUD);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`--confirm-project ${PROD_CONFIG.projectId}`));
    assert.doesNotMatch(r.stdout, /Connecting/);
  }
  const dev = run(['--confirm-project', 'demo-nufv'], { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(dev.status, 1);
  assert.match(dev.stderr, /for NODE_ENV=cloud-dev/);
  assert.doesNotMatch(dev.stdout, /Connecting/);
});

test('polling: gentler in cloud-dev, unchanged elsewhere, overridable within bounds', () => {
  const dev = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  assert.deepEqual([loadConfig(dev).outboxPollMs, loadConfig(dev).sweepPollMs], [10_000, 60_000]);
  assert.deepEqual([loadConfig(CLOUD).outboxPollMs, loadConfig(CLOUD).sweepPollMs], [60_000, 300_000]);
  const c = loadConfig({ ...CLOUD, OUTBOX_POLL_SECONDS: '5', SWEEP_POLL_SECONDS: '3600' });
  assert.deepEqual([c.outboxPollMs, c.sweepPollMs], [5_000, 3_600_000]);
  for (const [k, v] of [['OUTBOX_POLL_SECONDS', '4'], ['OUTBOX_POLL_SECONDS', '0'], ['OUTBOX_POLL_SECONDS', '3601'], ['SWEEP_POLL_SECONDS', '29'], ['SWEEP_POLL_SECONDS', 'soon'], ['SWEEP_POLL_SECONDS', '60.5'], ['SWEEP_POLL_SECONDS', '']]) {
    bad({ ...CLOUD, [k]: v }, new RegExp(`${k} must be a whole number`));
  }
  const index = readFileSync('server/index.js', 'utf8'); // the timers must really use the setting
  assert.match(index, /every\(config\.sweepPollMs, 'expiry sweep'/);
  assert.match(index, /every\(config\.sweepPollMs, 'reservation sweep'/);
  assert.match(index, /setInterval\(\(\) => mailer\.kick\(\), config\.outboxPollMs\)/);
});
