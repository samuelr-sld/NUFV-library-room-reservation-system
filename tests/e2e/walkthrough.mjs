// Functional walkthrough of the whole system through the real UI, in headless Chrome, against the demonstration environment.
// Run by hand (not part of `npm test`):
//
//   1. npm run demo                      (starts emulators, API, website and seeds the demo accounts; leave it running)
//   2. node tests/e2e/walkthrough.mjs    [--out docs/evidence]
//
// It walks the student, administrator and external-approver workflows and the six cross-workflow scenarios (A to F), saving a
// screenshot per step and a results table. Every step records what was expected and what was actually observed. It needs a
// fresh `npm run demo` (it registers a new student and takes the free stubs and room slots).
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startChrome, sleep } from '../support/cdp.mjs';
import { SITE, API, PASSWORD, acct, tomorrow, ui, signIn, mailTo, waitMail } from './lib.mjs';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'docs/evidence' }, chrome: { type: 'string' } } });
mkdirSync(a.out, { recursive: true });
const chrome = await startChrome({ chrome: a.chrome });
const results = [];
const sessions = new Map(); // email -> { page, u }: one signed-in browser per person, reused across steps
const ctx = {};

async function as(email, password = PASSWORD) {
  if (!sessions.has(email)) {
    const page = await chrome.openPage();
    sessions.set(email, { page, u: await signIn(page, email, password) });
  }
  return sessions.get(email);
}
async function guest() { const page = await chrome.openPage(); return { page, u: ui(page) }; }

