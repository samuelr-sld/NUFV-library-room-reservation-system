import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { normalizeReference, readFrame, createDebouncer, QR_PREFIX, RESERVATION_PREFIX } from '../../public/js/qr-reference.js';
import { parseReference } from '../../server/tickets.js';
import { isReservationReference, parseReservationReference } from '../../server/reservations.js';

// The scanner's decoding logic, run for real: QR matrices from the same generator the server uses, rasterized to
// pixels like a camera frame, decoded by the vendored jsQR build. No browser or camera involved.
const jsQR = createRequire(import.meta.url)('jsqr');
// The browser loads the vendored file as a script that sets self.jsQR; evaluate it the same way.
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(readFileSync('public/vendor/jsqr/jsQR.js', 'utf8'), sandbox);
const VENDORED = sandbox.jsQR;

function frameFor(text, { scale = 6, quiet = 4, width, height, offset = [0, 0], noise = false } = {}) {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const side = (size + quiet * 2) * scale;
  const [w, h] = [width ?? side, height ?? side];
  const rgba = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = Math.floor((x - offset[0]) / scale) - quiet;
      const qy = Math.floor((y - offset[1]) / scale) - quiet;
      const inside = x >= offset[0] && y >= offset[1] && qx >= -quiet && qy >= -quiet && qx < size + quiet && qy < size + quiet;
      let v = 255;
      if (inside) v = qx >= 0 && qy >= 0 && qx < size && qy < size && data[qy * size + qx] ? 0 : 255;
      else if (noise) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v = 200 + (seed % 56); } // light, grainy background
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { data: rgba, width: w, height: h };
}

const payload = () => `${QR_PREFIX}${randomBytes(18).toString('base64url')}`;

test('the vendored decoder is the unmodified jsQR package build and decodes like it', () => {
  assert.equal(readFileSync('public/vendor/jsqr/jsQR.js', 'utf8'), readFileSync('node_modules/jsqr/dist/jsQR.js', 'utf8'));
  assert.equal(typeof VENDORED, 'function');
  const text = payload();
  const frame = frameFor(text);
  assert.equal(VENDORED(frame.data, frame.width, frame.height).data, text);
});

test('every stub QR payload decodes back to exactly the payload, at several sizes', () => {
  for (let i = 0; i < 25; i++) {
    const text = payload();
    for (const scale of [3, 5, 8]) assert.equal(readFrame(jsQR, frameFor(text, { scale })), text, `${text} @${scale}`);
  }
});

test('a code held somewhere inside a larger, grainy camera frame is still found', () => {
  const text = payload();
  const frame = frameFor(text, { scale: 5, width: 640, height: 480, offset: [210, 120], noise: true });
  assert.equal(readFrame(jsQR, frame), text);
});

test('frames with no code, or someone else\'s QR code, yield nothing', () => {
  const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
  assert.equal(readFrame(jsQR, blank), null);
  for (const other of ['https://example.com/', 'WIFI:S:cafe;T:WPA;P:secret;;', 'NUFV2:' + 'a'.repeat(24), 'hello']) {
    const frame = frameFor(other);
    assert.equal(jsQR(frame.data, frame.width, frame.height)?.data, other, 'the decoder itself does read it');
    assert.equal(readFrame(jsQR, frame), null, `${other} is not a library stub`);
  }
});

test('the client accepts what the server accepts and rejects what it rejects', () => {
  const ref = randomBytes(18).toString('base64url');
  const samples = [
    `NUFV1:${ref}`, ref, ` NUFV1:${ref} `, 'SR-0123456789', 'cs-abcdefghjk', 'WF-ZZZZZZZZZZ', 'SR-ILOU012345', 'NUFV1:', 'NUFV1:short', `NUFV2:${ref}`,
    'a'.repeat(23), 'a'.repeat(25), 'a'.repeat(5000), '', '   ', 'hello world', "NUFV1:'; drop table", 'abc+def/ghi=jklmnopqrstu', null, 42, [ref],
  ];
  for (const s of samples) assert.equal(normalizeReference(s) !== null, parseReference(s) !== null, JSON.stringify(s));
  assert.equal(normalizeReference(ref), `NUFV1:${ref}`);
  assert.equal(normalizeReference('sr-0123456789'), 'SR-0123456789');
});

