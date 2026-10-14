// Generate Stubs. Availability shown here is advisory only: the server picks the resource and enforces every limit
// inside a transaction, so nothing on this page can reserve, extend or change anything by itself.
// Server data is always inserted as text; the QR image is a data: URI, which cannot run script.
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';

const SERVICES = {
  'silent-room': { title: 'Silent Room', icon: 'fa-book-open-reader', blurb: 'A quiet study seat, assigned to you automatically.', seatNoun: 'seat' },
  'computer-station': { title: 'Computer Station', icon: 'fa-desktop', blurb: 'The next free computer, assigned to you automatically.', seatNoun: 'station' },
  'wifi-voucher': { title: 'Wi-Fi Voucher', icon: 'fa-wifi', blurb: 'A demonstration Wi-Fi password for this prototype.', seatNoun: null },
};

const $ = (selector) => document.querySelector(selector);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
function inTime(iso) {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}
const say = (el, text, isError = false) => { el.hidden = !text; el.textContent = text ?? ''; el.classList.toggle('error', isError); };

let selected = null;
let availability = null;
let shownId = null;
let busy = false;

// ------------------------------------------------------------------ service cards and availability

function renderCards() {
  const grid = $('#service-grid');
  grid.replaceChildren(...Object.entries(SERVICES).map(([key, info]) => {
    const a = availability?.services[key];
    let badge = h('span', { class: 'status maintenance' }, 'Checking...');
    let full = false;
    if (a) {
      if (a.unlimited) badge = h('span', { class: 'status available' }, 'Always available');
      else if (a.available > 0) badge = h('span', { class: 'status available' }, `${a.available} of ${a.total} free`);
      else { full = true; badge = h('span', { class: 'status full' }, a.total ? 'None free right now' : 'Not available'); }
    }
    const card = h('button', { type: 'button', class: 'service-card', 'data-service': key, 'aria-pressed': String(selected === key), disabled: full && selected !== key },
      h('i', { class: `fas ${info.icon}` }), h('span', { class: 'title' }, info.title), h('span', { class: 'blurb' }, info.blurb), badge);
    card.addEventListener('click', () => { selected = key; say($('#error'), ''); say($('#message'), ''); renderCards(); syncGenerate(); });
    return card;
  }));
}

// Every active seat and station with its own status. Informational: the server still picks which one you get.
function renderResources() {
  $('#resource-list').replaceChildren(...Object.entries(SERVICES).flatMap(([key, info]) => {
    const list = availability?.services[key]?.resources ?? [];
    return list.length ? [h('h3', {}, info.title), h('ul', { class: 'resource-chips' }, ...list.map((r) =>
      h('li', { title: r.description || null }, `${r.label} `, h('span', { class: `status ${r.available ? 'available' : 'in-use'}` }, r.available ? 'Free' : 'In use'))))] : [];
  }));
}

function syncGenerate() {
  const a = availability?.services[selected];
  $('#generate').disabled = busy || !selected || !!(a && !a.unlimited && a.available === 0);
}

async function loadAvailability() {
  const state = $('#chooser [data-state]');
  try {
    availability = await apiFetch('/api/tickets/availability');
    state.hidden = true;
    $('#active-summary').textContent = `Active stubs: ${availability.active} of ${availability.limit} allowed.`;
  } catch (err) {
    state.hidden = false;
    state.className = 'state error';
    state.textContent = err.message;
  }
  renderCards();
  renderResources();
  syncGenerate();
}

// ------------------------------------------------------------------ the stub

