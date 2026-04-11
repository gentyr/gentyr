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

    // Filter to only crash-loop-paused tasks (skip manually paused)
    const crashLoopTasks = [];
    for (const task of pausedTasks) {
      try {
        const pauseEvent = ptDb.prepare(
          "SELECT details FROM events WHERE persistent_task_id = ? AND event_type = 'paused' ORDER BY created_at DESC LIMIT 1"
        ).get(task.id);
        if (!pauseEvent?.details) continue;
        const details = JSON.parse(pauseEvent.details);
        if (details.reason === 'crash_loop_circuit_breaker') {
          crashLoopTasks.push(task);
        }
      } catch (err) {
        warnings.push(`Failed to read pause event for task ${task.id.slice(0, 8)}: ${err.message || err}`);
      }
    }

    if (crashLoopTasks.length === 0) {
      output(warnings.length > 0 ? `[crash-loop-resume] ${warnings.join('; ')}` : null);
      return;
    }

    // Dedup: check session-queue.db for already-queued monitors
    const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
    let queueDb = null;
    try {
      if (fs.existsSync(queueDbPath)) {
        queueDb = new Database(queueDbPath, { readonly: true });
      }
    } catch (err) {
      warnings.push(`Queue DB open failed: ${err.message || err}`);
    }

    // Import enqueue and agent types
    let enqueueSession, AGENT_TYPES, HOOK_TYPES, buildPrompt;
    try {
      const sq = await import('./lib/session-queue.js');
      enqueueSession = sq.enqueueSession;
      const at = await import('./agent-tracker.js');
      AGENT_TYPES = at.AGENT_TYPES;
      HOOK_TYPES = at.HOOK_TYPES;
      const rp = await import('./lib/persistent-monitor-revival-prompt.js');
      buildPrompt = rp.buildPersistentMonitorRevivalPrompt;
    } catch (err) {
      output(`[crash-loop-resume] Failed to import dependencies: ${err.message || err}. ${crashLoopTasks.length} crash-loop-paused task(s) NOT resumed.`);
      try { queueDb?.close(); } catch { /* */ }
      return;
    }

    const resumed = [];
    for (const task of crashLoopTasks) {
      // Dedup: skip if monitor already queued/running
      if (queueDb) {
        try {
          const existing = queueDb.prepare(
            "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND metadata LIKE ?"
          ).get(`%"persistentTaskId":"${task.id}"%`);
          if (existing && existing.cnt > 0) continue;
        } catch (err) {
          warnings.push(`Dedup check failed for ${task.id.slice(0, 8)}: ${err.message || err}`);
        }
      }

      // Resume: TOCTOU guard with AND status = 'paused'
      const result = ptDb.prepare(
        "UPDATE persistent_tasks SET status = 'active' WHERE id = ? AND status = 'paused'"
      ).run(task.id);
      if (result.changes === 0) continue; // Already resumed by another process

      // Record resume event
      ptDb.prepare(
        "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
      ).run(
        randomUUID(),
        task.id,
        JSON.stringify({ reason: 'crash_loop_login_resume', source: 'crash-loop-resume' })
      );

      // Enqueue monitor — prefer --resume if monitor_session_id available
      try {
        const { prompt, extraEnv, metadata } = await buildPrompt(task, 'crash_loop_login_resume', PROJECT_DIR);
        const resumeSessionId = task.monitor_session_id || null;
        enqueueSession({
          title: `[Persistent] Login resume: ${task.title}`,
          agentType: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
          hookType: HOOK_TYPES.PERSISTENT_TASK_MONITOR,
          tagContext: 'persistent-monitor',
          source: 'crash-loop-resume',
          priority: 'critical',
          lane: 'persistent',
          ttlMs: 0,
          spawnType: resumeSessionId ? 'resume' : 'fresh',
          resumeSessionId,
          prompt,
          projectDir: PROJECT_DIR,
          extraEnv,
          metadata,
        });
        resumed.push(task.title);
      } catch (err) {
        warnings.push(`Enqueue failed for "${task.title}": ${err.message || err}`);
        // Rollback on enqueue failure
        try {
          ptDb.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ?").run(task.id);
        } catch (rbErr) {
          warnings.push(`Rollback also failed for ${task.id.slice(0, 8)}: ${rbErr.message || rbErr}`);
        }
      }
    }

    try { queueDb?.close(); } catch { /* */ }

    const parts = [];
    if (resumed.length > 0) {
      const titles = resumed.map(t => `"${t}"`).join(', ');
      parts.push(`Auto-resumed ${resumed.length} crash-loop-paused task(s): ${titles}`);
    }
    if (warnings.length > 0) {
      parts.push(`Warnings: ${warnings.join('; ')}`);
    }
    output(parts.length > 0 ? `[crash-loop-resume] ${parts.join('. ')}` : null);
  } finally {
    try { ptDb.close(); } catch { /* */ }
  }
}

main().catch((err) => {
  output(`[crash-loop-resume] Unexpected error: ${err.message || err}`);
});
