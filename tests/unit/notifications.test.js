import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, nextDelay, sinceFor, split, takeNew } from '../../public/nav/admin/notifications.js';

const ev = (id, type, at) => ({ id, type, at, room: 'R', date: '2030-06-11', startTime: '09:00', endTime: '10:00' });
const T0 = '2030-06-10T02:00:00.000Z';

test('takeNew drops events from before the page loaded: no history after a refresh', () => {
  const seen = new Set();
  const fresh = takeNew([ev('RS-1', 'submitted', '2030-06-10T01:59:30.000Z'), ev('RS-2', 'final', '2030-06-10T02:00:05.000Z')], seen, T0);
  assert.deepEqual(fresh.map(keyOf), ['RS-2:final']);
});

test('takeNew shows an event once, even when the overlap window returns it again', () => {
  const seen = new Set();
  const e = ev('RS-2', 'final', '2030-06-10T02:00:05.000Z');
  assert.equal(takeNew([e], seen, T0).length, 1);
  assert.equal(takeNew([e], seen, T0).length, 0);
});

test('the two events of one reservation are independent', () => {
  const seen = new Set();
  assert.equal(takeNew([ev('RS-3', 'submitted', '2030-06-10T02:01:00.000Z')], seen, T0).length, 1);
  assert.equal(takeNew([ev('RS-3', 'submitted', '2030-06-10T02:01:00.000Z'), ev('RS-3', 'final', '2030-06-10T02:05:00.000Z')], seen, T0).map(keyOf)[0], 'RS-3:final');
});

test('sinceFor looks back one minute', () => {
  assert.equal(sinceFor(T0), '2030-06-10T01:59:00.000Z');
});

test('split keeps summary + events within the cap of three: newest two events and a count of the rest', () => {
  const events = [1, 2, 3, 4, 5].map((n) => ev(`RS-${n}`, 'submitted', T0));
  const { show, more } = split(events);
  assert.deepEqual(show.map((e) => e.id), ['RS-4', 'RS-5']);
  assert.equal(more, 3);
  assert.equal(show.length + 1, 3, 'the summary popup takes the third slot');
  assert.deepEqual(split(events.slice(0, 3)), { show: events.slice(0, 3), more: 0 }, 'exactly three events need no summary');
});

test('backoff doubles from 20 s and stops at 120 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(nextDelay), [20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
});
