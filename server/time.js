// Time policy for discussion room bookings.
//
// Booking times are university-local wall-clock times in Asia/Manila (UTC+8, no daylight saving, so the offset is a
// constant and conversion needs no tz database). Students and administrators always see local times; the server
// stores absolute instants (Firestore Timestamps) plus the local date for day-based queries. A booking never spans
// midnight and must fit inside library hours. The server clock is the only clock that counts.

export const TIMEZONE = 'Asia/Manila';
const OFFSET_MINUTES = 8 * 60;
export const OPEN_MINUTES = 8 * 60; // 08:00
export const CLOSE_MINUTES = 20 * 60; // 20:00 (a booking may end at exactly this time)
export const SLOT_MINUTES = 15; // atomic lock granularity: every allowed booking interval (15, 30, 60) is a multiple of it
export const MAX_BOOKING_MINUTES = 4 * 60;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 'YYYY-MM-DD' -> { y, m, d } or null (rejects impossible dates such as 2026-02-30).
export function parseLocalDate(text) {
  const m = DATE.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? { y, m: mo, d } : null;
}

// 'HH:MM' -> minutes after local midnight, or null.
export function parseLocalTime(text) {
  const m = TIME.exec(typeof text === 'string' ? text : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// The absolute instant of a local date at a number of minutes after local midnight.
export function localToInstant(date, minutes) {
  return new Date(Date.UTC(date.y, date.m - 1, date.d) + (minutes - OFFSET_MINUTES) * 60_000);
}

// The local date ('YYYY-MM-DD') and minutes after midnight of an instant.
export function instantToLocal(instant) {
  const shifted = new Date(instant.getTime() + OFFSET_MINUTES * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  return { date, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export const formatMinutes = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const compactDate = (date) => date.replaceAll('-', '');

// Local date N calendar days after the local date of `instant`.
export function localDatePlusDays(instant, days) {
  const { date } = instantToLocal(instant);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// An instant the way people at the library read it ("14 Oct 2026, 1:00 pm (Asia/Manila)"), for emails, never raw UTC.
export const formatLocalInstant = (instant) => `${new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(instant)} (${TIMEZONE})`;
