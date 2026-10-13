import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createApp } from './app.js';
import { expireDue } from './tickets.js';
import { createAdapter, createMailer } from './mail/adapters.js';
import { expireDueReservations } from './reservations.js';

const config = loadConfig(process.env);
const firebase = initFirebase(config);
const mailer = createMailer({ db: firebase.db, adapter: createAdapter(config) });
const app = createApp({ config, ...firebase, mailer });
const server = app.listen(config.port, config.host, () => console.log(`API listening on :${config.port} (${config.mode}, project ${config.projectId})`));
if (config.cloud) console.log(`*** REAL Firebase project "${config.projectId}": accounts and data are live. Email transport: ${config.mail.transport}. ***`);

// A host restart or deploy sends SIGTERM: stop taking connections and let requests in flight (and their transactions) finish.
// Nothing is lost by a hard kill either (every change is transactional and queued mail has a lease), this just avoids cut-off responses.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

// Eventual cleanup of overdue stubs while the server is up. Correctness never depends on it: every request that
// reads or allocates also expires what is overdue, and `npm run expire-tickets` can be scheduled from outside.
// A sweep that is still running when the next one is due is skipped, so a slow database cannot pile sweeps up.
const every = (ms, what, fn) => {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.error(`${what} failed`, err); } finally { running = false; }
  }, ms).unref();
};
every(config.sweepPollMs, 'expiry sweep', () => expireDue({ db: firebase.db, now: new Date() }));

// Same idea for reservations, plus email delivery. Overdue requests also expire on any read or action, so correctness
// never depends on this; queued email does need a processor running (this timer, or `npm run process-outbox`).
every(config.sweepPollMs, 'reservation sweep', () => expireDueReservations({ db: firebase.db, config, now: new Date() }));
setInterval(() => mailer.kick(), config.outboxPollMs).unref(); // covers retries, abandoned leases and mail queued by a sweep; mail queued by a request is kicked at once
mailer.kick();
