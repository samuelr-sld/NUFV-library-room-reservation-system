import { parseArgs } from 'node:util';
import { createStaticHost } from '../staticHost.js';

// Usage: npm run serve-public   (serves public/ on :5000 with the headers from firebase.json; run the Auth and Firestore
// emulators and `npm run server` next to it, instead of the Hosting emulator)
//        npm run serve:cloud    (the same files on :5001, which the website treats as "use the real Firebase project"; see docs/cloud-setup.md)
//        npm run serve:cloud:lan (the same, reachable from the local network: same-Wi-Fi approver test, docs/cloud-setup.md section 7)
const { values } = parseArgs({ options: { port: { type: 'string' }, lan: { type: 'boolean' } } });
const port = Number(values.port ?? process.env.PORT ?? 5000);
createStaticHost().listen(port, values.lan ? '0.0.0.0' : '127.0.0.1', () => console.log(`public/ on http://localhost:${port}${values.lan ? ' and this machine\'s network address' : ''} with the firebase.json headers`));
