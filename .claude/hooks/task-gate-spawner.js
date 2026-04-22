#!/usr/bin/env node
/**
 * PostToolUse Hook: Task Gate Spawner
 *
 * Fires after mcp__todo-db__create_task. When a task enters 'pending_review'
 * status (i.e., it was NOT from a gate-bypass creator), spawns a lightweight
 * Haiku agent to review and approve/kill/escalate the task.
 *
 * Complements urgent-task-spawner.js:
 *   - urgent-task-spawner checks toolInput.priority === 'urgent' (from bypass creators)
 *   - task-gate-spawner checks tool_response.status === 'pending_review' (non-bypass creators)
 *   - No overlap: urgent tasks from authorized creators go to urgent-spawner;
 *     everything else goes to gate-spawner
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { enqueueSession } from './lib/session-queue.js';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'task-gate-spawner.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [task-gate-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('[task-gate-spawner] Warning:', err.message);
    // Non-fatal
  }
}

/**
 * Extract a keyword from the task title for CTO session search.
 * Takes the first 2-3 meaningful words.
 */
function extractKeyword(title) {
  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'or', 'in', 'on', 'of', 'add', 'fix', 'update', 'implement', 'create', 'remove', 'delete']);
  const words = title.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  return words.slice(0, 3).join(' ') || title.substring(0, 30);
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

    // Parse the response to check status
    let taskStatus = null;
    let taskId = null;
    let taskTitle = '';
    let taskSection = '';
    let taskCategoryId = '';
    let taskDescription = '';
    let assignedBy = '';
    let demoInvolved = false;

    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        taskStatus = response.status;
        taskId = response.id;
        taskTitle = response.title || '';
        taskSection = response.section || '';
        taskCategoryId = response.category_id || '';
        taskDescription = response.description || '';
        assignedBy = response.assigned_by || '';
        demoInvolved = response.demo_involved === true || response.demo_involved === 1;
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        taskStatus = parsed.status;
        taskId = parsed.id;
        taskTitle = parsed.title || '';
        taskSection = parsed.section || '';
        taskCategoryId = parsed.category_id || '';
        taskDescription = parsed.description || '';
        assignedBy = parsed.assigned_by || '';
        demoInvolved = parsed.demo_involved === true || parsed.demo_involved === 1;
      }
    } catch (err) {
      console.error('[task-gate-spawner] Warning:', err.message);
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
              taskCategoryId = parsed.category_id || '';
              taskDescription = parsed.description || '';
              assignedBy = parsed.assigned_by || '';
              demoInvolved = parsed.demo_involved === true || parsed.demo_involved === 1;
              break;
            }
          }
        }
      } catch (err) {
        console.error('[task-gate-spawner] Warning:', err.message);
        // Give up
      }
    }

    // Only act on pending_review tasks (non-bypassed)
    if (taskStatus !== 'pending_review') {
      process.exit(0);
    }

    if (!taskId) {
      log('pending_review task detected but could not extract task ID');
      process.exit(0);
    }

    log(`Gate review needed for task ${taskId}: "${taskTitle}" (category: ${taskCategoryId || taskSection}, by: ${assignedBy})`);

    // Auto-kill secret-manager tasks in local mode (remote tools unavailable)
    if (isLocalModeEnabled(PROJECT_DIR) && taskSection.toLowerCase().includes('secret')) {
      log(`Auto-killing task ${taskId}: secret-manager tasks are unavailable in local mode`);
      try {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(path.join(PROJECT_DIR, '.claude', 'todo.db'));
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
        db.close();
      } catch (err) {
        log(`Warning: could not auto-kill task ${taskId}: ${err.message}`);
      }
      process.exit(0);
    }

    const keyword = extractKeyword(taskTitle);

    enqueueSession({
      title: `Gate review: ${taskTitle}`,
      agentType: AGENT_TYPES.TASK_GATE,
      hookType: HOOK_TYPES.TASK_GATE,
      tagContext: 'task-gate',
      source: 'task-gate-spawner',
      model: 'claude-haiku-4-5-20251001',
      lane: 'gate',
      priority: 'normal',
      projectDir: PROJECT_DIR,
      metadata: { taskId, section: taskSection, category_id: taskCategoryId, assignedBy, demoInvolved },
      buildPrompt: (agentId) => {
        const demoCheck = demoInvolved ? `
4. DEMO VALIDITY: This task has demo_involved=true. Check the description for anti-patterns:
   a. If description mentions "secret_run_command" with "playwright" → KILL (reason: "Must use mcp__playwright__run_demo, not direct CLI via secret_run_command")
   b. If description contains "main tree" or "DO NOT.*worktree" or "avoid worktree" → KILL (reason: "Worktree isolation is required for demos — agents must run from worktrees")
   c. If category is not "demo-design" → ESCALATE (reason: "demo_involved tasks should use demo-design category")` : '';

        return `[Automation][task-gate][AGENT:${agentId}] Review task ${taskId}.

"${taskTitle}" | Category: ${taskCategoryId || taskSection} | By: ${assignedBy}
Description: ${taskDescription || '(none)'}

## Checks (do all ${demoInvolved ? '4' : '3'}, then decide)
1. DUPLICATES: Call ${taskCategoryId ? `mcp__todo-db__list_tasks({ category_id: "${taskCategoryId}", status: "pending" })` : `mcp__todo-db__list_tasks({ section: "${taskSection}", status: "pending" })`}. If a very similar task exists, KILL.
2. STABILITY: Call mcp__user-feedback__check_feature_stability with file paths or feature name from the description. If feature is locked, KILL.
3. CTO INTENT: Call mcp__agent-tracker__search_cto_sessions({ query: "${keyword}", project_directory: "${PROJECT_DIR}" }). If CTO recently discussed this topic, APPROVE.${demoCheck}

## Decision (pick ONE, then exit)
- APPROVE: mcp__todo-db__gate_approve_task({ id: "${taskId}" })
- KILL: mcp__todo-db__gate_kill_task({ id: "${taskId}", reason: "..." })
- UNSURE: mcp__todo-db__gate_escalate_task({ id: "${taskId}", reason: "..." })

If no stability lock and no duplicate, default to APPROVE. Err toward approval — only kill clear duplicates or stability-locked features.`;
      },
    });

    log(`Enqueued gate agent for task ${taskId}`);
  } catch (err) {
    process.stderr.write(`[task-gate-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
