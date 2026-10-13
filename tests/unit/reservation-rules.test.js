import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalInstant, compactDate, formatMinutes, instantToLocal, localDatePlusDays, localToInstant, parseLocalDate, parseLocalTime } from '../../server/time.js';
import { dueReason, parseBooking, slotKeys } from '../../server/reservations.js';
import { effectiveChain, validateConfig, FINAL_LABEL } from '../../server/workflow.js';
import { maskEmail, newCode } from '../../server/challenges.js';

// "Now" for these tests: 2030-06-10 10:00 in Manila (UTC+8), a Monday.
const NOW = new Date('2030-06-10T02:00:00Z');
const base = { roomId: 'room-a', date: '2030-06-11', startTime: '09:00', endTime: '10:00', participants: [{ name: 'Maria Santos' }], purpose: 'Group study' };
const rules = { now: NOW, interval: 60, advanceDays: 7 };
const bad = (patch, re, r = rules) => assert.throws(() => parseBooking({ ...base, ...patch }, r), (e) => e.status === 400 && re.test(e.message), JSON.stringify(patch));

// ---------------------------------------------------------------- time policy

test('local times convert to absolute instants with the fixed +08:00 university offset, and back', () => {
  const day = parseLocalDate('2030-06-11');
  assert.equal(localToInstant(day, 9 * 60).toISOString(), '2030-06-11T01:00:00.000Z');
  assert.equal(localToInstant(day, 0).toISOString(), '2030-06-10T16:00:00.000Z'); // local midnight is the previous UTC day
  assert.deepEqual(instantToLocal(new Date('2030-06-10T16:00:00Z')), { date: '2030-06-11', minutes: 0 });
  assert.deepEqual(instantToLocal(NOW), { date: '2030-06-10', minutes: 600 });
  assert.deepEqual(instantToLocal(new Date('2030-06-10T15:59:59Z')), { date: '2030-06-10', minutes: 23 * 60 + 59 });
});

test('dates and times are strictly validated', () => {
  assert.deepEqual(parseLocalDate('2030-02-28'), { y: 2030, m: 2, d: 28 });
  for (const bad of ['2030-02-30', '2030-13-01', '2030-1-1', '30-06-11', '', null, undefined, 20300611, '2030-06-11T00:00']) assert.equal(parseLocalDate(bad), null, String(bad));
  assert.equal(parseLocalTime('09:30'), 570);
  for (const bad of ['9:30', '24:00', '09:60', '0930', '', null, 930, '09:30:00']) assert.equal(parseLocalTime(bad), null, String(bad));
  assert.equal(formatMinutes(570), '09:30');
  assert.equal(compactDate('2030-06-11'), '20300611');
});

test('"N days ahead" is counted in local calendar days, including across the UTC date line', () => {
  assert.equal(localDatePlusDays(NOW, 7), '2030-06-17');
  assert.equal(localDatePlusDays(new Date('2030-06-10T17:00:00Z'), 0), '2030-06-11'); // 01:00 local on the 11th
  assert.equal(localDatePlusDays(new Date('2030-12-30T17:00:00Z'), 3), '2031-01-03'); // already the 31st in Manila
});

// ---------------------------------------------------------------- slots

test('a booking is a bounded set of 15-minute slot keys; adjacent bookings share none', () => {
  const a = slotKeys('room-a', '2030-06-11', 9 * 60, 10 * 60);
  const b = slotKeys('room-a', '2030-06-11', 10 * 60, 11 * 60);
  assert.deepEqual(a, ['room-a__20300611__0900', 'room-a__20300611__0915', 'room-a__20300611__0930', 'room-a__20300611__0945']);
  assert.equal(b[0], 'room-a__20300611__1000');
  assert.equal(a.filter((k) => b.includes(k)).length, 0);
  assert.equal(slotKeys('room-a', '2030-06-11', 8 * 60, 12 * 60).length, 16, 'the longest booking needs 16 locks');
  assert.notEqual(slotKeys('room-a', '2030-06-11', 540, 555)[0], slotKeys('room-b', '2030-06-11', 540, 555)[0]);
  assert.notEqual(slotKeys('room-a', '2030-06-11', 540, 555)[0], slotKeys('room-a', '2030-06-12', 540, 555)[0]);
});

// ---------------------------------------------------------------- booking validation

