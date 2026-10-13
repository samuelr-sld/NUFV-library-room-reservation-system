import { loadConfig } from '../config.js';
import { PROD_CONFIG } from '../../public/js/firebase-config.js';

// Usage: npm run cloud:check   (reads server/.env.cloud). Validates the cloud-dev settings and prints what a start would use.
// Offline on purpose: it opens no connection to Firebase or the mail server and prints no secret.
try {
  const c = loadConfig(process.env);
  if (!c.cloud) throw new Error('this check is for NODE_ENV=cloud-dev (or production); got ' + c.mode);
  console.log([
    `Configuration is valid (${c.mode}). Nothing was contacted.`,
    `  Server project   ${c.projectId}`,
    `  Website project  ${PROD_CONFIG.projectId}  (public/js/firebase-config.js)`,
    `  Admin credential ${process.env.GOOGLE_APPLICATION_CREDENTIALS ?? 'Application Default Credentials'}`,
    `  API              ${c.host ?? 'all interfaces'}:${c.port}, allowed origins ${c.corsOrigins.join(', ')}`,
    `  Polling          outbox every ${c.outboxPollMs / 1000} s, sweeps every ${c.sweepPollMs / 1000} s`,
    `  Application mail ${c.mail.transport === 'smtp' ? `LIVE through ${c.mail.smtp.host} as ${c.mail.smtp.user}` : 'sink (nothing is sent; readable at /api/dev/mail/view)'}`,
  ].join('\n'));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
