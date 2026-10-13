import { createAdapter } from '../mail/adapters.js';
import { processOutbox } from '../mail/outbox.js';
import { loadConfig } from '../config.js';
import { initFirebase } from '../firebase.js';

// Delivers queued email once and exits (schedule it, or rely on the server's own timer). Uses the full server
// configuration because the mail transport is part of it; with the default dev sink nothing leaves the machine.
try {
  const config = loadConfig(process.env);
  const { db } = initFirebase(config);
  const result = await processOutbox({ db, adapter: createAdapter(config), now: new Date() });
  console.log(`Outbox: ${result.sent} sent, ${result.retried} to retry, ${result.failed} failed.`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
