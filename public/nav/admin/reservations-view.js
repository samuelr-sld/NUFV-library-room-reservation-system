// Administrator views for discussion room reservations: the queue (with the FINAL approval) and the approval chain.
// The API enforces who may do what: only the final step can be decided here, as an authenticated administrator.
import { apiFetch } from '../../js/api.js';
import { h, say, when } from '../../js/dom.js';

const $ = (selector) => document.querySelector(selector);
const STATE_TEXT = { approved: 'approved', current: 'waiting', waiting: 'not reached', rejected: 'rejected', stopped: 'stopped', skipped: 'not needed' };

const tracker = (progress) => h('ol', { class: 'tracker' }, ...progress.map((p) => h('li', { class: p.state }, h('span', { class: 'dot', 'aria-hidden': 'true' }), `${p.label}: ${STATE_TEXT[p.state]}`)));

// ------------------------------------------------------------------ reservations queue

let openId = null;
let acting = false;

export async function loadReservations() {
  const state = $('#res-state');
  const status = $('#res-status').value;
  $('#res-table-wrap').hidden = true;
  state.hidden = false;
  state.className = 'state';
  state.textContent = 'Loading reservations...';
  try {
    const { reservations } = await apiFetch(`/api/admin/reservations?status=${encodeURIComponent(status)}`);
    $('#res-rows').replaceChildren(...reservations.map((r) => h('tr', {},
      h('td', {}, `${r.student.fullName} (${r.student.studentNumber || '—'})`),
      h('td', {}, r.room.label),
      h('td', {}, `${r.date} ${r.startTime}–${r.endTime}`),
      h('td', {}, h('span', { class: `status ${r.status}` }, r.status)),
      h('td', {}, r.status === 'pending' ? (r.awaitingFinalApproval ? 'Needs your decision' : `Waiting: ${r.currentStepLabel}`) : '—'),
      h('td', {}, h('button', { type: 'button', class: 'reserve-btn small', onclick: () => openDetail(r.id) }, 'Open')))));
    $('#res-table-wrap').hidden = reservations.length === 0;
    state.hidden = reservations.length > 0;
    if (!reservations.length) state.textContent = status === 'pending' ? 'No requests are waiting for a decision.' : `No ${status} reservations.`;
  } catch (err) {
    state.className = 'state error';
    state.textContent = err.message;
  }
}

async function openDetail(id) {
  openId = id;
  const panel = $('#res-detail');
  const feedback = $('#res-feedback');
  say(feedback, '');
  try {
    const { reservation: d } = await apiFetch(`/api/admin/reservations/${encodeURIComponent(id)}`);
    render(d);
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    say(feedback, err.message, true);
  }
}

function render(d) {
  const facts = [
    ['Reservation', d.id], ['Status', d.status], ['Student', `${d.student.fullName} (${d.student.studentNumber || '—'})`],
    ['Room', d.room.label], ['When', `${d.date} ${d.startTime}–${d.endTime} (${d.timezone})`],
    ['Participants', `${d.participantCount}: ${[d.student.fullName, ...d.participants.map((p) => p.name)].join(', ')}`],
    ['Purpose', d.purpose], ...(d.notes ? [['Special requests', d.notes]] : []),
    ...(d.stepDeadline ? [['Step expires', when(d.stepDeadline)]] : []),
    ...(d.confirmationRef ? [['Confirmation', d.confirmationRef]] : []),
    ...(d.endReason ? [['Ended because', d.endReason.replaceAll('_', ' ')]] : []),
  ];
  $('#res-facts').replaceChildren(...facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  $('#res-tracker').replaceChildren(tracker(d.progress));
  $('#res-chain').textContent = d.workflow.map((s) => (s.email ? `${s.label} <${s.email}>` : s.label)).join('  →  ');
  $('#res-history').replaceChildren(...d.history.map((a) => h('li', {}, `${when(a.at)} · ${a.action} · ${a.stepLabel} · ${a.actorType}${a.comment ? ` · "${a.comment}"` : ''}${a.reason ? ` (${a.reason.replaceAll('_', ' ')})` : ''}`)));

  const box = $('#res-actions');
  const parts = [];
  if (d.awaitingFinalApproval) {
    const comment = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Comment (optional)', 'aria-label': 'Comment' });
    parts.push(comment,
      h('div', { class: 'res-actions' },
        h('button', { type: 'button', class: 'reserve-btn', id: 'final-approve', onclick: () => act(d, 'decision', { decision: 'approve', step: d.currentStep, comment: comment.value }, 'Approved. The booking is confirmed.') }, 'Give final approval'),
        h('button', { type: 'button', class: 'reserve-btn danger', id: 'final-reject', onclick: () => act(d, 'decision', { decision: 'reject', step: d.currentStep, comment: comment.value }, 'Rejected. The room was released.') }, 'Reject')));
  } else if (d.status === 'pending') {
    parts.push(h('p', { class: 'hint' }, `Waiting for ${d.currentStepLabel}. Only that approver can decide this step.`));
    parts.push(h('div', { class: 'res-actions' }, h('button', { type: 'button', class: 'reserve-btn secondary', id: 'resend', onclick: () => act(d, 'resend', {}, 'A new review link was sent to the approver.') }, 'Send the request again')));
  }
  if (d.status === 'pending' || d.status === 'confirmed') {
    const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'Reason for cancelling (optional)', 'aria-label': 'Reason for cancelling' });
    const cancel = h('button', { type: 'button', class: 'reserve-btn secondary', id: 'admin-cancel' }, 'Cancel reservation');
    let armed = null;
    cancel.addEventListener('click', () => {
      if (!armed) { cancel.textContent = 'Confirm cancel'; cancel.classList.add('danger'); armed = setTimeout(() => { armed = null; cancel.textContent = 'Cancel reservation'; cancel.classList.remove('danger'); }, 5000); return; }
      clearTimeout(armed);
      act(d, 'cancel', { reason: reason.value }, 'Cancelled. The room was released.');
    });
    parts.push(h('div', { class: 'res-actions' }, reason, cancel));
  }
  box.replaceChildren(...parts);
}