// One recorded step. fn returns the observed result as text, or { actual, page } to also save a screenshot of that page.
async function step(id, area, name, expected, fn) {
  const row = { id, area, name, expected, actual: '', status: 'FAIL', evidence: '' };
  try {
    const r = await fn();
    row.actual = typeof r === 'string' ? r : r.actual;
    row.status = 'PASS';
    if (r?.page) { row.evidence = `evidence/${id}.jpg`; await r.page.shot(`${a.out}/${id}.jpg`).catch(() => {}); }
  } catch (err) {
    row.actual = `FAILED: ${String(err.message).slice(0, 300)}`;
    const any = [...sessions.values()].at(-1)?.page;
    if (any) { row.evidence = `evidence/${id}-failure.jpg`; await any.shot(`${a.out}/${id}-failure.jpg`).catch(() => {}); }
  }
  results.push(row);
  console.error(`${row.status}  ${id}  ${name}${row.status === 'FAIL' ? `\n        ${row.actual}` : ''}`);
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- shared flows ----
async function adminView(u, name) {
  if (!u.page.navs.at(-1)?.includes('/nav/admin/')) await u.go('/nav/admin/admin.html');
  await u.page.until("document.documentElement.hidden === false", 'the dashboard');
  await u.page.run(`location.hash = ${JSON.stringify(name)}; true`);
  await u.waitFor(`#view-${name}`, `the ${name} view`);
  await sleep(700);
}
async function scan(u, reference) {
  await adminView(u, 'tickets');
  await u.page.run("document.querySelector('#manual-form button').closest('form').querySelector('#manual-ref').value = ''; true");
  await u.fill('#manual-ref', reference);
  await u.page.run("document.querySelector('#manual-form').requestSubmit(); true");
}
async function openStubs(u) { await u.go('/nav/stubs/stubs.html'); await u.page.until("document.documentElement.hidden === false && !document.querySelector('#service-grid .status.maintenance')", 'the stubs page and its availability'); }
async function generate(u, service) {
  await openStubs(u);
  await u.click(`[data-service="${service}"]`);
  await u.click('#generate');
  await u.page.until("!!document.querySelector('#stub-view') && !document.querySelector('#stub-view').hidden || !document.querySelector('#error').hidden", 'the stub or an error');
}
async function reserveForm(u, { room, date = tomorrow(), start, end, purpose, count = 2, other = 'Guest Participant' }) {
  await u.go('/nav/reserve/reserve.html');
  await u.page.until("document.documentElement.hidden === false && document.querySelectorAll('#room option').length > 1", 'the reservation form');
  await u.fill('#room', room);
  await u.fill('#date', date);
  await u.fill('#start-time', start);
  await u.page.until("document.querySelectorAll('#end-time option').length > 1", 'end times');
  await u.fill('#end-time', end);
  await u.fill('#num', String(count));
  for (let i = 0; i < count - 1; i++) await u.page.run(`document.querySelectorAll('.participant-row')[${i}].querySelector('input').value = ${JSON.stringify(`${other} ${i + 1}`)}; true`);
  await u.fill('#purpose', purpose);
}
const submitReservation = (u) => u.page.run("document.querySelector('.reservation-form').requestSubmit(); true");
async function reserve(u, spec) {
  await reserveForm(u, spec);
  await submitReservation(u);
  await u.waitFor('#reserve-status', 'the submit result');
  return u.text('#reserve-status');
}
async function approver(email, marker, decision, comment) {
  let notice;
  for (let t = 0; t < 20_000 && !notice; t += 500) { notice = (await mailTo(email, 'approval-request')).filter((m) => m.text.includes(marker)).at(-1); if (!notice) await sleep(500); }
  must(notice, `no review email for ${email} mentioning ${marker}`);
  const id = /#([A-Za-z0-9_-]{24})/.exec(notice.text)[1];
  const before = (await mailTo(email, 'approval-code')).length;
  const g = await guest();
  await g.u.go(`/approve/approve.html#${id}`);
  await g.u.waitFor('#step-start', 'the approval page');
  await g.u.click('#send-code');
  await g.u.waitFor('#step-code', 'the code form');
  const mail = await waitMail(email, 'approval-code', before + 1);
  await g.u.fill('#code', /code is (\d{6})/.exec(mail.text)[1]);
  await g.u.click('#verify');
  await g.u.waitFor('#step-review', 'the review');
  const review = await g.u.text('#facts');
  if (comment) await g.u.fill('#comment', comment);
  await g.u.click(decision === 'approve' ? '#approve' : '#reject');
  await g.u.waitFor('#step-done', 'the decision to be recorded');
  return { review, done: await g.u.text('#done-title'), page: g.page };
}

const DEAN = acct('dean'), ADVISER = acct('adviser');
const NORA = acct('nora.villanueva');
const SLOT = { date: tomorrow() };

// =====================================================================================================================
// Student: registration, verification, sign-in, recovery, Home
// =====================================================================================================================
await step('ST-01', 'Student', 'Registration form validates, then creates the account', 'An empty or inconsistent form goes nowhere; a valid one tells the student to verify email and returns to Login', async () => {
  const g = await guest();
  await g.u.go('/register%20page/register.html');
  await g.page.until("document.readyState === 'complete' && !document.querySelector('.submit-button').disabled", 'the form');
  // an empty submit is stopped by the browser's own required-field check before any script runs: nothing is sent, nothing navigates
  const blocked = await g.page.run("!document.querySelector('.register-form').checkValidity()");
  await g.page.run("document.querySelector('.register-form').requestSubmit(); true");
  await sleep(500);
  must(blocked && (await g.page.path()).includes('register'), `empty submit: blocked ${blocked}`);
  // a filled form with a mismatching confirmation is stopped by the page's own validation
  await g.u.fill('#username', 'Nora Villanueva'); await g.u.fill('#student-num', 'demo-1001'); await g.u.fill('#student-email', NORA);
  await g.u.fill('#password', 'nora1234'); await g.u.fill('#confirm-password', 'different');
  await g.page.run("(() => { const c = document.querySelector('.legal-checkbox'); if (!c.checked) c.click(); document.querySelector('.register-form').requestSubmit(); return true; })()");
  await sleep(500);
  const flagged = await g.u.count('.is-invalid');
  must(flagged >= 1 && (await g.page.path()).includes('register'), `mismatched passwords: ${flagged} flagged`);
  await g.u.fill('#username', 'Nora Villanueva'); await g.u.fill('#student-num', 'demo-1001'); await g.u.fill('#student-email', NORA);
  await g.u.fill('#password', 'nora1234'); await g.u.fill('#confirm-password', 'nora1234');
  await g.page.run("(() => { const c = document.querySelector('.legal-checkbox'); if (!c.checked) c.click(); document.querySelector('.register-form').requestSubmit(); return true; })()");
  await g.page.until("location.pathname.includes('login')", 'the return to Login');
  await g.u.waitText('.form-notice', /Account created/, 'the notice on the login page');
  const said = await g.u.text('.form-notice');
  return { actual: `empty submit blocked by the browser; mismatched passwords flagged (${flagged} field(s)); then the corrected form: Login now says "${said}"`, page: g.page };
});
await step('ST-02', 'Student', 'Email verification', 'An unverified account is held on the verification page; after the emailed link is opened, "I have verified" lets the student in', async () => {
  const s = await as(NORA, 'nora1234');
  must((await s.page.path()).includes('/nav/verify/'), `landed on ${await s.page.path()}`);
  await s.u.click('#refresh');
  await s.u.waitText('#status', /not verified yet/, 'the pending message');
  const mail = (await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-nufv/oobCodes')).json()).oobCodes.filter((c) => c.email === NORA && c.requestType === 'VERIFY_EMAIL').at(-1);
  must(mail, 'no verification email in the Auth emulator');
  await fetch(mail.oobLink); // what clicking the link in the email does
  await s.u.click('#refresh');
  await s.u.waitPath('/nav/main/main.html');
  return { actual: 'held on the verification page ("not verified yet"); after the link was opened, redirected to Student Home', page: s.page };
});
await step('ST-03', 'Student', 'Student Home shows real data only', 'Three demo rooms with status for now, no upcoming reservations, an honest announcements notice, the student number', async () => {
  const s = await as(NORA);
  await s.u.go('/nav/main/main.html');
  await s.u.waitFor('#rooms-table', 'the rooms');
  const rooms = await s.page.run("[...document.querySelectorAll('#room-rows tr')].map((r) => r.cells[0].innerText + ' = ' + r.cells[2].innerText)");
  must(rooms.length === 3, `rooms: ${rooms}`);
  await s.u.waitText('#upcoming-state', /no upcoming reservations|could not be loaded/i, 'the upcoming list to load');
  must(/no upcoming reservations/i.test(await s.u.text('#upcoming-state')), `upcoming: ${await s.u.text('#upcoming-state')}`);
  must(/no announcements/i.test(await s.page.run('document.body.innerText')), 'announcements notice missing');
  must(/DEMO-1001/.test(await s.u.text('.student-course')), 'student number missing (and upper-cased?)');
  return { actual: `rooms: ${rooms.join('; ')}; "${await s.u.text('#upcoming-state')}"; ${await s.u.text('.student-course')}`, page: s.page };
});
await step('ST-04', 'Student', 'Password recovery', 'The reset page gives the same answer for any address; the emailed link sets a new password that then works, the old one does not', async () => {
  const g = await guest();
  await g.u.go('/forgot_pass/forgot.html');
  await g.page.until("!document.querySelector('.submit-button').disabled", 'the form');
  const answers = [];
  for (const email of [NORA, acct('nobody.here')]) {
    await g.u.fill('#student-email', email);
    await g.page.run("document.querySelector('.form-notice') && (document.querySelector('.form-notice').textContent = ''); document.querySelector('.register-form').requestSubmit(); true");
    await g.u.waitText('.form-notice', /reset link/, 'the answer');
    answers.push(await g.u.text('.form-notice'));
  }
  must(answers[0] === answers[1], `answers differ: ${answers}`);
  const codes = (await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-nufv/oobCodes')).json()).oobCodes.filter((c) => c.requestType === 'PASSWORD_RESET');
  must(codes.length === 1 && codes[0].email === NORA, 'a reset email must exist only for the real account');
  const reset = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oobCode: codes[0].oobCode, newPassword: 'nora5678' }) });
  must(reset.ok, 'reset link refused');
  const old = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: NORA, password: 'nora1234', returnSecureToken: true }) });
  must(!old.ok, 'old password still works');
  sessions.get(NORA)?.page.close(); sessions.delete(NORA);
  await as(NORA, 'nora5678');
  return { actual: `same message for a real and an unknown address ("${answers[0].slice(0, 40)}..."); reset link worked once; old password refused; new password signs in`, page: g.page };
});
await step('ST-05', 'Student', 'Sign-in errors and denied accounts', 'Wrong password and unknown user look identical; the suspended and the unverified accounts are handled', async () => {
  const msgs = {};
  for (const [label, email, pw] of [['wrong password', acct('ana.reyes'), 'nope1234'], ['unknown user', acct('ghost'), 'nope1234'], ['suspended', acct('sam.suspended'), PASSWORD]]) {
    const g = await guest();
    await g.u.go('/login%20page/login.html');
    await g.page.until("!document.querySelector('.btn-primary').disabled", 'the form');
    await g.u.fill('#student-email', email); await g.u.fill('#password', pw);
    await g.page.run("document.querySelector('.login-form').requestSubmit(); true");
    await g.u.waitFor('.form-notice', 'the error message');
    msgs[label] = await g.u.text('.form-notice');
    must((await g.page.path()).includes('login'), `${label} left the login page`);
    await g.page.close();
  }
  must(msgs['wrong password'] === msgs['unknown user'], 'wrong password and unknown user differ');
  must(/not active/.test(msgs.suspended), `suspended: ${msgs.suspended}`);
  return `"${msgs['wrong password']}" (both wrong password and unknown user); suspended: "${msgs.suspended}"`;
});

