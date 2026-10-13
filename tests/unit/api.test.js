import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, retryUncertain, ApiError } from '../../public/js/api.js';
import { apiBaseFor } from '../../public/js/firebase-config.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const client = (fetchFn, token = 'tok') => createApiClient({ getToken: async () => token, baseUrl: 'http://api', fetchFn });
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof ApiError && e.code === code);

test('attaches the bearer token and JSON body, returns parsed JSON', async () => {
  let seen;
  const res = await client(async (url, init) => ((seen = { url, init }), json(201, { role: 'student' })))('/x', { method: 'POST', body: { a: 1 } });
  assert.deepEqual(res, { role: 'student' });
  assert.equal(seen.url, 'http://api/x');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.body, '{"a":1}');
});

test('no signed-in user means no request is made', async () => {
  let called = false;
  const fetchFn = async () => { called = true; };
  await rejectsWith(client(fetchFn, null)('/x'), 'unauthenticated');
  await rejectsWith(createApiClient({ getToken: async () => { throw new Error('boom'); }, baseUrl: '', fetchFn })('/x'), 'unauthenticated');
  assert.equal(called, false);
});

test('network failures become a friendly error', async () => {
  await assert.rejects(client(async () => { throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.5'); })('/x'),
    (e) => e.code === 'network' && e.uncertain && !/ECONNREFUSED|10\.0/.test(e.message));
});

test('401 asks the student to sign in again', async () => {
  await rejectsWith(client(async () => json(401, { error: { code: 'invalid-token', message: 'internal detail' } }))('/x'), 'unauthenticated');
});

test('validation, conflict and suspension messages pass through; server errors are generic', async () => {
  const e409 = await client(async () => json(409, { error: { code: 'already-exists', message: 'This student number is already registered.' } }))('/x').catch((e) => e);
  assert.equal(e409.message, 'This student number is already registered.');

  const e500 = await client(async () => json(500, { error: { code: 'internal', message: 'stack trace here' } }))('/x').catch((e) => e);
  assert.doesNotMatch(e500.message, /stack/);

  const html = await client(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('<html>'); } }))('/x').catch((e) => e);
  assert.equal(html.status, 502);
  assert.doesNotMatch(html.message, /html/);
});

test('API base: local hosts use the local backend, anything else is refused (production URL is unset)', () => {
  assert.equal(apiBaseFor('localhost'), 'http://localhost:3000');
  for (const h of ['lrc-room-reservation.web.app', 'evil.example', '']) assert.throws(() => apiBaseFor(h), /not configured/);
});

test('a request that never gets an answer times out as an uncertain failure', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const request = createApiClient({ getToken: async () => 'tok', baseUrl: 'http://api', fetchFn: hang, timeoutMs: 20 });
  await assert.rejects(request('/x'), (e) => e.code === 'network' && e.uncertain);
});

test('only network failures and 5xx are uncertain; 4xx and sign-in problems are definitive', async () => {
  const caught = (fetchFn, token) => client(fetchFn, token)('/x').catch((e) => e);
  assert.equal((await caught(async () => json(500, {}))).uncertain, true);
  assert.equal((await caught(async () => json(503, null))).uncertain, true);
  const envelope = { error: { code: 'x', message: 'y' } };
  for (const status of [400, 401, 403, 409, 413]) assert.equal((await caught(async () => json(status, envelope))).uncertain, false, String(status));
  // A 4xx that is not in this API's error envelope (proxy timeout, rate limiter, wrong host) proves nothing about what was written.
  for (const status of [400, 401, 404, 408, 429]) assert.equal((await caught(async () => json(status, null))).uncertain, true, String(status));
  assert.equal((await caught(async () => json(408, { error: 'Request Timeout' }))).uncertain, true);
  assert.equal((await caught(async () => json(200, {}), null)).uncertain, false);
});

test('retryUncertain re-sends after a lost response and returns the eventual answer', async () => {
  let calls = 0;
  const waits = [];
  const send = async () => {
    if (++calls < 3) throw new ApiError('network', 'x', 0, true);
    return { role: 'student' };
  };
  assert.deepEqual(await retryUncertain(send, { wait: async (ms) => waits.push(ms) }), { role: 'student' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('retryUncertain gives up after the attempt limit with the uncertain error intact', async () => {
  let calls = 0;
  await assert.rejects(retryUncertain(async () => { calls++; throw new ApiError('network', 'x', 0, true); }, { attempts: 3, wait: async () => {} }),
    (e) => e.uncertain === true);
  assert.equal(calls, 3);
});

test('retryUncertain never repeats a definitive rejection', async () => {
  let calls = 0;
  await assert.rejects(retryUncertain(async () => { calls++; throw new ApiError('already-exists', 'x', 409); }, { wait: async () => {} }),
    (e) => e.status === 409);
  assert.equal(calls, 1);
});
