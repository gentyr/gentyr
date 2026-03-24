#!/usr/bin/env node
/**
 * Dead Agent Recovery — SessionStart hook for immediate dead-agent detection.
 *
 * Runs on every interactive session start. Catches dead agents immediately
 * instead of waiting for the 5-minute automation cycle:
 *
 * 1. Reads agent-tracker-history.json
 * 2. For each agent with status=running and a pid: checks isProcessAlive
 * 3. If dead: marks completed, resets linked TODO task to pending
 *
 * Uses advisory file locking (same O_CREAT|O_EXCL pattern as agent-tracker.js).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const HISTORY_PATH = path.join(STATE_DIR, 'agent-tracker-history.json');
// Use the same lock file as agent-tracker.js to coordinate with hourly automation
const LOCK_FILE = path.join(STATE_DIR, 'agent-tracker-history.json.lock');
const LOCK_STALE_MS = 10000;
const LOCK_MAX_ATTEMPTS = 10;

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal: TODO reconciliation will be skipped
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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(LOCK_FILE);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* cleanup - failure expected */}
            continue;
          }
        } catch (_) { /* cleanup - failure expected */
          continue;
        }
        const waitMs = 50 * Math.pow(2, attempt);
        const sharedBuffer = new SharedArrayBuffer(4);
        const view = new Int32Array(sharedBuffer);
        Atomics.wait(view, 0, 0, waitMs);
      } else {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* cleanup - failure expected */}
}

async function main() {
  // Skip spawned sessions — only interactive sessions run this
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const stdinData = await readStdin();

  if (!fs.existsSync(HISTORY_PATH)) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const locked = acquireLock();
  if (!locked) {
    // Another process holds the lock (reaper or session-reviver) — skip to avoid conflicts
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let changed = false;
  let recoveredCount = 0;

  try {
    let history;
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (!Array.isArray(history.agents)) {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
      }
    } catch {
      console.log(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
    const hasTodoDb = Database && fs.existsSync(todoDbPath);

    for (const agent of history.agents) {
      if (agent.status !== 'running' || !agent.pid) continue;

      if (!isProcessAlive(agent.pid)) {
        // Mark agent as dead
        agent.status = 'completed';
        agent.reapReason = 'process_already_dead';
        agent.reapedAt = new Date().toISOString();
        changed = true;
        recoveredCount++;

        // Reset linked TODO task to pending
        const taskId = agent.metadata?.taskId;
        if (taskId && hasTodoDb) {
          try {
            const db = new Database(todoDbPath);
            const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
            if (task && task.status === 'in_progress') {
              db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(taskId);
            }
            db.close();
          } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
        }
      }
    }

    if (changed) {
      try {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
      } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
    }
  } finally {
    releaseLock();
  }

  if (recoveredCount > 0) {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[dead-agent-recovery] Detected ${recoveredCount} dead agent(s), reset tasks to pending for re-spawn.`,
    }));
  } else {
    console.log(JSON.stringify({ continue: true }));
  }

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
