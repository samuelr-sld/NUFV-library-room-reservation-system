import { Router } from 'express';
import { HttpError } from '../errors.js';
import { listAudit } from '../auditView.js';
import { emailOverview, approvalsOverview, requeueEmail } from '../ops.js';
import { reconcile } from '../reconcile.js';
import { resolveScan } from '../scan.js';

// Mounted under /api/admin (behind authenticate + requireAdmin). Visibility and safe recovery only: nothing here approves,
// skips or resets an approval step. Responses are never cached (they list people, addresses and reasons).
export function adminOpsRouter({ db, config, clock, mailer }) {
  const router = Router();
  router.use(['/qr', '/ops', '/audit'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // One scanner for both code formats: { kind: 'ticket' | 'reservation', ... }. The reference travels in the body, not the URL.
  router.post('/qr/resolve', async (req, res) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'invalid-argument', 'Request body must be a JSON object.');
    res.json(await resolveScan({ db, config, reference: req.body.reference, now: clock() }));
  });

  router.get('/ops/approvals', async (req, res) => res.json(await approvalsOverview({ db, config, now: clock() })));
  router.get('/ops/emails', async (req, res) => res.json(await emailOverview({ db, status: req.query.status })));
  router.post('/ops/emails/:id/requeue', async (req, res) => {
    await requeueEmail({ db, id: req.params.id, now: clock(), adminUid: req.user.uid });
    mailer.kick();
    res.json(await emailOverview({ db, status: 'failed' }));
  });
  // Read-only consistency check. Repairs are an operator action (npm run reconcile -- --apply), never an HTTP route.
  router.get('/ops/diagnostics', async (req, res) => res.json(await reconcile({ db, now: clock(), apply: false })));

  router.get('/audit', async (req, res) => res.json(await listAudit({ db, query: req.query })));

  return router;
}
