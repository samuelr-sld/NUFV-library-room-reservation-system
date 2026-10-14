import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Static checks of the pages as shipped: navigation is the same everywhere, nothing points at a file that is not there,
// icon-only menus keep their names on small screens, and the print layout hides everything but the printable stub.
const PUBLIC = resolve('public');
const read = (path) => readFileSync(join(PUBLIC, path), 'utf8');
const files = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(full).isDirectory()) files(full, out); else out.push(full);
  }
  return out;
};

const STUDENT_PAGES = ['nav/main/main.html', 'nav/reserve/reserve.html', 'nav/stubs/stubs.html', 'nav/reservations/reservations.html'];
const links = (html) => [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*class="menu-item[^"]*"[^>]*>|<a\s[^>]*class="menu-item[^"]*"[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1] ?? m[2]);

test('My Profile is reached from the header name link (no menu item) and serves both roles with the matching menu', () => {
  for (const page of [...STUDENT_PAGES, 'nav/admin/admin.html']) {
    const html = read(page);
    assert.deepEqual(links(html).filter((h) => h.includes('profile')), [], `${page}: no profile menu item`);
    assert.match(html, /<a class="profile-section" href="\.\.\/profile\/profile\.html"/, page);
  }
  const html = read('nav/profile/profile.html');
  assert.doesNotMatch(html, /data-role=/, 'open to both roles; the API acts on the caller only');
  assert.match(html, /id="nav-student"/);
  assert.match(html, /id="nav-admin"/);
  const code = read('nav/profile/profile.js');
  assert.match(code, /\/api\/profile/);
  assert.match(code, /body: { fullName, program: [^}]*address: [^}]*}/, 'only name, course and address are ever sent');
});

test('every student page offers the same four destinations and no placeholder links', () => {
  const nav = (page) => links(read(page)).filter((href) => !href.includes('login'));
  const reference = nav(STUDENT_PAGES[0]).map((h) => resolve(PUBLIC, dirname(STUDENT_PAGES[0]), h));
  assert.equal(reference.length, 4);
  for (const page of STUDENT_PAGES) {
    const targets = nav(page).map((h) => resolve(PUBLIC, dirname(page), h));
    assert.deepEqual(targets, reference, page);
    assert.ok(links(read(page)).every((h) => h !== '#' && h !== ''), `${page} has a placeholder link`);
    assert.equal((read(page).match(/aria-current="page"/g) ?? []).length, 1, `${page} marks exactly one current page`);
    assert.match(read(page), /<nav class="sidebar-menu" aria-label="Student">/, page);
  }
});

