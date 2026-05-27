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
import { buildAuditorSessionSpec } from './lib/auditor-prompt.js';

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
// Merge-context resolution
// ============================================================================

/**
 * Resolve the merge target (baseRef, headRef, mergeCommitSha, prNumber) for
 * a task being audited. Best-effort — returns `{ baseRef: null, ... }` on
 * any failure so the auditor still spawns (with the fallback warning prompt).
 *
 * Resolution sources, by task type:
 *   - plan       → plan_orchestrator DB: plans.base_branch + plan_tasks.pr_url
 *   - persistent → persistent_tasks DB: metadata.pr_url + metadata.base_branch
 *   - todo       → todo DB: pr_url field if present
 *
 * When a pr_url is found but no baseRef, we try `gh pr view <url> --json
 * baseRefName,headRefName,mergeCommit` to fill in the gaps.
 *
 * @param {{ taskType: 'todo'|'persistent'|'plan', taskId: string, projectDir: string, log: function }} args
 * @returns {Promise<{ baseRef: string|null, headRef: string|null, mergeCommitSha: string|null, prNumber: string|null }>}
 */
async function resolveMergeContext({ taskType, taskId, projectDir, log }) {
  const empty = { baseRef: null, headRef: null, mergeCommitSha: null, prNumber: null };
  let prUrl = null;
  let baseRef = null;

  try {
    const Database = (await import('better-sqlite3')).default;

    if (taskType === 'plan') {
      const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          // plan_tasks has pr_url (optional); join the parent plan for base_branch
          const row = db.prepare(`
            SELECT pt.pr_url AS pr_url, p.base_branch AS base_branch
              FROM plan_tasks pt
              JOIN plans p ON p.id = pt.plan_id
             WHERE pt.id = ?
          `).get(taskId);
          if (row) {
            prUrl = row.pr_url || null;
            baseRef = row.base_branch || null;
          }
        } catch { /* schema may differ in future; non-fatal */ }
        db.close();
      }
    } else if (taskType === 'persistent') {
      const dbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
          if (row && row.metadata) {
            try {
              const meta = JSON.parse(row.metadata);
              prUrl = meta.pr_url || meta.prUrl || null;
              baseRef = meta.base_branch || meta.baseRef || null;
            } catch { /* malformed metadata; non-fatal */ }
          }
        } catch { /* non-fatal */ }
        db.close();
      }
    } else if (taskType === 'todo') {
      const dbPath = path.join(projectDir, '.claude', 'todo.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          // pr_url is an optional column; query defensively
          const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
          if (row) {
            prUrl = row.pr_url || null;
            baseRef = row.base_branch || null;
          }
        } catch { /* non-fatal */ }
        db.close();
      }
    }
  } catch (err) {
    log(`merge-context: DB read failed for ${taskType}:${taskId} — ${err.message}`);
  }

  // If we have a PR URL, fill in the gaps via `gh pr view`. Bounded 5s
  // timeout — must not block audit spawn on a slow network.
  let headRef = null;
  let mergeCommitSha = null;
  let prNumber = null;
  if (prUrl) {
    const m = String(prUrl).match(/\/pull\/(\d+)/);
    prNumber = m ? m[1] : null;
    try {
      const { execFileSync } = await import('child_process');
      const out = execFileSync('gh', ['pr', 'view', prUrl, '--json', 'baseRefName,headRefName,mergeCommit'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(out);
      baseRef = baseRef || parsed.baseRefName || null;
      headRef = parsed.headRefName || null;
      mergeCommitSha = parsed.mergeCommit?.oid || null;
    } catch {
      // gh unavailable or rate-limited; we still return whatever baseRef we found.
    }
  }

  if (!baseRef && !prUrl) return empty;
  return { baseRef, headRef, mergeCommitSha, prNumber };
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

    // Resolve the merge-target context (baseRef / headRef / mergeCommitSha /
    // prNumber) so the auditor can verify against origin/<baseRef> instead of
    // the auditor's local working tree. Best-effort — when nothing resolves,
    // the auditor prompt falls back to a warning section and audit-lane-guard
    // does not enforce the Read deny.
    const mergeContext = await resolveMergeContext({ taskType, taskId, projectDir: PROJECT_DIR, log });

    const spec = buildAuditorSessionSpec(
      {
        taskId, taskType,
        taskTitle: resolvedTitle, criteria: resolvedCriteria, method: resolvedMethod,
        baseRef: mergeContext.baseRef,
        headRef: mergeContext.headRef,
        mergeCommitSha: mergeContext.mergeCommitSha,
        prNumber: mergeContext.prNumber,
      },
      PROJECT_DIR,
    );
    enqueueSession({
      ...spec,
      title: `Auditing: "${resolvedTitle}"`,
      source: 'universal-audit-spawner',
    });

    auditEvent('task_pending_audit', {
      task_type: taskType, task_id: taskId,
      criteria: (resolvedCriteria || '').slice(0, 200),
      base_ref: mergeContext.baseRef,
      pr_number: mergeContext.prNumber,
    });
    log(`Enqueued auditor for ${taskType} task ${taskId}${mergeContext.baseRef ? ` (baseRef=${mergeContext.baseRef})` : ' (no merge context)'}`);
  } catch (err) {
    log(`Error: ${err.message}\n${err.stack}`);
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
