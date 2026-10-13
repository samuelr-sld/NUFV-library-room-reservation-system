import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { createResource, changeResource, retireResource, getResource, listResources, summary } from '../resources.js';
import { getSettings, updateSettings } from '../settings.js';
import { expireDue } from '../tickets.js';
import { adminTicketsRouter } from './adminTickets.js';
import { adminReservationsRouter } from './adminReservations.js';
import { adminOpsRouter } from './adminOps.js';
import { expireDueReservations } from '../reservations.js';

// Every route here needs a verified ID token AND an active admin profile in Firestore (role and status are read, not trusted from the token).
export function adminRouter(deps) {
  const { db, clock } = deps;
  const router = Router();
  router.use(authenticate(deps), requireAdmin(deps));
  // Overdue stubs still hold their seat until someone releases them. Do it first so inventory shows, and status
  // changes judge, the real allocation rather than a stale one.
  const sweep = () => Promise.all([expireDue({ db, now: clock() }), expireDueReservations({ db, config: deps.config, now: clock() })]).catch((err) => console.error('expiry sweep failed', err));

  router.use('/tickets', adminTicketsRouter(deps));
  router.use(adminReservationsRouter(deps));
  router.use(adminOpsRouter(deps));

  router.get('/summary', async (req, res) => { await sweep(); res.json(await summary(db)); });

  router.get('/resources', async (req, res) => { await sweep(); res.json({ resources: await listResources(db, req.query) }); });
  router.post('/resources', async (req, res) => res.status(201).json({ resource: await createResource({ db, uid: req.user.uid, body: req.body }) }));
  router.get('/resources/:id', async (req, res) => res.json({ resource: await getResource(db, req.params.id) }));
  router.patch('/resources/:id', async (req, res) => {
    await sweep();
    const { resource } = await changeResource({ db, uid: req.user.uid, id: req.params.id, patch: req.body, now: clock() });
    res.json({ resource });
  });
  // Soft delete: resources are retired, never removed, because audit records and future tickets refer to them.
  router.delete('/resources/:id', async (req, res) => {
    await sweep();
    const { resource } = await retireResource({ db, uid: req.user.uid, id: req.params.id, now: clock() });
    res.json({ resource });
  });

  router.get('/settings', async (req, res) => res.json(await getSettings(db)));
  router.patch('/settings', async (req, res) => res.json(await updateSettings({ db, uid: req.user.uid, patch: req.body })));

  return router;
}