// =====================================================================================================================
// Scenario A: stub, QR scan, check-in and check-out
// =====================================================================================================================
await step('A-01', 'Scenario A', 'Nora generates a Silent Room stub', 'A stub with a seat, a stub id and a QR code; it appears under Active stubs and in History', async () => {
  const s = await as(NORA);
  await generate(s.u, 'silent-room');
  const seat = await s.u.text('#stub-assignment'), id = await s.u.text('#stub-id');
  must(/^Silent Seat \d$/.test(seat) && /^SR-/.test(id), `${seat} / ${id}`);
  ctx.noraStub = { id, seat, qr: await s.u.decodeQr('#stub-qr') };
  must(ctx.noraStub.qr?.startsWith('NUFV1:'), `QR ${ctx.noraStub.qr}`);
  await sleep(800);
  must((await s.u.count('#active-list li')) === 1 && (await s.u.count('#history-rows tr')) === 1, 'lists not updated');
  return { actual: `${seat}, ${id}, QR decodes to ${ctx.noraStub.qr}; 1 active, 1 in history`, page: s.page };
});
await step('A-02', 'Scenario A', 'Administrator scans the QR payload', 'The scanner shows the student, the seat and "ISSUED"', async () => {
  const s = await as(acct('admin'));
  await scan(s.u, ctx.noraStub.qr);
  await s.u.waitFor('#ticket-panel', 'the ticket');
  const banner = await s.u.text('#ticket-banner'), facts = await s.u.text('#ticket-facts');
  must(/ISSUED/.test(banner) && /Nora Villanueva/.test(facts) && facts.includes(ctx.noraStub.id), `${banner} | ${facts}`);
  return { actual: `${banner.slice(0, 70)}; ${facts.replace(/\n/g, ' ').slice(0, 120)}`, page: s.page };
});
await step('A-03', 'Scenario A', 'Check-in needs the identity confirmation', 'The Check in button stays disabled until the ID box is ticked; then the student is checked in', async () => {
  const s = await as(acct('admin'));
  await s.u.waitFor('#do-check-in', 'the check-in button');
  must(await s.page.run("document.querySelector('#do-check-in').disabled"), 'enabled before the ID check');
  await s.u.click('#identity-check');
  must(!(await s.page.run("document.querySelector('#do-check-in').disabled")), 'still disabled after the ID check');
  await s.u.click('#do-check-in');
  await s.u.waitText('#ticket-feedback', /Checked in/, 'the confirmation');
  must(/CHECKED IN/.test(await s.u.text('#ticket-banner')), 'banner');
  return { actual: 'button disabled until ticked; then "Checked in." and banner CHECKED IN', page: s.page };
});
await step('A-04', 'Scenario A', 'Check-out frees the seat', 'The stub becomes "CHECKED OUT"; the student sees it in History; the seat is free again', async () => {
  const s = await as(acct('admin'));
  await s.u.click('#do-check-out');
  await s.u.waitText('#ticket-feedback', /Checked out/, 'the confirmation');
  const n = await as(NORA);
  await openStubs(n.u);
  const history = await n.u.text('#history-rows');
  must(/checked out/i.test(history) && (await n.u.count('#active-list li')) === 0, `history: ${history}`);
  const card = await n.u.text('[data-service="silent-room"]');
  must(/3 of 3 free/.test(card), `card: ${card}`);
  return { actual: `banner CHECKED OUT; student History shows checked out, Active empty; Silent Room card: "${card.replace(/\n/g, ' ')}"`, page: n.page };
});

