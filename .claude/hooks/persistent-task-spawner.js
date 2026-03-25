#!/usr/bin/env node
/**
 * Persistent Task Monitor Spawner
 *
 * PostToolUse hook on mcp__persistent-task__activate_persistent_task and
 * mcp__persistent-task__resume_persistent_task. Enqueues a monitor session
 * in the persistent lane immediately when a persistent task is activated
 * or resumed.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { debugLog } from './lib/debug-log.js';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  console.log(JSON.stringify({ }));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Extract tool response
  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let responseData;
  try {
    responseData = typeof toolResponse === 'string' ? JSON.parse(toolResponse) : toolResponse;
  } catch (_) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Check for error or non-active status
  if (responseData.error || responseData.status !== 'active') {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const taskId = responseData.id;
  if (!taskId) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Read the persistent task for prompt building
  if (!Database || !fs.existsSync(PT_DB_PATH)) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let ptDb;
  try {
    ptDb = new Database(PT_DB_PATH, { readonly: true });
  } catch (_) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const task = ptDb.prepare("SELECT * FROM persistent_tasks WHERE id = ?").get(taskId);
  if (!task || task.status !== 'active') {
    ptDb.close();
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Read amendments
  const amendments = ptDb.prepare(
    "SELECT content, amendment_type, created_at FROM amendments WHERE persistent_task_id = ? ORDER BY created_at ASC"
  ).all(taskId);
  ptDb.close();

  // Build the monitor prompt
  const amendmentSection = amendments.length > 0
    ? '\n\n## Amendments\n' + amendments.map((a, i) => `${i + 1}. [${a.amendment_type}, ${a.created_at}] ${a.content}`).join('\n')
    : '';

  const outcomeCriteria = task.outcome_criteria
    ? `\n\n## Outcome Criteria\n${task.outcome_criteria}`
    : '';

  const prompt = `[Automation][persistent-monitor][AGENT:{AGENT_ID}]

## Persistent Task: ${task.title}

You are the persistent task monitor for this objective. Read the full task details first:
mcp__persistent-task__get_persistent_task({ id: "${taskId}", include_amendments: true, include_subtasks: true })

## Primary Objective
${task.prompt}${outcomeCriteria}${amendmentSection}

## Instructions
1. Break down the objective into concrete sub-tasks
2. Create sub-tasks via mcp__todo-db__create_task with persistent_task_id: "${taskId}"
3. Spawn sub-agents for implementation work (use isolation: "worktree" for code changes)
4. Monitor progress, check signals, run alignment checks
5. Complete when outcome criteria are met

Persistent Task ID: ${taskId}
Parent TODO Task ID: ${task.parent_todo_task_id || 'none'}`;

  // Enqueue the monitor session
  try {
    const { enqueueSession } = await import(
      path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js')
    );
    const { AGENT_TYPES, HOOK_TYPES } = await import(
      path.join(PROJECT_DIR, '.claude', 'hooks', 'agent-tracker.js')
    );

    const result = enqueueSession({
      title: `[Persistent] Monitor: ${task.title}`,
      agentType: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
      hookType: HOOK_TYPES.PERSISTENT_TASK_MONITOR,
      tagContext: 'persistent-monitor',
      source: 'persistent-task-spawner',
      priority: 'critical',
      lane: 'persistent',
      ttlMs: 0, // No TTL expiration
      prompt,
      projectDir: PROJECT_DIR,
      extraEnv: {
        GENTYR_PERSISTENT_TASK_ID: taskId,
        GENTYR_PERSISTENT_MONITOR: 'true',
      },
      metadata: {
        persistentTaskId: taskId,
        parentTodoTaskId: task.parent_todo_task_id || null,
      },
    });

    debugLog('persistent-task-spawner', 'monitor_spawn', { taskId, queueId: result.queueId, title: task.title });

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT TASK] Monitor session enqueued (queueId: ${result.queueId}, spawned: ${result.drained?.spawned > 0 ? 'yes' : 'queued'}).`,
      },
    }));
  } catch (err) {
    debugLog('persistent-task-spawner', 'monitor_spawn_failed', { taskId, error: err.message }, 'error');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT TASK] Warning: Failed to enqueue monitor session: ${err.message}. The hourly automation will pick it up within 15 minutes.`,
      },
    }));
  }

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ }));
  process.exit(0);
});
