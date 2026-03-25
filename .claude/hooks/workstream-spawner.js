#!/usr/bin/env node
/**
 * PostToolUse Hook: Workstream Spawner
 *
 * Fires after mcp__todo-db__create_task. When a new task enters the queue
 * (status is NOT 'pending_review'), spawns a lightweight workstream-manager
 * agent to assess whether the new task introduces queue conflicts or
 * dependencies with already-running/queued work.
 *
 * Does NOT fire when status === 'pending_review' — the gate agent handles
 * those tasks first. This hook fires only on tasks that have already cleared
 * the gate (or were created by bypass creators).
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { enqueueSession } from './lib/session-queue.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'workstream-spawner.log');
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const WS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [workstream-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Check if a workstream-manager is already running in the session queue.
 * @returns {boolean}
 */
function isWorkstreamManagerRunning() {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE agent_type LIKE '%workstream%' AND status IN ('queued', 'spawning', 'running')"
    ).get();
    db.close();
    return row && row.cnt > 0;
  } catch (err) {
    log(`Warning: could not check session queue: ${err.message}`);
    // Fail open — don't block spawning
    return false;
  }
}

/**
 * Read current queue state for the assessment prompt.
 * Returns { running: string[], queued: string[] }
 */
function readQueueState() {
  if (!fs.existsSync(DB_PATH)) return { running: [], queued: [] };
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const running = db.prepare(
      "SELECT id, title, agent_type FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC LIMIT 20"
    ).all();
    const queued = db.prepare(
      "SELECT id, title, agent_type FROM queue_items WHERE status = 'queued' ORDER BY enqueued_at ASC LIMIT 20"
    ).all();
    db.close();
    return { running, queued };
  } catch (err) {
    log(`Warning: could not read queue state: ${err.message}`);
    return { running: [], queued: [] };
  }
}

/**
 * Read existing active dependencies from workstream.db.
 * Returns array of { id, blocked_task_id, blocker_task_id, reasoning }
 */
function readActiveDependencies() {
  if (!fs.existsSync(WS_DB_PATH)) return [];
  try {
    const db = new Database(WS_DB_PATH, { readonly: true });
    const deps = db.prepare(
      "SELECT id, blocked_task_id, blocker_task_id, reasoning FROM queue_dependencies WHERE status = 'active' LIMIT 50"
    ).all();
    db.close();
    return deps;
  } catch (err) {
    log(`Warning: could not read workstream.db: ${err.message}`);
    return [];
  }
}

/**
 * Build the assessment prompt for the workstream-manager agent.
 */
function buildAssessmentPrompt(agentId, task, queueState, activeDeps) {
  const runningList = queueState.running.length > 0
    ? queueState.running.map(r => `  - [${r.id}] "${r.title}" (${r.agent_type})`).join('\n')
    : '  (none)';

  const queuedList = queueState.queued.length > 0
    ? queueState.queued.map(q => `  - [${q.id}] "${q.title}" (${q.agent_type})`).join('\n')
    : '  (none)';

  const depsList = activeDeps.length > 0
    ? activeDeps.map(d => `  - [${d.id}] ${d.blocked_task_id} BLOCKED BY ${d.blocker_task_id}: ${d.reasoning}`).join('\n')
    : '  (none)';

  return `[Automation][workstream-assessment][AGENT:${agentId}] Assess new task for workstream dependencies.

## New Task
- ID: ${task.id}
- Title: "${task.title}"
- Section: ${task.section}
- Description: ${task.description || '(none)'}

## Current Queue State

### Running (${queueState.running.length}):
${runningList}

### Queued (${queueState.queued.length}):
${queuedList}

### Existing Active Dependencies:
${depsList}

## Your Assessment Task

1. Review the new task details and the current queue state.
2. Call \`mcp__workstream__get_queue_context({})\` to see the full queue context with dependency statuses.
3. Determine if any running or queued tasks would conflict with or block the new task.
4. Determine if the new task would block any already-queued task.

## Decision

**If a dependency is needed:**
Call \`mcp__workstream__add_dependency({ blocked_task_id: "<task_id>", blocker_task_id: "<blocker_id>", reasoning: "..." })\`

**If no dependencies needed:**
Call \`mcp__workstream__record_assessment({ task_id: "${task.id}", reasoning: "No conflicts or dependencies detected: ..." })\`

Be concise. Only add dependencies when there is a clear conflict (e.g., two tasks modify the same file/feature, or Task A's output is required by Task B). Do NOT add speculative or precautionary dependencies — only real blockers.`;
}

// ============================================================================
// Main: Read PostToolUse stdin and process
// ============================================================================

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);

    // Only act on task creation
    const toolName = hookInput.tool_name || '';
    if (toolName !== 'mcp__todo-db__create_task') {
      process.exit(0);
    }

    // Parse task info from tool_response
    let taskStatus = null;
    let taskId = null;
    let taskTitle = '';
    let taskSection = '';
    let taskDescription = '';

    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        taskStatus = response.status;
        taskId = response.id;
        taskTitle = response.title || '';
        taskSection = response.section || '';
        taskDescription = response.description || '';
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        taskStatus = parsed.status;
        taskId = parsed.id;
        taskTitle = parsed.title || '';
        taskSection = parsed.section || '';
        taskDescription = parsed.description || '';
      }
    } catch (err) {
      // Try MCP content array format
      try {
        const response = hookInput.tool_response;
        if (response?.content && Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              const parsed = JSON.parse(block.text);
              taskStatus = parsed.status;
              taskId = parsed.id;
              taskTitle = parsed.title || '';
              taskSection = parsed.section || '';
              taskDescription = parsed.description || '';
              break;
            }
          }
        }
      } catch (innerErr) {
        // Give up parsing
      }
    }

    // Skip pending_review tasks — gate agent handles them first
    if (taskStatus === 'pending_review') {
      log(`Skipping pending_review task ${taskId} — gate agent handles first`);
      process.exit(0);
    }

    if (!taskId) {
      log('Task creation detected but could not extract task ID');
      process.exit(0);
    }

    log(`Assessing new task ${taskId}: "${taskTitle}" (section: ${taskSection}, status: ${taskStatus})`);

    // Skip if a workstream-manager is already running
    if (isWorkstreamManagerRunning()) {
      log(`Workstream-manager already running — skipping assessment for task ${taskId}`);
      process.exit(0);
    }

    // Gather context for the assessment prompt
    const queueState = readQueueState();
    const activeDeps = readActiveDependencies();

    enqueueSession({
      title: `[Workstream] Assess: ${taskTitle}`,
      agentType: AGENT_TYPES.TASK_RUNNER_WORKSTREAM_MANAGER,
      hookType: HOOK_TYPES.WORKSTREAM_SPAWNER,
      tagContext: 'workstream-assessment',
      source: 'workstream-spawner',
      model: 'claude-haiku-4-5-20251001',
      lane: 'gate',
      priority: 'normal',
      projectDir: PROJECT_DIR,
      metadata: { taskId, section: taskSection, assessmentFor: taskTitle },
      buildPrompt: (agentId) => buildAssessmentPrompt(
        agentId,
        { id: taskId, title: taskTitle, section: taskSection, description: taskDescription },
        queueState,
        activeDeps,
      ),
    });

    log(`Enqueued workstream-manager assessment for task ${taskId}`);
  } catch (err) {
    process.stderr.write(`[workstream-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
