import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFor, PROD_CONFIG } from '../../public/js/firebase-config.js';

test('local hosts use the emulators with a demo project and no production keys', () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const { config, useEmulators } = configFor(host);
    assert.equal(useEmulators, true);
    assert.equal(config.projectId, 'demo-nufv');
    assert.notEqual(config.apiKey, PROD_CONFIG.apiKey);
  }
});

test('only the project Hosting domains get the production config', () => {
  for (const host of ['lrc-room-reservation.web.app', 'lrc-room-reservation.firebaseapp.com']) {
    assert.deepEqual(configFor(host), { config: PROD_CONFIG, useEmulators: false });
  }
});

test('any other host is refused instead of falling back to production', () => {
  for (const host of ['', '192.168.1.5', 'evil.web.app', 'lrc-room-reservation.web.app.evil.com']) {
    assert.throws(() => configFor(host), /not configured/);
  }
});

// ---------------------------------------------------------------- "no real email in demo mode" notice

import { readFileSync } from 'node:fs';
import { devMailUrl } from '../../public/js/firebase-config.js';

test('the demo email viewer is pointed to on a developer machine only, never on a deployed host', () => {
  assert.equal(devMailUrl('localhost'), 'http://localhost:3000/api/dev/mail/view');
  assert.equal(devMailUrl('127.0.0.1'), 'http://localhost:3000/api/dev/mail/view');
  for (const host of ['lrc-room-reservation.web.app', 'lrc-room-reservation.firebaseapp.com', 'library.example.edu', 'evil.example', '']) assert.equal(devMailUrl(host), null, host);
});

test('every page that says an email was sent also says, in demo mode, that none really was and where to read it', () => {
  for (const [file, needle] of [['login page/login.js', /REGISTERED\[registered\], \{ error: false \}\); demoMailNote\(loginForm\)/], ['forgot_pass/forgot.js', /demoMailNote\(form\)/], ['nav/verify/verify.js', /demoMailNote\(status\.parentElement\)/], ['approve/approve.js', /demoMailNote\(\$\('#step-code'\)\)/]]) {
    assert.match(readFileSync(`public/${file}`, 'utf8'), needle, file);
  }
  assert.match(readFileSync('public/js/dom.js', 'utf8'), /Demo mode: no real email is sent/);
});

// ---------------------------------------------------------------- cloud-connected development (port 5001)

import { apiBaseFor, CLOUD_DEV } from '../../public/js/firebase-config.js';

test('http://localhost:5001 alone uses the real project and API :3001; every other local address stays on the emulators', () => {
  assert.deepEqual(configFor('localhost', '5001'), { config: PROD_CONFIG, useEmulators: false });
  assert.equal(apiBaseFor('localhost', '5001'), 'http://localhost:3001');
  assert.equal(devMailUrl('localhost', '5001'), null);
  for (const port of ['', '5000', '3000', '5002']) {
    assert.equal(configFor('localhost', port).useEmulators, true, port);
    assert.equal(configFor('127.0.0.1', port).config.projectId, 'demo-nufv', port);
    assert.equal(apiBaseFor('localhost', port), 'http://localhost:3000', port);
  }
  assert.equal(CLOUD_DEV.sitePort, '5001');
});

test('127.0.0.1:5001 is refused rather than guessed: not an authorized Auth domain, and never the emulators', () => {
  assert.throws(() => configFor('127.0.0.1', '5001'), /http:\/\/localhost:5001/);
  assert.throws(() => apiBaseFor('127.0.0.1', '5001'), /not configured/);
  assert.equal(devMailUrl('127.0.0.1', '5001'), null);
});