async function showStub(id, { scroll = true } = {}) {
  const data = await apiFetch(`/api/tickets/${encodeURIComponent(id)}/print`);
  const t = data.ticket;
  shownId = t.id;
  const seat = SERVICES[t.service].seatNoun;

  $('#stub-service').textContent = t.serviceLabel;
  $('#stub-assignment').textContent = t.resource ? t.resource.label : 'Wi-Fi access';
  $('#stub-id').textContent = t.id;
  $('#stub-student').textContent = data.student.fullName;
  $('#stub-number').textContent = data.student.studentNumber || '—';
  $('#stub-issued').textContent = when(t.issuedAt);
  $('#stub-expires').textContent = `${when(t.expiresAt)}${t.status === 'issued' || t.status === 'checked_in' ? ` (in ${inTime(t.expiresAt)})` : ''}`;
  $('#stub-checkin-row').hidden = !t.checkInDeadline;
  $('#stub-checkin').textContent = when(t.checkInDeadline);
  $('#stub-status').textContent = t.status.replace('_', ' ');
  $('#stub-qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qrSvg)}`;
  $('#stub-foot').textContent = t.checkInDeadline
    ? `Go to the library desk and check in before ${when(t.checkInDeadline)}, or this ${seat} is given to someone else.`
    : 'Keep this stub until it expires.';

  const v = data.voucher;
  $('#stub-demo').hidden = !v;
  $('#stub-password').hidden = !v?.passwordAvailable;
  $('#stub-password-value').textContent = v?.password ?? '';
  const note = $('#stub-password-note');
  note.hidden = !v;
  if (v) note.textContent = v.passwordAvailable
    ? 'Demonstration only: this password does not work on any real network. It is available here until the voucher expires.'
    : 'The password is no longer available because this voucher is not active.';

  $('#stub-view').hidden = false;
  if (scroll) $('#stub-view').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ------------------------------------------------------------------ my stubs

async function loadLists() {
  try {
    const [{ tickets: active }, { tickets: history }] = await Promise.all([apiFetch('/api/tickets/active'), apiFetch('/api/tickets/history?limit=20')]);
    $('#active-empty').hidden = active.length > 0;
    $('#active-list').replaceChildren(...active.map((t) => h('li', {},
      h('div', {}, h('strong', {}, `${t.serviceLabel}${t.resource ? ` · ${t.resource.label}` : ''}`),
        h('div', { class: 'meta' }, `${t.id} · expires ${when(t.expiresAt)} (in ${inTime(t.expiresAt)})`)),
      h('button', { type: 'button', class: 'reserve-btn small', onclick: () => open(t.id) }, 'View / print'))));

    $('#history-empty').hidden = history.length > 0;
    $('#history-wrap').hidden = history.length === 0;
    $('#history-rows').replaceChildren(...history.map((t) => h('tr', {},
      h('td', {}, h('code', {}, t.id)),
      h('td', {}, t.serviceLabel + (t.resource ? ` · ${t.resource.label}` : '')),
      h('td', {}, h('span', { class: `status ${t.status === 'issued' || t.status === 'checked_in' ? 'available' : t.status === 'revoked' ? 'full' : 'retired'}` }, t.status.replace('_', ' '))),
      h('td', {}, when(t.issuedAt)),
      h('td', {}, h('button', { type: 'button', class: 'reserve-btn small secondary', onclick: () => open(t.id) }, 'View')))));
  } catch (err) {
    say($('#error'), err.message, true);
  }
}

async function open(id) {
  say($('#error'), '');
  try { await showStub(id); } catch (err) { say($('#error'), err.message, true); }
}

// ------------------------------------------------------------------ generate

$('#generate').addEventListener('click', async () => {
  if (busy || !selected) return;
  busy = true;
  const button = $('#generate');
  const label = button.textContent;
  button.textContent = 'Generating...';
  syncGenerate();
  say($('#error'), '');
  say($('#message'), '');
  try {
    const { ticket, created } = await apiFetch('/api/tickets', { method: 'POST', body: { service: selected } });
    await showStub(ticket.id);
    say($('#message'), created ? 'Your stub is ready.' : `You already have an active ${SERVICES[selected].title} stub, so we are showing that one.`);
  } catch (err) {
    say($('#error'), err.message, true);
  } finally {
    busy = false;
    button.textContent = label;
    await Promise.all([loadAvailability(), loadLists()]);
  }
});

$('#print').addEventListener('click', () => window.print());
$('#close-stub').addEventListener('click', () => { $('#stub-view').hidden = true; shownId = null; });

// ------------------------------------------------------------------ start

async function refresh() {
  await Promise.all([loadAvailability(), loadLists()]);
  if (shownId && !busy) showStub(shownId, { scroll: false }).catch(() => {}); // keeps status, expiry and password availability current
}

// guard.js has already redirected anyone who is not a signed-in, verified, active student; do nothing for them.
if (guardResult.status === 'allow') {
  renderCards();
  refresh();
  setInterval(refresh, 30000);
}
