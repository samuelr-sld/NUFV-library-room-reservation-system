// UI/UX audit of every major page at a desktop and a real phone viewport (touch, mobile layout), in headless Chrome, against the
// demonstration environment. Run by hand after `npm run demo` (best after the walkthrough, so the pages have content):
//
//   node tests/e2e/ui-audit.mjs [--out docs/evidence/ui]
//
// For each page and size it saves a screenshot and lists problems found by script: horizontal overflow, content wider than the
// screen, controls without accessible names or labels, images without alt, duplicate ids, missing lang/title, tiny tap
// targets, and any console error (a blocked resource or a CSP violation included). Exit code 1 if anything is found.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startChrome, sleep } from '../support/cdp.mjs';
import { acct, ui, signIn, mailTo, AUDIT } from './lib.mjs';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'docs/evidence/ui' }, chrome: { type: 'string' } } });
mkdirSync(a.out, { recursive: true });
const chrome = await startChrome({ chrome: a.chrome });
const VIEWPORTS = [['desktop', 1280, 800, false], ['mobile', 390, 844, true]];
const report = [];

async function audit(page, name, vp, settleMs = 1800) {
  await sleep(settleMs);
  const issues = await page.run(AUDIT);
  const errors = page.consoleErrors.splice(0).filter((e) => !/favicon|Failed to load resource: the server responded with a status of 40[134]/.test(e));
  await page.shot(`${a.out}/${name}-${vp}.jpg`, { fullPage: true });
  report.push({ page: name, viewport: vp, issues: [...issues, ...errors.map((e) => `console error: ${e.slice(0, 160)}`)] });
  console.error(`${report.at(-1).issues.length ? 'ISSUES' : 'ok    '}  ${name} (${vp})${report.at(-1).issues.map((i) => `\n          - ${i}`).join('')}`);
}

for (const [vp, w, h, mobile] of VIEWPORTS) {
  // signed-out pages
  const g = await chrome.openPage({ width: w, height: h });
  await g.setViewport(w, h, mobile);
  for (const [name, path] of [['login', '/login%20page/login.html'], ['register', '/register%20page/register.html'], ['forgot-password', '/forgot_pass/forgot.html'], ['terms', '/terms/terms.html']]) {
    await ui(g).go(path); await audit(g, name, vp);
  }
  const link = (await mailTo(acct('dean'), 'approval-request')).at(-1)?.text.match(/approve\.html#[A-Za-z0-9_-]{24}/)?.[0];
  if (link) { await ui(g).go(`/approve/${link}`); await audit(g, 'approver-page', vp); }

  // an unverified student: the verification page
  const una = await chrome.openPage({ width: w, height: h });
  await una.setViewport(w, h, mobile);
  await signIn(una, acct('una.unverified'));
  await audit(una, 'verify-email', vp);

  // a student
  const s = await chrome.openPage({ width: w, height: h });
  await s.setViewport(w, h, mobile);
  const su = await signIn(s, acct('carla.lim'));
  for (const [name, path] of [['student-home', '/nav/main/main.html'], ['student-reserve', '/nav/reserve/reserve.html'], ['student-stubs', '/nav/stubs/stubs.html'], ['student-reservations', '/nav/reservations/reservations.html']]) {
    await su.go(path); await s.until("document.documentElement.hidden === false", name); await audit(s, name, vp, 2500);
  }

  // an administrator
  const ad = await chrome.openPage({ width: w, height: h });
  await ad.setViewport(w, h, mobile);
  const au = await signIn(ad, acct('admin'));
  await au.go('/nav/admin/admin.html');
  for (const view of ['overview', 'resources', 'tickets', 'reservations', 'workflow', 'ops', 'audit', 'settings']) {
    await ad.run(`location.hash = ${JSON.stringify(view)}; true`);
    await au.waitFor(`#view-${view}`, view);
    await audit(ad, `admin-${view}`, vp, 1800);
  }
}

writeFileSync(`${a.out}/ui-audit-results.json`, JSON.stringify(report, null, 2));
const bad = report.filter((r) => r.issues.length);
console.error(`\n${report.length - bad.length} of ${report.length} page views clean; ${bad.length} with issues`);
chrome.close();
process.exit(bad.length ? 1 : 0);
