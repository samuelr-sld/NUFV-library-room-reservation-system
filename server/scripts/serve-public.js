import { parseArgs } from 'node:util';
import { createStaticHost } from '../staticHost.js';

// Usage: npm run serve-public   (serves public/ on :5000 with the headers from firebase.json; run the Auth and Firestore
// emulators and `npm run server` next to it, instead of the Hosting emulator)
//        npm run serve:cloud    (the same files on :5001, which the website treats as "use the real Firebase project"; see docs/cloud-setup.md)
const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = Number(values.port ?? process.env.PORT ?? 5000);
createStaticHost().listen(port, '127.0.0.1', () => console.log(`public/ on http://localhost:${port} with the firebase.json headers`));
