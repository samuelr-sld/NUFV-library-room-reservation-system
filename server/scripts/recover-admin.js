import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { recoverAdmin } from '../recovery.js';
import { run } from './cli.js';

// Usage (see README "Administrator recovery"):
//   npm run recover-admin:dev -- --old-admin lost@x.edu --new-admin spare@x.edu --reason "lost access to mailbox"
//   production: real environment variables, then node server/scripts/recover-admin.js ... --confirm-project <project id>
await run(async ({ config, operator, firebase }) => {
  const { values } = parseArgs({ options: {
    'old-admin': { type: 'string' }, 'new-admin': { type: 'string' }, reason: { type: 'string' }, 'confirm-project': { type: 'string' },
  } });
  if (config.cloud && values['confirm-project'] !== config.projectId) {
    throw new Error(`Recovery in a real project needs --confirm-project ${config.projectId}.`);
  }
  // Records who ran it: the service account named in the key file when one is used, else the OS user.
  let identity = operator;
  try { identity = `${operator} as ${JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')).client_email}`; } catch { /* ADC or emulator */ }

  const result = await recoverAdmin({
    ...firebase(), config, operator: identity,
    oldEmail: values['old-admin'], newEmail: values['new-admin'], reason: values.reason, confirmProject: values['confirm-project'],
  });
  console.log(`Recovered: ${result.newAdmin.email} is now the administrator; ${result.lostAdmin.email} is suspended, disabled and signed out.`);
});
