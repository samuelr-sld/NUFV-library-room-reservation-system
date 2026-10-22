// Administrator dashboard. All data comes from the Express API, which re-checks the administrator on every call;
// this file only renders it. Server data is always inserted as text, never as HTML.
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';
import { h, say } from '../../js/dom.js';
import { initTicketsView, stopScanner } from './tickets-view.js';
import { initReservationViews, loadReservations, loadWorkflow, showReservation } from './reservations-view.js';
import { initNotifications } from './notifications.js';
import { initOpsView, loadOps } from './ops-view.js';
import { initAuditView, loadAudit } from './audit-view.js';

const TYPE_LABELS = { 'silent-seat': 'Silent room seats', 'computer-station': 'Computer stations', 'discussion-room': 'Discussion rooms' };
const TYPE_SINGULAR = { 'silent-seat': 'Silent room seat', 'computer-station': 'Computer station', 'discussion-room': 'Discussion room' };
const TYPE_ICONS = { 'silent-seat': 'fa-book-open-reader', 'computer-station': 'fa-desktop', 'discussion-room': 'fa-users' };
const NEXT_STATUS = { active: ['maintenance', 'retired'], maintenance: ['active', 'retired'], retired: [] };
const SETTING_FIELDS = {
  silentRoomTicketMinutes: ['Silent room ticket duration', 'minutes'],
  computerTicketMinutes: ['Computer station ticket duration', 'minutes'],
  noShowGraceMinutes: ['No-show grace period', 'minutes'],
  maxActiveTicketsPerStudent: ['Maximum active tickets per student', 'ticket(s)'],
  discussionRoomBookingIntervalMinutes: ['Discussion room booking interval', 'minutes'],
  reservationAdvanceBookingDays: ['Advance-booking window', 'days'],
  wifiVoucherMinutes: ['Wi-Fi voucher validity', 'minutes'],
};

const $ = (selector, root = document) => root.querySelector(selector);

