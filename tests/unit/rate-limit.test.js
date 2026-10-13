import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { memoryLimiter } from '../../server/rateLimit.js';
import { errorHandler } from '../../server/errors.js';
import { loadConfig } from '../../server/config.js';

// The per-process limiter on its own (the Firestore-backed one is tested against the emulator in tests/reservations).
async function serve({ max = 3, trustProxy = 0, clock }) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(memoryLimiter({ windowMs: 60_000, max }, clock));
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const get = (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
  return { get, close: () => { server.close(); server.closeAllConnections(); } };
}

test('an address is allowed its quota per window, then refused with 429 and Retry-After; a new window starts fresh', async () => {
  const time = { now: new Date('2030-01-01T00:00:00Z') };
  const s = await serve({ clock: () => new Date(time.now) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.get()).status, 200);
    const blocked = await s.get();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '60');
    assert.equal((await blocked.json()).error.code, 'rate-limited');
    time.now = new Date(time.now.getTime() + 30_000);
    assert.equal((await s.get()).status, 429);
    assert.equal((await s.get()).headers.get('retry-after'), '30');
    time.now = new Date(time.now.getTime() + 30_000);
    assert.equal((await s.get()).status, 200);
  } finally { s.close(); }
});

test('X-Forwarded-For is only believed when a proxy is trusted', async () => {
  const clock = () => new Date('2030-01-01T00:00:00Z');
  const direct = await serve({ max: 1, trustProxy: 0, clock });
  try {
    assert.equal((await direct.get({ 'X-Forwarded-For': '1.1.1.1' })).status, 200);
    assert.equal((await direct.get({ 'X-Forwarded-For': '2.2.2.2' })).status, 429, 'spoofing a new address changes nothing');
  } finally { direct.close(); }

  const behind = await serve({ max: 1, trustProxy: 1, clock });
  try {
    assert.equal((await behind.get({ 'X-Forwarded-For': '1.1.1.1' })).status, 200);
    assert.equal((await behind.get({ 'X-Forwarded-For': '2.2.2.2' })).status, 200, 'the proxy-reported client is the key');
    assert.equal((await behind.get({ 'X-Forwarded-For': '1.1.1.1' })).status, 429);
    assert.equal((await behind.get({ 'X-Forwarded-For': '9.9.9.9, 1.1.1.1' })).status, 429, 'only the hop our proxy appended counts, not what the client put in front');
  } finally { behind.close(); }
});

test('the proxy setting is validated at startup', () => {
  const env = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-nufv', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  assert.equal(loadConfig(env).trustProxy, 0);
  assert.equal(loadConfig({ ...env, TRUST_PROXY_HOPS: '1' }).trustProxy, 1);
  for (const bad of ['-1', '4', '1.5', 'yes']) assert.throws(() => loadConfig({ ...env, TRUST_PROXY_HOPS: bad }), /TRUST_PROXY_HOPS/, bad);
});
