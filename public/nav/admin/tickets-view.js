// Scan codes: QR scanner, manual entry, and what the code refers to. Physical service stubs (NUFV1:) get the check-in /
// check-out / revoke actions; discussion room reservations (NUFR1:) are shown read-only, because no attendance policy exists yet.
// Every decision is made by the API (administrator role, state, server time); this file only shows what the API returns
// and offers the actions it lists. A scanned code is just a lookup key, never proof of who holds it.
import { apiFetch } from '../../js/api.js';
import { h, say, when } from '../../js/dom.js';
import { normalizeReference, readFrame, createDebouncer } from '../../js/qr-reference.js';

const $ = (selector) => document.querySelector(selector);

const CAMERA_PROBLEMS = {
  NotAllowedError: 'Camera permission was denied. Allow camera access for this site in the browser settings, or use manual entry below.',
  SecurityError: 'Camera permission was denied. Allow camera access for this site in the browser settings, or use manual entry below.',
  NotFoundError: 'No camera was found on this device. Use manual entry below.',
  OverconstrainedError: 'The selected camera is not available. Choose another one.',
  NotReadableError: 'The camera is in use by another application. Close it and try again.',
  AbortError: 'The camera could not be started. Try again.',
};

let jsQR = null;
let stream = null;
let timer = null;
let canvas = null;
let generation = 0; // bumped by every stop, so a start still waiting for the permission prompt knows it was cancelled
let busy = false; // a lookup or an action is in flight: ignore scans and clicks meanwhile
let current = null; // the last ticket view returned by the API (null while a reservation is shown)
let shownReference = null; // the code whose ticket is on screen: scanning it again does nothing until the administrator moves on
const accept = createDebouncer(5000); // the same code held in front of the camera is reported once

// ------------------------------------------------------------------ camera

async function loadDecoder() {
  if (jsQR) return jsQR;
  await import('../../vendor/jsqr/jsQR.js'); // sets self.jsQR; loaded only when someone starts the camera
  jsQR = self.jsQR;
  if (typeof jsQR !== 'function') throw new Error('decoder missing');
  return jsQR;
}

async function listCameras(selectedId) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const select = $('#camera-select');
  select.replaceChildren(h('option', { value: '' }, 'Default camera'), ...devices.map((d, i) => h('option', { value: d.deviceId }, d.label || `Camera ${i + 1}`)));
  if (selectedId) select.value = selectedId;
}

