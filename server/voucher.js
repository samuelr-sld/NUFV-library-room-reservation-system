import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';

// DEMONSTRATION Wi-Fi credentials only. Nothing here talks to the university's real Wi-Fi.
// The password is shown to its owner through the print endpoint while the voucher is active. At rest it is stored
// only as AES-256-GCM ciphertext (key from the environment, bound to the ticket id), never as plaintext, and it is
// never written to audit logs or returned by any list or detail endpoint.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so a printed stub is readable

export function generateVoucherPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `DEMO-${group()}-${group()}-${group()}`; // 12 random characters, about 60 bits
}

export function encryptSecret(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

// Returns null when the key is wrong, the data was altered, or it belongs to another ticket.
export function decryptSecret(key, box, aad) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
