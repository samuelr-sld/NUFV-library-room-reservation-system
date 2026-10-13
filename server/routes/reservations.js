import { Router } from 'express';
import { authenticate, requireActiveStudent, requireVerifiedEmail } from '../middleware/auth.js';
import { persistentLimiter } from '../rateLimit.js';
import { availability, bookingRules, cancelMine, getMine, listMine, listRooms, printableReservation, submitReservation } from '../reservations.js';

// Student side of discussion room reservations. Identity always comes from the verified ID token; no route accepts a
// student id, and none can approve anything. Gate: valid token, verified email, active student profile.
export function reservationsRouter(deps) {
  const { db, config, clock, mailer, limits } = deps;
  const router = Router();
  router.use(authenticate(deps), requireVerifiedEmail, requireActiveStudent(deps));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const ctx = (req) => ({ db, config, uid: req.user.uid, now: clock() });

  router.get('/config', async (req, res) => res.json(await bookingRules({ db, now: clock() })));
  router.get('/rooms', async (req, res) => res.json({ rooms: await listRooms(db) }));
  router.get('/availability', async (req, res) => res.json(await availability({ db, date: req.query.date, now: clock() })));

  // Submitting emails the first approver, so a student cannot loop submit-cancel-submit to mail them without end.
  router.post('/', persistentLimiter({ db, config, name: 'submit', limit: limits.submit, clock, by: (req) => req.user.uid }), async (req, res) => {
    const reservation = await submitReservation({ ...ctx(req), body: req.body });
    mailer.kick();
    res.status(201).json({ reservation });
  });
  router.get('/', async (req, res) => res.json({ reservations: await listMine(ctx(req)) }));
  router.get('/:id', async (req, res) => res.json({ reservation: await getMine({ ...ctx(req), id: req.params.id }) }));
  router.post('/:id/cancel', async (req, res) => {
    const reservation = await cancelMine({ ...ctx(req), id: req.params.id });
    mailer.kick();
    res.json({ reservation });
  });
  router.get('/:id/print', async (req, res) => res.json(await printableReservation({ ...ctx(req), id: req.params.id })));

  return router;
}
