// Connects the reservation form to the API. The page never decides anything: rooms, capacity, the booking window,
// the interval and conflicts are all checked again by the server inside a transaction. What is shown here (free times,
// capacity) only saves the student a round trip.
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';

const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  node.append(...kids);
  return node;
};

const pad = (n) => String(n).padStart(2, '0');
const to12 = (minutes) => {
  const h = Math.floor(minutes / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(minutes % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};
// "9:00 AM" -> minutes after midnight (the select options keep the existing display text as their value).
function from12(text) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(text ?? '');
  return m ? (Number(m[1]) % 12 + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]) : null;
}
const to24 = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const clock = (text) => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };

async function init() {
  const room = $('#room');
  const date = $('#date');
  const start = $('#start-time');
  const end = $('#end-time');
  const num = $('#num');
  const form = $('.reservation-form');
  const status = $('#reserve-status');
  const submit = form.querySelector('.submit-button');

  const say = (content, isError = false) => {
    status.replaceChildren(...(Array.isArray(content) ? content : [content]));
    status.hidden = !content;
    status.classList.toggle('error', isError);
  };

  let rules;
  let rooms = [];
  let busy = [];
  try {
    [rules, { rooms }] = await Promise.all([apiFetch('/api/reservations/config'), apiFetch('/api/reservations/rooms')]);
  } catch (err) {
    submit.disabled = true;
    return say(err.message, true);
  }

  // ---- fill the controls from the server's rules ----
  const placeholder = (select) => select.querySelector('option[disabled]');
  const fill = (select, options) => select.replaceChildren(placeholder(select), ...options);
  fill(room, rooms.map((r) => el('option', { value: r.id }, `${r.label} (up to ${r.capacity})`)));
  if (!rooms.length) say('No discussion rooms are open for booking right now.', true);

  date.min = rules.today;
  date.max = rules.lastDate;
  const openMin = clock(rules.open);
  const closeMin = clock(rules.close);
  const step = rules.intervalMinutes;
  const startTimes = [];
  for (let m = openMin; m + step <= closeMin; m += step) startTimes.push(m);
  fill(start, startTimes.map((m) => el('option', {}, to12(m))));

  function fillEnd() {
    const from = from12(start.value);
    const keep = end.value;
    const options = [];
    for (let m = (from ?? openMin) + step; m <= Math.min(closeMin, (from ?? openMin) + rules.maxHours * 60); m += step) options.push(el('option', {}, to12(m)));
    fill(end, options);
    if (options.some((o) => o.textContent === keep)) end.value = keep;
  }
  fillEnd();

  const selectedRoom = () => rooms.find((r) => r.id === room.value);
  function fillParticipantCount() {
    const cap = selectedRoom()?.capacity ?? 2;
    const keep = num.value;
    const options = [];
    for (let n = Math.min(2, cap); n <= cap; n++) options.push(el('option', { value: n }, `${n} Participant${n > 1 ? 's' : ''}`));
    fill(num, options);
    if (options.some((o) => o.value === keep)) num.value = keep;
    renderParticipants();
  }

  // One row per other participant (the requester is already counted).
  const group = el('div', { class: 'form-group', id: 'participants-group', hidden: true }, el('label', {}, 'Other participants'));
  const rowsBox = el('div', { id: 'participant-rows' });
  group.append(rowsBox);
  $('#requests').closest('.form-group').before(group);
  function renderParticipants() {
    const others = Math.max(0, Number(num.value || 0) - 1);
    const old = [...rowsBox.querySelectorAll('.participant-row')].map((row) => [...row.querySelectorAll('input')].map((i) => i.value));
    rowsBox.replaceChildren(...Array.from({ length: others }, (_, i) => el('div', { class: 'participant-row' },
      el('input', { type: 'text', placeholder: `Participant ${i + 2} full name`, 'aria-label': `Participant ${i + 2} full name`, maxlength: 80, value: old[i]?.[0] ?? '' }),
      el('input', { type: 'text', placeholder: 'Student no. (optional)', 'aria-label': `Participant ${i + 2} student number`, maxlength: 24, value: old[i]?.[1] ?? '' }))));
    group.hidden = others === 0;
  }

  // ---- advisory availability note ----
  const note = el('p', { class: 'reserve-note', id: 'availability-note', hidden: true });
  $('.time-row').after(note);
  async function showAvailability() {
    note.hidden = true;
    if (!room.value || !date.value) return;
    try {
      const day = await apiFetch(`/api/reservations/availability?date=${encodeURIComponent(date.value)}`);
      busy = day.rooms.find((r) => r.id === room.value)?.busy ?? [];
      note.textContent = busy.length ? `Already reserved or under review: ${busy.map((b) => `${to12(b.start)} to ${to12(b.end)}`).join(', ')}.` : 'This room is free all day.';
      note.hidden = false;
    } catch { /* the server will still decide on submit */ }
  }

  room.addEventListener('change', () => { fillParticipantCount(); showAvailability(); });
  date.addEventListener('change', showAvailability);
  start.addEventListener('change', fillEnd);
  num.addEventListener('change', renderParticipants);
  form.addEventListener('reset', () => setTimeout(() => { rowsBox.replaceChildren(); group.hidden = true; note.hidden = true; fillEnd(); }, 0));

  // ---- submit ----
  let sending = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    say('');
    const startMin = from12(start.value);
    const endMin = from12(end.value);
    if (!room.value || !date.value || startMin === null || endMin === null || !num.value || !$('#purpose').value.trim()) {
      return say('Please fill in the room, date, times, purpose and number of participants.', true);
    }
    const participants = [...rowsBox.querySelectorAll('.participant-row')].map((row) => {
      const [name, studentNumber] = [...row.querySelectorAll('input')].map((i) => i.value.trim());
      return { name, ...(studentNumber ? { studentNumber } : {}) };
    });
    if (participants.some((p) => !p.name)) return say("Please enter every participant's name.", true);

    sending = true;
    submit.disabled = true;
    try {
      const { reservation } = await apiFetch('/api/reservations', {
        method: 'POST',
        body: { roomId: room.value, date: date.value, startTime: to24(startMin), endTime: to24(endMin), participants, purpose: $('#purpose').value.trim(), notes: $('#requests').value.trim() },
      });
      const first = reservation.currentStepLabel;
      say([`Request submitted (${reservation.id}). `, first ? `It is waiting for: ${first}. ` : '', el('a', { href: '../reservations/reservations.html' }, 'Follow its progress in My Reservations')]);
      $('.reset-button').click();
    } catch (err) {
      say(err.message, true);
      if (err.code === 'slot-taken') showAvailability();
    } finally {
      sending = false;
      submit.disabled = false;
    }
  });
}

if (guardResult.status === 'allow') init();
