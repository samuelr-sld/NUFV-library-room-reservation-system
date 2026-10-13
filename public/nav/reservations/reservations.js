// My Reservations: history, approval progress, cancellation and the printable confirmation.
// The API decides everything (ownership, who may cancel, whether a QR exists). Server text is inserted as text only.
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';

const $ = (selector) => document.querySelector(selector);
function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const say = (el, text, isError = false) => { el.hidden = !text; el.textContent = text ?? ''; el.classList.toggle('error', isError); };
const STATE_TEXT = { approved: 'approved', current: 'waiting for a decision', waiting: 'not reached yet', rejected: 'rejected', stopped: 'stopped', skipped: 'not needed' };
const REASONS = { approval_timeout: 'It ran out of time before every approver decided.', start_passed: 'The start time arrived before it was approved.' };

function tracker(progress) {
  return h('ol', { class: 'tracker', 'aria-label': 'Approval progress' }, ...progress.map((p) =>
    h('li', { class: p.state }, h('span', { class: 'dot', 'aria-hidden': 'true' }), `${p.label}: ${STATE_TEXT[p.state]}`)));
}

// Students may cancel a pending request, or a confirmed one that has not started (the server enforces the same).
const cancellable = (r) => (r.status === 'pending' || r.status === 'confirmed') && Date.parse(r.startsAt) > Date.now();

function card(r) {
  const actions = h('div', { class: 'res-actions' });
  if (r.status === 'confirmed') actions.append(h('button', { type: 'button', class: 'reserve-btn small', onclick: () => showConfirmation(r.id) }, 'View / print confirmation'));
  if (cancellable(r)) {
    const button = h('button', { type: 'button', class: 'reserve-btn small secondary' }, 'Cancel reservation');
    let armed = null;
    button.addEventListener('click', () => {
      if (!armed) { // two steps, so a stray click cannot cancel
        button.textContent = 'Confirm cancel';
        button.classList.add('danger');
        armed = setTimeout(() => { armed = null; button.textContent = 'Cancel reservation'; button.classList.remove('danger'); }, 5000);
        return;
      }
      clearTimeout(armed);
      cancel(r, button);
    });
    actions.append(button);
  }
  return h('article', { class: 'res-card' },
    h('div', { class: 'res-head' },
      h('div', {}, h('div', { class: 'res-title' }, `${r.room.label} · ${r.date}, ${r.startTime}–${r.endTime}`), h('div', { class: 'res-meta' }, `${r.id} · ${r.participantCount} participant(s) · ${r.timezone}`)),
      h('span', { class: `status ${r.status}` }, r.status)),
    h('p', { class: 'res-purpose' }, r.purpose),
    tracker(r.progress),
    r.status === 'pending' ? h('p', { class: 'res-meta' }, `Waiting for: ${r.currentStepLabel}. If nobody decides by ${when(r.stepDeadline)} the request expires and the room is released.`) : '',
    r.status === 'confirmed' ? h('p', { class: 'res-meta' }, `Confirmed ${when(r.confirmedAt)} · reference ${r.confirmationRef}`) : '',
    r.decision?.comment && r.status === 'rejected' ? h('p', { class: 'reason' }, `Reason given: ${r.decision.comment}`) : '',
    REASONS[r.endReason] ? h('p', { class: 'reason' }, REASONS[r.endReason]) : '',
    actions);
}

async function load() {
  const state = $('#list-state');
  try {
    const { reservations } = await apiFetch('/api/reservations');
    state.hidden = true;
    $('#reservation-list').replaceChildren(...(reservations.length ? reservations.map(card) : [h('p', { class: 'hint' }, 'You have not made any reservations yet.')]));
  } catch (err) {
    state.hidden = false;
    state.className = 'state error';
    state.textContent = err.message;
  }
}

async function cancel(r, button) {
  button.disabled = true;
  try {
    await apiFetch(`/api/reservations/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', body: {} });
    say($('#list-notice'), 'Reservation cancelled. The room is free for others.');
  } catch (err) {
    say($('#list-notice'), err.message, true);
  }
  await load();
}

async function showConfirmation(id) {
  try {
    const data = await apiFetch(`/api/reservations/${encodeURIComponent(id)}/print`);
    const r = data.reservation;
    $('#c-room').textContent = r.room.label;
    $('#c-ref').textContent = r.confirmationRef;
    $('#c-date').textContent = r.date;
    $('#c-time').textContent = `${r.startTime} – ${r.endTime} (${r.timezone})`;
    $('#c-student').textContent = data.student.fullName;
    $('#c-number').textContent = data.student.studentNumber || '—';
    $('#c-people').textContent = [data.student.fullName, ...r.participants.map((p) => p.name)].join(', ');
    $('#c-purpose').textContent = r.purpose;
    $('#c-approved').textContent = when(r.confirmedAt);
    $('#c-qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qrSvg)}`;
    $('#c-foot').textContent = 'Show this confirmation at the library desk. Your reservation is valid only for the approved date and time.';
    $('#confirmation').hidden = false;
    $('#confirmation').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    say($('#list-notice'), err.message, true);
  }
}

$('#c-print').addEventListener('click', () => window.print());
$('#c-close').addEventListener('click', () => { $('#confirmation').hidden = true; });

// guard.js has already redirected anyone who is not a signed-in, verified, active student; do nothing for them.
if (guardResult.status === 'allow') {
  load();
  setInterval(load, 30000);
}
