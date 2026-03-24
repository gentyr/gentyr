#!/usr/bin/env node
/**
 * PostToolUse Hook: Workstream Dependency Satisfier
 *
 * Fires after mcp__todo-db__complete_task. When a task completes, checks
 * workstream.db for any active dependencies where this task is the blocker.
 * Satisfies those dependencies and triggers a queue drain to unblock waiting tasks.
 *
 * If any now-unblocked task has CTO priority in the queue, calls preemptForCtoTask
 * to make room immediately. Otherwise calls drainQueue() to pick up unblocked items.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'workstream-dep-satisfier.log');
const WS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');
const SQ_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [workstream-dep-satisfier] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Generate a unique ID for workstream change records.
 */
function generateChangeId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `wsc-${timestamp}-${random}`;
}

/**
 * Check if any newly unblocked task has CTO priority in the session queue.
 * Returns the queue ID of the first CTO-priority item found, or null.
 */
function findCtoPriorityUnblocked(unblockedTaskIds) {
  if (!unblockedTaskIds.length || !fs.existsSync(SQ_DB_PATH)) return null;
  try {
    const db = new Database(SQ_DB_PATH, { readonly: true });
    for (const taskId of unblockedTaskIds) {
      const row = db.prepare(
        "SELECT id FROM queue_items WHERE metadata LIKE ? AND priority = 'cto' AND status = 'queued' LIMIT 1"
      ).get(`%"taskId":"${taskId}"%`);
      if (row) {
        db.close();
        return row.id;
      }
    }
    db.close();
  } catch (err) {
    log(`Warning: could not check for CTO-priority items: ${err.message}`);
  }
  return null;
}

// ============================================================================
// Main: Read PostToolUse stdin and process
// ============================================================================

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);

    // Only act on complete_task
    const toolName = hookInput.tool_name || '';
    if (toolName !== 'mcp__todo-db__complete_task') {
      process.exit(0);
    }

    // Extract the completed task ID from the tool response
    let completedTaskId = null;

    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        completedTaskId = response.id || hookInput.tool_input?.id;
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        completedTaskId = parsed.id;
      }
    } catch (err) {
      // Try MCP content array format
      try {
        const response = hookInput.tool_response;
        if (response?.content && Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              const parsed = JSON.parse(block.text);
              if (parsed.id) {
                completedTaskId = parsed.id;
                break;
              }
            }
          }
        }
      } catch (innerErr) {
        // Give up parsing tool_response
      }
    }

    // Fallback: try tool_input directly
    if (!completedTaskId && hookInput.tool_input?.id) {
      completedTaskId = hookInput.tool_input.id;
    }

    if (!completedTaskId) {
      log('complete_task fired but could not extract task ID');
      process.exit(0);
    }

    // Open workstream.db — if it doesn't exist, no deps to satisfy
    if (!fs.existsSync(WS_DB_PATH)) {
      process.exit(0);
    }

    let wsDb;
    try {
      wsDb = new Database(WS_DB_PATH);
    } catch (err) {
      log(`Warning: could not open workstream.db: ${err.message}`);
      process.exit(0);
    }

    // Query active dependencies where this task is the blocker
    let activeDeps;
    try {
      activeDeps = wsDb.prepare(
        "SELECT id, blocked_task_id, blocker_task_id FROM queue_dependencies WHERE blocker_task_id = ? AND status = 'active'"
      ).all(completedTaskId);
    } catch (err) {
      log(`Warning: could not query dependencies: ${err.message}`);
      wsDb.close();
      process.exit(0);
    }

    if (!activeDeps || activeDeps.length === 0) {
      wsDb.close();
      process.exit(0);
    }

    log(`Satisfying ${activeDeps.length} dependencies blocked by task ${completedTaskId}`);

    const now = new Date().toISOString();
    const unblockedTaskIds = [];

    // Satisfy each dependency and record a workstream change
    const satisfyStmt = wsDb.prepare(
      "UPDATE queue_dependencies SET status = 'satisfied', satisfied_at = ? WHERE id = ? AND status = 'active'"
    );
    const insertChangeStmt = wsDb.prepare(`
      INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at)
      VALUES (?, 'dependency_satisfied', NULL, ?, ?, ?, NULL, ?)
    `);

    for (const dep of activeDeps) {
      try {
        const result = satisfyStmt.run(now, dep.id);
        if (result.changes > 0) {
          unblockedTaskIds.push(dep.blocked_task_id);

          const details = JSON.stringify({
            dependency_id: dep.id,
            blocked_task_id: dep.blocked_task_id,
            blocker_task_id: dep.blocker_task_id,
          });
          const reasoning = `Blocker task ${dep.blocker_task_id} completed — dependency ${dep.id} satisfied`;

          insertChangeStmt.run(
            generateChangeId(),
            dep.blocked_task_id,
            details,
            reasoning,
            now,
          );

          log(`Satisfied dep ${dep.id}: ${dep.blocked_task_id} unblocked by completion of ${dep.blocker_task_id}`);
        }
      } catch (err) {
        log(`Warning: could not satisfy dep ${dep.id}: ${err.message}`);
      }
    }

    wsDb.close();

    if (unblockedTaskIds.length === 0) {
      process.exit(0);
    }

    // Check if any now-unblocked task has CTO priority in the queue
    const ctoPriorityQueueId = findCtoPriorityUnblocked(unblockedTaskIds);

    // Import session-queue module and trigger appropriate action
    const sessionQueuePath = path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'session-queue.js');

    try {
      const { drainQueue, preemptForCtoTask } = await import(sessionQueuePath);

      if (ctoPriorityQueueId) {
        log(`CTO-priority item ${ctoPriorityQueueId} unblocked — triggering preemption`);
        await preemptForCtoTask(ctoPriorityQueueId, PROJECT_DIR);
      } else {
        log(`Draining queue to pick up ${unblockedTaskIds.length} unblocked task(s)`);
        drainQueue();
      }
    } catch (err) {
      log(`Warning: could not trigger queue drain: ${err.message}`);
    }

  } catch (err) {
    process.stderr.write(`[workstream-dep-satisfier] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
