import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// Every relative reference inside public/ must resolve inside public/, so the site keeps working when Hosting serves only that folder.
const PUBLIC = 'public';
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
// Already dangling before the move (forgot.html loads a login.js that was never created); not fixed here.
const KNOWN_DANGLING = new Set([join(PUBLIC, 'forgot_pass', 'forgot.html') + '|login.js']);
const REFS = [
  /\b(?:src|href)=["']([^"']+)["']/g, // html
  /\bfrom\s+["']([^"']+)["']/g, // js imports
  /\bimport\(\s*["']([^"']+)["']\s*\)/g, // dynamic imports
  /url\(\s*["']?([^"')]+)["']?\s*\)/g, // css
];

test('relative links, imports and css urls resolve to files inside public/', () => {
  let checked = 0;
  for (const file of files(PUBLIC).filter((f) => /\.(html|js|css)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    for (const re of REFS) {
      for (const [, ref] of text.matchAll(re)) {
        if (/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref)) continue;
        const target = join(dirname(file), decodeURIComponent(ref.split(/[?#]/)[0]));
        assert.ok(!relative(PUBLIC, target).startsWith('..'), `${file}: "${ref}" escapes public/`);
        if (KNOWN_DANGLING.has(`${file}|${ref}`)) continue;
        assert.ok(existsSync(target), `${file}: "${ref}" does not exist`);
        checked++;
      }
    }
  }
  assert.ok(checked > 20, `only ${checked} references checked`);
});

test('public/ holds no backend, config or test files', () => {
  const bad = files(PUBLIC).filter((f) => /(^|[\\/])(server|tests|node_modules)[\\/]|package(-lock)?\.json$|firebase\.json$|firestore\.|\.env|\.firebaserc/.test(f));
  assert.deepEqual(bad, []);
});
