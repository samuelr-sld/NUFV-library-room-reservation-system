// Validates the environment once at startup. Anything ambiguous throws, so the server never starts half-configured
// and never falls back to production Firebase services by accident.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CLOUD_DEV, PROD_CONFIG } from '../public/js/firebase-config.js';

// development/test: emulators only. cloud-dev: the REAL Firebase project, driven from this machine over http://localhost.
// production: the real project behind https. Both of the last two count as "cloud" (`config.cloud`).
const MODES = ['development', 'test', 'cloud-dev', 'production'];
const EMULATOR_HOST = /^(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}$/;
const EMULATOR_VARS = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB'];
const DEV_ORIGINS = ['http://localhost:5000', 'http://127.0.0.1:5000'];
const CLOUD_DEV_SITE = `http://localhost:${CLOUD_DEV.sitePort}`; // not 127.0.0.1: only localhost is an authorized Auth domain by default

function fail(msg) {
  throw new Error(`Invalid server configuration: ${msg}`);
}

// forServer=false is for operator scripts, which serve no HTTP and so need no port or CORS settings.
// Email is never sent for real unless an operator opts in on purpose: the default outside production is an in-memory
// sink, production has no default, and SMTP needs every setting plus MAIL_LIVE_APPROVED=yes.
export function mailConfig(env, production) {
  const transport = env.MAIL_TRANSPORT ?? (production ? fail('MAIL_TRANSPORT is required in production (smtp).') : 'sink');
  if (!['sink', 'smtp'].includes(transport)) fail('MAIL_TRANSPORT must be "sink" or "smtp".');
  if (transport === 'sink') {
    if (production) fail('the email sink cannot be used in production.');
    return { transport };
  }
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((k) => !env[k]);
  if (missing.length) fail(`smtp transport needs ${missing.join(', ')}.`);
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('SMTP_PORT must be an integer from 1 to 65535.');
  if (env.MAIL_LIVE_APPROVED !== 'yes') fail('live email delivery needs MAIL_LIVE_APPROVED=yes (an explicit operator approval).');
  return { transport, smtp: { host: env.SMTP_HOST, port, secure: port === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM } };
}

// A cloud-dev operator must name a service-account key whose project is the one being configured. Reads the file but never
// repeats its contents.
function checkKeyFile(path, projectId) {
  if (!path) fail('cloud-dev requires GOOGLE_APPLICATION_CREDENTIALS (path to the service-account key file, kept outside the repository).');
  let key;
  try { key = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('GOOGLE_APPLICATION_CREDENTIALS must point to a readable JSON key file.'); }
  if (key?.type !== 'service_account') fail('GOOGLE_APPLICATION_CREDENTIALS is not a service-account key file.');
  if (key.project_id !== projectId) fail(`the service-account key belongs to project "${key.project_id}", not "${projectId}".`);
}

