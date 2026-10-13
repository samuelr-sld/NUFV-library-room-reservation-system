// Sign-in navigation check, run by hand in real Chrome (not part of `npm test`: it needs Chrome and the local stack).
//
//   1. firebase emulators:start --only auth,firestore --project demo-nufv     2. npm run server     3. npm run serve-public
//   4. node tests/auth/nav-check.mjs [--student <email>] [--admin <email>] [--suspended <email>] [--noprofile <email>] [--password demo1234] [--runs 12]
//      (the defaults are the accounts of `npm run demo`, so: `npm run demo` in one terminal, `npm run test:browser` in another)
//
// Every account is an existing, verified student/admin (the suspended and no-profile ones as their names say) in the
// emulator. Each scenario runs in a clean browser context and asserts the exact chain of main-frame URLs, so a stray
// redirect (to Reserve, Stubs, anywhere) cannot go unnoticed. Exit code 1 if any scenario fails.
import { parseArgs } from 'node:util';
import { startChrome, sleep } from './../support/cdp.mjs';

const { values: a } = parseArgs({ options: {
  student: { type: 'string', default: 'dev.patel@demo.nufv.test' }, admin: { type: 'string', default: 'admin@demo.nufv.test' },
  suspended: { type: 'string', default: 'sam.suspended@demo.nufv.test' }, noprofile: { type: 'string', default: 'nina.noprofile@demo.nufv.test' },
  password: { type: 'string', default: 'demo1234' }, site: { type: 'string', default: 'http://localhost:5000' }, runs: { type: 'string', default: '12' },
  chrome: { type: 'string' }, only: { type: 'string' },
} });
const SITE = a.site;
const LOGIN = `${SITE}/login%20page/login.html`;
const HOME = '/nav/main/main.html';
const ADMIN = '/nav/admin/admin.html';
const STUBS = '/nav/stubs/stubs.html';
const RESERVE = '/nav/reserve/reserve.html';
const RESERVATIONS = '/nav/reservations/reservations.html';
const pathOf = (url) => { try { const u = new URL(url); return u.origin === SITE ? u.pathname + u.search + u.hash : url; } catch { return url; } };

const chrome = await startChrome({ chrome: a.chrome });
const results = [];
const scenario = async (name, fn) => {
  if (a.only && !a.only.split(',').some((part) => name.toLowerCase().includes(part.trim().toLowerCase()))) return; // --only "tabs,cleared" runs the scenarios whose names contain either
  const page = await chrome.openPage();
  try {
    const detail = await fn(page);
    results.push({ name, ok: true, detail });
    console.error(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: `${String(err.message).slice(0, 400)}${page.consoleErrors.length ? ` | console: ${page.consoleErrors.slice(0, 3).join(' ; ').slice(0, 300)}` : ''}` });
    console.error(`FAIL  ${name}
        ${String(err.message).slice(0, 300)}`);
  } finally {
    await page.close();
    await chrome.disposeContext(page);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const visited = (page) => page.navs.map(pathOf);
const only = (page, allowed) => { const bad = visited(page).filter((p) => p !== 'about:blank' && !allowed.some((x) => p.startsWith(x))); expect(!bad.length, `unexpected navigation: ${bad.join(', ')} (all: ${visited(page).join(' > ')})`); };

// Fills the real login form and submits it. `now: true` submits as soon as the form exists, without waiting for the page to finish loading.
async function signIn(page, email, { now = false } = {}) {
  const fill = `document.getElementById('student-email').value = ${JSON.stringify(email)}; document.getElementById('password').value = ${JSON.stringify(a.password)}; document.querySelector('.login-form').requestSubmit(); true`;
  if (now) await page.until("document.getElementById('password') && document.querySelector('.login-form')", 'the login form', 8000);
  else await page.until("document.readyState === 'complete' && document.getElementById('password')", 'the login form');
  await page.run(fill);
}
// A person can only click Log out once the guard has shown the page (until then the page is hidden), so wait for that.
const logout = async (page) => { await page.until("document.documentElement.hidden === false", 'the page to be shown'); await page.run("document.querySelector('.logout').click(); true"); await page.settle(1500); };
const pressEnter = async (page) => { for (const type of ['keyDown', 'keyUp']) await page.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? String.fromCharCode(13) : undefined }); };
const reachHome = async (page, email) => { await page.go(LOGIN); await signIn(page, email); await page.until(`location.pathname === '${HOME}'`, 'Home after sign-in'); };