test('every menu entry has a visible text label for assistive technology, on every page with a sidebar', () => {
  for (const page of [...STUDENT_PAGES, 'nav/admin/admin.html', 'nav/verify/verify.html']) {
    const anchors = [...read(page).matchAll(/<a\s[^>]*class="menu-item[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.ok(anchors.length >= 1, page);
    for (const [, inner] of anchors) assert.match(inner, /<span>[^<\s][^<]*<\/span>/, `${page}: ${inner.trim().slice(0, 60)}`);
  }
});

test('collapsing the sidebar to icons hides the labels visually, never from screen readers', () => {
  for (const css of ['nav/main/main.css', 'nav/reserve/reserve.css']) {
    const text = read(css);
    assert.doesNotMatch(text, /\.menu-item span\s*\{[^}]*display:\s*none/, `${css} removes the link name with display:none`);
    const collapsed = text.slice(text.indexOf('@media (max-width: 1200px)'));
    assert.match(collapsed, /\.menu-item span\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/, `${css} keeps the name available`);
    assert.match(collapsed, /@media \(max-width: 768px\)[\s\S]*flex-direction: row[\s\S]*overflow-x: auto/, `${css} turns the sidebar into a scrolling row on phones`);
  }
});

test('every administrator menu entry opens a section that the script knows, and the reverse', () => {
  const html = read('nav/admin/admin.html');
  const script = read('nav/admin/admin.js');
  const menu = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  const registered = [...script.slice(script.indexOf('const VIEWS')).matchAll(/^  ([a-z]+): \{ el: /gm)].map((m) => m[1]);
  assert.deepEqual([...menu].sort(), [...registered].sort());
  for (const view of menu) assert.match(html, new RegExp(`<section id="view-${view}" class="view"`), view);
  assert.ok(menu.includes('ops') && menu.includes('audit'), 'operations and audit log are reachable');
});

test('every relative link, script, stylesheet, image and import in the shipped pages points at a file that exists', () => {
  const missing = [];
  for (const file of files(PUBLIC).filter((f) => /\.(html|js|css)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const refs = [];
    if (file.endsWith('.html')) for (const m of text.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) refs.push(m[1]);
    if (file.endsWith('.js')) for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) refs.push(m[1]);
    if (file.endsWith('.css')) for (const m of text.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) refs.push(m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|mailto:|\/\/)/.test(ref) || ref.startsWith('#')) continue;
      const target = resolve(dirname(file), decodeURIComponent(ref.split('?')[0]));
      if (!existsSync(target)) missing.push(`${relative(PUBLIC, file)} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('printing a stub or a confirmation shows only the stub: the sidebar, header and controls are hidden, colors do not depend on the browser', () => {
  for (const page of ['nav/stubs/stubs.html', 'nav/reservations/reservations.html']) {
    const html = read(page);
    assert.match(html, /<aside class="sidebar no-print">/, page);
    assert.match(html, /<header class="header no-print">/, page);
    assert.match(html, /<div class="actions no-print">/, `${page}: print and close buttons are screen-only`);
  }
  const css = read('nav/stubs/stubs.css');
  const print = css.slice(css.indexOf('@media print'));
  for (const rule of [/\.no-print\s*\{\s*display:\s*none\s*!important/, /\.dashboard-container\s*\{\s*display:\s*block/, /\.stub\s*\{[^}]*box-shadow:\s*none/, /break-inside:\s*avoid/, /print-color-adjust:\s*exact/]) assert.match(print, rule);
  assert.match(read('nav/reservations/reservations.html'), /<link rel="stylesheet" href="\.\.\/stubs\/stubs\.css">/, 'the confirmation uses the same print rules as stubs');
});

test('the approval page is a standalone page with no sidebar and a mobile-width viewport', () => {
  const html = read('approve/approve.html');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  assert.doesNotMatch(html, /class="sidebar"/);
  assert.match(read('approve/approve.css'), /max-width|min\(/, 'the card is width-bounded rather than fixed');
});

test('no student page ships invented content: made-up rooms, bookings, announcements, a fake student, dead controls or an unbacked policy', () => {
  const invented = [/Discussion Room [1-9]\b/, /\bAug(ust)? \d/, /Program\/Course/, /BS Computer Engineering/, /Juan Dela Cruz/, /Extended Hours/, /Group Project Meeting<\/h4>/, /notification-btn/, /fa-chevron-down/, /within 15 minutes/];
  for (const page of [...STUDENT_PAGES, 'nav/reservations/reservations.js', 'nav/stubs/stubs.js']) {
    const text = read(page);
    for (const pattern of invented) assert.doesNotMatch(text, pattern, `${page} contains ${pattern}`);
  }
  const home = read('nav/main/main.html');
  assert.match(home, /<script type="module" src="main\.js">/, 'the Home page loads its real data');
  assert.match(home, /There are no announcements\. Library announcements are not part of this system yet\./, 'announcements say honestly that no such feature exists');
  const code = read('nav/main/main.js');
  assert.match(code, /\/api\/reservations\/availability/);
  assert.match(code, /\/api\/reservations'/);
});

test('sign-in, registration and password reset report through inline notices, never blocking alert() pop-ups', () => {
  for (const js of ['login page/login.js', 'register page/register.js', 'forgot_pass/forgot.js']) {
    const text = read(js);
    assert.doesNotMatch(text, /\balert\(/, `${js} still uses alert()`);
    assert.match(text, /\bnotice\(/, js);
  }
  assert.match(read('js/dom.js'), /role', error \? 'alert' : 'status'/, 'the notice is announced to screen readers');
  for (const css of ['login page/login.css', 'register page/register.css', 'forgot_pass/forgot.css']) assert.match(read(css), /\.form-notice\.error/, css);
  assert.match(read('register page/register.js'), /login\.html\?registered=\$\{result\}/, 'the login page tells the student what happens next');
});

test('on a phone every page can be scrolled as a whole and the login and sign-up cards fit short screens', () => {
  for (const css of ['nav/main/main.css', 'nav/reserve/reserve.css']) {
    const phone = read(css).slice(read(css).indexOf('@media (max-width: 768px)'));
    assert.match(phone, /\.dashboard-container\s*\{[^}]*overflow:\s*visible/, `${css}: the page must not clip its content`);
    assert.match(phone, /\.content-wrapper\s*\{[^}]*overflow-y:\s*visible/, `${css}: no nested scroll strip`);
  }
  assert.match(read('login page/login.css'), /@media \(max-width: 768px\)[\s\S]*flex-direction: column/, 'the login panels stack');
  for (const css of ['register page/register.css', 'forgot_pass/forgot.css']) assert.match(read(css), /@media \(max-width: 600px\)[\s\S]*height: auto/, `${css}: the card must grow with its content`);
});

test('every labelled control points at the control it labels (a label for="room" on the participants list once hid it from screen readers)', () => {
  for (const page of [...STUDENT_PAGES, 'login page/login.html', 'register page/register.html', 'forgot_pass/forgot.html', 'approve/approve.html', 'nav/admin/admin.html']) {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const labelled = {};
    for (const m of html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) {
      assert.ok(ids.has(m[1]), `${page}: label for="${m[1]}" points at nothing`);
      labelled[m[1]] = (labelled[m[1]] ?? 0) + 1;
    }
    for (const [id, n] of Object.entries(labelled)) assert.equal(n, 1, `${page}: #${id} has ${n} labels`);
  }
});
