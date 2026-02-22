/**
 * gentyr scaffold - Scaffold a new project
 *
 * Wraps the existing scaffold logic from setup.sh.
 * Usage: npx gentyr scaffold --path /path/to/new-project
 *
 * @module commands/scaffold
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RED = '\x1b[0;31m';
const NC = '\x1b[0m';

export default async function scaffold(args) {
  // Delegate to setup.sh --scaffold for now since it has interactive prompts
  // that are complex to replicate in Node.js
  const frameworkDir = path.resolve(__dirname, '..', '..');
  const setupScript = path.join(frameworkDir, 'scripts', 'setup.sh');

  // Build args for setup.sh
  const setupArgs = ['--scaffold'];

  // Forward --path argument
  const pathIdx = args.indexOf('--path');
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    setupArgs.push('--path', args[pathIdx + 1]);
  } else if (args.length > 0 && !args[0].startsWith('-')) {
    // Allow: npx gentyr scaffold /path/to/project
    setupArgs.push('--path', args[0]);
  } else {
    console.error(`${RED}Error: --path is required${NC}`);
    console.error('Usage: npx gentyr scaffold --path /path/to/new-project');
    process.exit(1);
  }

  try {
    execFileSync(setupScript, setupArgs, { stdio: 'inherit', timeout: 120000 });
  } catch (err) {
    if (err.status) process.exit(err.status);
    throw err;
  }
}