// ---- 1. the reported observation: sign-in must always end on the role's home and never visit another page on the way ----
await scenario(`fresh student sign-in, ${a.runs} times, each in a clean browser: always Home, never Reserve/Stubs/Reservations`, async (page) => {
  const chains = [];
  for (let i = 0; i < Number(a.runs); i++) {
    const p = await chrome.openPage();
    try {
      await p.go(LOGIN);
      await signIn(p, a.student);
      await p.until(`location.pathname === '${HOME}'`, `Home (run ${i + 1})`);
      expect(await p.settle(1200) === HOME, `run ${i + 1} ended at ${await p.path()}`);
      only(p, ['/login%20page/', HOME]);
      chains.push(visited(p).length);
    } finally { await p.close(); await chrome.disposeContext(p); }
  }
  return `navigations per run: ${[...new Set(chains)].join('/')}`;
});
await scenario('admin sign-in goes to the administrator dashboard', async (page) => {
  await page.go(LOGIN); await signIn(page, a.admin);
  await page.until(`location.pathname === '${ADMIN}'`, 'the dashboard');
  expect(await page.settle() === ADMIN, `ended at ${await page.path()}`);
  only(page, ['/login%20page/', ADMIN]);
});
await scenario('sign in, log out, sign in again: Home each time, logout lands on Login with no destination carried over', async (page) => {
  await reachHome(page, a.student);
  await logout(page);
  expect((await page.path()).startsWith('/login%20page/login.html'), `after logout: ${await page.path()}`);
  expect(!(await page.path()).includes('next='), `logout must not remember a destination: ${await page.path()}`);
  await signIn(page, a.student);
  await page.until(`location.pathname === '${HOME}'`, 'Home the second time');
  expect(await page.settle() === HOME, `ended at ${await page.path()}`);
  only(page, ['/login%20page/', HOME]);
});
await scenario('pressing Enter before the page finished starting does nothing (no reload, no native submit); then a double submit lands once, on Home', async (page) => {
  await page.call('Page.navigate', { url: LOGIN });
  await page.until("document.getElementById('password') && document.querySelector('.btn-primary')", 'the login form', 8000);
  await page.run("document.getElementById('student-email').value = " + JSON.stringify(a.student) + "; document.getElementById('password').value = " + JSON.stringify(a.password) + "; document.getElementById('password').focus(); true");
  const early = await page.run("document.querySelector('.btn-primary').disabled");
  if (early) { await pressEnter(page); await sleep(400); expect(!visited(page).some((u) => u.includes('login.html?')), `a native submit reloaded the page: ${visited(page).join(' > ')}`); }
  await page.until("document.readyState === 'complete' && !document.querySelector('.btn-primary').disabled", 'the form to become ready');
  await signIn(page, a.student);
  await page.run("document.querySelector('.login-form').requestSubmit(); true");
  await page.until(`location.pathname === '${HOME}'`, 'Home');
  expect(await page.settle(2000) === HOME, `ended at ${await page.path()}`);
  only(page, ['/login%20page/', HOME]);
  return early ? 'Enter pressed while the button was still disabled' : 'the form was already ready on the first look';
});
await scenario('session restoration: the login page of a signed-in browser goes Home; a reload of Home stays', async (page) => {
  await reachHome(page, a.student);
  await page.go(LOGIN);
  await page.until(`location.pathname === '${HOME}'`, 'the signed-in student to be sent Home from the login page');
  await page.call('Page.reload');
  await page.until("document.documentElement.hidden === false", 'Home to be shown again after the reload');
  expect(await page.settle(1500) === HOME, `after reload: ${await page.path()}`);
});

