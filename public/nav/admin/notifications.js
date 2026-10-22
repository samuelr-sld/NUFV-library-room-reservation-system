// Administrator popups: "new reservation request" and "ready for final review". Polls one cheap endpoint while the tab is
// visible. State lives in memory only: a refresh starts from the server's clock and never replays or shows history.
import { apiFetch } from '../../js/api.js';
import { h } from '../../js/dom.js';

export const POLL_MS = 20_000;
export const MAX_POLL_MS = 120_000;
export const OVERLAP_MS = 60_000; // a transaction's timestamp can predate its commit; re-read a minute and dedupe by key
export const SHOW_MS = 6_000;
export const MAX_VISIBLE = 3;

const TITLES = { submitted: 'New reservation request', final: 'Ready for final review' };

// ---- pure helpers (unit tested) ----
export const nextDelay = (failures) => Math.min(POLL_MS * 2 ** failures, MAX_POLL_MS);
export const sinceFor = (serverTime) => new Date(new Date(serverTime).getTime() - OVERLAP_MS).toISOString();
export const keyOf = (e) => `${e.id}:${e.type}`;

// Events not shown before and not older than this page load; remembers what it returns.
export function takeNew(events, seen, floor) {
  const fresh = events.filter((e) => e.at >= floor && !seen.has(keyOf(e)));
  fresh.forEach((e) => seen.add(keyOf(e)));
  return fresh;
}

// At most `max` popups per batch, the summary included: on overflow the newest max-1 events plus a count of the rest.
export function split(events, max = MAX_VISIBLE) {
  if (events.length <= max) return { show: events, more: 0 };
  const show = events.slice(-(max - 1));
  return { show, more: events.length - show.length };
}

// ---- popups ----
function popup(box, { title, line, onOpen }) {
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(close, SHOW_MS); };
  const el = h('div', { class: 'toast', role: 'status' },
    h('button', { type: 'button', class: 'toast-body', onclick: () => { close(); onOpen(); } }, h('strong', {}, title), line),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss notification', onclick: close }, '×'));
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  el.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  box.prepend(el);
  while (box.children.length > MAX_VISIBLE) box.lastElementChild.remove(); // oldest goes first
  arm();
}

export function initNotifications({ open }) {
  const box = document.querySelector('#toasts');
  if (!box) return;
  const seen = new Set();
  let cursor = null; // the server's clock at the last successful poll
  let floor = null; // the server's clock at page load: nothing older is ever announced
  let failures = 0;
  let timer = null;
  let busy = false;
  let stopped = false;

  const show = (events) => {
    const { show: shown, more } = split(events);
    if (more > 0) popup(box, { title: `${more} more need attention`, line: 'Open the reservation queue.', onOpen: () => open(null) });
    shown.forEach((e) => popup(box, { title: TITLES[e.type], line: `${e.room} · ${e.date} ${e.startTime}–${e.endTime}`, onOpen: () => open(e.id) }));
  };

  async function tick() {
    clearTimeout(timer);
    if (busy || stopped || document.visibilityState !== 'visible') return; // visibilitychange resumes
    busy = true;
    try {
      const r = await apiFetch(cursor ? `/api/admin/notifications?since=${encodeURIComponent(sinceFor(cursor))}` : '/api/admin/notifications');
      failures = 0;
      if (floor === null) floor = r.serverTime;
      else show(takeNew(r.events, seen, floor));
      cursor = r.serverTime;
    } catch (err) {
      if (err.status === 401 || err.status === 403) stopped = true; // guard.js handles the redirect
      else failures += 1; // keep cursor and seen: the next success catches up
    } finally {
      busy = false;
    }
    if (!stopped) timer = setTimeout(tick, nextDelay(failures));
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  tick();
}
