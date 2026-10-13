import { parseArgs } from 'node:util';
import { bootstrapAdmin } from '../bootstrap.js';
import { run } from './cli.js';

// Usage: npm run bootstrap-admin:dev -- --email admin@example.com --name "Library Admin"
// Real project: npm run bootstrap-admin:cloud -- --email ... --name ... --confirm-project <project id> [--verify-email]
//   (--verify-email: you vouch that you control the mailbox; the Console cannot mark an address verified)
// Production: set real environment variables, then
//   node server/scripts/bootstrap-admin.js --email ... --name ... --confirm-project <project id>
await run(async ({ config, operator, firebase }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, 'confirm-project': { type: 'string' }, 'verify-email': { type: 'boolean' } } });
  if (config.cloud && values['confirm-project'] !== config.projectId) {
    throw new Error(`Bootstrapping a real project needs --confirm-project ${config.projectId}.`);
  }
  const result = await bootstrapAdmin({
    ...firebase(), config, operator,
    email: values.email, fullName: values.name, confirmProject: values['confirm-project'], verifyEmail: values['verify-email'] === true,
  });
  console.log(`Administrator provisioned: ${result.email} (${result.uid}) in project ${config.projectId}.`);
});