async function act(d, path, body, success) {
  if (acting) return;
  acting = true;
  document.querySelectorAll('#res-actions button').forEach((b) => { b.disabled = true; });
  const feedback = $('#res-feedback');
  say(feedback, 'Working...');
  try {
    await apiFetch(`/api/admin/reservations/${encodeURIComponent(d.id)}/${path}`, { method: 'POST', body });
    say(feedback, success);
  } catch (err) {
    say(feedback, err.message, true);
  } finally {
    acting = false;
  }
  const message = feedback.textContent;
  const isError = feedback.classList.contains('error');
  await Promise.all([loadReservations(), openDetail(d.id)]);
  say(feedback, message, isError);
}

// ------------------------------------------------------------------ approval chain editor

let steps = [];

function drawSteps() {
  $('#wf-steps').replaceChildren(...steps.map((s, i) => h('div', { class: 'wf-step' },
    h('span', { class: 'wf-num' }, `${i + 1}`),
    h('label', {}, 'Step label', h('input', { type: 'text', value: s.label, maxlength: 60, 'data-i': i, 'data-field': 'label' })),
    h('label', {}, 'Approver email', h('input', { type: 'email', value: s.email, maxlength: 100, 'data-i': i, 'data-field': 'email', autocomplete: 'off' })),
    h('label', { class: 'checkbox-row' }, h('input', { type: 'checkbox', checked: s.enabled, 'data-i': i, 'data-field': 'enabled' }), 'Enabled'),
    h('div', { class: 'wf-buttons' },
      h('button', { type: 'button', class: 'reserve-btn small secondary', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
      h('button', { type: 'button', class: 'reserve-btn small secondary', 'aria-label': 'Move down', disabled: i === steps.length - 1, onclick: () => move(i, 1) }, '↓'),
      h('button', { type: 'button', class: 'reserve-btn small secondary', onclick: () => { readSteps(); steps.splice(i, 1); drawSteps(); } }, 'Remove')))));
  preview();
  $('#wf-add').disabled = steps.length >= 5;
}
function preview() {
  const active = steps.filter((s) => s.enabled);
  $('#wf-preview').textContent = ['Student submits', ...active.map((s) => s.label || '(unnamed step)'), 'Final administrator approval (authenticated administrator)'].join('  →  ');
}
function readSteps() {
  document.querySelectorAll('#wf-steps [data-field]').forEach((input) => {
    steps[Number(input.dataset.i)][input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
  });
}
function move(i, delta) {
  readSteps();
  [steps[i], steps[i + delta]] = [steps[i + delta], steps[i]];
  drawSteps();
}

export async function loadWorkflow() {
  const state = $('#wf-state');
  $('#wf-form').hidden = true;
  state.hidden = false;
  state.className = 'state';
  state.textContent = 'Loading the approval chain...';
  try {
    const w = await apiFetch('/api/admin/approval-workflow');
    steps = w.steps.map((s) => ({ ...s }));
    $('#wf-hours').value = w.stepHours;
    $('#wf-meta').textContent = w.version ? `Version ${w.version}, last changed ${when(w.updatedAt)}.` : 'No approvers are configured yet: requests go straight to the final administrator.';
    drawSteps();
    $('#wf-form').hidden = false;
    state.hidden = true;
  } catch (err) {
    state.className = 'state error';
    state.textContent = err.message;
  }
}

// ------------------------------------------------------------------ wiring

let wired = false;
export function initReservationViews() {
  if (wired) return;
  wired = true;
  $('#res-status').addEventListener('change', () => { $('#res-detail').hidden = true; loadReservations(); });
  $('#wf-steps').addEventListener('input', () => { readSteps(); preview(); }); // only the preview: redrawing the rows would steal focus while typing
  $('#wf-add').addEventListener('click', () => { readSteps(); steps.push({ label: '', email: '', enabled: true }); drawSteps(); });
  $('#wf-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    readSteps();
    const error = $('#wf-error');
    const notice = $('#wf-notice');
    say(error, '');
    say(notice, '');
    $('#wf-save').disabled = true;
    try {
      await apiFetch('/api/admin/approval-workflow', { method: 'PUT', body: { steps: steps.map((s) => ({ label: s.label, email: s.email, enabled: s.enabled })), stepHours: Number($('#wf-hours').value) } });
      await loadWorkflow();
      say($('#wf-notice'), 'Approval chain saved. It applies to requests submitted from now on; requests already in progress keep their original chain.');
    } catch (err) {
      say(error, err.message, true);
    } finally {
      $('#wf-save').disabled = false;
    }
  });
}