// Loading / empty / error states live in each view's [data-state] paragraph.
function setState(view, kind, text, retry) {
  const el = $('[data-state]', view);
  el.hidden = !kind;
  el.className = kind === 'error' ? 'state error' : 'state';
  el.replaceChildren(text ?? '');
  if (kind === 'error' && retry) el.append(h('button', { type: 'button', class: 'reserve-btn small', onclick: retry }, 'Try again'));
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ------------------------------------------------------------------ overview

const overview = $('#view-overview');

async function loadOverview() {
  $('#overview-body').hidden = true;
  setState(overview, 'loading', 'Loading overview...');
  try {
    const data = await apiFetch('/api/admin/summary');
    $('#type-cards').replaceChildren(...Object.entries(TYPE_LABELS).map(([type, title]) => {
      const s = data.byType[type];
      return h('article', { class: 'card' },
        h('h3', {}, h('i', { class: `fas ${TYPE_ICONS[type]}` }), title),
        h('div', { class: 'total' }, String(s.active), h('small', {}, 'active resources')),
        h('ul', {},
          ...[['Available', s.available], ['Assigned', s.assigned], ['Occupied', s.occupied], ['Total', s.total], ['Maintenance', s.maintenance], ['Retired', s.retired]]
            .map(([name, n]) => h('li', {}, name, h('strong', {}, String(n))))));
    }));

    const cfg = data.settings;
    $('#settings-facts').replaceChildren(...[
      ...Object.entries(SETTING_FIELDS).map(([key, [label, unit]]) => [label, `${cfg.settings[key]} ${unit}`]),
      ['Configuration', cfg.customized ? `Customized (version ${cfg.version})` : 'Defaults'],
      ['Last changed', when(cfg.updatedAt)],
    ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));

    $('#overview-body').hidden = false;
    if (data.total === 0) {
      setState(overview, 'empty', 'No resources yet. Add silent room seats, computer stations or discussion rooms under Resources.');
    } else {
      setState(overview, null);
    }
  } catch (err) {
    setState(overview, 'error', err.message, loadOverview);
  }
}

// ------------------------------------------------------------------ resources

const resources = $('#view-resources');
const form = $('#resource-form');
const fields = { id: $('#f-id'), type: $('#f-type'), label: $('#f-label'), description: $('#f-description'), capacity: $('#f-capacity'), status: $('#f-status') };
let editing = null; // the resource being edited, or null when the form creates a new one

async function loadResources() {
  say($('#resource-notice'), '');
  $('#resource-table-wrap').hidden = true;
  setState(resources, 'loading', 'Loading resources...');
  const query = new URLSearchParams();
  if ($('#filter-type').value) query.set('type', $('#filter-type').value);
  if ($('#filter-status').value) query.set('status', $('#filter-status').value);
  try {
    const { resources: list } = await apiFetch(`/api/admin/resources${query.size ? `?${query}` : ''}`);
    $('#resource-rows').replaceChildren(...list.map(resourceRow));
    $('#resource-table-wrap').hidden = list.length === 0;
    setState(resources, list.length ? null : 'empty', 'No resources match. Use "Add resource" to create one.');
  } catch (err) {
    setState(resources, 'error', err.message, loadResources);
  }
}

function resourceRow(r) {
  const used = r.allocation.assigned + r.allocation.occupied + r.allocation.held;
  const actions = h('div', { class: 'row-actions' });
  if (r.status !== 'retired') {
    actions.append(h('button', { type: 'button', class: 'reserve-btn small', onclick: () => openForm(r) }, 'Edit'), retireButton(r));
  } else {
    actions.append('—');
  }
  return h('tr', {},
    h('td', {}, r.id),
    h('td', {}, TYPE_SINGULAR[r.type]),
    h('td', {}, r.label, r.description ? h('div', { class: 'hint' }, r.description) : ''),
    h('td', {}, r.capacity ?? '—'),
    h('td', {}, h('span', { class: `status ${r.status === 'active' ? 'available' : r.status}` }, r.status)),
    h('td', { title: `${r.allocation.assigned} assigned, ${r.allocation.occupied} occupied, ${r.allocation.held} held` },
      used ? h('span', {}, ...[[r.allocation.assigned, 'assigned', 'Assigned'], [r.allocation.occupied, 'in-use', 'Occupied'], [r.allocation.held, 'maintenance', 'Held']]
        .filter(([n]) => n).map(([, cls, text]) => h('span', { class: `status ${cls}` }, text))) : '—'),
    h('td', {}, actions));
}

// Two-step retire: the first click arms the button, the second one sends the request.
function retireButton(r) {
  let armed = null;
  const button = h('button', { type: 'button', class: 'reserve-btn small secondary' }, 'Retire');
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Confirm retire';
      button.classList.add('danger');
      armed = setTimeout(() => { armed = null; button.textContent = 'Retire'; button.classList.remove('danger'); }, 5000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    try {
      await apiFetch(`/api/admin/resources/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      await loadResources();
      say($('#resource-notice'), `${r.label} was retired.`);
    } catch (err) {
      armed = null;
      button.disabled = false;
      button.textContent = 'Retire';
      button.classList.remove('danger');
      say($('#resource-notice'), err.message, true);
    }
  });
  return button;
}

function syncTypeFields() {
  $('#f-capacity-wrap').hidden = fields.type.value !== 'discussion-room';
}

function openForm(resource = null) {
  editing = resource;
  form.reset();
  say($('#resource-error'), '');
  say($('#resource-notice'), '');
  $('#resource-form-title').textContent = resource ? `Edit ${resource.id}` : 'Add resource';
  fields.id.value = resource?.id ?? '';
  fields.type.value = resource?.type ?? 'silent-seat';
  fields.label.value = resource?.label ?? '';
  fields.description.value = resource?.description ?? '';
  fields.capacity.value = resource?.capacity ?? '';
  fields.id.readOnly = fields.type.disabled = !!resource;
  const statuses = resource ? [resource.status, ...NEXT_STATUS[resource.status]] : ['active', 'maintenance'];
  fields.status.replaceChildren(...statuses.map((s) => h('option', { value: s }, s)));
  fields.status.value = resource?.status ?? 'active';
  syncTypeFields();
  form.hidden = false;
  (resource ? fields.label : fields.id).focus();
}

fields.type.addEventListener('change', syncTypeFields);
$('#add-resource').addEventListener('click', () => openForm());
$('#resource-cancel').addEventListener('click', () => { form.hidden = true; });
$('#filter-type').addEventListener('change', loadResources);
$('#filter-status').addEventListener('change', loadResources);

let saving = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving) return;
  const error = $('#resource-error');
  say(error, '');
  const label = fields.label.value.trim();
  const description = fields.description.value.trim();
  if (!label || (!editing && !fields.id.value.trim())) return say(error, 'Identifier and label are required.', true);

  const capacity = fields.capacity.value === '' ? undefined : Number(fields.capacity.value);
  if (fields.type.value === 'discussion-room' && capacity === undefined) return say(error, 'Capacity is required for discussion rooms.', true);
  let request;
  if (editing) {
    const patch = {};
    if (label !== editing.label) patch.label = label;
    if (description !== editing.description) patch.description = description;
    if (editing.type === 'discussion-room' && capacity !== editing.capacity) patch.capacity = capacity;
    if (fields.status.value !== editing.status) patch.status = fields.status.value;
    if (!Object.keys(patch).length) { form.hidden = true; return; }
    request = apiFetch(`/api/admin/resources/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: patch });
  } else {
    const body = { id: fields.id.value.trim(), type: fields.type.value, label, description, status: fields.status.value };
    if (body.type === 'discussion-room') body.capacity = capacity;
    request = apiFetch('/api/admin/resources', { method: 'POST', body });
  }

  saving = true;
  $('#resource-save').disabled = true;
  try {
    await request;
    form.hidden = true;
    await loadResources();
    say($('#resource-notice'), editing ? 'Changes saved.' : 'Resource added.');
  } catch (err) {
    say(error, err.message, true);
  } finally {
    saving = false;
    $('#resource-save').disabled = false;
  }
});

