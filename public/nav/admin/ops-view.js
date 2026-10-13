// Operations: what is waiting on approvers, what email is stuck, and whether the stored records agree with each other.
// Read-mostly. The only actions are "send this failed email again" and (on a reservation) "send the request again":
// nothing here approves, skips or resets an approval step. The API decides what is allowed; this file renders it.
import { apiFetch } from '../../js/api.js';
import { h, say, when } from '../../js/dom.js';

const $ = (selector) => document.querySelector(selector);
const ATTENTION = {
  locked: 'Locked after too many wrong codes: open the reservation and send the request again',
  'challenge-closed': 'The approval link is no longer open: open the reservation and send the request again',
  'notice-failed': 'The review email failed to send: send it again below, or send the request again from the reservation',
};
const CHECKS = {
  staleAllocations: 'Seats marked in use by a stub that is no longer active',
  activeTicketsWithoutSeat: 'Active stubs whose seat does not point back at them',
  orphanLocks: 'Room holds that no active reservation owns',
  reservationsWithoutHold: 'Active reservations missing part of their room hold',
  orphanChallenges: 'Open approval links that are not current',
  expiredLocks: 'Old room holds that can be cleaned up',
  expiredRateLimits: 'Old request counters that can be cleaned up',
};

const table = (headers, rows) => h('table', { class: 'rooms-table' }, h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, ...rows));
const failure = (el, err) => { el.hidden = false; el.className = 'state error'; el.textContent = err.message; };
const who = (r) => `${r.student.fullName} · ${r.room} · ${r.date} ${r.startTime}–${r.endTime}`;

// ------------------------------------------------------------------ approvals

async function loadApprovals() {
  const state = $('#ops-approvals-state');
  state.hidden = false;
  state.className = 'state';
  state.textContent = 'Loading approvals...';
  try {
    const data = await apiFetch('/api/admin/ops/approvals');
    state.hidden = true;
    $('#ops-pending').replaceChildren(data.pending.length ? table(['Reservation', 'Waiting on', 'Step expires', 'Needs attention'], data.pending.map((p) => h('tr', {},
      h('td', {}, who(p)),
      h('td', {}, p.stepType === 'admin' ? `${p.stepLabel} (an administrator)` : `${p.stepLabel} <${p.approverEmail}>`),
      h('td', {}, when(p.stepDeadline)),
      h('td', {}, p.attention.length ? p.attention.map((a) => ATTENTION[a]).join('. ') : '—')))) : h('p', { class: 'hint' }, 'No approval steps are waiting.'));
    $('#ops-expired').replaceChildren(data.expired.length ? table(['Reservation', 'Why it ended', 'Ended'], data.expired.map((e) => h('tr', {},
      h('td', {}, who(e)),
      h('td', {}, e.endReason.replaceAll('_', ' ')),
      h('td', {}, when(e.endedAt))))) : h('p', { class: 'hint' }, 'No recently expired requests.'));
  } catch (err) {
    failure(state, err);
  }
}

// ------------------------------------------------------------------ email

async function loadEmails(feedbackText) {
  const state = $('#ops-email-state');
  const feedback = $('#ops-email-feedback');
  state.hidden = false;
  state.className = 'state';
  state.textContent = 'Loading email...';
  try {
    const data = await apiFetch(`/api/admin/ops/emails?status=${encodeURIComponent($('#ops-email-status').value)}`);
    state.hidden = true;
    $('#ops-email-counts').replaceChildren(...Object.entries(data.counts).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, String(v)))));
    $('#ops-emails').replaceChildren(data.messages.length ? table(['Message', 'To', 'State', 'Attempts', 'Last error', ''], data.messages.map((m) => h('tr', {},
      h('td', {}, `${m.subject} (${m.kind.replaceAll('-', ' ')})`),
      h('td', {}, m.to),
      h('td', {}, m.willRetry ? `retrying after ${when(m.nextAttemptAt)}` : m.status),
      h('td', {}, `${m.attempts} of ${data.maxAttempts}`),
      h('td', {}, m.lastError ?? '—'),
      h('td', {}, m.requeueable ? h('button', { type: 'button', class: 'reserve-btn small', onclick: (e) => requeue(m, e.currentTarget) }, 'Send again') : '—')))) : h('p', { class: 'hint' }, `No ${data.status} messages.`));
    say(feedback, feedbackText ?? '');
  } catch (err) {
    failure(state, err);
  }
}

async function requeue(message, button) {
  button.disabled = true;
  try {
    await apiFetch(`/api/admin/ops/emails/${encodeURIComponent(message.id)}/requeue`, { method: 'POST', body: {} });
    await loadEmails('Queued again. Delivery is at-least-once: if the earlier attempt did reach the recipient, they may receive it twice.');
  } catch (err) {
    button.disabled = false;
    say($('#ops-email-feedback'), err.message, true);
  }
}

// ------------------------------------------------------------------ diagnostics

async function runDiagnostics() {
  const out = $('#ops-diag');
  const button = $('#ops-diag-run');
  button.disabled = true;
  out.replaceChildren(h('p', { class: 'state' }, 'Checking...'));
  try {
    const { findings, generatedAt } = await apiFetch('/api/admin/ops/diagnostics');
    const problems = Object.entries(findings).filter(([k, f]) => f.count && !k.startsWith('expired'));
    out.replaceChildren(
      h('p', { class: problems.length ? 'notice error' : 'notice', role: 'status' }, problems.length ? 'Some records disagree. Details below; repairs are run by an operator (npm run reconcile).' : `Everything agrees (checked ${when(generatedAt)}).`),
      h('dl', { class: 'facts' }, ...Object.entries(CHECKS).map(([k, label]) => h('div', {}, h('dt', {}, label), h('dd', {}, String(findings[k].count))))),
      ...problems.map(([k, f]) => h('details', {}, h('summary', {}, CHECKS[k]), h('pre', { class: 'diag-items' }, JSON.stringify(f.items, null, 2)))));
  } catch (err) {
    out.replaceChildren(h('p', { class: 'state error' }, err.message));
  } finally {
    button.disabled = false;
  }
}

export function loadOps() {
  loadApprovals();
  loadEmails();
}

let wired = false;
export function initOpsView() {
  if (wired) return;
  wired = true;
  $('#ops-email-status').addEventListener('change', () => loadEmails());
  $('#ops-diag-run').addEventListener('click', runDiagnostics);
}
