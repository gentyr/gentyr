#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Interactive Session Heartbeat
 *
 * Refreshes the current interactive session's liveness entry in
 * .claude/state/interactive-sessions.json so rescue/reaper automation can
 * tell that the session is alive and avoid hijacking its CTO worktree.
 *
 * Fast-exit paths:
 *  - Spawned sessions (CLAUDE_SPAWNED_SESSION === 'true')
 *  - Missing session_id in the event
 *
 * Non-blocking. Never writes to stderr (silently swallows errors).
 *
 * SECURITY: This file should be root-owned via npx gentyr protect.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { recordInteractiveLiveness } from './lib/interactive-liveness.js';

function fastExit() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

async function main() {
  // Fast-exit: spawned sessions never need a heartbeat
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') return fastExit();

  // Read event JSON from stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return fastExit();
  }

  const sessionId = event?.session_id || event?.sessionId || '';
  if (!sessionId) return fastExit();

  // Resolve the current session's CTO worktree path from automation-config.json.
  // Prefer per-session map (new), fall back to legacy singular field.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let ctoWorktreePath = null;
  try {
    const configPath = path.join(projectDir, '.claude', 'state', 'automation-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config?.ctoWorktreePaths && typeof config.ctoWorktreePaths === 'object') {
      ctoWorktreePath = config.ctoWorktreePaths[sessionId] || null;
    }
    if (!ctoWorktreePath) {
      ctoWorktreePath = config?.ctoWorktreePath || null;
    }
  } catch { /* no config yet */ }

  try {
    recordInteractiveLiveness(sessionId, ctoWorktreePath, { projectDir });
  } catch { /* non-fatal */ }

  fastExit();
}

main().catch(() => fastExit());
