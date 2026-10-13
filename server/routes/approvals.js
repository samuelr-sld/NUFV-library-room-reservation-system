import { Router } from 'express';
import { HttpError } from '../errors.js';
import { decide, publicChallenge, requestCode, review, verifyCode } from '../approvalAccess.js';
import { memoryLimiter, persistentLimiter } from '../rateLimit.js';

// Public routes for EXTERNAL approvers (no account, no role). The challenge id in the path is an unguessable
// reference to one reservation step; on its own it reveals nothing and approves nothing. The limits live on the
// challenge itself (codes per challenge, attempts per code, total wrong guesses, expiry); per-IP limits are in rateLimit.js.
export function approvalsRouter({ db, config, clock, mailer, limits }) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(memoryLimiter(limits.ip, clock));
  const shared = (name) => persistentLimiter({ db, config, name, limit: limits[name], clock });
  const body = (req) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'invalid-argument', 'Request body must be a JSON object.');
    return req.body;
  };
  const ctx = (req) => ({ db, config, id: req.params.id, now: clock() });

  router.get('/:id', async (req, res) => res.json(await publicChallenge(ctx(req))));
  router.post('/:id/code', shared('code'), async (req, res) => {
    const out = await requestCode(ctx(req));
    mailer.kick();
    res.json(out);
  });
  router.post('/:id/verify', shared('verify'), async (req, res) => res.json(await verifyCode({ ...ctx(req), code: body(req).code })));
  router.post('/:id/review', async (req, res) => res.json(await review({ ...ctx(req), session: body(req).session })));
  router.post('/:id/decision', async (req, res) => {
    const { session, decision, comment } = body(req);
    const out = await decide({ ...ctx(req), session, decision, comment });
    mailer.kick();
    res.json(out);
  });
  return router;
}