test('a valid request is normalized: instants, participant count including the requester, trimmed text', () => {
  const b = parseBooking({ ...base, purpose: '  Group study  ', notes: ' whiteboard ', participants: [{ name: ' Maria Santos ', studentNumber: '2023-123456' }, { name: 'Jo Lim' }] }, rules);
  assert.equal(b.startsAt.toISOString(), '2030-06-11T01:00:00.000Z');
  assert.equal(b.endsAt.toISOString(), '2030-06-11T02:00:00.000Z');
  assert.equal(b.participantCount, 3);
  assert.equal(b.purpose, 'Group study');
  assert.equal(b.notes, 'whiteboard');
  assert.deepEqual(b.participants[0], { name: 'Maria Santos', studentNumber: '2023-123456' });
});

test('times must fit the configured booking interval', () => {
  bad({ startTime: '09:30', endTime: '10:30' }, /60-minute marks/);
  assert.doesNotThrow(() => parseBooking({ ...base, startTime: '09:30', endTime: '10:30' }, { ...rules, interval: 30 }));
  assert.doesNotThrow(() => parseBooking({ ...base, startTime: '09:15', endTime: '09:45' }, { ...rules, interval: 15 }));
  bad({ startTime: '09:15', endTime: '09:45' }, /30-minute marks/, { ...rules, interval: 30 });
  bad({ startTime: '09:00', endTime: '09:20' }, /marks/);
});

test('library hours, ordering and maximum length are enforced', () => {
  bad({ startTime: '07:00', endTime: '08:00' }, /between 08:00 and 20:00/);
  bad({ startTime: '19:00', endTime: '21:00' }, /between 08:00 and 20:00/);
  assert.doesNotThrow(() => parseBooking({ ...base, startTime: '19:00', endTime: '20:00' }, rules));
  assert.doesNotThrow(() => parseBooking({ ...base, startTime: '08:00', endTime: '12:00' }, rules));
  bad({ startTime: '08:00', endTime: '13:00' }, /at most 4 hours/);
  bad({ startTime: '10:00', endTime: '09:00' }, /after the start/);
  bad({ startTime: '10:00', endTime: '10:00' }, /after the start/);
  bad({ startTime: '10:00', endTime: '24:00' }, /Choose a start and an end/);
});

test('the booking window: future starts only, up to the advance-booking limit inclusive', () => {
  bad({ date: '2030-06-10', startTime: '09:00', endTime: '10:00' }, /in the future/); // 09:00 today is already past at 10:00
  bad({ date: '2030-06-10', startTime: '10:00', endTime: '11:00' }, /in the future/); // starts exactly now
  assert.doesNotThrow(() => parseBooking({ ...base, date: '2030-06-10', startTime: '11:00', endTime: '12:00' }, rules));
  assert.doesNotThrow(() => parseBooking({ ...base, date: '2030-06-17' }, rules)); // today + 7
  bad({ date: '2030-06-18' }, /at most 7 day/);
  bad({ date: '2030-06-05' }, /in the future/);
  bad({ date: '2030-02-30' }, /valid date/);
  assert.doesNotThrow(() => parseBooking({ ...base, date: '2030-06-12' }, { ...rules, advanceDays: 2 }));
  bad({ date: '2030-06-13' }, /at most 2 day/, { ...rules, advanceDays: 2 });
});

test('participants, purpose and notes are validated; unknown fields are refused', () => {
  bad({ participants: 'Maria' }, /list of the other participants/);
  bad({ participants: [{ name: 'M' }] }, /name of 2 to 80/);
  bad({ participants: [{ name: 'Maria Santos', studentNumber: 'a b' }] }, /student number/);
  bad({ participants: [{ name: 'Maria Santos', role: 'admin' }] }, /unknown field/);
  bad({ participants: [{ name: 'Maria\nSantos' }] }, /name of 2 to 80/);
  bad({ participants: Array.from({ length: 50 }, () => ({ name: 'Someone' })) }, /list of the other participants/);
  bad({ purpose: 'ab' }, /3 to 200/);
  bad({ purpose: 'x'.repeat(201) }, /3 to 200/);
  bad({ purpose: 5 }, /3 to 200/);
  bad({ notes: 'x'.repeat(201) }, /at most 200/);
  bad({ uid: 'someone-else' }, /Unknown field/);
  bad({ status: 'confirmed' }, /Unknown field/);
  bad({ roomId: '../users/x' }, /Choose a room/);
  assert.throws(() => parseBooking([], rules), /JSON object/);
  assert.throws(() => parseBooking(null, rules), /JSON object/);
});

