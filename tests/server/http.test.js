import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';

const config = { corsOrigins: ['http://localhost:5000'] };
const calls = { verify: [] };
const auth = {
  async verifyIdToken(token) {
    calls.verify.push(token);
    if (token === 'good') return { uid: 'u1', email: 'u1@example.com' };
    if (token === 'disabled') throw Object.assign(new Error('x'), { code: 'auth/user-disabled' });
    throw Object.assign(new Error('bad token details'), { code: 'auth/argument-error' });
  },
};
const db = { runTransaction: async () => { throw new Error('secret database internals'); } };

let server, base;
before(async () => {
  server = createApp({ config, auth, db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (headers = {}, body = '{"fullName":"Juan","studentNumber":"2023-123456"}') =>
  fetch(`${base}/api/students/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
const errorOf = async (res) => (await res.json()).error;

test('missing token is rejected before any verification', async () => {
  const res = await post();
  assert.equal(res.status, 401);
  assert.equal((await errorOf(res)).code, 'unauthenticated');
  assert.equal(calls.verify.length, 0);
});

test('a malformed Authorization header is treated as missing', async () => {
  for (const h of ['good', 'Basic good', 'Bearer', 'Bearer a b']) {
    assert.equal((await post({ Authorization: h })).status, 401, h);
  }
  assert.equal(calls.verify.length, 0);
});

test('an invalid token gets a generic 401 that does not echo the verifier error', async () => {
  const res = await post({ Authorization: 'Bearer forged' });
  assert.equal(res.status, 401);
  const err = await errorOf(res);
  assert.equal(err.code, 'invalid-token');
  assert.doesNotMatch(JSON.stringify(err), /bad token details/);
});

test('a disabled Firebase account is reported as suspended', async () => {
  const res = await post({ Authorization: 'Bearer disabled' });
  assert.equal(res.status, 403);
  assert.equal((await errorOf(res)).code, 'account-suspended');
});

test('unexpected failures return a generic 500 without internals', async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const res = await post({ Authorization: 'Bearer good' });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /"code":"internal"/);
    assert.doesNotMatch(text, /secret|stack|at /);
  } finally {
    console.error = log;
  }
});

test('invalid JSON, oversized bodies and unknown routes use the same JSON error shape', async () => {
  const bad = await post({ Authorization: 'Bearer good' }, '{nope');
  assert.equal(bad.status, 400);
  assert.equal((await errorOf(bad)).code, 'invalid-json');

  const big = await post({ Authorization: 'Bearer good' }, JSON.stringify({ fullName: 'x'.repeat(20000) }));
  assert.equal(big.status, 413);
  assert.equal((await errorOf(big)).code, 'payload-too-large');

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await errorOf(missing)).code, 'not-found');
});

test('CORS: only allowlisted origins get headers; preflight from others is refused', async () => {
  const ok = await fetch(`${base}/api/nope`, { headers: { Origin: 'http://localhost:5000' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5000');

  const evil = await fetch(`${base}/api/nope`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/api/students/profile`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5000' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

  const badPre = await fetch(`${base}/api/students/profile`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
  assert.equal(badPre.status, 403);
});

// ---------------------------------------------------------------- production hardening

test('every API response is uncacheable, carries the basic hardening headers, and never names the framework', async () => {
  for (const [path, status] of [['/api/health', 200], ['/api/nope', 404], ['/api/tickets/active', 401], ['/api/admin/summary', 401]]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('x-powered-by'), null, path);
  }
});

test('the whole of /api/admin, /api/tickets and /api/reservations sits behind sign-in: even paths that do not exist answer 401, never 404', async () => {
  const before = calls.verify.length;
  for (const prefix of ['/api/admin', '/api/tickets', '/api/reservations']) {
    for (const path of ['', '/', '/x', '/a/b/c', '/ops/anything', '/..%2fadmin']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        assert.equal(res.status, 401, `${method} ${prefix}${path}`);
      }
    }
  }
  assert.equal(calls.verify.length, before, 'refused before any token was even checked');
});

test('a malformed URL is the caller\'s mistake (400), not a server error, and leaks nothing', async () => {
  for (const path of ['/api/approvals/%E0%A4%A', '/api/approvals/%']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: { code: 'bad-request', message: 'The request could not be processed.' } });
  }
});

test('a state-changing request from an origin that is not allowed is refused outright; reads and allowed origins are unaffected', async () => {
  const before = calls.verify.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await fetch(`${base}/api/students/profile`, { method, headers: { Origin: 'http://evil.example', Authorization: 'Bearer good', 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 403, method);
    assert.equal((await errorOf(res)).code, 'origin-not-allowed');
  }
  const cross = await fetch(`${base}/api/approvals/${'A'.repeat(24)}/code`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.equal(cross.status, 403, 'the public approval endpoints too: a foreign page cannot make the server mail a code');
  assert.equal(calls.verify.length, before, 'nothing was authenticated or run');
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'http://evil.example' } })).status, 200);
  assert.equal((await post({ Origin: 'http://localhost:5000' })).status, 401, 'the real site still reaches the handler');
  assert.equal((await post()).status, 401, 'no Origin header (curl, server-to-server) is not a browser cross-site request');
});

test('failures reveal nothing internal: unexpected errors are generic and the bodies are bounded', async () => {
  const boom = await post({ Authorization: 'Bearer good' });
  assert.equal(boom.status, 500);
  const text = await boom.text();
  assert.ok(!/secret|database|internals|stack|at /i.test(text), text);
  assert.equal((await post({ 'Content-Type': 'application/json' }, 'x'.repeat(20_000))).status, 413);
  assert.equal((await post({ 'Content-Type': 'application/json' }, '{"a":')).status, 400);
});
