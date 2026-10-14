// Picks the Firebase config for the host serving the page. Pure, so it is unit-testable.
// The web config is public by design; security comes from Firestore rules and the Express API.

export const PROD_CONFIG = {
  apiKey: 'AIzaSyAAEMxLq1vnGK_Tt9Yl6OfG0rmxhbFrSVU',
  authDomain: 'lrc-room-reservation.firebaseapp.com',
  projectId: 'lrc-room-reservation',
  storageBucket: 'lrc-room-reservation.firebasestorage.app',
  messagingSenderId: '919530221746',
  appId: '1:919530221746:web:40a22e8945849a4c3919ab',
};

// Fake keys on purpose: if an emulator connection were ever skipped, requests fail instead of reaching production.
const EMULATOR_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-nufv.firebaseapp.com',
  projectId: 'demo-nufv',
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const PROD_HOSTS = [`${PROD_CONFIG.projectId}.web.app`, `${PROD_CONFIG.projectId}.firebaseapp.com`];

// Cloud-connected development: the local site on http://localhost:5001 talks to the REAL Firebase project and the local API
// on :3001. The port is the switch, so the demo (:5000, emulators) and this can never be mistaken for each other, and the
// browser keeps their sign-in sessions apart. The server (server/config.js) reads the same numbers.
export const CLOUD_DEV = { sitePort: '5001', apiPort: '3001' };

export function configFor(hostname, port = '') {
  if (port === CLOUD_DEV.sitePort && LOCAL_HOSTS.includes(hostname)) {
    if (hostname !== 'localhost') throw new Error(`Cloud development must be opened as http://localhost:${port} (got "${hostname}").`);
    return { config: PROD_CONFIG, useEmulators: false };
  }
  if (LOCAL_HOSTS.includes(hostname)) return { config: EMULATOR_CONFIG, useEmulators: true };
  if (PROD_HOSTS.includes(hostname)) return { config: PROD_CONFIG, useEmulators: false };
  throw new Error(`Firebase is not configured for host "${hostname}". Serve the app with "npm run emulators".`);
}

// Explicit production API origin (e.g. 'https://api.example.edu'). Left empty on purpose: set it when the backend is deployed.
export const PROD_API_BASE = '';
const LOCAL_API_BASE = 'http://localhost:3000';

// Private IPv4 (home Wi-Fi, phone hotspots). Only the approver page works there: configFor still refuses it, so no sign-in.
const LAN_HOST = /^(10\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}|192\.168\.\d{1,3})\.\d{1,3}$/;

export function apiBaseFor(hostname, port = '') {
  if (port === CLOUD_DEV.sitePort && hostname === 'localhost') return `http://localhost:${CLOUD_DEV.apiPort}`;
  if (port === CLOUD_DEV.sitePort && LAN_HOST.test(hostname)) return `http://${hostname}:${CLOUD_DEV.apiPort}`; // same-Wi-Fi approver test
  if (LOCAL_HOSTS.includes(hostname) && port !== CLOUD_DEV.sitePort) return LOCAL_API_BASE;
  if (PROD_HOSTS.includes(hostname) && PROD_API_BASE) return PROD_API_BASE;
  throw new Error(`The API is not configured for host "${hostname}".`);
}

// On a developer's machine no real email exists: the API's email sink and the Auth emulator only record what would have been
// sent, and a viewer shows it. Returns that viewer's address on localhost, and null everywhere else (so it never shows in production).
// Not in cloud development either: there Firebase sends real account emails, so "no real email is sent" would be false.
export const devMailUrl = (hostname, port = '') => (LOCAL_HOSTS.includes(hostname) && port !== CLOUD_DEV.sitePort ? `${LOCAL_API_BASE}/api/dev/mail/view` : null);