// =====================================================================================================================
// Scenario B: Computer Station stub revoked
// =====================================================================================================================
await step('B-01', 'Scenario B', 'Ana generates a Computer Station stub', 'A stub with a computer, id CS-...', async () => {
  const s = await as(acct('ana.reyes'));
  await generate(s.u, 'computer-station');
  const seat = await s.u.text('#stub-assignment'), id = await s.u.text('#stub-id');
  must(/^Computer \d$/.test(seat) && /^CS-/.test(id), `${seat}/${id}`);
  ctx.anaStub = { id, seat };
  return { actual: `${seat}, ${id}`, page: s.page };
});
await step('B-02', 'Scenario B', 'Administrator revokes it with a reason', 'Revoking asks for a reason; the stub becomes REVOKED; the student loses it', async () => {
  const s = await as(acct('admin'));
  await scan(s.u, ctx.anaStub.id.toLowerCase()); // a typed ticket id, in lower case, works too
  await s.u.waitFor('#ticket-panel', 'the ticket');
  await s.u.click('#do-revoke');
  await s.u.fill('#revoke-reason', 'Demonstration: wrong student at the desk');
  await s.u.click('#confirm-revoke');
  await s.u.waitText('#ticket-banner', /REVOKED/, 'the revoked banner');
  const a1 = await as(acct('ana.reyes'));
  await openStubs(a1.u);
  must((await a1.u.count('#active-list li')) === 0 && /revoked/i.test(await a1.u.text('#history-rows')), 'student view');
  return { actual: `banner: ${(await s.u.text('#ticket-banner')).slice(0, 80)}; the student's Active list is empty and History shows revoked`, page: s.page };
});

// =====================================================================================================================
// Scenario C: Wi-Fi voucher
// =====================================================================================================================
await step('C-01', 'Scenario C', 'Ben generates a demo Wi-Fi voucher and retrieves its password', 'The voucher shows a clearly-marked demo password, the same one every time it is opened', async () => {
  const s = await as(acct('ben.cruz'));
  await generate(s.u, 'wifi-voucher');
  const pw = await s.u.text('#stub-password-value');
  must(/^DEMO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pw), `password ${pw}`);
  must(await s.u.visible('#stub-demo'), 'the DEMO banner must be visible');
  await s.u.click('#close-stub');
  await s.u.clickText('#active-list button', /View/);
  await s.u.waitFor('#stub-password-value');
  must((await s.u.text('#stub-password-value')) === pw, 'password changed between views');
  ctx.benVoucher = { pw, qr: await s.u.decodeQr('#stub-qr') };
  return { actual: `password ${pw} (demo banner shown, same password on reopening); QR ${ctx.benVoucher.qr}`, page: s.page };
});

