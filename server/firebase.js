import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Outside the cloud modes the Admin SDK talks to the emulators named by the env vars loadConfig already required;
// production and cloud-dev use Application Default Credentials (loadConfig proved no emulator variable is set), which never leave the server.
export function initFirebase(config) {
  const app = initializeApp(config.cloud
    ? { projectId: config.projectId, credential: applicationDefault() }
    : { projectId: config.projectId });
  return { auth: getAuth(app), db: getFirestore(app) };
}
