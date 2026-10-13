// Library QR codes carry only an opaque 24-character reference behind a prefix: NUFV1: for physical service stubs and
// NUFR1: for discussion room reservation confirmations. This module is the browser's view of those formats: it
// validates what the scanner or the keyboard produced before asking the server, and turns camera frames into a
// reference. The server re-validates everything; nothing here is a security boundary.
export const QR_PREFIX = 'NUFV1:';
export const RESERVATION_PREFIX = 'NUFR1:';
const REFERENCE = /^[A-Za-z0-9_-]{24}$/;
const TICKET_ID = /^(SR|CS|WF)-[0-9A-HJKMNP-TV-Z]{10}$/;
const CONFIRMATION_REF = /^RC-[0-9A-HJKMNP-TV-Z]{10}$/;

// Returns the text to send to the server, or null when it is not a library code. A bare 24-character reference is a
// stub's (it is ambiguous otherwise); a reservation needs its NUFR1: prefix or its RC- confirmation reference.
export function normalizeReference(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text.length === 0 || text.length > 64) return null;
  if (text.startsWith(RESERVATION_PREFIX)) return REFERENCE.test(text.slice(RESERVATION_PREFIX.length)) ? text : null;
  if (CONFIRMATION_REF.test(text.toUpperCase())) return text.toUpperCase();
  const ref = text.startsWith(QR_PREFIX) ? text.slice(QR_PREFIX.length) : text;
  if (REFERENCE.test(ref)) return `${QR_PREFIX}${ref}`;
  if (TICKET_ID.test(text.toUpperCase())) return text.toUpperCase();
  return null;
}

// Decodes one camera frame (an ImageData-like { data, width, height }) with jsQR and returns the normalized
// reference, or null if the frame holds no QR code or one that is not ours (so other QR codes are ignored).
export function readFrame(jsQR, frame) {
  const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  return code ? normalizeReference(code.data) : null;
}

// Suppresses the same code being reported over and over while it stays in front of the camera.
export function createDebouncer(windowMs = 5000, now = () => Date.now()) {
  let last = null;
  let at = 0;
  return (value) => {
    const t = now();
    if (value === last && t - at < windowMs) return false;
    [last, at] = [value, t];
    return true;
  };
}
