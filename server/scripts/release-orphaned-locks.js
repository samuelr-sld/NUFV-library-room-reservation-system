import { parseArgs } from 'node:util';
import { releaseOrphanedLocks } from '../lifecycle.js';
import { run } from './cli.js';

// Usage: npm run release-locks:dev            (dry run: lists what would be released)
//        npm run release-locks:dev -- --apply (releases them)
await run(async ({ config, operator, firebase }) => {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'confirm-project': { type: 'string' } } });
  if (values.apply && config.cloud && values['confirm-project'] !== config.projectId) {
    throw new Error(`Applying to a real project needs --confirm-project ${config.projectId}.`);
  }
  const report = await releaseOrphanedLocks({ ...firebase(), apply: !!values.apply, operator });
  console.log(JSON.stringify(report, null, 2));
  if (!values.apply && report.orphaned.length) console.log('Dry run: nothing changed. Re-run with --apply to release these locks.');
});
