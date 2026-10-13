// Print and QR check, run by hand (not part of `npm test`: it needs Chrome and a running local stack).
//
//   1. firebase emulators:start --only auth,firestore --project demo-nufv     (or npm run emulators)
//   2. npm run server        3. npm run serve-public (serves public/ on :5000 with the firebase.json headers)
//   4. node tests/print/print-check.mjs --out <dir> --admin <email> --silent <email> --computer <email> --wifi <email> --reservation <email>
//
// Every account is an existing, verified, active student in the emulator with the shared --password (default "demo1234", the demo accounts of `npm run demo`);
// the script issues the stub if the student has none, and the reservation student needs a confirmed reservation.
// For each document it opens the real page in headless Chrome (a clean browser profile each time), switches to print media,
// writes the page as a PDF and a PNG, counts the pages, decodes the QR code as printed with the vendored jsQR, checks that the
// payload matches the API and that the admin scanner resolves it, and checks nothing but the printable document is visible.
// It is a rendering check, not a camera test: no physical scanner or printer is involved.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startChrome, DEFAULT_CHROME, sleep } from '../support/cdp.mjs';

const { values: a } = parseArgs({ options: {
  out: { type: 'string' }, admin: { type: 'string' }, silent: { type: 'string' }, computer: { type: 'string' }, wifi: { type: 'string' }, reservation: { type: 'string' },
  password: { type: 'string', default: 'demo1234' }, chrome: { type: 'string', default: DEFAULT_CHROME },
  site: { type: 'string', default: 'http://localhost:5000' }, api: { type: 'string', default: 'http://localhost:3000' },
} });
mkdirSync(a.out, { recursive: true });
const jsQRSource = readFileSync('public/vendor/jsqr/jsQR.js', 'utf8');

