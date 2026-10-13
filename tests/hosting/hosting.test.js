import { test } from 'node:test';
import assert from 'node:assert/strict';

// Needs the Hosting emulator (npm test starts it). Only public/ may be served.
const base = `http://${process.env.FIREBASE_HOSTING_EMULATOR_HOST ?? '127.0.0.1:5000'}`;
const get = (path) => fetch(base + path, { redirect: 'manual' });

test('public pages and assets keep their URLs', async () => {
  for (const [path, type] of [
    ['/', /html/],
    ['/login%20page/login.html', /html/],
    ['/register%20page/register.html', /html/],
    ['/register%20page/register.js', /javascript/],
    ['/login%20page/login.css', /css/],
    ['/js/api.js', /javascript/],
    ['/js/firebase.js', /javascript/],
    ['/js/session.js', /javascript/],
    ['/nav/admin/admin.html', /html/],
    ['/nav/admin/admin.js', /javascript/],
    ['/nav/admin/admin.css', /css/],
    ['/nav/admin/tickets-view.js', /javascript/],
    ['/vendor/jsqr/jsQR.js', /javascript/],
    ['/js/qr-reference.js', /javascript/],
    ['/approve/approve.html', /html/],
    ['/approve/approve.js', /javascript/],
    ['/approve/approve.css', /css/],
    ['/nav/reservations/reservations.html', /html/],
    ['/nav/reservations/reservations.js', /javascript/],
    ['/nav/reserve/reserve-form.js', /javascript/],
    ['/nav/admin/reservations-view.js', /javascript/],
    ['/nav/admin/ops-view.js', /javascript/],
    ['/nav/admin/audit-view.js', /javascript/],
    ['/nav/main/main.js', /javascript/],
    ['/register%20page/terms-popup.js', /javascript/],
    ['/js/dom.js', /javascript/],
    ['/nav/stubs/stubs.html', /html/],
    ['/nav/stubs/stubs.js', /javascript/],
    ['/nav/stubs/stubs.css', /css/],
    ['/nav/verify/verify.html', /html/],
    ['/nav/verify/verify.js', /javascript/],
    ['/nav/main/main.html', /html/],
    ['/forgot_pass/forgot.html', /html/],
    ['/terms/terms.html', /html/],
    ['/assets/bg1.jpg', /image/],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
  }
});

test('backend source, package files, tests, rules and dotfiles are not served', async () => {
  for (const path of [
    '/server/index.js', '/server/app.js', '/server/config.js', '/server/routes/students.js', '/server/.env.example',
    '/package.json', '/package-lock.json', '/firebase.json', '/firestore.rules', '/firestore.indexes.json', '/.firebaserc',
    '/README.md', '/tests/server/students.test.js', '/node_modules/express/package.json',
    '/public/js/api.js', '/%2e%2e/package.json', '/js/%2e%2e/%2e%2e/package.json', '/..%2fpackage.json',
  ]) {
    const res = await get(path);
    assert.notEqual(res.status, 200, path);
    assert.doesNotMatch(await res.text(), /"express"|firebase-admin|loadConfig|rules_version/, path);
  }
});

// The Hosting emulator (firebase-tools 15.6) does not apply the `headers` rules, so a live request cannot prove them here;
// tests/unit/security.test.js checks the declared rules and serves them through server/staticHost.js. Verify once after
// the first deploy with `curl -I`.
test('the hosting configuration declares one header rule for every path, with a Content-Security-Policy', async () => {
  const { readFile } = await import('node:fs/promises');
  const rules = JSON.parse(await readFile('firebase.json', 'utf8')).hosting.headers;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, '**');
  assert.deepEqual(rules[0].headers.map((h) => h.key), ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']);
});
