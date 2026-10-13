import { Router } from 'express';
import { HttpError } from '../errors.js';
import { authenticate, requireActiveStudent, requireVerifiedEmail } from '../middleware/auth.js';
import { activeTickets, availability, getTicket, issueTicket, printableTicket, ticketHistory } from '../tickets.js';

// Student stubs. Identity always comes from the verified ID token (req.user.uid); no route accepts a student id.
// Gate, in order: valid token, verified email (token claim), then an active student profile in Firestore.
export function ticketsRouter(deps) {
  const { db, config, clock } = deps;
  const router = Router();
  router.use(authenticate(deps), requireVerifiedEmail, requireActiveStudent(deps));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // tickets and voucher passwords must not be cached

  const ctx = (req) => ({ db, config, uid: req.user.uid, now: clock() });

  router.get('/availability', async (req, res) => res.json(await availability(ctx(req))));

  // Idempotent per service: a student who already holds an active stub for it gets that stub back (200, created:false).
  // Asking for a different service beyond the configured limit is a 409.
  router.post('/', async (req, res) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'invalid-argument', 'Request body must be a JSON object.');
    const { ticket, created } = await issueTicket({ ...ctx(req), service: req.body.service });
    res.status(created ? 201 : 200).json({ ticket, created });
  });

  router.get('/active', async (req, res) => res.json({ tickets: await activeTickets(ctx(req)) }));

  router.get('/history', async (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'invalid-argument', 'limit must be a whole number from 1 to 50.');
    res.json({ tickets: await ticketHistory({ ...ctx(req), limit }) });
  });

  router.get('/:id', async (req, res) => res.json({ ticket: await getTicket({ ...ctx(req), id: req.params.id }) }));
  router.get('/:id/print', async (req, res) => res.json(await printableTicket({ ...ctx(req), id: req.params.id })));

  return router;
}
