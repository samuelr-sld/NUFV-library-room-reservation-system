// External approver page. No account: access is a one-time code sent to the address the request was sent to.
// The link only names the request step (in the URL fragment, so it is never sent to a server by the browser itself);
// it shows nothing and cannot approve. The session secret lives only in this page's memory.
import { publicApi } from '../js/api.js';
import { demoMailNote } from '../js/dom.js';

const $ = (selector) => document.querySelector(selector);
const id = location.hash.slice(1);
let session = null;

const STEPS = ['loading', 'step-start', 'step-code', 'step-review', 'step-done', 'step-closed'];
function show(name) {
  for (const s of STEPS) $(`#${s}`).hidden = s !== name;
}
function say(text, ok = false) {
  const m = $('#message');
  m.hidden = !text;
  m.textContent = text ?? '';
  m.classList.toggle('ok', ok);
}
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function start() {
  if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return show('step-closed');
  try {
    const info = await publicApi(`/api/approvals/${id}`, { method: 'GET' });
    if (info.state !== 'open') return show('step-closed');
    $('#start-title').textContent = `Approval requested: ${info.stepLabel}`;
    $('#email-hint').textContent = $('#email-hint-2').textContent = info.emailHint;
    show('step-start');
  } catch (err) {
    show('step-closed');
    say(err.message, false);
  }
}

let cooling = null;
function cooldown(button, label, seconds = 30) {
  let left = seconds;
  button.disabled = true;
  clearInterval(cooling);
  cooling = setInterval(() => {
    button.textContent = `${label} (${--left}s)`;
    if (left <= 0) { clearInterval(cooling); button.textContent = label; button.disabled = false; }
  }, 1000);
}

async function sendCode(button, label) {
  say('');
  button.disabled = true;
  try {
    await publicApi(`/api/approvals/${id}/code`, { body: {} });
    show('step-code');
    say('Code sent. Check your inbox (and spam folder).', true);
    demoMailNote($('#step-code'));
    $('#code').value = '';
    $('#code').focus();
    cooldown($('#resend'), 'Send a new code');
  } catch (err) {
    say(err.message);
    if (err.code === 'challenge-closed') show('step-closed');
    else button.disabled = false;
  }
}

$('#send-code').addEventListener('click', () => sendCode($('#send-code'), 'Send me a code'));
$('#resend').addEventListener('click', () => sendCode($('#resend'), 'Send a new code'));

$('#code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say('');
  const code = $('#code').value.trim();
  if (!/^\d{6}$/.test(code)) return say('Enter the 6-digit code from the email.');
  $('#verify').disabled = true;
  try {
    ({ session } = await publicApi(`/api/approvals/${id}/verify`, { body: { code } }));
    await openReview();
  } catch (err) {
    say(err.message);
    if (err.code === 'challenge-closed') show('step-closed');
  } finally {
    $('#verify').disabled = false;
  }
});

async function openReview() {
  const r = await publicApi(`/api/approvals/${id}/review`, { body: { session } });
  const q = r.reservation;
  $('#review-title').textContent = r.stepLabel;
  const rows = [
    ['Requested by', `${r.student.fullName} (${r.student.studentNumber || 'no student number'})`],
    ['Room', q.room],
    ['Date', q.date],
    ['Time', `${q.startTime} – ${q.endTime} (${q.timezone})`],
    ['Participants', `${q.participantCount}: ${[r.student.fullName, ...q.participants.map((p) => p.name)].join(', ')}`],
    ['Purpose', q.purpose],
    ...(q.notes ? [['Special requests', q.notes]] : []),
    ['Decision needed by', when(r.expiresAt)],
  ];
  $('#facts').replaceChildren(...rows.map(([k, v]) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    div.append(dt, dd);
    return div;
  }));
  $('#previous').textContent = r.previousApprovals.length ? `Already approved: ${r.previousApprovals.map((a) => a.label).join(', ')}.` : '';
  say('');
  show('step-review');
}

let deciding = false;
async function decide(decision) {
  if (deciding) return;
  deciding = true;
  $('#approve').disabled = $('#reject').disabled = true;
  say('');
  try {
    const out = await publicApi(`/api/approvals/${id}/decision`, { body: { session, decision, comment: $('#comment').value.trim() } });
    session = null;
    $('#done-title').textContent = out.outcome === 'approved' ? 'Approved' : 'Rejected';
    $('#done-text').textContent = out.outcome === 'approved'
      ? 'Your approval was recorded and the request moves to the next step. You can close this page.'
      : 'Your rejection was recorded and the room was released. You can close this page.';
    show('step-done');
  } catch (err) {
    say(err.message);
    if (err.code === 'invalid-session') { session = null; show('step-code'); }
    else if (['challenge-closed', 'not-pending', 'not-current-step', 'reservation-expired'].includes(err.code)) show('step-closed');
    else $('#approve').disabled = $('#reject').disabled = false;
  } finally {
    deciding = false;
  }
}
$('#approve').addEventListener('click', () => decide('approve'));
$('#reject').addEventListener('click', () => decide('reject'));

start();

// A different link pasted into this tab starts from scratch (and the old session is dropped with the page).
window.addEventListener('hashchange', () => location.reload());