test('dueReason: a pending request expires at its step deadline or at the booking start, whichever comes first', () => {
  const T = (iso) => ({ toMillis: () => Date.parse(iso) });
  const r = { status: 'pending', startsAt: T('2030-06-11T01:00:00Z'), stepDeadline: T('2030-06-10T12:00:00Z') };
  assert.equal(dueReason(r, new Date('2030-06-10T11:59:59Z')), null);
  assert.equal(dueReason(r, new Date('2030-06-10T12:00:00Z')), 'approval_timeout');
  assert.equal(dueReason(r, new Date('2030-06-11T01:00:00Z')), 'start_passed');
  assert.equal(dueReason({ ...r, status: 'confirmed' }, new Date('2031-01-01Z')), null);
  assert.equal(dueReason({ ...r, status: 'cancelled' }, new Date('2031-01-01Z')), null);
});

// ---------------------------------------------------------------- approval workflow configuration

const step = (n, extra = {}) => ({ label: `Approver ${n}`, email: `Approver${n}@Example.edu `, enabled: true, ...extra });

test('a valid chain is normalized and always ends with the final administrator step', () => {
  const config = validateConfig({ steps: [step(1), step(2, { enabled: false }), step(3)], stepHours: 24 });
  assert.deepEqual(config.steps.map((s) => s.email), ['approver1@example.edu', 'approver2@example.edu', 'approver3@example.edu']);
  const chain = effectiveChain(config);
  assert.deepEqual(chain.map((s) => s.type), ['external', 'external', 'admin']);
  assert.equal(chain.at(-1).label, FINAL_LABEL);
  assert.equal(chain.at(-1).email, undefined, 'the final step has no external approver');
  assert.deepEqual(effectiveChain({ steps: [], stepHours: 48 }).map((s) => s.type), ['admin']);
  assert.deepEqual(effectiveChain({ steps: [step(1, { enabled: false })], stepHours: 48 }).map((s) => s.type), ['admin']);
  assert.equal(validateConfig({ steps: [] }).stepHours, 48);
});

test('chain validation rejects bad emails, labels, flags, duplicates, extra fields and oversized chains', () => {
  const throws = (body, re) => assert.throws(() => validateConfig(body), (e) => e.status === 400 && re.test(e.message), JSON.stringify(body).slice(0, 80));
  throws(null, /JSON object/);
  throws([], /JSON object/);
  throws({}, /steps must be a list/);
  throws({ steps: 'x' }, /steps must be a list/);
  throws({ steps: Array.from({ length: 6 }, (_, i) => step(i)) }, /at most 5/);
  throws({ steps: [step(1, { email: 'not-an-email' })] }, /valid approver email/);
  throws({ steps: [step(1, { email: 'a@b' })] }, /valid approver email/);
  throws({ steps: [step(1, { email: 'a@b.co, c@d.co' })] }, /valid approver email/);
  throws({ steps: [step(1, { label: '' })] }, /label/);
  throws({ steps: [step(1, { label: 'x'.repeat(61) })] }, /label/);
  throws({ steps: [step(1, { enabled: 'yes' })] }, /enabled/);
  throws({ steps: [step(1, { type: 'admin' })] }, /unknown field "type"/);
  throws({ steps: [step(1), step(2, { email: 'APPROVER1@example.edu' })] }, /same email/);
  throws({ steps: [], finalStep: { type: 'external' } }, /Unknown field "finalStep"/);
  throws({ steps: [], stepHours: 0 }, /stepHours/);
  throws({ steps: [], stepHours: 169 }, /stepHours/);
  throws({ steps: [], stepHours: 1.5 }, /stepHours/);
  assert.doesNotThrow(() => validateConfig({ steps: [step(1), step(2, { enabled: false, email: 'approver1@example.edu' })] }), 'a disabled duplicate is allowed');
});

// ---------------------------------------------------------------- challenge helpers

test('codes are six digits and emails are masked in anything shown to an approver', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const code = newCode();
    assert.match(code, /^\d{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 250);
  assert.equal(maskEmail('jane.doe@example.edu'), 'j***@example.edu');
});

test('instants in emails are written in local library time, never as raw UTC', () => {
  assert.equal(formatLocalInstant(new Date('2026-10-14T05:00:00Z')), '14 Oct 2026, 1:00 pm (Asia/Manila)');
  assert.equal(formatLocalInstant(new Date('2026-10-13T16:30:00Z')), '14 Oct 2026, 12:30 am (Asia/Manila)', 'across midnight: the local date, not the UTC one');
  assert.doesNotMatch(formatLocalInstant(new Date()), /T\d\d:\d\d|Z\b/);
});
