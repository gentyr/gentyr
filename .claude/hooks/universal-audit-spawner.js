#!/usr/bin/env node
/**
 * PostToolUse Hook: Universal Audit Spawner
 *
 * Fires after mcp__todo-db__complete_task and
 * mcp__persistent-task__complete_persistent_task. When the response contains
 * status 'pending_audit', spawns an independent auditor to verify the task's
 * completion claims against actual artifacts using gate_success_criteria and
 * gate_verification_method.
 *
 * The auditor is fully independent — runs in the 'audit' lane (signal-excluded),
 * cannot receive messages from the originating agent, and renders exactly one verdict.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { enqueueSession } from './lib/session-queue.js';

let auditEvent;
try {
  const auditMod = await import('./lib/session-audit.js');
  auditEvent = auditMod.auditEvent;
} catch { auditEvent = () => {}; }

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'universal-audit-spawner.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [universal-audit-spawner] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

/**
 * Determine the task type from the tool name.
 * @param {string} toolName
 * @returns {'todo' | 'persistent' | null}
 */
function detectTaskType(toolName) {
  if (!toolName) return null;
  if (toolName === 'mcp__todo-db__complete_task' || toolName === 'complete_task') return 'todo';
  if (toolName === 'mcp__persistent-task__complete_persistent_task' || toolName === 'complete_persistent_task') return 'persistent';
  return null;
}

/**
 * Parse the tool response to extract audit-relevant fields.
 * Handles three response shapes: plain object, JSON string, and MCP content array.
 * @param {any} response
 * @returns {{ status: string|null, taskId: string|null, successCriteria: string, verificationMethod: string, taskTitle: string }}
 */
function parseResponse(response) {
  const result = { status: null, taskId: null, successCriteria: '', verificationMethod: '', taskTitle: '' };

  function extractFields(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    result.status = parsed.status || null;
    result.taskId = parsed.task_id || parsed.id || null;
    result.successCriteria = parsed.gate_success_criteria || '';
    result.verificationMethod = parsed.gate_verification_method || '';
    result.taskTitle = parsed.title || '';
  }

  // Attempt 0: response is a bare content array (Claude Code's primary PostToolUse format)
  if (Array.isArray(response)) {
    for (const block of response) {
      if (block && block.type === 'text' && block.text) {
        try {
          extractFields(JSON.parse(block.text));
          if (result.status) return result;
        } catch {
          // Not JSON text block, continue
        }
      }
    }
    return result;
  }

  // Attempt 1: response is already an object
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    // Check for MCP content array format
    if (response.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try {
            extractFields(JSON.parse(block.text));
            if (result.status) return result;
          } catch {
            // Not JSON text block, continue
          }
        }
      }
    }
    extractFields(response);
    if (result.status) return result;
  }

  // Attempt 2: response is a JSON string
  if (typeof response === 'string') {
    try {
      extractFields(JSON.parse(response));
    } catch {
      // Not valid JSON
    }
  }

  return result;
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

    // Detect task type from tool name
    const toolName = hookInput.tool_name;
    const taskType = detectTaskType(toolName);

    if (!taskType) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Parse the response
    const { status, taskId, successCriteria, verificationMethod, taskTitle } = parseResponse(hookInput.tool_response);

    // Fast-exit if not pending_audit
    if (status !== 'pending_audit') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!taskId) {
      log('pending_audit detected but could not extract task ID');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // If success criteria or verification method missing, try reading from the DB
    let resolvedCriteria = successCriteria;
    let resolvedMethod = verificationMethod;
    let resolvedTitle = taskTitle;

    if (!resolvedCriteria || !resolvedMethod || !resolvedTitle) {
      try {
        const Database = (await import('better-sqlite3')).default;

        if (taskType === 'todo') {
          const dbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
          if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath, { readonly: true });
            const task = db.prepare('SELECT title, gate_success_criteria, gate_verification_method FROM tasks WHERE id = ?').get(taskId);
            db.close();
            if (task) {
              resolvedTitle = resolvedTitle || task.title || '';
              resolvedCriteria = resolvedCriteria || task.gate_success_criteria || '';
              resolvedMethod = resolvedMethod || task.gate_verification_method || '';
            }
          }
        } else if (taskType === 'persistent') {
          const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
          if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath, { readonly: true });
            const task = db.prepare('SELECT title, gate_success_criteria, gate_verification_method FROM persistent_tasks WHERE id = ?').get(taskId);
            db.close();
            if (task) {
              resolvedTitle = resolvedTitle || task.title || '';
              resolvedCriteria = resolvedCriteria || task.gate_success_criteria || '';
              resolvedMethod = resolvedMethod || task.gate_verification_method || '';
            }
          }
        }
      } catch (err) {
        log(`Warning: could not read task details from DB: ${err.message}`);
      }
    }

    if (!resolvedCriteria && !resolvedMethod) {
      log(`pending_audit for ${taskType} task ${taskId} but no gate_success_criteria or gate_verification_method found — skipping`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    log(`Audit needed for ${taskType} task ${taskId}: "${resolvedTitle}"`);

    // Build tool names based on task type
    const passTool = taskType === 'todo'
      ? 'mcp__todo-db__task_audit_pass'
      : 'mcp__persistent-task__pt_audit_pass';
    const failTool = taskType === 'todo'
      ? 'mcp__todo-db__task_audit_fail'
      : 'mcp__persistent-task__pt_audit_fail';

    enqueueSession({
      title: `Universal audit: ${resolvedTitle}`,
      agentType: 'universal-auditor',
      hookType: 'universal-auditor',
      tagContext: 'universal-auditor',
      source: 'universal-audit-spawner',
      model: 'claude-haiku-4-5-20251001',
      agent: 'universal-auditor',
      lane: 'audit',
      priority: 'normal',
      ttlMs: 8 * 60 * 1000, // 8 minute TTL
      projectDir: PROJECT_DIR,
      metadata: { taskId, taskType },
      buildPrompt: (agentId) => {
        return `[Automation][universal-auditor][AGENT:${agentId}] Audit ${taskType} task ${taskId}.

## Task
"${resolvedTitle}"

## Success Criteria
${resolvedCriteria || '(none provided)'}

## Verification Method
${resolvedMethod || '(none provided)'}

## Your Job
You are an INDEPENDENT auditor. Verify the success criteria and verification method against actual artifacts.
Do NOT trust the agent's claims — check actual files, test results, PR status, directory contents, etc.

## Process
1. Read the success criteria and verification method above carefully
2. Use Read, Glob, Grep, Bash to check each claim against reality:
   - If criteria mention tests: run them or check recent test output
   - If criteria mention files/directories: verify they exist with expected content
   - If criteria mention PRs: check PR status via \`gh pr view\`
   - If criteria mention counts: verify actual counts match
3. Render exactly ONE verdict with concrete evidence

## Verdict (pick ONE, then exit immediately)
- PASS: ${passTool}({ task_id: "${taskId}", evidence: "<what you found>" })
- FAIL: ${failTool}({ task_id: "${taskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 8 minutes. Be efficient. If you cannot verify (external system unavailable, ambiguous criteria), FAIL with reason.`;
      },
    });

    auditEvent('task_pending_audit', { task_type: taskType, task_id: taskId, criteria: (resolvedCriteria || '').slice(0, 200) });
    log(`Enqueued auditor for ${taskType} task ${taskId}`);
  } catch (err) {
    log(`Error: ${err.message}\n${err.stack}`);
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
