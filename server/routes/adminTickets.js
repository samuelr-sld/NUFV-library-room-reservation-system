import { Router } from 'express';
import { HttpError } from '../errors.js';
import { checkInTicket, checkOutTicket, resolveTicket, revokeTicket } from '../tickets.js';

// Mounted under /api/admin/tickets, behind authenticate + requireAdmin (active admin profile in Firestore).
// The QR reference travels in a POST body, never in a URL, so it stays out of access logs and browser history.
export function adminTicketsRouter({ db, clock }) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const body = (req) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'invalid-argument', 'Request body must be a JSON object.');
    return req.body;
  };
  const ctx = (req) => ({ db, id: req.params.id, now: clock(), actorUid: req.user.uid });

  router.post('/resolve', async (req, res) => res.json(await resolveTicket({ db, reference: body(req).reference, now: clock() })));

  // identityChecked: the administrator attests they compared the student with the ticket holder (QR possession alone proves nothing).
  router.post('/:id/check-in', async (req, res) => {
    if (body(req).identityChecked !== true) throw new HttpError(400, 'identity-not-confirmed', 'Confirm that you checked the ID of the student before checking them in.');
    res.json(await checkInTicket({ ...ctx(req), identityChecked: true }));
  });
  router.post('/:id/check-out', async (req, res) => res.json(await checkOutTicket(ctx(req))));
  router.post('/:id/revoke', async (req, res) => res.json(await revokeTicket({ ...ctx(req), reason: body(req).reason })));

  return router;
}
