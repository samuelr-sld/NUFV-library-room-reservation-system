import { parseArgs } from 'node:util';
import { verifyConnection } from '../cloudVerify.js';
import { run } from './cli.js';

// Usage: npm run cloud:verify -- --confirm-project <project id>
// The first command that CONNECTS to the real project, and it only reads: one Auth user, collection names, one admin lookup.
// Run `npm run cloud:check` (offline) first; run this before `npm run server:cloud`.
await run(async ({ config, firebase }) => {
  const { values } = parseArgs({ options: { 'confirm-project': { type: 'string' } } });
  if (!config.cloud) throw new Error('cloud:verify is for NODE_ENV=cloud-dev (or production); the emulator environments are verified by the test suite.');
  if (values['confirm-project'] !== config.projectId) throw new Error(`Connecting to a real project needs --confirm-project ${config.projectId}.`);
  console.log(`Connecting read-only to project "${config.projectId}" ...`);
  const r = await verifyConnection({ ...firebase(), config });
  console.log([
    `Connected to "${r.projectId}": Authentication and Firestore both answered. Nothing was written.`,
    `  Authentication has users  ${r.authHasUsers}`,
    `  Firestore collections     ${r.collections.length ? r.collections.join(', ') : '(none yet)'}`,
    `  An administrator exists   ${r.adminExists}`,
  ].join('\n'));
});