// =====================================================================================================================
// Administrator: inventory and settings
// =====================================================================================================================
await step('AD-01', 'Administrator', 'Dashboard overview', 'Cards for the three resource types and the current settings', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'overview');
  await s.u.waitFor('#overview-body', 'the overview');
  const cards = await s.u.count('#type-cards .card'), facts = await s.u.count('#settings-facts div');
  must(cards === 3 && facts >= 7, `${cards} cards, ${facts} facts`);
  return { actual: `${cards} resource cards, ${facts} settings facts; ${await s.u.text('#type-cards .card:nth-child(1) .total')} silent seats`, page: s.page };
});
await step('AD-02', 'Administrator', 'Resource creation', 'A new computer station is added through the form and appears in the inventory', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'resources');
  await s.u.waitFor('#resource-table-wrap', 'the inventory');
  const before = await s.u.count('#resource-rows tr');
  await s.u.click('#add-resource');
  await s.u.fill('#f-id', 'pc-03'); await s.u.fill('#f-type', 'computer-station'); await s.u.fill('#f-label', 'Computer 3');
  await s.page.run("document.querySelector('#resource-form').requestSubmit(); true");
  await s.u.waitText('#resource-notice', /Resource added/, 'the confirmation');
  await sleep(600);
  must((await s.u.count('#resource-rows tr')) === before + 1, 'row count');
  return { actual: `${before} -> ${before + 1} resources; "${await s.u.text('#resource-notice')}"`, page: s.page };
});
await step('AD-03', 'Administrator', 'Resource validation', 'A duplicate identifier and an empty form are refused with a message', async () => {
  const s = await as(acct('admin'));
  await s.u.click('#add-resource');
  await s.page.run("document.querySelector('#resource-form').requestSubmit(); true");
  await s.u.waitText('#resource-error', /required/, 'the empty-form message');
  const empty = await s.u.text('#resource-error');
  await s.u.fill('#f-id', 'pc-03'); await s.u.fill('#f-label', 'Duplicate'); await s.u.fill('#f-type', 'computer-station');
  await s.page.run("document.querySelector('#resource-form').requestSubmit(); true");
  await s.u.waitText('#resource-error', /already|exists|taken/i, 'the duplicate message');
  const dup = await s.u.text('#resource-error');
  await s.u.click('#resource-cancel');
  return { actual: `empty: "${empty}"; duplicate: "${dup}"`, page: s.page };
});
await step('AD-04', 'Administrator', 'Maintenance and two-step retire', 'Two stations go into maintenance (a status change); a throwaway seat is retired only on the second click', async () => {
  const s = await as(acct('admin'));
  for (const id of ['pc-02', 'pc-03']) {
    await s.u.rowClick('#resource-rows tr', new RegExp(id), /Edit/);
    await s.u.fill('#f-status', 'maintenance');
    await s.page.run("document.querySelector('#resource-form').requestSubmit(); true");
    await s.u.waitText('#resource-notice', /Changes saved/, `${id} saved`);
    await sleep(500);
  }
  await s.u.click('#add-resource');
  await s.u.fill('#f-id', 'temp-01'); await s.u.fill('#f-type', 'silent-seat'); await s.u.fill('#f-label', 'Temporary seat');
  await s.page.run("document.querySelector('#resource-form').requestSubmit(); true");
  await s.u.waitText('#resource-notice', /Resource added/, 'temp created');
  await sleep(500);
  await s.u.rowClick('#resource-rows tr', /temp-01/, /^Retire$/);
  await sleep(300);
  must((await s.u.count('#resource-rows tr')) > 0 && !/was retired/.test(await s.u.text('#resource-notice')), 'retired on the first click');
  await s.u.rowClick('#resource-rows tr', /temp-01/, /Confirm retire/);
  await s.u.waitText('#resource-notice', /was retired/, 'retire confirmation');
  const rows = await s.page.run("[...document.querySelectorAll('#resource-rows tr')].map((r) => r.cells[0].innerText + ':' + r.cells[4].innerText)");
  must(rows.includes('pc-02:maintenance') && rows.includes('pc-03:maintenance') && rows.includes('temp-01:retired'), rows.join(','));
  return { actual: `pc-02 and pc-03 maintenance, temp-01 retired after a second "Confirm retire" click (${rows.length} rows)`, page: s.page };
});
await step('AD-05', 'Administrator', 'System settings', 'A setting is changed, versioned and restored', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'settings');
  await s.u.waitFor('#settings-form', 'the settings');
  const before = await s.u.value('#s-wifiVoucherMinutes');
  await s.u.fill('#s-wifiVoucherMinutes', '200');
  await s.page.run("document.querySelector('#settings-form').requestSubmit(); true");
  await s.u.waitText('#settings-notice', /Settings saved \(version \d+\)/, 'saved');
  const saved = await s.u.text('#settings-notice');
  await s.u.fill('#s-wifiVoucherMinutes', before);
  await s.page.run("document.querySelector('#settings-form').requestSubmit(); true");
  await s.u.waitText('#settings-notice', /Settings saved/, 'restored');
  await s.u.fill('#s-wifiVoucherMinutes', '5'); // below the minimum of 15
  await s.page.run("document.querySelector('#settings-form').requestSubmit(); true");
  await s.u.waitFor('#settings-error', 'the validation message');
  return { actual: `${before} -> 200 ("${saved}") -> restored; 5 minutes refused: "${await s.u.text('#settings-error')}"`, page: s.page };
});
await step('AD-06', 'Administrator', 'Scanner rejects what is not a library code', 'Garbage gets a clear message; an unknown but well-formed code is "no match"', async () => {
  const s = await as(acct('admin'));
  await scan(s.u, 'hello world');
  await s.u.waitFor('#lookup-state', 'a message');
  const invalid = await s.u.text('#lookup-state');
  await scan(s.u, 'NUFV1:AAAAAAAAAAAAAAAAAAAAAAAA');
  await s.u.waitText('#lookup-state', /No stub matches/, 'unknown code');
  await scan(s.u, 'NUFR1:AAAAAAAAAAAAAAAAAAAAAAAA');
  await s.u.waitText('#lookup-state', /No reservation matches/, 'unknown reservation code');
  return { actual: `"${invalid.slice(0, 60)}..."; unknown stub: "No stub matches this code."; unknown reservation: "No reservation matches this code."`, page: s.page };
});

