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
import { auditEvent } from './lib/session-audit.js';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  console.log(JSON.stringify({ }));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const AGENT_ID = process.env.CLAUDE_AGENT_ID || 'unknown';

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [persistent-task-spawner] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* non-fatal */ }
}

import { buildPersistentMonitorDemoInstructions } from './lib/persistent-monitor-demo-instructions.js';
import { buildPersistentMonitorStrictInfraInstructions } from './lib/persistent-monitor-strict-infra-instructions.js';

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
    debugLog('persistent-task-spawner', 'exit_no_stdin', {}, 'warn');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    debugLog('persistent-task-spawner', 'exit_parse_error', { stdinLength: stdinData.length }, 'warn');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Extract tool response — Claude Code PostToolUse hooks receive tool_response
  // in various formats depending on the MCP transport. Log the raw shape for debugging.
  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    debugLog('persistent-task-spawner', 'exit_no_tool_response', { inputKeys: Object.keys(input) }, 'warn');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let responseData = null;

  // Format 1: MCP content wrapper — { content: [{ type: 'text', text: '...' }] }
  if (toolResponse && typeof toolResponse === 'object' && Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          responseData = JSON.parse(block.text);
          break;
        } catch (_) { /* try next block */ }
      }
    }
  }

  // Format 2: Bare content array — [{ type: 'text', text: '...' }]
  if (!responseData && Array.isArray(toolResponse)) {
    for (const block of toolResponse) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          responseData = JSON.parse(block.text);
          break;
        } catch (_) { /* try next block */ }
      }
    }
  }

  // Format 3: Plain string (JSON-encoded)
  if (!responseData && typeof toolResponse === 'string') {
    try {
      responseData = JSON.parse(toolResponse);
    } catch (_) { /* fall through */ }
  }

  // Format 4: Plain object with status/id (already deserialized, non-MCP path)
  if (!responseData && toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse) && (toolResponse.status || toolResponse.id)) {
    responseData = toolResponse;
  }

  if (!responseData) {
    debugLog('persistent-task-spawner', 'exit_response_parse_error', {
      toolResponseType: typeof toolResponse,
      isArray: Array.isArray(toolResponse),
      hasContent: !!(toolResponse?.content),
      sample: JSON.stringify(toolResponse).slice(0, 300),
    }, 'warn');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  debugLog('persistent-task-spawner', 'response_parsed', { status: responseData.status, hasError: !!responseData.error, id: responseData.id || responseData.persistent_task_id });

  // Handle pause_persistent_task — audit only, no spawn
  const toolName = input.tool_name || '';
  if (toolName === 'mcp__persistent-task__pause_persistent_task' || responseData.status === 'paused') {
    if (!responseData.error && responseData.id) {
      const taskId = responseData.id;
      const reason = responseData.reason ?? null;
      log(`[persistent-task] Task ${taskId} paused: ${reason}`);
      auditEvent('persistent_task_paused', { taskId, reason, pausedBy: AGENT_ID });
    }
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Handle cancel_persistent_task — audit only, no spawn
  if (toolName === 'mcp__persistent-task__cancel_persistent_task' || responseData.status === 'cancelled') {
    if (!responseData.error && responseData.id) {
      const taskId = responseData.id;
      const reason = responseData.reason ?? null;
      log(`[persistent-task] Task ${taskId} cancelled: ${reason}`);
      auditEvent('persistent_task_cancelled', { taskId, reason, cancelledBy: AGENT_ID });
    }
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Check for error or non-active status
  if (responseData.error || responseData.status !== 'active') {
    debugLog('persistent-task-spawner', 'exit_not_active', { status: responseData.status, error: responseData.error });
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const taskId = responseData.persistent_task_id || responseData.id;
  if (!taskId) {
    debugLog('persistent-task-spawner', 'exit_no_task_id', { responseKeys: Object.keys(responseData) });
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
    debugLog('persistent-task-spawner', 'exit_task_not_active_in_db', { taskId, taskStatus: task?.status || 'not_found' });
    ptDb.close();
    console.log(JSON.stringify({ }));
    process.exit(0);
  }
  debugLog('persistent-task-spawner', 'task_found_active', { taskId, title: task.title });

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

  // Check if demo/strict-infra/plan-manager is involved via task metadata
  let demoInstructions = '';
  let strictInfraInstructions = '';
  let planId = null;
  let planSection = '';
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    if (meta.demo_involved) {
      demoInstructions = buildPersistentMonitorDemoInstructions();
    }
    if (meta.strict_infra_guidance === true) {
      strictInfraInstructions = buildPersistentMonitorStrictInfraInstructions();
    }
    if (meta.plan_id) {
      planId = meta.plan_id;
      planSection = `\nYou are a PLAN MANAGER for plan "${meta.plan_title || planId}" (ID: ${planId}).
Follow the plan-manager agent instructions. Poll get_spawn_ready_tasks, create persistent tasks for ready plan steps, monitor them, and advance the plan until all phases complete.\n`;
    }
  } catch (_) { /* non-fatal */ }

  const prompt = `[Automation][persistent-monitor][AGENT:{AGENT_ID}]

## Persistent Task: ${task.title}
${planSection}
You are the persistent task monitor for this objective. Read the full task details first:
mcp__persistent-task__get_persistent_task({ id: "${taskId}", include_amendments: true, include_subtasks: true })

## Primary Objective
${task.prompt}${outcomeCriteria}${amendmentSection}

## Instructions
CRITICAL: You are an ORCHESTRATOR, not an implementer. Never read source files, investigate code, or edit files directly.

1. Read the persistent task and review existing sub-tasks
2. For EXISTING pending sub-tasks: use force_spawn_tasks({ taskIds: ['<id>'] }) to launch them — do NOT execute them yourself
3. Create NEW sub-tasks via mcp__todo-db__create_task with persistent_task_id: "${taskId}" only when no existing sub-task covers the needed work
4. Monitor sub-agent progress via inspect_persistent_task, check signals, run alignment checks
5. Complete when outcome criteria are met

PROHIBITED: Using Edit, Write, or the Task tool to spawn code-writer/test-writer/demo-manager agents. All implementation work must go through create_task + force_spawn_tasks.
${demoInstructions}${strictInfraInstructions}
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
      agent: planId ? 'plan-manager' : 'persistent-monitor',
      extraArgs: ['--disallowedTools', 'Edit,Write,NotebookEdit'],
      extraEnv: {
        GENTYR_PERSISTENT_TASK_ID: taskId,
        GENTYR_PERSISTENT_MONITOR: 'true',
        ...(planId ? { GENTYR_PLAN_MANAGER: 'true', GENTYR_PLAN_ID: planId } : {}),
      },
      metadata: {
        persistentTaskId: taskId,
        parentTodoTaskId: task.parent_todo_task_id || null,
      },
    });

    debugLog('persistent-task-spawner', 'monitor_spawn', { taskId, queueId: result.queueId, title: task.title });

    // Auto-activate reserved slots if none are currently set.
    // 2 reserved slots ensure persistent task children and CTO-directed work
    // are not blocked when normal tasks fill all concurrency slots.
    try {
      const { getReservedSlots, setReservedSlots } = await import(
        path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js')
      );
      if (getReservedSlots() === 0) {
        setReservedSlots(2);
        debugLog('persistent-task-spawner', 'reserved_slots_activated', { taskId, slots: 2 });
      }
    } catch (_) { /* non-fatal — reserved slots are a best-effort feature */ }

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT TASK] Monitor session automatically enqueued (queueId: ${result.queueId}, spawned: ${result.drained?.spawned > 0 ? 'yes' : 'queued'}). Do NOT manually create tasks or call force_spawn_tasks — the monitor is already handled.`,
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