// ------------------------------------------------------------------ settings

const settingsView = $('#view-settings');
const settingsForm = $('#settings-form');
let current = null;

async function loadSettings() {
  settingsForm.hidden = true;
  setState(settingsView, 'loading', 'Loading settings...');
  try {
    current = await apiFetch('/api/admin/settings');
    $('#settings-fields').replaceChildren(...Object.entries(SETTING_FIELDS).map(([key, [label, unit]]) => {
      const limit = current.limits[key];
      const hint = limit.allowed ? `Allowed: ${limit.allowed.join(', ')} ${unit}.` : `${limit.min} to ${limit.max} ${unit}.`;
      const control = limit.allowed
        ? h('select', { id: `s-${key}`, 'data-key': key }, ...limit.allowed.map((v) => h('option', { value: v }, String(v))))
        : h('input', { id: `s-${key}`, 'data-key': key, type: 'number', min: limit.min, max: limit.max, step: 1 });
      control.value = current.settings[key];
      return h('label', {}, `${label} (${unit})`, control, h('span', { class: 'hint' }, `${hint} Default ${limit.default}.`));
    }));
    $('#settings-meta').textContent = current.customized
      ? `Version ${current.version}, last changed ${when(current.updatedAt)}.`
      : 'Using the default values; nothing has been customized yet.';
    settingsForm.hidden = false;
    setState(settingsView, null);
  } catch (err) {
    setState(settingsView, 'error', err.message, loadSettings);
  }
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#settings-error');
  const notice = $('#settings-notice');
  say(error, '');
  say(notice, '');

  const patch = {};
  for (const input of settingsForm.querySelectorAll('[data-key]')) {
    const value = input.value.trim() === '' ? NaN : Number(input.value);
    input.setAttribute('aria-invalid', String(!Number.isInteger(value)));
    if (!Number.isInteger(value)) return say(error, `${SETTING_FIELDS[input.dataset.key][0]} must be a whole number.`, true);
    if (value !== current.settings[input.dataset.key]) patch[input.dataset.key] = value;
  }
  if (!Object.keys(patch).length) return say(notice, 'No changes to save.');

  $('#settings-save').disabled = true;
  try {
    const saved = await apiFetch('/api/admin/settings', { method: 'PATCH', body: patch });
    await loadSettings();
    say($('#settings-notice'), `Settings saved (version ${saved.version}).`);
  } catch (err) {
    say(error, err.message, true);
  } finally {
    $('#settings-save').disabled = false;
  }
});

// ------------------------------------------------------------------ navigation

const VIEWS = {
  overview: { el: overview, title: 'Overview', load: loadOverview },
  resources: { el: resources, title: 'Resources', load: loadResources },
  tickets: { el: $('#view-tickets'), title: 'Scan Codes', load: () => {} },
  reservations: { el: $('#view-reservations'), title: 'Reservations', load: loadReservations },
  workflow: { el: $('#view-workflow'), title: 'Approval Chain', load: loadWorkflow },
  ops: { el: $('#view-ops'), title: 'Operations', load: loadOps },
  audit: { el: $('#view-audit'), title: 'Audit Log', load: loadAudit },
  settings: { el: settingsView, title: 'System Settings', load: loadSettings },
};

function route() {
  const name = location.hash.slice(1) in VIEWS ? location.hash.slice(1) : 'overview';
  if (name !== 'tickets') stopScanner(); // the camera never keeps running behind another screen
  for (const [key, view] of Object.entries(VIEWS)) view.el.hidden = key !== name;
  document.querySelectorAll('[data-view]').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === name);
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#view-title').textContent = VIEWS[name].title;
  document.title = `${VIEWS[name].title} - Administrator - National University Philippines`;
  VIEWS[name].load();
}

// guard.js has already redirected anyone who is not a signed-in, active administrator; do nothing for them.
if (guardResult.status === 'allow') {
  initTicketsView();
  initReservationViews();
  initOpsView();
  initAuditView();
  initNotifications({ open: showReservation });
  window.addEventListener('hashchange', route);
  route();
}