// =====================================================================================================================
// Scenario D: reservation, sequential external approval, final approval, confirmation QR
// =====================================================================================================================
await step('D-01', 'Scenario D', 'Carla submits a reservation (form validation first)', 'An incomplete form is refused in place; a complete one is submitted and waits for the Dean', async () => {
  const s = await as(acct('carla.lim'));
  await s.u.go('/nav/reserve/reserve.html');
  await s.page.until("document.documentElement.hidden === false && document.querySelectorAll('#room option').length > 1", 'the form');
  const invalid = await s.page.run("!document.querySelector('.reservation-form').checkValidity()");
  await submitReservation(s.u);
  await sleep(500);
  const incomplete = `blocked by the browser's required-field check (${invalid ? 'form invalid' : 'form VALID?'}); no request sent`;
  must(invalid && !(await s.u.visible('#reserve-status')), incomplete);
  const msg = await reserve(s.u, { room: 'room-a', start: '9:00 AM', end: '10:00 AM', purpose: 'Thesis defense rehearsal', count: 2, other: 'Mia Cortez' });
  must(/Request submitted \(RS-/.test(msg) && /College Dean/.test(msg), msg);
  ctx.carlaRes = /RS-[0-9A-Z]{10}/.exec(msg)[0];
  return { actual: `empty form: ${incomplete}; then: "${msg.slice(0, 110)}"`, page: s.page };
});
await step('D-02', 'Scenario D', 'The Dean approves through the emailed link', 'Link -> request a code -> code from the email -> review shows the student and room -> approve', async () => {
  const r = await approver(DEAN, 'Thesis defense rehearsal', 'approve', 'Approved for the defense rehearsal');
  must(/Carla Lim/.test(r.review) && /Discussion Room A/.test(r.review), r.review);
  return { actual: `review showed: ${r.review.replace(/\n/g, ' ').slice(0, 130)}; result: "${r.done}"`, page: r.page };
});
await step('D-03', 'Scenario D', 'The Library Adviser approves next, only after the Dean', 'The second approver is notified only now; approving moves it to the final administrator', async () => {
  const r = await approver(ADVISER, 'Thesis defense rehearsal', 'approve');
  const s = await as(acct('carla.lim'));
  await s.u.go('/nav/reservations/reservations.html');
  await s.u.waitFor('#reservation-list .res-card', 'the list');
  const tracker = await s.u.text('#reservation-list .tracker');
  must(/College Dean: approved/.test(tracker) && /Library Adviser: approved/.test(tracker) && /Final administrator approval: waiting for a decision/.test(tracker), tracker);
  return { actual: `student's progress: ${tracker.replace(/\n/g, ' | ')}`, page: s.page };
});
await step('D-04', 'Scenario D', 'Administrator gives the final approval', 'The request appears as "Needs your decision"; approving confirms the booking', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'reservations');
  await s.u.waitFor('#res-table-wrap', 'the queue');
  must(/Needs your decision/.test(await s.u.text('#res-rows')), 'not shown as needing a decision');
  await s.u.rowClick('#res-rows tr', /Carla Lim/, /Open/);
  await s.u.waitFor('#final-approve', 'the final approval button');
  await s.u.click('#final-approve');
  await s.u.waitText('#res-feedback', /confirmed/i, 'the confirmation');
  await sleep(800);
  return { actual: `"${await s.u.text('#res-feedback')}"`, page: s.page };
});
await step('D-05', 'Scenario D', 'The student gets a confirmation with a QR; the administrator verifies it', 'The confirmation shows reference RC-..., its QR decodes to NUFR1:..., and scanning it shows a confirmed booking that is not valid yet', async () => {
  const s = await as(acct('carla.lim'));
  await s.u.go('/nav/reservations/reservations.html');
  await s.u.clickText('#reservation-list button', /View \/ print/);
  await s.u.waitFor('#c-qr');
  await s.page.until("document.querySelector('#c-qr').complete && document.querySelector('#c-qr').naturalWidth > 0", 'the QR');
  const ref = await s.u.text('#c-ref'), qr = await s.u.decodeQr('#c-qr');
  must(/^RC-/.test(ref) && qr?.startsWith('NUFR1:'), `${ref} / ${qr}`);
  ctx.confirmation = { ref, qr };
  const ad = await as(acct('admin'));
  await scan(ad.u, qr);
  await ad.u.waitFor('#reservation-panel', 'the reservation');
  const banner = await ad.u.text('#reservation-banner'), facts = await ad.u.text('#reservation-facts');
  must(/CONFIRMED/.test(banner) && /Not valid right now/.test(banner) && /Carla Lim/.test(facts) && /Discussion Room A/.test(facts), `${banner} | ${facts}`);
  await scan(ad.u, ref); // the printed reference works as well as the QR
  await ad.u.waitText('#reservation-banner', /CONFIRMED/, 'the reference lookup');
  return { actual: `confirmation ${ref}; QR ${qr}; scanner: ${banner.slice(0, 90)}`, page: ad.page };
});
await step('D-06', 'Scenario D', 'A rejection reaches the student with its reason', 'The Dean rejects with a comment; the student sees Rejected and the reason; the room is released', async () => {
  const s = await as(acct('carla.lim'));
  const msg = await reserve(s.u, { room: 'room-c', start: '11:00 AM', end: '12:00 PM', purpose: 'Faculty-room request (to be rejected)', count: 2 });
  must(/Request submitted/.test(msg), msg);
  const r = await approver(DEAN, 'Faculty-room request', 'reject', 'Room reserved for a faculty meeting');
  await s.u.go('/nav/reservations/reservations.html');
  await s.u.waitText('#reservation-list', /Reason given: Room reserved for a faculty meeting/, 'the reason');
  return { actual: `Dean: "${r.done}"; student sees: "Reason given: Room reserved for a faculty meeting"`, page: s.page };
});