// ---- 2. return to the requested page ----
await scenario('direct access to a protected page while signed out: Login, then back to that page after signing in', async (page) => {
  await page.go(SITE + STUBS);
  const at = await page.settle(2500);
  expect(at.startsWith('/login%20page/login.html'), `signed out at Stubs: ${at}`);
  expect(decodeURIComponent(at).includes(`next=${STUBS}`), `the login page should remember the destination: ${at}`);
  await signIn(page, a.student);
  await page.until(`location.pathname === '${STUBS}'`, 'the requested page');
  expect(await page.settle() === STUBS, `ended at ${await page.path()}`);
});
await scenario('each student page and the administrator page is remembered and returned to, with its section', async (page) => {
  for (const target of [RESERVE, RESERVATIONS]) {
    await page.go(SITE + target);
    expect(decodeURIComponent(await page.settle(2000)).includes(`next=${target}`), `${target} not remembered: ${await page.path()}`);
    await signIn(page, a.student);
    await page.until(`location.pathname === '${target}'`, target);
    await logout(page);
  }
  await page.go(SITE + ADMIN + '#ops');
  const at = await page.settle(2000);
  expect(decodeURIComponent(at).includes(`next=${ADMIN}#ops`), `admin section not remembered: ${at}`);
  await signIn(page, a.admin);
  await page.until(`location.pathname === '${ADMIN}' && location.hash === '#ops'`, 'the dashboard on the remembered section');
});
await scenario('a destination the account may not use falls back to the role\'s home (student -> admin page, admin -> student page)', async (page) => {
  await page.go(`${LOGIN}?next=${encodeURIComponent(ADMIN)}`);
  await signIn(page, a.student);
  await page.until(`location.pathname === '${HOME}'`, 'student fallback to Home');
  expect(await page.settle() === HOME, `student ended at ${await page.path()}`);
  only(page, ['/login%20page/', HOME]);
  await logout(page);
  await page.go(`${LOGIN}?next=${encodeURIComponent(STUBS)}`);
  await signIn(page, a.admin);
  await page.until(`location.pathname === '${ADMIN}'`, 'admin fallback to the dashboard');
  expect(await page.settle() === ADMIN, `admin ended at ${await page.path()}`);
});
const UNSAFE = ['https://evil.example/', '//evil.example/x', '\\\\evil.example', '/\\evil.example', 'javascript:alert(1)', 'data:text/html,hi', '/nav/stubs/stubs.html/../../../etc/passwd', '/server/index.js', '/login%20page/login.html', `${STUBS}?x=1&next=//evil.example`, 'http://localhost:5000@evil.example/', '%2f%2fevil.example', '', 'null', '/nav/stubs/stubs.html%00', '/NAV/STUBS/STUBS.HTML'];
await scenario(`${UNSAFE.length} unsafe or unknown destinations are ignored: sign-in lands on Home and the browser never leaves this site`, async () => {
  for (const bad of UNSAFE) {
    const p = await chrome.openPage();
    try {
      await p.go(`${LOGIN}?next=${encodeURIComponent(bad)}`);
      await signIn(p, a.student);
      await p.until(`location.pathname === '${HOME}'`, `Home for next=${bad}`);
      expect(await p.settle(800) === HOME, `next=${bad} ended at ${await p.path()}`);
      const off = p.navs.filter((u) => u !== 'about:blank' && !u.startsWith(SITE));
      expect(!off.length, `next=${bad} left the site: ${off.join(', ')}`);
    } finally { await p.close(); await chrome.disposeContext(p); }
  }
});
await scenario('an absolute same-site URL as the destination is accepted only when it is one of the known pages', async (page) => {
  await page.go(`${LOGIN}?next=${encodeURIComponent(SITE + RESERVE)}`);
  await signIn(page, a.student);
  await page.until(`location.pathname === '${RESERVE}'`, 'the known page named by an absolute same-site URL');
});

// ---- 3. denied accounts ----
await scenario('suspended and missing-profile accounts are denied, stay on Login with a message, and hold no session', async (page) => {
  for (const [email, text] of [[a.suspended, /not active/], [a.noprofile, /no student profile/]]) {
    await page.go(`${LOGIN}?next=${encodeURIComponent(STUBS)}`);
    await signIn(page, email);
    await sleep(2500);
    expect((await page.path()).startsWith('/login%20page/login.html'), `${email} left the login page: ${await page.path()}`);
    const said = await page.run("document.querySelector('.form-notice')?.innerText ?? ''");
    expect(text.test(said), `${email}: "${said}"`);
    await page.go(SITE + STUBS);
    expect((await page.settle(2500)).startsWith('/login%20page/login.html'), `${email} still has access: ${await page.path()}`);
  }
});

