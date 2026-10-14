// Student Home: today's rooms and the student's own upcoming reservations, from the existing API. Nothing here is invented:
// where the system has no feature (announcements) the page says so. Server data is always inserted as text.
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';
import { h } from '../../js/dom.js';

const $ = (selector) => document.querySelector(selector);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const note = (el, text, isError = false) => { el.hidden = !text; el.textContent = text ?? ''; el.classList.toggle('error', isError); };

// Current local time at the library (the server's Asia/Manila policy), whatever the visitor's own time zone.
function manilaMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}

async function loadRooms() {
  const state = $('#rooms-state');
  try {
    const rules = await apiFetch('/api/reservations/config');
    const { rooms } = await apiFetch(`/api/reservations/availability?date=${rules.today}`);
    const now = manilaMinutes();
    const open = now >= minutes(rules.open) && now < minutes(rules.close);
    $('#room-rows').replaceChildren(...rooms.map((room) => {
      const taken = room.busy.some((b) => now >= b.start && now < b.end);
      const [label, cls, why] = !open ? ['Closed', 'in-use', `Open ${rules.open} to ${rules.close}`] : taken ? ['Taken now', 'in-use', 'Booked, or held while a request is being reviewed'] : ['Free now', 'available', 'No booking or pending request covers this moment'];
      return h('tr', {},
        h('td', {}, room.label, room.description ? h('div', { class: 'home-note' }, room.description) : ''),
        h('td', {}, h('i', { class: 'fas fa-users', 'aria-hidden': 'true' }), ` ${room.capacity}`),
        h('td', {}, h('span', { class: `status ${cls}`, title: why }, label)),
        h('td', {}, h('a', { href: '../reserve/reserve.html', class: 'reserve-btn' }, 'Reserve')));
    }));
    $('#rooms-table').hidden = rooms.length === 0;
    note(state, rooms.length ? '' : 'No discussion rooms have been set up for booking yet.');
    return rules.today;
  } catch (err) {
    $('#rooms-table').hidden = true;
    note(state, `Rooms could not be loaded. ${err.message}`, true);
    return null;
  }
}

function reservationCard(r, today) {
  const [y, m, d] = r.date.split('-').map(Number);
  const when = r.status === 'pending' ? ['pending', 'Pending approval'] : r.date === today ? ['today', 'Today'] : ['upcoming', 'Confirmed'];
  return h('div', { class: 'reservation-card' },
    h('div', { class: 'date-badge' }, h('div', { class: 'month' }, MONTHS[m - 1]), h('div', { class: 'day' }, String(d)), h('div', { class: 'dayname' }, DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()])),
    h('div', { class: 'reservation-details' },
      h('h4', {}, r.room.label),
      h('p', { class: 'time' }, h('i', { class: 'fas fa-clock', 'aria-hidden': 'true' }), ` ${r.startTime} - ${r.endTime}`),
      h('p', { class: 'activity' }, h('i', { class: 'fas fa-users', 'aria-hidden': 'true' }), ` ${r.purpose}`)),
    h('span', { class: `badge ${when[0]}` }, when[1]));
}

async function loadUpcoming(today) {
  const state = $('#upcoming-state');
  try {
    const { reservations } = await apiFetch('/api/reservations');
    const now = Date.now();
    const next = reservations.filter((r) => ['pending', 'confirmed'].includes(r.status) && Date.parse(r.endsAt) > now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 3);
    $('#upcoming-list').replaceChildren(...next.map((r) => reservationCard(r, today)));
    note(state, next.length ? '' : 'You have no upcoming reservations.');
  } catch (err) {
    note(state, `Your reservations could not be loaded. ${err.message}`, true);
  }
}

if (guardResult.status === 'allow') {
  const number = guardResult.profile.studentNumber;
  if (number) $('.student-course').textContent = `Student no. ${number}`;
  loadRooms().then((today) => loadUpcoming(today));
}
