import { processOutbox } from './outbox.js';

// Delivery adapters: send({ id, to, subject, text }) resolves when the transport accepted the message, or throws.
// An error with permanent: true is never retried (bad address, rejected content); anything else is retried with backoff.

// Development and tests: nothing leaves the machine. Messages are kept in memory (newest last) so a developer or a
// test can read them; the dev-only /api/dev/mail endpoint shows them.
export function createSinkAdapter({ keep = 200 } = {}) {
  const messages = [];
  return {
    name: 'sink',
    messages,
    async send(message) {
      messages.push({ id: message.id, kind: message.kind, to: message.to, subject: message.subject, text: message.text, at: new Date().toISOString() });
      if (messages.length > keep) messages.shift();
      return { messageId: `sink-${message.id}` };
    },
  };
}

const NETWORK = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EDNS', 'EAI_AGAIN']);

// Production: SMTP through nodemailer, only when the operator configured it AND approved live delivery (see config.js).
// transportFactory exists so tests can prove the error handling without a mail server.
export function createSmtpAdapter(smtp, { transportFactory } = {}) {
  let transport;
  const get = async () => {
    if (transport) return transport;
    const make = transportFactory ?? (await import('nodemailer')).default.createTransport;
    transport = make({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10_000, socketTimeout: 20_000 });
    return transport;
  };
  return {
    name: 'smtp',
    async send({ to, subject, text }) {
      try {
        const info = await (await get()).sendMail({ from: smtp.from, to, subject, text });
        return { messageId: info?.messageId };
      } catch (err) {
        const code = Number(err?.responseCode);
        const clean = [smtp.pass, smtp.user].filter(Boolean).reduce((t, v) => t.replaceAll(v, '***'), String(err?.message ?? err)); // errors reach logs and Firestore
        const wrapped = new Error(`smtp: ${clean.slice(0, 150)}`);
        wrapped.permanent = code >= 500 && code < 600 && !NETWORK.has(err?.code); // 4xx and network trouble are temporary
        throw wrapped;
      }
    },
  };
}

export function createAdapter(config) {
  if (config?.mail?.transport === 'smtp') return createSmtpAdapter(config.mail.smtp);
  return createSinkAdapter();
}

// The processor the server runs. kick() delivers soon after something was queued; the timer in index.js (and
// `npm run process-outbox`) catches everything else. Neither is needed for the data to be correct.
export function createMailer({ db, adapter, clock = () => new Date(), autoKick = true }) {
  let running = null;
  let again = false;
  const run = async () => {
    do {
      again = false;
      await processOutbox({ db, adapter, now: clock() }).catch((err) => console.error('outbox processing failed', err));
    } while (again);
  };
  const kick = () => {
    if (!autoKick) return;
    if (running) { again = true; return; }
    running = new Promise((resolve) => setImmediate(resolve)).then(run).finally(() => { running = null; });
  };
  return { adapter, kick, drain: () => processOutbox({ db, adapter, now: clock() }) };
}
