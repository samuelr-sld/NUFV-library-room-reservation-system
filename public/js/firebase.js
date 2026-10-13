import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { configFor } from './firebase-config.js';

const { config, useEmulators } = configFor(location.hostname, location.port);

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (useEmulators) {
  const host = location.hostname;
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
}
