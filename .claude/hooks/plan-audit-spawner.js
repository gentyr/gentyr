#!/usr/bin/env node
/**
 * PostToolUse Hook: Plan Audit Spawner
 *
 * Fires after mcp__plan-orchestrator__update_task_progress. When a plan task
 * enters 'pending_audit' status (has a verification_strategy), spawns a
 * lightweight Haiku auditor agent to independently verify the task's completion
 * claims against actual artifacts.
 *
 * The auditor is fully independent — runs in the 'audit' lane (signal-excluded),
 * cannot receive messages from the plan manager, and renders exactly one verdict.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { enqueueSession } from './lib/session-queue.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'plan-audit-spawner.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [plan-audit-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
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

    // Parse the response to check for pending_audit status
    let taskStatus = null;
    let taskId = null;
    let taskTitle = '';
    let verificationStrategy = '';
    let planId = '';

    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        taskStatus = response.status;
        taskId = response.task_id;
        verificationStrategy = response.verification_strategy || '';
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        taskStatus = parsed.status;
        taskId = parsed.task_id;
        verificationStrategy = parsed.verification_strategy || '';
      }
    } catch {
      // Try MCP content array format
      try {
        const response = hookInput.tool_response;
        if (response?.content && Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              const parsed = JSON.parse(block.text);
              taskStatus = parsed.status;
              taskId = parsed.task_id;
              verificationStrategy = parsed.verification_strategy || '';
              break;
            }
          }
        }
      } catch {
        // Give up
      }
    }

    // Only act on pending_audit tasks
    if (taskStatus !== 'pending_audit') {
      process.exit(0);
    }

    if (!taskId) {
      log('pending_audit detected but could not extract task ID');
      process.exit(0);
    }

    // Read task details from plans.db if not in response
    if (!verificationStrategy || !taskTitle || !planId) {
      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
        if (fs.existsSync(dbPath)) {
          const db = new Database(dbPath, { readonly: true });
          const task = db.prepare('SELECT title, verification_strategy, plan_id FROM plan_tasks WHERE id = ?').get(taskId);
          db.close();
          if (task) {
            taskTitle = taskTitle || task.title;
            verificationStrategy = verificationStrategy || task.verification_strategy || '';
            planId = planId || task.plan_id || '';
          }
        }
      } catch (err) {
        log(`Warning: could not read task details from plans.db: ${err.message}`);
      }
    }

    if (!verificationStrategy) {
      log(`pending_audit for task ${taskId} but no verification_strategy found — skipping`);
      process.exit(0);
    }

    log(`Audit needed for plan task ${taskId}: "${taskTitle}"`);

    enqueueSession({
      title: `Plan audit: ${taskTitle}`,
      agentType: AGENT_TYPES.PLAN_AUDITOR,
      hookType: HOOK_TYPES.PLAN_AUDITOR,
      tagContext: 'plan-auditor',
      source: 'plan-audit-spawner',
      model: 'claude-haiku-4-5-20251001',
      agent: 'plan-auditor',
      lane: 'audit',
      priority: 'normal',
      ttlMs: 5 * 60 * 1000, // 5 minute TTL
      projectDir: PROJECT_DIR,
      metadata: { taskId, planId },
      buildPrompt: (agentId) => {
        return `[Automation][plan-auditor][AGENT:${agentId}] Audit plan task ${taskId}.

## Task
"${taskTitle}"

## Verification Strategy
${verificationStrategy}

## Your Job
You are an INDEPENDENT auditor. Verify the verification strategy against actual artifacts.
Do NOT trust the agent's claims — check actual files, test results, PR status, directory contents, etc.

## Process
1. Read the verification strategy above carefully
2. Use Read, Glob, Grep, Bash to check each claim against reality:
   - If strategy mentions tests: run them or check recent test output
   - If strategy mentions files/directories: verify they exist with expected content
   - If strategy mentions PRs: check PR status via \`gh pr view\`
   - If strategy mentions counts: verify actual counts match
3. Render exactly ONE verdict with concrete evidence

## CRITICAL: File Path Verification
If the verification_strategy references specific file paths (e.g., "Results at .claude/releases/X/test-results.json",
"Report generated at .claude/releases/X/report.md", or any path starting with ./ or .claude/), you MUST verify those
files exist on disk using the Read tool. If the referenced files do NOT exist, the audit FAILS — the work was not
actually completed regardless of what the agent claimed. Missing artifact files are an automatic FAIL verdict.

## Verdict (pick ONE, then exit immediately)
- PASS: mcp__plan-orchestrator__verification_audit_pass({ task_id: "${taskId}", evidence: "<what you found>" })
- FAIL: mcp__plan-orchestrator__verification_audit_fail({ task_id: "${taskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 5 minutes. Be efficient. If you cannot verify (external system unavailable, ambiguous strategy), FAIL with reason.`;
      },
    });

    log(`Enqueued auditor for plan task ${taskId}`);
  } catch (err) {
    process.stderr.write(`[plan-audit-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
