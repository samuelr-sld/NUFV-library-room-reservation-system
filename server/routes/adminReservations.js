import { Router } from 'express';
import { HttpError } from '../errors.js';
import { adminList, adminReservation, applyReservation, resendNotice } from '../reservations.js';
import { getWorkflow, saveWorkflow } from '../workflow.js';

// Administrator side, mounted under /api/admin (behind authenticate + requireAdmin). Admins configure the approval
// chain and make the FINAL decision as authenticated administrators; they cannot approve an external step for the approver.
export function adminReservationsRouter({ db, config, clock, mailer }) {
  const router = Router();
  const body = (req) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'invalid-argument', 'Request body must be a JSON object.');
    return req.body;
  };
  const note = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, 'invalid-argument', 'A comment can be at most 300 characters.');
    return value.trim();
  };

  router.get('/approval-workflow', async (req, res) => res.json(await getWorkflow(db)));
  router.put('/approval-workflow', async (req, res) => res.json(await saveWorkflow({ db, uid: req.user.uid, body: body(req) })));

  router.get('/reservations', async (req, res) => res.json({ reservations: await adminList({ db, config, now: clock(), status: req.query.status ?? 'pending' }) }));
  router.get('/reservations/:id', async (req, res) => {
    await applyReservation({ db, config, id: req.params.id, now: clock(), op: 'expire_if_due', actor: { type: 'system' } });
    res.json({ reservation: await adminReservation({ db, id: req.params.id }) });
  });

  // `step` is the step the administrator was looking at: a stale screen cannot decide a different step.
  router.post('/reservations/:id/decision', async (req, res) => {
    const { decision, step, comment } = body(req);
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'invalid-argument', 'Choose approve or reject.');
    if (!Number.isInteger(step)) throw new HttpError(400, 'invalid-argument', 'step is required.');
    await applyReservation({ db, config, id: req.params.id, now: clock(), op: decision, expectedStep: step, comment: note(comment), actor: { type: 'admin', uid: req.user.uid } });
    mailer.kick();
    res.json({ reservation: await adminReservation({ db, id: req.params.id }) });
  });

  router.post('/reservations/:id/cancel', async (req, res) => {
    const result = await applyReservation({ db, config, id: req.params.id, now: clock(), op: 'cancel', comment: note(body(req).reason), actor: { type: 'admin', uid: req.user.uid } });
    mailer.kick();
    res.json({ changed: result.changed, reservation: await adminReservation({ db, id: req.params.id }) });
  });

  router.post('/reservations/:id/resend', async (req, res) => {
    await resendNotice({ db, config, id: req.params.id, now: clock(), adminUid: req.user.uid });
    mailer.kick();
    res.json({ reservation: await adminReservation({ db, id: req.params.id }) });
  });

  return router;
}
