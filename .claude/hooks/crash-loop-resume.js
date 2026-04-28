#!/usr/bin/env node
/**
 * Crash-Loop Resume — SessionStart hook
 *
 * On interactive session start (login), detects persistent tasks paused by
 * the crash-loop circuit breaker and auto-resumes them. Manually paused tasks
 * are left alone.
 *
 * This eliminates the delay where overnight auth expiry causes crash-loop
 * pauses, and the CTO has to manually resume each task after logging in.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Bypass guard — check for pending CTO bypass requests
let checkBypassBlock = () => ({ blocked: false });
try {
  const bg = await import('./lib/bypass-guard.js');
  checkBypassBlock = bg.checkBypassBlock;
} catch (_) { /* non-fatal — fail open */ }

// Accumulate warnings/errors for systemMessage (never stderr in SessionStart hooks)
const warnings = [];

// Lazy SQLite import
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  warnings.push(`SQLite unavailable: ${err.message || err}`);
}

// Read stdin (SessionStart hook contract)
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 100);
  });
}

function output(message) {
  if (message) {
    console.log(JSON.stringify({ continue: true, systemMessage: message }));
  } else {
    console.log(JSON.stringify({ continue: true }));
  }
}

async function main() {
  await readStdin();

  // Skip spawned sessions — only interactive (CTO login) sessions trigger resume
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    output(null);
    return;
  }

  if (!Database) {
    output(warnings.length > 0 ? `[crash-loop-resume] ${warnings.join('; ')}` : null);
    return;
  }

  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) {
    output(null);
    return;
  }

  let ptDb;
  try {
    ptDb = new Database(ptDbPath);
  } catch (err) {
    output(`[crash-loop-resume] Failed to open persistent-tasks.db: ${err.message || err}`);
    return;
  }

  try {
    // Find all paused persistent tasks
    const pausedTasks = ptDb.prepare(
      "SELECT id, title, metadata, monitor_session_id FROM persistent_tasks WHERE status = 'paused'"
    ).all();

    if (pausedTasks.length === 0) {
      output(null);
      return;
    }

    // The circuit breaker no longer auto-pauses tasks (replaced with exponential backoff).
    // This hook now only shows paused tasks to the CTO for awareness.
    // Paused tasks are either: manually paused by a monitor (bypass request) or
    // paused by the self-pause circuit breaker (2+ self-pauses in 2h).
    // No auto-resume — the stale-pause auto-resume in hourly-automation handles that.
    const pauseReasons = [];
    for (const task of pausedTasks) {
      let reason = 'manual';
      try {
        const bypassCheck = checkBypassBlock('persistent', task.id);
        if (bypassCheck.blocked) reason = 'bypass-request';
        else {
          const meta = task.metadata ? JSON.parse(task.metadata) : {};
          if (meta.do_not_auto_resume) reason = 'do-not-auto-resume';
        }
      } catch (_) { /* non-fatal */ }
      pauseReasons.push(`"${task.title?.slice(0, 40) || task.id.slice(0, 8)}" (${reason})`);
    }

    const msg = `[crash-loop-resume] ${pausedTasks.length} paused task(s): ${pauseReasons.join(', ')}`;
    output(msg);
  } finally {
    try { ptDb.close(); } catch { /* */ }
  }
}

main().catch((err) => {
  output(`[crash-loop-resume] Unexpected error: ${err.message || err}`);
});
