// Audit log: who did what, to which ticket or reservation, and why. Read-only, newest first, one bounded page at a time.
// The API never returns passwords, codes or tokens; everything is shown as text.
import { apiFetch } from '../../js/api.js';
import { h, say, when } from '../../js/dom.js';

const $ = (selector) => document.querySelector(selector);
let next = null; // cursor of the following page, or null when this is the last

async function load({ more = false } = {}) {
  const state = $('#audit-state');
  say($('#audit-error'), '');
  const query = new URLSearchParams({ limit: '50' });
  const filter = $('#audit-filter').value.trim();
  if (filter) query.set($('#audit-filter-kind').value, filter);
  if (more && next) query.set('before', next);
  if (!more) { state.hidden = false; state.textContent = 'Loading the audit log...'; }
  $('#audit-more').disabled = true;
  try {
    const page = await apiFetch(`/api/admin/audit?${query}`);
    const rows = page.entries.map((e) => h('tr', {},
      h('td', {}, when(e.at)),
      h('td', {}, e.action),
      h('td', {}, e.actor.label),
      h('td', {}, `${e.target.type} ${e.target.id}`),
      h('td', {}, e.outcome),
      h('td', {}, e.reason ?? '—')));
    if (more) $('#audit-rows').append(...rows); else $('#audit-rows').replaceChildren(...rows);
    next = page.next;
    const any = $('#audit-rows').children.length > 0;
    $('#audit-table-wrap').hidden = !any;
    state.hidden = any;
    state.textContent = 'No entries match.';
    $('#audit-more').hidden = !next;
  } catch (err) {
    state.hidden = true;
    say($('#audit-error'), err.message, true);
  } finally {
    $('#audit-more').disabled = false;
  }
}

export const loadAudit = () => load();

let wired = false;
export function initAuditView() {
  if (wired) return;
  wired = true;
  $('#audit-form').addEventListener('submit', (event) => { event.preventDefault(); load(); });
  $('#audit-more').addEventListener('click', () => load({ more: true }));
}
