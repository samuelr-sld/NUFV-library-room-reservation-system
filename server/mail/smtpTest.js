import { mailConfig } from '../config.js';
import { createSmtpAdapter } from './adapters.js';

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

// One explicit test message to one recipient: no outbox, no retry loop. Throws (never with credentials) unless SMTP is
// fully configured AND live delivery was approved; mailConfig is the same gate the server uses.
export async function sendSmtpTest({ env, to, transportFactory }) {
  if (!EMAIL.test(to ?? '')) throw new Error('give exactly one recipient: npm run mail:test -- --to someone@example.com');
  if (env.MAIL_TRANSPORT !== 'smtp') throw new Error('MAIL_TRANSPORT is not "smtp"; nothing was sent.');
  const { smtp } = mailConfig(env, false);
  const info = await createSmtpAdapter(smtp, { transportFactory }).send({
    to, subject: 'NUFV Library Services: SMTP test',
    text: 'This is a one-off test message from the NUFV Library Services mail setup. If you can read it, delivery works. No action is needed.',
  });
  return `Sent one test message to ${to} through ${smtp.host}:${smtp.port}${info.messageId ? ` (message id ${info.messageId})` : ''}.`;
}
