import { parseArgs } from 'node:util';
import { sendSmtpTest } from '../mail/smtpTest.js';

// Usage: npm run mail:test -- --to someone@example.com   (settings come from server/.env.local, see docs/gmail-smtp-setup.md)
// Sends ONE real message, only because you ran this on purpose. Needs MAIL_TRANSPORT=smtp and MAIL_LIVE_APPROVED=yes.
try {
  const { values } = parseArgs({ options: { to: { type: 'string' } } });
  console.log(await sendSmtpTest({ env: process.env, to: values.to }));
} catch (err) {
  console.error(`SMTP test failed: ${err.message}`);
  process.exitCode = 1;
}
