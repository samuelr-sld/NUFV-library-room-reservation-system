import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../server/config.js';

const DEV = {
  NODE_ENV: 'development',
  FIREBASE_PROJECT_ID: 'demo-nufv',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};
const PROD = {
  NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'lrc-room-reservation', CORS_ORIGINS: 'https://lrc-room-reservation.web.app',
  VOUCHER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  APPROVAL_SECRET: Buffer.alloc(32, 2).toString('base64'),
  APP_BASE_URL: 'https://lrc-room-reservation.web.app',
  MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.edu', SMTP_PORT: '587', SMTP_USER: 'mailer', SMTP_PASS: 'x', MAIL_FROM: 'library@example.edu', MAIL_LIVE_APPROVED: 'yes',
};
const bad = (env, re) => assert.throws(() => loadConfig(env), re);

test('development: demo project, emulators, default port and CORS allowlist', () => {
  const c = loadConfig(DEV);
  assert.equal(c.production, false);
  assert.equal(c.port, 3000);
  assert.deepEqual(c.corsOrigins, ['http://localhost:5000', 'http://127.0.0.1:5000']);
});

test('production: explicit project, https origins, no emulators', () => {
  const c = loadConfig({ ...PROD, PORT: '8080' });
  assert.equal(c.production, true);
  assert.equal(c.port, 8080);
  assert.deepEqual(c.corsOrigins, ['https://lrc-room-reservation.web.app']);
});

test('NODE_ENV must be set to a known mode', () => {
  bad({ ...DEV, NODE_ENV: undefined }, /NODE_ENV/);
  bad({ ...DEV, NODE_ENV: 'staging' }, /NODE_ENV/);
});

test('a missing or conflicting project id is refused', () => {
  bad({ ...DEV, FIREBASE_PROJECT_ID: undefined }, /FIREBASE_PROJECT_ID is required/);
  bad({ ...DEV, GCLOUD_PROJECT: 'demo-other' }, /disagree/);
  assert.equal(loadConfig({ ...DEV, FIREBASE_PROJECT_ID: undefined, GCLOUD_PROJECT: 'demo-nufv' }).projectId, 'demo-nufv');
});

test('non-production never reaches real Firebase: needs demo project, emulator hosts and no credentials', () => {
  bad({ ...DEV, FIREBASE_PROJECT_ID: 'lrc-room-reservation' }, /demo-\*/);
  bad({ ...DEV, FIREBASE_AUTH_EMULATOR_HOST: undefined }, /EMULATOR_HOST/);
  bad({ ...DEV, FIRESTORE_EMULATOR_HOST: undefined }, /EMULATOR_HOST/);
  bad({ ...DEV, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }, /loopback/);
  bad({ ...DEV, GOOGLE_APPLICATION_CREDENTIALS: 'key.json' }, /credentials/);
});

test('production refuses emulator hosts, demo projects and missing or insecure CORS origins', () => {
  bad({ ...PROD, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, /emulator hosts/);
  bad({ ...PROD, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, /emulator hosts/);
  bad({ ...PROD, FIREBASE_PROJECT_ID: 'demo-nufv' }, /demo project/);
  bad({ ...PROD, CORS_ORIGINS: undefined }, /CORS_ORIGINS is required/);
  bad({ ...PROD, CORS_ORIGINS: 'http://example.com' }, /https/);
});

test('malformed CORS origins and ports are refused', () => {
  for (const o of ['*', 'localhost', 'https://a.com/', 'https://a.com/path']) bad({ ...DEV, CORS_ORIGINS: o }, /CORS origin/);
  for (const p of ['0', '70000', 'abc', '3000.5', '']) bad({ ...DEV, PORT: p }, /PORT/);
});
