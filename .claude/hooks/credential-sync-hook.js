#!/usr/bin/env node
/**
 * PreToolUse Hook: Credential Sync (Throttled)
 *
 * Periodically re-checks credential sources during long sessions to detect
 * account switches that happen between SessionStart events.
 *
 * Runs on Bash tool calls only. Throttled to once per 30 minutes via state file.
 * Uses the shared key-sync module for multi-source credential detection.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { syncKeys } from './key-sync.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'credential-sync-state.json');
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { lastCheck: 0 };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastCheck: 0 };
  }
}

function writeState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

async function main() {
  // Skip for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Throttle check
  const state = readState();
  const elapsed = Date.now() - state.lastCheck;
  if (elapsed < COOLDOWN_MS) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Run key sync
  try {
    const result = await syncKeys();
    state.lastCheck = Date.now();
    writeState(state);

    if (result.keysAdded > 0) {
      console.log(JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage: `Credential sync: ${result.keysAdded} new key(s) discovered mid-session.`,
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch {
    // Don't block on errors
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