// ---- 4. races ----
await scenario('a slow sign-in response (2.5 s on every request) still ends once on Home, with the button locked meanwhile', async (page) => {
  await page.go(LOGIN);
  await page.until("document.getElementById('password')", 'the form');
  await page.call('Network.enable');
  await page.call('Network.emulateNetworkConditions', { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 });
  await signIn(page, a.student);
  await sleep(600);
  expect(await page.run("document.querySelector('.btn-primary').disabled"), 'the button should be locked while waiting');
  await page.run("document.querySelector('.login-form').requestSubmit(); true");
  await page.until(`location.pathname === '${HOME}'`, 'Home', 40000);
  await page.call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  expect(await page.settle(2500) === HOME, `ended at ${await page.path()}`);
  only(page, ['/login%20page/', HOME]);
});
await scenario('multiple tabs: signing out in one sends the others to Login (remembering their page), and signing in again returns each correctly', async (page) => {
  await reachHome(page, a.student);
  const tab = await chrome.openTab(page);
  try {
    await tab.go(SITE + STUBS);
    await tab.until("document.documentElement.hidden === false", 'the second tab to show Stubs');
    await logout(page);
    const at = await tab.settle(3000);
    expect(at.startsWith('/login%20page/login.html'), `second tab after sign-out elsewhere: ${at}`);
    expect(decodeURIComponent(at).includes(`next=${STUBS}`), `the second tab did not keep its destination: ${at}`);
    await signIn(tab, a.student);
    await tab.until(`location.pathname === '${STUBS}'`, 'the second tab back on Stubs');
  } finally { await tab.close(); }
});
await scenario('an expired or cleared session on a protected page: reload goes to Login with that page as the destination', async (page) => {
  await reachHome(page, a.student);
  await page.go(SITE + RESERVATIONS);
  await page.until("document.documentElement.hidden === false", 'Reservations');
  await page.run("new Promise((r) => { const q = indexedDB.deleteDatabase('firebaseLocalStorageDb'); q.onsuccess = q.onerror = q.onblocked = () => r(true); setTimeout(() => r(true), 1500); })");
  await page.call('Page.reload');
  const at = await page.settle(3000);
  expect(at.startsWith('/login%20page/login.html'), `after the session vanished: ${at}`);
  expect(decodeURIComponent(at).includes(`next=${RESERVATIONS}`), `destination not kept: ${at}`);
});
await scenario('a student asking for the administrator page, and an administrator asking for a student page, are sent Home without a detour', async (page) => {
  await reachHome(page, a.student);
  await page.go(SITE + ADMIN);
  await page.until(`location.pathname === '${HOME}'`, 'the student to be sent Home from the administrator page');
  expect(await page.settle(1000) === HOME, `student at the admin page ended at ${await page.path()}`);
  await logout(page);
  await page.go(LOGIN); await signIn(page, a.admin);
  await page.until(`location.pathname === '${ADMIN}'`, 'the dashboard');
  await page.go(SITE + STUBS);
  await page.until(`location.pathname === '${ADMIN}'`, 'the administrator to be sent to the dashboard from a student page');
  expect(await page.settle(1000) === ADMIN, `admin at a student page ended at ${await page.path()}`);
});
await scenario('back and forward: after logging out, Back never shows the signed-in page; after signing in, Back does not bounce through the login page', async (page) => {
  await reachHome(page, a.student);
  await page.go(SITE + STUBS);
  await page.until("document.documentElement.hidden === false", 'Stubs');
  await logout(page);
  for (let i = 0; i < 3; i++) {
    const { entries, currentIndex } = await page.call('Page.getNavigationHistory');
    if (currentIndex === 0) break;
    await page.call('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
    await sleep(2500);
    const at = await page.path().catch(() => '?');
    const shown = await page.run("document.documentElement.hidden === false && !!document.querySelector('.student-name') && !document.querySelector('.login-form')").catch(() => false);
    expect(!shown, `Back showed the signed-in page ${at}`);
  }
  // sign in and press Back: the login page must not be a trap that forwards straight to Home again
  const p = await chrome.openPage();
  try {
    await p.go('about:blank'); await p.go(LOGIN); await signIn(p, a.student);
    await p.until(`location.pathname === '${HOME}'`, 'Home');
    await p.settle(1500);
    const { entries, currentIndex } = await p.call('Page.getNavigationHistory');
    expect(!entries.slice(0, currentIndex).some((e) => e.url.includes('login')), `the login page is still in the history behind Home: ${entries.map((e) => pathOf(e.url)).join(' > ')}`);
  } finally { await p.close(); await chrome.disposeContext(p); }
});

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} scenarios passed`);
chrome.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
