#!/usr/bin/env node
/**
 * SessionStart Hook: GENTYR Splash
 *
 * Overwrites the default Clawd icon with a GENTYR-colored variant.
 * Spawns a detached background process that waits for React Ink to finish
 * rendering, then overwrites the Clawd using relative cursor movement.
 *
 * @version 2.0.0
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

  // Wait for React Ink to finish initial render
  setTimeout(() => {
    try {
      const tty = fs.openSync('/dev/tty', 'w');

      // GENTYR color — bright cyan/teal (256-color 43)
      const BODY = '\\x1b[38;5;43m';
      const BG_BODY = '\\x1b[48;5;43m';
      const FG_BLACK = '\\x1b[38;5;0m';
      const R = '\\x1b[0m';

      // Save cursor, then move UP from current position to reach the Clawd
      // After React Ink renders, cursor is at the prompt area.
      // Layout (bottom to top):
      //   cursor/prompt area
      //   separator line
      //   blank line
      //   Clawd row 3 (legs)
      //   Clawd row 2 (body)
      //   Clawd row 1 (head)
      // That's ~5 lines up from cursor to Clawd row 1
      const LINES_UP = 8;

      fs.writeSync(tty, '\\x1b[s');                    // save cursor
      fs.writeSync(tty, '\\x1b[' + LINES_UP + 'A');   // move up N lines
      fs.writeSync(tty, '\\r');                         // move to col 1

      // Redraw Clawd in GENTYR color
      fs.writeSync(tty, BODY + '▗' + FG_BLACK + BG_BODY + ' ▗   ▖ ' + R + BODY + '▖' + R + '\\x1b[K\\n');
      fs.writeSync(tty, ' ' + BG_BODY + '       ' + R + '\\x1b[K\\n');
      fs.writeSync(tty, '  ' + BODY + '▘▘ ▝▝' + R + '\\x1b[K\\n');

      // Restore cursor
      fs.writeSync(tty, '\\x1b[u');

      fs.closeSync(tty);
    } catch (e) {
      // Silently fail
    }
    process.exit(0);
  }, 800);
`], {
  detached: true,
  stdio: 'ignore',
});

child.unref();

// Return immediately — don't block session start
console.log(JSON.stringify({ continue: true, suppressOutput: true }));
