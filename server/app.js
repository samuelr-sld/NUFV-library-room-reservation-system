import express from 'express';
import { errorHandler, notFound, HttpError } from './errors.js';
import { studentsRouter } from './routes/students.js';
import { profileRouter } from './routes/profile.js';
import { adminRouter } from './routes/admin.js';
import { ticketsRouter } from './routes/tickets.js';
import { reservationsRouter } from './routes/reservations.js';
import { approvalsRouter } from './routes/approvals.js';
import { devMailRouter } from './routes/devMail.js';
import { createAdapter, createMailer } from './mail/adapters.js';
import { DEFAULT_LIMITS } from './rateLimit.js';

// Exact-match allowlist. Disallowed origins get no CORS headers, so browsers block the response; a disallowed origin is also
// refused outright for anything that can change state, so a cross-site page cannot trigger an action it may not read the answer to.
const cors = (allowed) => (req, res, next) => {
  const origin = req.get('origin');
  if (!origin) return next();
  res.vary('Origin');
  if (!allowed.includes(origin)) {
    return ['GET', 'HEAD'].includes(req.method) ? next() : next(new HttpError(403, 'origin-not-allowed', 'Origin not allowed.'));
  }
  res.set('Access-Control-Allow-Origin', origin);
  if (req.method !== 'OPTIONS') return next();
  res.set({
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  }).sendStatus(204);
};

// clock returns the current server time as a Date; tests replace it to move time without sleeping.
// mailer delivers queued email. By default (tests) it is an in-memory sink that only delivers when drained; index.js passes
// a real one that delivers on its own.
// limits are the per-IP limits of the public approval endpoints (rateLimit.js); tests pass their own.
export function createApp({ config, auth, db, clock = () => new Date(), limits = DEFAULT_LIMITS, mailer = createMailer({ db, adapter: createAdapter(config), clock, autoKick: false }) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 0);
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  app.get('/api/health', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true })); // liveness only: no Firebase call, so a probe costs nothing
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // nothing the API returns is cacheable: tickets, people, codes
  app.use(cors(config.corsOrigins));
  app.use(express.json({ limit: '10kb' }));
  app.use('/api/students', studentsRouter({ auth, db }));
  app.use('/api/profile', profileRouter({ auth, db }));
  app.use('/api/admin', adminRouter({ auth, db, config, clock, mailer }));
  app.use('/api/tickets', ticketsRouter({ auth, db, config, clock }));
  app.use('/api/reservations', reservationsRouter({ auth, db, config, clock, mailer, limits }));
  app.use('/api/approvals', approvalsRouter({ db, config, clock, mailer, limits }));
  if (!config.production && mailer.adapter.name === 'sink') app.use('/api/dev/mail', devMailRouter({ mailer, config }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
