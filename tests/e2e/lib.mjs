// Helpers shared by the hand-run browser checks that drive the real UI (walkthrough.mjs, ui-audit.mjs).
// They sit on the shared Chrome driver in tests/support/cdp.mjs.
import { readFileSync } from 'node:fs';
import { sleep } from '../support/cdp.mjs';

export const SITE = 'http://localhost:5000';
export const API = 'http://localhost:3000';
export const DOMAIN = 'demo.nufv.test';
export const PASSWORD = 'demo1234';
export const acct = (name) => `${name}@${DOMAIN}`;
const JSQR = readFileSync('public/vendor/jsqr/jsQR.js', 'utf8');

export const tomorrow = () => new Date(Date.now() + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10); // the library's local date, Asia/Manila

// A page with the small vocabulary the scenarios use. Selectors are CSS; text matching is by regular expression.
export function ui(page) {
  const q = (sel) => JSON.stringify(sel);
  const api = {
    page,
    go: (path) => page.go(path.startsWith('http') ? path : SITE + path),
    exists: (sel) => page.run(`!!document.querySelector(${q(sel)})`),
    visible: (sel) => page.run(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !e.hidden && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && !e.closest('[hidden]'); })()`),
    text: (sel) => page.run(`(document.querySelector(${q(sel)})?.innerText ?? '').trim()`),
    count: (sel) => page.run(`document.querySelectorAll(${q(sel)}).length`),
    value: (sel) => page.run(`document.querySelector(${q(sel)}).value`),
    waitFor: (sel, what = sel, ms = 15000) => page.until(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !e.hidden && !e.closest('[hidden]'); })()`, what, ms),
    waitText: (sel, re, what, ms = 15000) => page.until(`new RegExp(${q(re.source)}, ${q(re.flags)}).test((document.querySelector(${q(sel)})?.innerText ?? ''))`, what ?? `${sel} to match ${re}`, ms),
    waitPath: (path, ms = 15000) => page.until(`location.pathname === ${q(path)}`, `to reach ${path}`, ms),
    click: async (sel) => { await api.waitFor(sel, `${sel} to be there`); await page.run(`document.querySelector(${q(sel)}).click(); true`); },
    // Clicks the first button (or link) inside `within` whose text matches.
    clickText: async (within, re) => {
      await page.until(`[...document.querySelectorAll(${q(within)})].some((e) => new RegExp(${q(re.source)}, ${q(re.flags)}).test(e.innerText))`, `${re} inside ${within}`);
      await page.run(`[...document.querySelectorAll(${q(within)})].find((e) => new RegExp(${q(re.source)}, ${q(re.flags)}).test(e.innerText)).click(); true`);
    },
    fill: (sel, value) => page.run(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    // A row of a table whose first cell (or any cell) contains the text.
    rowClick: (rowSel, re, btnRe) => page.run(`(() => { const row = [...document.querySelectorAll(${q(rowSel)})].find((r) => new RegExp(${q(re.source)}, ${q(re.flags)}).test(r.innerText)); const b = [...row.querySelectorAll('button')].find((x) => new RegExp(${q(btnRe.source)}, ${q(btnRe.flags)}).test(x.innerText)); b.click(); return true; })()`),
    // Reads a QR code off the page the way a scanner would: draws the image and decodes it with the vendored jsQR.
    decodeQr: (imgSel) => page.run(`(async () => { ${JSQR}
      const img = document.querySelector(${q(imgSel)}); const c = document.createElement('canvas'); c.width = img.naturalWidth * 4; c.height = img.naturalHeight * 4;
      const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height); return self.jsQR(d.data, d.width, d.height)?.data ?? null; })()`),
  };
  return api;
}

export async function signIn(page, email, password = PASSWORD) {
  const u = ui(page);
  await u.go('/login%20page/login.html');
  await page.until("document.readyState === 'complete' && !document.querySelector('.btn-primary').disabled", 'the login form');
  await u.fill('#student-email', email);
  await u.fill('#password', password);
  await page.run("document.querySelector('.login-form').requestSubmit(); true");
  await page.until("!location.pathname.includes('login')", `sign-in of ${email}`);
  await page.until("document.documentElement.hidden === false || location.pathname.includes('verify')", 'the page to be shown');
  return u;
}

// What the local email sink holds (the same data the demo viewer shows).
export async function mailTo(email, kind) {
  const { messages } = await (await fetch(`${API}/api/dev/mail?to=${encodeURIComponent(email)}`)).json();
  return messages.filter((m) => !kind || m.kind === kind);
}
export async function waitMail(email, kind, count = 1, ms = 20000) {
  for (let t = 0; t < ms; t += 400) {
    const m = await mailTo(email, kind);
    if (m.length >= count) return m.at(-1);
    await sleep(400);
  }
  throw new Error(`no ${kind} email for ${email}`);
}

// ---- the page audit used by ui-audit.mjs and the walkthrough ----
export const AUDIT = `(() => {
  const issues = [];
  const shown = (e) => !e.hidden && !e.closest('[hidden]') && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth + 1) issues.push('horizontal overflow: page is ' + de.scrollWidth + 'px wide in a ' + innerWidth + 'px viewport');
  if (!de.lang) issues.push('missing <html lang>');
  if (!document.title.trim()) issues.push('empty <title>');
  const ids = {}; document.querySelectorAll('[id]').forEach((e) => { ids[e.id] = (ids[e.id] ?? 0) + 1; });
  for (const [id, n] of Object.entries(ids)) if (n > 1) issues.push('duplicate id #' + id);
  document.querySelectorAll('img').forEach((i) => { if (shown(i) && !i.hasAttribute('alt')) issues.push('image without alt: ' + (i.id || i.src.slice(-30))); });
  const named = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || '').trim() || (e.innerText || '').trim();
  document.querySelectorAll('button, a[href]').forEach((e) => { if (shown(e) && !named(e) && !e.querySelector('img[alt]:not([alt=""])')) issues.push('button or link without a name: ' + (e.id || e.className || e.getAttribute('href'))); });
  document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach((e) => {
    if (!shown(e) || e.type === 'submit') return;
    if (!((e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))) issues.push('form control without a label: ' + (e.id || e.name || e.placeholder));
  });
  const small = [...document.querySelectorAll('button, a.menu-item, input, select')].filter((e) => shown(e) && e.type !== 'checkbox' && (e.getBoundingClientRect().height < 24 || e.getBoundingClientRect().width < 24));
  small.slice(0, 3).forEach((e) => issues.push('tiny tap target (' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + '): ' + (e.id || e.className || e.tagName)));
  [...document.querySelectorAll('input:not([type=checkbox]):not([type=hidden]), select, textarea')].filter((e) => shown(e) && e.getBoundingClientRect().width < 120 && !e.closest('.participant-row')).slice(0, 3).forEach((e) => issues.push('cramped form control (' + Math.round(e.getBoundingClientRect().width) + 'px wide): ' + (e.id || e.placeholder)));
  const clipped = [...document.querySelectorAll('body *')].filter((e) => shown(e) && !e.closest('.sidebar, .table-scroll, .table-panel, .table-wrap, pre, table') && e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && getComputedStyle(e).position !== 'absolute');
  clipped.slice(0, 3).forEach((e) => issues.push('content wider than the screen: ' + e.tagName + '.' + e.className + '#' + e.id));
  return issues;
})()`;