// =====================================================================================================================
// Scenario E: competition for the last computer and for one room slot
// =====================================================================================================================
await step('E-01', 'Scenario E', 'Two students race for the last free computer station', 'Exactly one gets a stub; the other is told none is free', async () => {
  const [d, e] = [await as(acct('dev.patel')), await as(acct('eli.tan'))];
  await Promise.all([openStubs(d.u), openStubs(e.u)]);
  const card = await d.u.text('[data-service="computer-station"]');
  must(/1 of 1 free/.test(card), `before the race: ${card}`);
  await Promise.all([d.u.click('[data-service="computer-station"]'), e.u.click('[data-service="computer-station"]')]);
  await Promise.all([d.u.click('#generate'), e.u.click('#generate')]);
  // each side settles on either a stub or an error message; wait for that, not for a fixed time
  await Promise.all([d, e].map((x) => x.page.until("(!!document.querySelector('#stub-view') && !document.querySelector('#stub-view').hidden) || !document.querySelector('#error').hidden", 'an outcome')));
  const got = await Promise.all([d, e].map(async (x) => ({ stub: await x.u.visible('#stub-view'), error: await x.u.text('#error') })));
  must(got.filter((g) => g.stub).length === 1, `outcomes: ${JSON.stringify(got)}`);
  const loser = got.find((g) => !g.stub);
  ctx.computerWinner = got[0].stub ? 'dev' : 'eli';
  return { actual: `winner: ${ctx.computerWinner}; the other saw: "${loser.error || 'the card now shows none free'}"`, page: (got[0].stub ? e : d).page };
});
await step('E-02', 'Scenario E', 'Two students submit the same room and time at the same moment', 'Exactly one request is accepted; the other is told the slot is taken', async () => {
  const [d, e] = [await as(acct('dev.patel')), await as(acct('eli.tan'))];
  const spec = { room: 'room-b', start: '1:00 PM', end: '2:00 PM', purpose: 'Race for the same slot', count: 2 };
  await Promise.all([reserveForm(d.u, spec), reserveForm(e.u, spec)]);
  await Promise.all([submitReservation(d.u), submitReservation(e.u)]);
  await Promise.all([d, e].map((x) => x.u.waitFor('#reserve-status', 'the submit result')));
  const msgs = await Promise.all([d, e].map((x) => x.u.text('#reserve-status')));
  const wins = msgs.filter((m) => /Request submitted/.test(m)), losses = msgs.filter((m) => /already reserved or being reviewed/.test(m));
  must(wins.length === 1 && losses.length === 1, JSON.stringify(msgs));
  ctx.slotWinner = /Request submitted/.test(msgs[0]) ? 'dev.patel' : 'eli.tan';
  ctx.slotLoser = ctx.slotWinner === 'dev.patel' ? 'eli.tan' : 'dev.patel';
  ctx.slotRes = /RS-[0-9A-Z]{10}/.exec(wins[0])[0];
  return { actual: `winner ${ctx.slotWinner} (${ctx.slotRes}); the other saw: "${losses[0].slice(0, 100)}"`, page: (ctx.slotLoser === 'dev.patel' ? d : e).page };
});

