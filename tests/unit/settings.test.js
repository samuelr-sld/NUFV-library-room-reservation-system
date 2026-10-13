import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, SETTINGS, validatePatch, validateMerged } from '../../server/settings.js';

test('every default satisfies its own limits and the cross-field rule', () => {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    assert.doesNotThrow(() => validatePatch({ [key]: spec.default }), key);
  }
  assert.doesNotThrow(() => validateMerged(DEFAULTS));
});

test('limits are inclusive at both ends and exclusive just outside', () => {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (spec.allowed) {
      for (const v of spec.allowed) assert.doesNotThrow(() => validatePatch({ [key]: v }));
      assert.throws(() => validatePatch({ [key]: Math.max(...spec.allowed) + 1 }), /one of/);
      continue;
    }
    assert.doesNotThrow(() => validatePatch({ [key]: spec.min }), `${key} min`);
    assert.doesNotThrow(() => validatePatch({ [key]: spec.max }), `${key} max`);
    assert.throws(() => validatePatch({ [key]: spec.min - 1 }), /between/, `${key} below`);
    assert.throws(() => validatePatch({ [key]: spec.max + 1 }), /between/, `${key} above`);
  }
});

test('only whole numbers are accepted', () => {
  for (const bad of ['60', 60.5, null, undefined, true, [], {}, NaN, Infinity]) {
    assert.throws(() => validatePatch({ noShowGraceMinutes: bad }), /whole number/, String(bad));
  }
});

test('unknown keys and non-objects are rejected', () => {
  assert.throws(() => validatePatch({ nope: 1 }), /Unknown setting/);
  assert.throws(() => validatePatch({}), /at least one/);
  for (const bad of [null, [], 'x', 5]) assert.throws(() => validatePatch(bad), /JSON object/);
});

test('the no-show grace period must be shorter than both ticket durations', () => {
  assert.doesNotThrow(() => validateMerged({ ...DEFAULTS, noShowGraceMinutes: 14, silentRoomTicketMinutes: 15, computerTicketMinutes: 15 }));
  assert.throws(() => validateMerged({ ...DEFAULTS, noShowGraceMinutes: 15, silentRoomTicketMinutes: 15 }), /shorter/);
  assert.throws(() => validateMerged({ ...DEFAULTS, noShowGraceMinutes: 30, computerTicketMinutes: 20 }), /shorter/);
});
