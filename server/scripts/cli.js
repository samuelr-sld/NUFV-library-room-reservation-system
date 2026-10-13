import { userInfo } from 'node:os';
import { loadConfig } from '../config.js';
import { initFirebase } from '../firebase.js';

// Shared by operator scripts: validates the environment (fail closed) before any Firebase connection is made.
export async function run(main) {
  try {
    const config = loadConfig(process.env, { forServer: false });
    await main({ config, operator: userInfo().username, firebase: () => initFirebase(config) });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
