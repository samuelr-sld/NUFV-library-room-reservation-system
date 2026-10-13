import { parseArgs } from 'node:util';
import { reconcile } from '../reconcile.js';
import { run } from './cli.js';

// Usage: npm run reconcile:dev            (dry run: reports inconsistencies, changes nothing)
//        npm run reconcile:dev -- --apply (repairs what is repairable; see server/reconcile.js for what that covers)
await run(async ({ config, operator, firebase }) => {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'confirm-project': { type: 'string' } } });
  if (values.apply && config.cloud && values['confirm-project'] !== config.projectId) {
    throw new Error(`Applying to a real project needs --confirm-project ${config.projectId}.`);
  }
  const report = await reconcile({ ...firebase(), apply: !!values.apply, operator });
  console.log(JSON.stringify(report, null, 2));
  if (!values.apply) console.log('Dry run: nothing changed. Re-run with --apply to repair the repairable findings.');
});