export function loadConfig(env, { forServer = true } = {}) {
  const mode = env.NODE_ENV;
  if (!MODES.includes(mode)) fail(`NODE_ENV must be one of ${MODES.join(', ')} (got "${mode ?? ''}").`);
  const production = mode === 'production';
  const cloud = production || mode === 'cloud-dev';
  const cloudDev = mode === 'cloud-dev';

  const ids = [env.FIREBASE_PROJECT_ID, env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].filter(Boolean);
  if (new Set(ids).size > 1) fail('FIREBASE_PROJECT_ID, GCLOUD_PROJECT and GOOGLE_CLOUD_PROJECT disagree.');
  const projectId = ids[0];
  if (!projectId) fail('FIREBASE_PROJECT_ID is required.');

  if (cloud) {
    const leaked = EMULATOR_VARS.filter((k) => env[k]);
    if (leaked.length) fail(`emulator hosts must not be set in ${mode} (${leaked.join(', ')}).`);
    if (projectId.startsWith('demo-')) fail(`a demo project cannot be used in ${mode}.`);
    // The website's Firebase config and the API must name one project, or tokens from one are refused by (or worse, accepted by) the other.
    if (projectId !== PROD_CONFIG.projectId) fail(`FIREBASE_PROJECT_ID "${projectId}" differs from the project the website is configured for ("${PROD_CONFIG.projectId}", public/js/firebase-config.js).`);
    if (cloudDev) checkKeyFile(env.GOOGLE_APPLICATION_CREDENTIALS, projectId);
  } else {
    const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
    const firestoreHost = env.FIRESTORE_EMULATOR_HOST;
    if (!projectId.startsWith('demo-')) fail(`${mode} requires a demo-* project (got "${projectId}").`);
    if (!authHost || !firestoreHost) fail(`${mode} requires FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST.`);
    if (!EMULATOR_HOST.test(authHost) || !EMULATOR_HOST.test(firestoreHost)) fail('emulator hosts must be loopback host:port.');
    if (env.GOOGLE_APPLICATION_CREDENTIALS) fail(`credentials must not be set outside production.`);
  }

  if (!forServer) return { mode, production, cloud, projectId };

  const port = env.PORT === undefined ? (cloudDev ? Number(CLOUD_DEV.apiPort) : 3000) : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be an integer from 1 to 65535.');

  let corsOrigins;
  if (env.CORS_ORIGINS) {
    corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  } else if (production) {
    fail('CORS_ORIGINS is required in production.');
  } else {
    corsOrigins = cloudDev ? [CLOUD_DEV_SITE] : DEV_ORIGINS;
  }
  for (const o of corsOrigins) {
    let url;
    try { url = new URL(o); } catch { fail(`CORS origin "${o}" is not a valid origin.`); }
    if (url.origin !== o) fail(`CORS origin "${o}" must be a bare origin (no path or trailing slash).`);
    if (production && url.protocol !== 'https:') fail(`CORS origin "${o}" must be https in production.`);
  }

  // 32 random bytes, base64 (openssl rand -base64 32). Encrypts demo Wi-Fi voucher passwords at rest.
  let voucherKey;
  if (env.VOUCHER_ENCRYPTION_KEY) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(env.VOUCHER_ENCRYPTION_KEY)) fail('VOUCHER_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.');
    voucherKey = Buffer.from(env.VOUCHER_ENCRYPTION_KEY, 'base64');
  } else if (cloud) {
    fail(`VOUCHER_ENCRYPTION_KEY is required in ${mode} (data outlives restarts there).`);
  } else {
    voucherKey = randomBytes(32); // ephemeral: vouchers issued before a restart can no longer be decrypted outside production
  }

  // HMAC key for approver one-time codes and sessions (never stored in the clear; a database leak alone cannot forge them).
  let approvalKey;
  if (env.APPROVAL_SECRET) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(env.APPROVAL_SECRET)) fail('APPROVAL_SECRET must be 32 random bytes, base64-encoded.');
    approvalKey = Buffer.from(env.APPROVAL_SECRET, 'base64');
  } else if (cloud) {
    fail(`APPROVAL_SECRET is required in ${mode} (data outlives restarts there).`);
  } else {
    approvalKey = randomBytes(32); // ephemeral: outstanding codes die with a restart; approvers simply ask for a new one
  }

  // Where approval links point. A bare origin; https in production.
  const appBaseUrl = env.APP_BASE_URL ?? (production ? fail('APP_BASE_URL is required in production.') : cloudDev ? CLOUD_DEV_SITE : 'http://localhost:5000');
  let base;
  try { base = new URL(appBaseUrl); } catch { fail('APP_BASE_URL is not a valid URL.'); }
  if (base.origin !== appBaseUrl) fail('APP_BASE_URL must be a bare origin (no path or trailing slash).');
  if (production && base.protocol !== 'https:') fail('APP_BASE_URL must be https in production.');

  // How many reverse proxies sit in front of Express (0 = none: the socket address is the client). Per-IP limits read the
  // client address from X-Forwarded-For only when this is set, so it must match the real hosting setup.
  const trustProxy = env.TRUST_PROXY_HOPS === undefined ? 0 : Number(env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 3) fail('TRUST_PROXY_HOPS must be a whole number from 0 to 3.');

  // Background polling costs Firestore reads (every pass is at least one read per query, even when nothing is due), which is the
  // Spark daily quota in cloud-dev. Neither timer is needed for correctness (see server/index.js); they bound how late a retry or
  // a sweep-driven email can be. Defaults: 10 s / 60 s locally, 60 s / 300 s in cloud-dev (about 3,500 reads a day).
  const pollMs = (key, local, cloudDefault, min, max) => {
    if (env[key] === undefined) return (cloudDev ? cloudDefault : local) * 1000;
    const n = Number(env[key]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${key} must be a whole number of seconds from ${min} to ${max}.`);
    return n * 1000;
  };
  const outboxPollMs = pollMs('OUTBOX_POLL_SECONDS', 10, 60, 5, 3600);
  const sweepPollMs = pollMs('SWEEP_POLL_SECONDS', 60, 300, 30, 3600);

  // cloud-dev holds real accounts and a live sink viewer: listen on this machine only, never on the network.
  return { mode, production, cloud, projectId, port, host: cloudDev ? '127.0.0.1' : undefined, corsOrigins, voucherKey, approvalKey, appBaseUrl, trustProxy, outboxPollMs, sweepPollMs, mail: mailConfig(env, production) };
}