export async function startScanner() {
  if (stream) return;
  const status = $('#scan-status');
  if (!window.isSecureContext) return say(status, 'Camera scanning needs a secure page (https, or localhost while developing). Use manual entry below.', true);
  if (!navigator.mediaDevices?.getUserMedia) return say(status, 'This browser cannot access a camera. Use manual entry below.', true);

  const mine = ++generation;
  say(status, 'Starting camera... allow camera access if the browser asks.');
  $('#scan-start').disabled = true;
  $('#scan-stop').disabled = false; // lets the administrator cancel while the permission prompt is open
  try {
    await loadDecoder();
  } catch {
    stopScanner();
    return say(status, 'The QR decoder could not be loaded. Use manual entry below.', true);
  }
  let granted;
  try {
    const deviceId = $('#camera-select').value;
    granted = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } } });
  } catch (err) {
    if (mine === generation) stopScanner();
    return say(status, CAMERA_PROBLEMS[err?.name] ?? 'The camera could not be started. Use manual entry below.', true);
  }
  if (mine !== generation) { // stopped or navigated away while the prompt was open: do not leave the camera running
    granted.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = granted;

  const video = $('#scan-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await listCameras(stream.getVideoTracks()[0]?.getSettings().deviceId).catch(() => {});
  canvas = document.createElement('canvas');
  timer = setInterval(scanFrame, 150);
  $('#video-wrap').hidden = false;
  $('#scan-stop').disabled = false;
  say(status, 'Point the camera at the QR code on the stub.');
}

function scanFrame() {
  const video = $('#scan-video');
  if (!stream || busy || video.readyState < 2 || !video.videoWidth) return;
  const scale = Math.min(1, 640 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const reference = readFrame(jsQR, ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (reference && reference !== shownReference && accept(reference)) lookup(reference);
}

// Safe to call at any time, including before the view was ever opened. Releases the camera light.
export function stopScanner() {
  generation++;
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  const video = $('#scan-video');
  if (video) video.srcObject = null;
  if ($('#video-wrap')) $('#video-wrap').hidden = true;
  if ($('#scan-start')) { $('#scan-start').disabled = false; $('#scan-stop').disabled = true; }
}

// ------------------------------------------------------------------ lookup and display

function showState(kind, text) {
  const el = $('#lookup-state');
  el.hidden = !kind;
  el.className = kind === 'loading' ? 'state' : 'state error';
  el.textContent = text ?? '';
}

async function lookup(text) {
  const reference = normalizeReference(text);
  if (!reference) {
    current = null;
    hidePanels();
    return showState('invalid', 'That is not a library code. Scan the QR code on a stub or a reservation confirmation, or type the ticket ID (SR-0123456789) or reservation reference (RC-0123456789).');
  }
  if (busy) return;
  busy = true;
  showState('loading', 'Looking up the code...');
  say($('#ticket-feedback'), '');
  try {
    const view = await apiFetch('/api/admin/qr/resolve', { method: 'POST', body: { reference } });
    if (view.kind === 'reservation') renderReservation(view);
    else render(view);
    shownReference = reference;
    showState(null);
  } catch (err) {
    current = null;
    shownReference = null;
    hidePanels();
    showState('error', err.message);
  } finally {
    busy = false;
  }
}

const BANNERS = {
  issued: (v) => (v.ticket.resource ? ['info', 'Issued. Waiting for the student to check in.'] : ['info', 'Active Wi-Fi voucher. No check-in is needed.']),
  checked_in: () => ['ok', 'Checked in. The student is using the seat.'],
  checked_out: (v) => ['muted', `Checked out ${when(v.ticket.endedAt)}.`],
  expired: (v) => ['bad', v.ticket.endReason === 'no_show' ? 'Expired: the student did not check in before the deadline (no-show). The seat was released.' : 'Expired. The seat was released.'],
  revoked: (v) => ['bad', `Revoked${v.ticket.revokeReason ? `: ${v.ticket.revokeReason}` : ''}.`],
};
const WARNINGS = {
  'student-not-active': 'This student account is not active. Check-in is not available.',
  'resource-mismatch': 'The assigned seat is no longer held for this ticket. Do not seat the student; they should generate a new stub.',
};

function hidePanels() {
  $('#ticket-panel').hidden = true;
  $('#reservation-panel').hidden = true;
}

const PERIOD_TEXT = { upcoming: 'The booking has not started yet.', in_progress: 'The booking is in progress.', ended: 'The booking has ended.' };
const RES_WARNINGS = { 'student-not-active': 'This student account is not active.' };

// Read-only. A confirmed booking is valid only during its approved time; cancelled, rejected and expired ones never are.
function renderReservation(view) {
  current = null;
  hidePanels();
  const { reservation: r, student: s } = view;
  const banner = $('#reservation-banner');
  const [kind, text] = view.validNow ? ['ok', `Valid now. ${PERIOD_TEXT.in_progress}`]
    : r.status === 'confirmed' ? [view.period === 'upcoming' ? 'info' : 'muted', `Not valid right now. ${PERIOD_TEXT[view.period]}`]
      : ['bad', `${r.endReason ? `Ended: ${r.endReason.replaceAll('_', ' ')}.` : 'This reservation is not active.'}`];
  banner.className = `banner ${kind}`;
  banner.textContent = `${r.status.toUpperCase()} — ${text}`;
  const facts = [
    ['Reservation', r.id], ...(r.confirmationRef ? [['Confirmation', r.confirmationRef]] : []),
    ['Student', `${s.fullName} (${s.studentNumber || 'no student number'})`],
    ['Room', r.room], ['Date', r.date], ['Approved time', `${r.startTime}–${r.endTime} (${r.timezone})`],
    ['Participants', String(r.participantCount)],
    ...(r.endedAt ? [['Ended', when(r.endedAt)]] : []),
  ];
  $('#reservation-facts').replaceChildren(...facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  say($('#reservation-warnings'), view.warnings.map((w) => RES_WARNINGS[w]).filter(Boolean).join(' '), true);
  $('#reservation-panel').hidden = false;
}

function render(view) {
  current = view;
  $('#reservation-panel').hidden = true;
  const { ticket: t, student: s } = view;
  const [kind, text] = BANNERS[t.status](view);
  const banner = $('#ticket-banner');
  banner.className = `banner ${kind}`;
  banner.textContent = `${t.status.replace('_', ' ').toUpperCase()} — ${text}`;

  const facts = [
    ['Ticket ID', t.id], ['Service', t.serviceLabel],
    ['Student', `${s.fullName} (${s.studentNumber || 'no student number'})`],
    ['Assignment', t.resource ? t.resource.label : 'Wi-Fi access'],
    ['Issued', when(t.issuedAt)],
    ...(t.checkInDeadline ? [['Check in before', when(t.checkInDeadline)]] : []),
    ...(t.checkedInAt ? [['Checked in', when(t.checkedInAt)]] : []),
    ['Expires', when(t.expiresAt)],
    ...(t.endedAt ? [['Ended', when(t.endedAt)]] : []),
  ];
  $('#ticket-facts').replaceChildren(...facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  say($('#ticket-warnings'), view.warnings.map((w) => WARNINGS[w]).filter(Boolean).join(' '), true);
  renderActions(view);
  $('#ticket-panel').hidden = false;
}

function renderActions(view) {
  const box = $('#ticket-actions');
  const allowed = view.allowedActions;
  const parts = [];

  if (allowed.includes('check_in')) {
    const confirm = h('input', { type: 'checkbox', id: 'identity-check' });
    const button = h('button', { type: 'button', class: 'reserve-btn', id: 'do-check-in', disabled: true }, 'Check in');
    confirm.addEventListener('change', () => { button.disabled = !confirm.checked || busy; });
    button.addEventListener('click', () => act('check-in', { identityChecked: true }, (c) => (c ? 'Checked in.' : 'Already checked in. Nothing was changed.')));
    parts.push(h('div', { class: 'action-block' },
      h('label', { class: 'checkbox-row' }, confirm, "I checked the student's ID against this ticket"), button));
  }
  if (allowed.includes('check_out')) {
    parts.push(h('button', { type: 'button', class: 'reserve-btn', id: 'do-check-out', onclick: () => act('check-out', {}, (c) => (c ? 'Checked out. The seat is free again.' : 'Already checked out. Nothing was changed.')) }, 'Check out'));
  }
  if (allowed.includes('revoke')) {
    const reason = h('textarea', { id: 'revoke-reason', rows: 2, maxlength: 200, placeholder: 'Why is this ticket being revoked?', 'aria-label': 'Reason for revoking' });
    const form = h('div', { class: 'revoke-form', hidden: true }, reason,
      h('button', { type: 'button', class: 'reserve-btn danger', id: 'confirm-revoke', onclick: () => act('revoke', { reason: reason.value }, () => 'Revoked.') }, 'Confirm revoke'),
      h('button', { type: 'button', class: 'reserve-btn secondary', onclick: () => { form.hidden = true; } }, 'Cancel'));
    parts.push(h('button', { type: 'button', class: 'reserve-btn secondary', id: 'do-revoke', onclick: () => { form.hidden = false; reason.focus(); } }, 'Revoke...'), form);
  }
  if (!parts.length) parts.push(h('p', { class: 'hint' }, 'No actions are available for this ticket.'));
  parts.push(h('button', { type: 'button', class: 'reserve-btn secondary', onclick: scanNext }, 'Scan next'));
  box.replaceChildren(...parts);
}

function scanNext() {
  current = null;
  shownReference = null;
  hidePanels();
  say($('#ticket-feedback'), '');
  showState(null);
  $('#manual-ref').value = '';
}

// One action at a time; a double click or a second scan cannot repeat it (and the API ignores repeats anyway).
async function act(path, body, successText) {
  if (busy || !current) return;
  busy = true;
  document.querySelectorAll('#ticket-actions button').forEach((b) => { b.disabled = true; });
  const feedback = $('#ticket-feedback');
  say(feedback, 'Working...');
  const id = current.ticket.id;
  try {
    const result = await apiFetch(`/api/admin/tickets/${encodeURIComponent(id)}/${path}`, { method: 'POST', body });
    render(result);
    say(feedback, successText(result.changed));
  } catch (err) {
    say(feedback, err.message, true);
    busy = false;
    await lookup(id); // show the ticket as it really is now (for example expired while the screen was open)
    say(feedback, err.message, true);
    return;
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------ wiring

let wired = false;
export function initTicketsView() {
  if (wired) return;
  wired = true;
  $('#scan-start').addEventListener('click', startScanner);
  $('#scan-stop').addEventListener('click', () => { stopScanner(); say($('#scan-status'), 'Camera stopped.'); });
  $('#reservation-next').addEventListener('click', scanNext);
  $('#camera-select').addEventListener('change', () => { if (stream) { stopScanner(); startScanner(); } });
  $('#manual-form').addEventListener('submit', (event) => {
    event.preventDefault();
    accept(normalizeReference($('#manual-ref').value) ?? $('#manual-ref').value.trim()); // keeps the camera from re-reading the same code a moment later
    lookup($('#manual-ref').value);
  });
  // The camera must never keep running behind another screen, a hidden tab or a closed page.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScanner(); });
  window.addEventListener('pagehide', stopScanner);
}
