#!/usr/bin/env node
/**
 * SessionStart Hook: GENTYR Splash
 *
 * Overwrites the default Clawd icon with a GENTYR-colored variant.
 * Spawns a detached background process that waits for React Ink to finish
 * rendering, then overwrites the Clawd using relative cursor movement.
 *
 * @version 2.1.0
 */

import { spawn } from 'child_process';

// Skip for spawned sessions — agents don't see the Clawd
if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

// Spawn a detached child that waits for React Ink to render, then overwrites
const child = spawn('node', ['-e', `
  const fs = require('fs');

  setTimeout(() => {
    try {
      fs.writeFileSync('/tmp/gentyr-splash-debug.txt', 'Ran at ' + new Date().toISOString());
      const tty = fs.openSync('/dev/tty', 'w');

      // Test 1: Just write plain bright red text with NO cursor movement
      // This tells us if /dev/tty writes are visible at all
      fs.writeSync(tty, '\\x1b[91m>>> GENTYR WAS HERE <<<\\x1b[0m\\n');

      fs.closeSync(tty);
    } catch (e) {
      fs.writeFileSync('/tmp/gentyr-splash-error.txt', e.message + '\\n' + e.stack);
    }
    process.exit(0);
  }, 2000);
`], {
  detached: true,
  stdio: 'ignore',
});

child.unref();

// Return immediately — don't block session start
console.log(JSON.stringify({ continue: true, suppressOutput: true }));
