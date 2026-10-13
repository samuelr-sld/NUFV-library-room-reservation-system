import { expireDue } from '../tickets.js';
import { run } from './cli.js';

// Releases every overdue stub (idempotent; safe to schedule). Usage: npm run expire-tickets:dev
await run(async ({ firebase }) => {
  const { db } = firebase();
  let total = 0;
  for (let n = await expireDue({ db, now: new Date() }); n > 0; n = await expireDue({ db, now: new Date() })) total += n;
  console.log(`Expired ${total} overdue stub(s).`);
});