// ---- the emulator API, from Node ----
const token = async (email) => (await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: a.password, returnSecureToken: true }) })).json()).idToken;
const api = async (email, method, path, body) => {
  const res = await fetch(a.api + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(email)}` }, body: body && JSON.stringify(body) });
  return res.json();
};

// ---- Chrome, through the shared driver ----
const chrome = await startChrome({ chrome: a.chrome });
const openPage = async () => { const p = await chrome.openPage({ width: 1280, height: 900 }); return { ...p, close: async () => { await p.close(); await chrome.disposeContext(p); } }; };

// ---- the check ----
const results = [];
async function check({ name, email, open, expectPrefix, payloadOf }) {
  const p = await openPage();
  try {
    await p.go(`${a.site}/login%20page/login.html`);
    await p.until("document.readyState === 'complete' && !document.querySelector('.btn-primary').disabled", 'the login form to be ready');
    await p.run(`document.getElementById('student-email').value = ${JSON.stringify(email)}; document.getElementById('password').value = ${JSON.stringify(a.password)}; document.querySelector('.login-form').requestSubmit(); true`);
    await p.until("location.pathname.includes('/nav/main/')", 'sign-in');
    const shown = await open(p); // opens the document on screen and returns the selectors { root, img }
    await p.until(`(() => { const i = document.querySelector(${JSON.stringify(shown.img)}); return i && i.complete && i.naturalWidth > 0 && !document.querySelector(${JSON.stringify(shown.root)}).hidden; })()`, 'the document and its QR code');

    await p.call('Emulation.setEmulatedMedia', { media: 'print' });
    await p.call('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 2, mobile: false }); // A4 at 96 dpi
    const measured = await p.run(`(async () => {
      ${jsQRSource}
      const jsQR = self.jsQR;
      const root = document.querySelector(${JSON.stringify(shown.root)});
      const img = document.querySelector(${JSON.stringify(shown.img)});
      const r = img.getBoundingClientRect();
      const paper = { w: 794 };
      const decodeAt = (scale) => {
        const c = document.createElement('canvas'); c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
        const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height); return jsQR(d.data, d.width, d.height)?.data ?? null;
      };
      // modules across = the decoded matrix size; measured from the SVG's own viewBox: size + 2 (margin 1 each side)
      const svg = decodeURIComponent(img.src.split(',')[1]);
      const viewBox = /viewBox="0 0 (\\d+) (\\d+)"/.exec(svg);
      const units = Number(viewBox[1]);
      const modulePx = r.width / units;
      const others = [...root.querySelectorAll('*')].filter((e) => !e.contains(img) && !img.contains(e) && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none');
      const gaps = others.map((e) => { const b = e.getBoundingClientRect(); const dx = Math.max(b.left - r.right, r.left - b.right, 0); const dy = Math.max(b.top - r.bottom, r.top - b.bottom, 0); return { g: dx || dy ? Math.hypot(dx, dy) : Infinity, el: e.tagName + '.' + e.className + '#' + e.id }; }).filter((x) => x.g > 0);
      const nearest = gaps.reduce((m, x) => (x.g < m.g ? x : m));
      const rootBox = root.querySelector('.stub')?.getBoundingClientRect() ?? root.getBoundingClientRect();
      const visibleOutside = [...document.querySelectorAll('body *')].filter((e) => !root.contains(e) && !e.contains(root) && getComputedStyle(e).display !== 'none' && !['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE'].includes(e.tagName) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0).map((e) => e.tagName + '.' + e.className);
      const text = root.innerText;
      return { decoded: decodeAt(1), decodedSmaller: decodeAt(0.6), qrPx: Math.round(r.width), qrMm: +(r.width * 25.4 / 96).toFixed(1), modules: units, modulePx: +modulePx.toFixed(2), moduleMm: +(modulePx * 25.4 / 96).toFixed(2),
        quietModules: +(1 + nearest.g / modulePx).toFixed(1), nearest: nearest.el + ' ' + Math.round(nearest.g) + 'px', docWidth: Math.round(rootBox.width), docHeight: Math.round(rootBox.height), paperWidth: paper.w, overflowsX: rootBox.right > paper.w, visibleOutside,
        longTokens: (text.match(/[A-Za-z0-9_-]{20,}/g) ?? []), text };
    })()`);

    const pdf = await p.call('Page.printToPDF', { paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.47, marginBottom: 0.47, marginLeft: 0.47, marginRight: 0.47, printBackground: true, preferCSSPageSize: true });
    const bytes = Buffer.from(pdf.data, 'base64');
    writeFileSync(join(a.out, `${name}.pdf`), bytes);
    const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const shot = await p.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(a.out, `${name}.png`), Buffer.from(shot.data, 'base64'));

    const expected = await payloadOf(measured.text);
    const scan = measured.decoded ? await api(a.admin, 'POST', '/api/admin/qr/resolve', { reference: measured.decoded }) : null;
    const { text, ...rest } = measured;
    results.push({ name, pages, ...rest, expectedPayload: expected === measured.decoded, prefixOk: measured.decoded?.startsWith(expectPrefix) ?? false, scannerKind: scan?.kind ?? scan?.error?.code, pdfBytes: bytes.length });
  } finally {
    await p.close().catch(() => {});
  }
}

const stubCase = (name, email, service, prefix) => check({
  name, email, expectPrefix: prefix,
  open: async (p) => {
    const made = await api(email, 'POST', '/api/tickets', { service }); // idempotent: returns the student's active stub if there is one
    if (!made.ticket) throw new Error(`${name}: ${JSON.stringify(made)}`);
    await p.go(`${a.site}/nav/stubs/stubs.html`);
    await p.until("document.querySelector('#active-list button')", 'the stub list');
    await p.run("document.querySelector('#active-list button').click(); true");
    return { root: '#stub-view', img: '#stub-qr' };
  },
  payloadOf: async (text) => { const id = /\b(SR|CS|WF)-[0-9A-HJKMNP-TV-Z]{10}\b/.exec(text)[0]; return (await api(email, 'GET', `/api/tickets/${id}/print`)).ticket.qrPayload; },
});

if (a.silent) await stubCase('silent-room-stub', a.silent, 'silent-room', 'NUFV1:');
if (a.computer) await stubCase('computer-station-stub', a.computer, 'computer-station', 'NUFV1:');
if (a.wifi) await stubCase('wifi-voucher', a.wifi, 'wifi-voucher', 'NUFV1:');
if (a.reservation) {
  await check({
    name: 'reservation-confirmation', email: a.reservation, expectPrefix: 'NUFR1:',
    open: async (p) => {
      await p.go(`${a.site}/nav/reservations/reservations.html`);
      await p.until("[...document.querySelectorAll('#reservation-list button')].some((b) => /View/.test(b.textContent))", 'a confirmed reservation');
      await p.run("[...document.querySelectorAll('#reservation-list button')].find((b) => /View/.test(b.textContent)).click(); true");
      return { root: '#confirmation', img: '#c-qr' };
    },
    payloadOf: async (text) => {
      const ref = /RC-[0-9A-HJKMNP-TV-Z]{10}/.exec(text)[0];
      const mine = (await api(a.reservation, 'GET', '/api/reservations')).reservations.find((r) => r.confirmationRef === ref);
      return mine.qrPayload;
    },
  });
}

console.log(JSON.stringify(results, null, 2));
chrome.close();
process.exit(results.every((r) => r.pages === 1 && r.decoded && r.expectedPayload && r.prefixOk && !r.overflowsX && !r.visibleOutside.length) ? 0 : 1);
