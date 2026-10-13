// Small DOM helpers shared by the administrator screens. Server data is always inserted as text, never as HTML.
import { devMailUrl } from './firebase-config.js';

export function h(tag, attrs = {}, ...kids) {
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

export const say = (el, text, isError = false) => { el.hidden = !text; el.textContent = text ?? ''; el.classList.toggle('error', isError); };
export const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// One inline message at the top of a form (sign-in, registration, password reset), announced to screen readers. Replaces blocking
// alert() pop-ups: it stays on screen, can be read again, and works the same on a phone.
export function notice(form, text, { error = true } = {}) {
  let el = form.querySelector('.form-notice');
  if (!el) { el = document.createElement('p'); el.className = 'form-notice'; form.prepend(el); }
  el.hidden = !text;
  el.textContent = text ?? '';
  el.setAttribute('role', error ? 'alert' : 'status');
  el.classList.toggle('error', error);
}

// In local demo or development mode, say plainly that no real email was sent and where to read it. Nothing on a deployed site.
export function demoMailNote(container) {
  const url = devMailUrl(location.hostname, location.port);
  if (!url || container.querySelector('.demo-mail')) return;
  container.append(h('p', { class: 'form-notice demo-mail', role: 'note' },
    'Demo mode: no real email is sent. Open the ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'demo email viewer'), ' to read it.'));
}