// =====================================================================================================================
// Scenario F: cancellation releases the slot
// =====================================================================================================================
await step('F-01', 'Scenario F', 'The winner cancels (two-step) and the room is released', 'Cancel asks for a second click; the reservation shows cancelled', async () => {
  const s = await as(acct(ctx.slotWinner));
  await s.u.go('/nav/reservations/reservations.html');
  await s.u.waitFor('#reservation-list .res-card', 'the list');
  await s.u.clickText('#reservation-list button', /^Cancel reservation$/);
  await sleep(300);
  must(/Confirm cancel/.test(await s.u.text('#reservation-list')), 'no second step');
  await s.u.clickText('#reservation-list button', /Confirm cancel/);
  await s.u.waitText('#list-notice', /cancelled/i, 'the notice');
  await sleep(700);
  must(/cancelled/.test(await s.u.text('#reservation-list .status')), 'status not cancelled');
  return { actual: `"${await s.u.text('#list-notice')}"; card status: cancelled`, page: s.page };
});
await step('F-02', 'Scenario F', 'The other student now gets the same slot', 'The same room and time that was refused a moment ago is accepted', async () => {
  const s = await as(acct(ctx.slotLoser));
  const msg = await reserve(s.u, { room: 'room-b', start: '1:00 PM', end: '2:00 PM', purpose: 'Second try for the same slot', count: 2 });
  must(/Request submitted/.test(msg), msg);
  return { actual: `"${msg.slice(0, 90)}"`, page: s.page };
});

// =====================================================================================================================
// Administrator: reservations, approval chain, audit, operations
// =====================================================================================================================
await step('AD-07', 'Administrator', 'Reservation management', 'Statuses are filterable; confirmed, rejected, cancelled and pending requests are each listed', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'reservations');
  const seen = {};
  for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
    await s.u.fill('#res-status', status);
    await sleep(1500);
    seen[status] = await s.u.count('#res-rows tr');
  }
  must(seen.pending >= 1 && seen.confirmed === 1 && seen.rejected === 1 && seen.cancelled === 1, JSON.stringify(seen));
  return { actual: `rows per status: ${JSON.stringify(seen)}`, page: s.page };
});
await step('AD-08', 'Administrator', 'Approval workflow configuration', 'The chain is edited (step time), saved with a new version, and restored', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'workflow');
  await s.u.waitFor('#wf-form', 'the chain editor');
  const steps = await s.u.count('#wf-steps .wf-step');
  const hours = await s.u.value('#wf-hours');
  await s.u.fill('#wf-hours', '24');
  await s.page.run("document.querySelector('#wf-form').requestSubmit(); true");
  await s.u.waitText('#wf-notice', /Approval chain saved/, 'saved');
  const meta = await s.u.text('#wf-meta');
  await s.u.fill('#wf-hours', hours);
  await s.page.run("document.querySelector('#wf-form').requestSubmit(); true");
  await s.u.waitText('#wf-notice', /Approval chain saved/, 'restored');
  return { actual: `${steps} approvers; ${hours} h -> 24 h saved ("${meta}") -> restored`, page: s.page };
});
await step('AD-09', 'Administrator', 'Audit log', 'Events are listed newest first with who and why; filtering by event type works', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'audit');
  await s.u.waitFor('#audit-table-wrap', 'the log');
  const total = await s.u.count('#audit-rows tr');
  await s.u.fill('#audit-filter', 'ticket.revoked');
  await s.page.run("document.querySelector('#audit-form').requestSubmit(); true");
  await sleep(1200);
  const rows = await s.page.run("[...document.querySelectorAll('#audit-rows tr')].map((r) => r.cells[1].innerText + ' | ' + r.cells[2].innerText + ' | ' + r.cells[5].innerText)");
  must(rows.length === 1 && /Demo Administrator/.test(rows[0]) && /wrong student/.test(rows[0]), rows.join('; '));
  return { actual: `${total} events; filtered "ticket.revoked": ${rows[0]}`, page: s.page };
});
await step('AD-10', 'Administrator', 'Operations and diagnostics', 'Pending approval steps and email counts are shown; the consistency check agrees with itself', async () => {
  const s = await as(acct('admin'));
  await adminView(s.u, 'ops');
  await s.page.until("document.querySelector('#ops-approvals-state').hidden && document.querySelector('#ops-email-state').hidden", 'loaded');
  const pending = await s.u.text('#ops-pending'), counts = (await s.u.text('#ops-email-counts')).replace(/\n/g, ' ');
  await s.u.click('#ops-diag-run');
  await s.u.waitText('#ops-diag', /Everything agrees/, 'the diagnostics');
  return { actual: `waiting on approvers: ${pending.split('\n').slice(4, 6).join(' / ')}; email: ${counts}; "${(await s.u.text('#ops-diag')).split('\n')[0]}"`, page: s.page };
});

// =====================================================================================================================
console.log(JSON.stringify(results, null, 2));
writeFileSync(`${a.out}/walkthrough-results.json`, JSON.stringify(results, null, 2));
const md = ['| ID | Area | Test case | Expected | Actual (observed) | Result | Evidence |', '|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.area} | ${r.name} | ${r.expected} | ${r.actual.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${r.status} | ${r.evidence ? `[${r.evidence}](${r.evidence})` : ''} |`)];
writeFileSync(`${a.out}/walkthrough-results.md`, md.join('\n') + '\n');
console.error(`\n${results.filter((r) => r.status === 'PASS').length} of ${results.length} steps passed`);
chrome.close();
process.exit(results.every((r) => r.status === 'PASS') ? 0 : 1);
