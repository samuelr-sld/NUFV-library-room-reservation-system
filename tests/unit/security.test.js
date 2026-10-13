import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStaticHost } from '../../server/staticHost.js';

// The Content-Security-Policy in firebase.json only protects anything if the pages obey it, and it only does no harm if the
// pages never need more than it allows. These checks keep both true. (The Hosting emulator does not apply headers, so
// `npm run serve-public` serves them locally; a real browser run against it is in the Stage 9 report.)
const PUBLIC = resolve('public');
const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting;
const headers = Object.fromEntries(hosting.headers[0].headers.map((h) => [h.key, h.value]));
const csp = Object.fromEntries(headers['Content-Security-Policy'].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...src]) => [name, src]));
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
};
const pages = walk(PUBLIC).filter((f) => f.endsWith('.html'));
const scripts = walk(PUBLIC).filter((f) => f.endsWith('.js'));
const origin = (url) => new URL(url).origin;

test('the policy forbids what the pages do not need: no inline script, no eval, no plugins, no foreign framing, no foreign base or form target', () => {
  assert.deepEqual(csp['script-src'], ["'self'", 'https://www.gstatic.com']);
  assert.ok(!csp['script-src'].some((s) => /unsafe|\*/.test(s)));
  assert.ok(!csp['style-src'].some((s) => /unsafe|\*/.test(s)));
  assert.deepEqual([csp['object-src'], csp['base-uri'], csp['form-action'], csp['frame-ancestors'], csp['frame-src']], [["'none'"], ["'self'"], ["'self'"], ["'self'"], ["'self'"]]);
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN', 'the Terms dialog is a same-site iframe; DENY would break it');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['Permissions-Policy'], 'camera=(self), microphone=(), geolocation=()', 'the QR scanner needs the camera, nothing else is needed');
});

test('no page uses anything the policy blocks: inline scripts, inline style attributes, inline event handlers, eval', () => {
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    const rel = file.slice(PUBLIC.length + 1);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc="/, `${rel}: inline <script>`);
    assert.doesNotMatch(html, /<style\b/i, `${rel}: <style> block`);
    assert.doesNotMatch(html, /\sstyle="/i, `${rel}: style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+="/i, `${rel}: inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${rel}: javascript: URL`);
  }
  for (const file of scripts) {
    const js = readFileSync(file, 'utf8');
    const rel = file.slice(PUBLIC.length + 1);
    assert.doesNotMatch(js, /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]|setAttribute\(\s*['"]style['"]/, `${rel}: eval-like code or a style attribute`);
    assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, `${rel}: HTML built from strings`);
  }
});

test('every external script, stylesheet, font and module the pages load comes from an origin the policy names', () => {
  const external = [];
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"/g)) external.push(['script-src', m[1], file]);
    for (const m of html.matchAll(/<link\b[^>]*\bhref="(https?:[^"]+)"[^>]*>/g)) external.push([/rel="stylesheet"/.test(m[0]) ? 'style-src' : 'font-src', m[1], file]);
  }
  for (const file of scripts) for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*['"](https?:[^'"]+)['"]|`(https:\/\/www\.gstatic\.com[^`$]*)/g)) external.push(['script-src', m[1] ?? m[2], file]);
  assert.ok(external.length >= 20);
  for (const [directive, url, file] of external) {
    assert.ok(csp[directive].includes(origin(url)), `${file.slice(PUBLIC.length + 1)} loads ${url}, which ${directive} does not allow`);
  }
  assert.ok(csp['font-src'].includes('https://fonts.gstatic.com') && csp['style-src'].includes('https://fonts.googleapis.com'), 'Google Fonts: stylesheet and font files');
  assert.ok(csp['font-src'].includes('https://cdnjs.cloudflare.com'), 'Font Awesome font files come from the same CDN as its stylesheet');
});

test('the one third-party stylesheet that can be pinned is pinned (Subresource Integrity); Google Fonts and the Firebase SDK modules cannot be and are listed as accepted gaps', () => {
  let pinned = 0;
  for (const file of pages) {
    for (const m of readFileSync(file, 'utf8').matchAll(/<link\b[^>]*cdnjs\.cloudflare\.com[^>]*>/g)) {
      assert.match(m[0], /integrity="sha512-[A-Za-z0-9+/]{86}=="/, file);
      assert.match(m[0], /crossorigin="anonymous"/, file);
      pinned++;
    }
  }
  assert.equal(pinned, 10);
  const firebaseVersions = new Set(scripts.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/firebasejs\/([0-9.]+)\//g)].map((m) => m[1])));
  assert.deepEqual([...firebaseVersions], ['13.0.0'], 'one exact, pinned SDK version everywhere (never a floating one)');
});

test('the local static host serves every file with the headers from firebase.json, and only files inside public/', async () => {
  const server = createStaticHost().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/approve/approve.html', '/nav/admin/admin.html', '/login%20page/login.html', '/js/api.js', '/nav/main/main.css']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      for (const [key, value] of Object.entries(headers)) assert.equal(res.headers.get(key), value, `${path} ${key}`);
    }
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/server/index.js', '/missing.html']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      assert.notEqual(res.status, 200, path);
      assert.doesNotMatch(await res.text(), /"express"|loadConfig/, path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
