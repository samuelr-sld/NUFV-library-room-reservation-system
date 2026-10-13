import { parseArgs } from 'node:util';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, resetDemo, seedDemo } from '../demo.js';
import { run } from './cli.js';

// Usage: npm run demo:seed            adds the demo accounts, inventory and approval chain that are missing (safe to repeat)
//        npm run demo:reset           erases the LOCAL emulators first, then seeds: a clean slate
// Works only against the Firebase emulators of a demo-* project; anything else is refused (see server/demo.js).
await run(async ({ config, firebase }) => {
  const { values } = parseArgs({ options: { reset: { type: 'boolean' } } });
  if (config.cloud) throw new Error(`Refusing to run the demonstration seed against a real Firebase project (${config.projectId}).`);
  if (values.reset) { await resetDemo(process.env); console.log('Emulators erased.'); }
  const made = await seedDemo({ ...firebase(), config });
  console.log(`Seeded: ${made.accounts} account(s), ${made.resources} resource(s)${made.workflow ? ', the approval chain' : ''}.`);
  console.log(`Demo password for every account: ${DEMO_PASSWORD}`);
  for (const a of DEMO_ACCOUNTS) console.log(`  ${a.role.padEnd(8)} ${a.email}`);
});