test('server reference parsing: payload, bare reference and ticket id resolve to the right lookup', () => {
  const ref = randomBytes(18).toString('base64url');
  assert.deepEqual(parseReference(`NUFV1:${ref}`), { by: 'qr', value: ref });
  assert.deepEqual(parseReference(ref), { by: 'qr', value: ref });
  assert.deepEqual(parseReference('sr-0123456789'), { by: 'id', value: 'SR-0123456789' });
  assert.equal(parseReference('../users/x'), null);
});

test('duplicate scan suppression: the same code is reported once per window, other codes immediately', () => {
  let t = 0;
  const accept = createDebouncer(5000, () => t);
  assert.equal(accept('A'), true);
  t = 100; assert.equal(accept('A'), false);
  t = 4999; assert.equal(accept('A'), false);
  t = 4999; assert.equal(accept('B'), true);
  t = 5100; assert.equal(accept('B'), false);
  t = 20000; assert.equal(accept('B'), true);
});

// ---------------------------------------------------------------- reservation confirmations (NUFR1) share the scanner

const reservationPayload = () => `${RESERVATION_PREFIX}${randomBytes(18).toString('base64url')}`;

test('reservation QR payloads decode back exactly, and the scanner reports them alongside stub codes', () => {
  for (let i = 0; i < 15; i++) {
    const text = reservationPayload();
    for (const scale of [3, 5, 8]) assert.equal(readFrame(jsQR, frameFor(text, { scale })), text, `${text} @${scale}`);
  }
  assert.equal(readFrame(jsQR, frameFor('NUFR2:' + 'a'.repeat(24))), null, 'another version is not ours');
});

test('the client and the server accept and reject the same reservation references', () => {
  const ref = randomBytes(18).toString('base64url');
  const samples = [
    `NUFR1:${ref}`, ` NUFR1:${ref} `, 'RC-0123456789', 'rc-abcdefghjk', 'RC-ILOU000000', 'RC-012345678', 'NUFR1:', 'NUFR1:short', `NUFR2:${ref}`,
    ref, `NUFV1:${ref}`, 'SR-0123456789', 'a'.repeat(5000), '', null, 42, [`NUFR1:${ref}`], "NUFR1:'; drop table",
  ];
  for (const s of samples) {
    const server = isReservationReference(s) && parseReservationReference(s) !== null;
    const client = typeof s === 'string' && (s.trim().startsWith('NUFR1:') || /^RC-/i.test(s.trim())) && normalizeReference(s) !== null;
    assert.equal(client, server, JSON.stringify(s));
  }
  assert.equal(normalizeReference(`NUFR1:${ref}`), `NUFR1:${ref}`);
  assert.equal(normalizeReference('rc-0123456789'), 'RC-0123456789');
  assert.equal(normalizeReference(ref), `NUFV1:${ref}`, 'a bare reference stays a stub reference');
});

test('server dispatch: NUFR1 and RC- go to reservations; everything else keeps its stub meaning', () => {
  const ref = randomBytes(18).toString('base64url');
  assert.deepEqual(parseReservationReference(`NUFR1:${ref}`), { field: 'qrRef', value: ref });
  assert.deepEqual(parseReservationReference('rc-0123456789'), { field: 'confirmationRef', value: 'RC-0123456789' });
  assert.equal(parseReservationReference(ref), null);
  assert.equal(parseReservationReference(`NUFV1:${ref}`), null);
  for (const stub of [`NUFV1:${ref}`, ref, 'SR-0123456789', 'cs-abcdefghjk']) assert.equal(isReservationReference(stub), false, stub);
  for (const res of [`NUFR1:${ref}`, 'NUFR1:', 'RC-0123456789', 'rc-x']) assert.equal(isReservationReference(res), true, res);
});
