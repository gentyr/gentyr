#!/usr/bin/env node
/**
 * PostToolUse Hook: Plan-Persistent Task Sync
 *
 * Fires after complete_persistent_task. When the completed persistent task
 * has plan_task_id in its metadata, auto-marks the linked plan task as completed.
 * This triggers the plan-orchestrator's auto-completion cascade (phase + plan).
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const PERSISTENT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const NOOP = JSON.stringify({});

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => resolve(data));
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  // Only fire on complete_persistent_task
  const toolName = input.tool_name || '';
  if (!toolName.includes('complete_persistent_task')) {
    process.stdout.write(NOOP);
    return;
  }

  // Extract persistent task ID from tool input
  let persistentTaskId;
  try {
    const toolInput = typeof input.tool_input === 'string'
      ? JSON.parse(input.tool_input)
      : input.tool_input;
    persistentTaskId = toolInput?.id;
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  if (!persistentTaskId) {
    process.stdout.write(NOOP);
    return;
  }

  // Lazy-load SQLite
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  // Check if this persistent task has plan linkage
  let planTaskId, planId;
  try {
    if (!fs.existsSync(PERSISTENT_DB_PATH)) {
      process.stdout.write(NOOP);
      return;
    }
    const pdb = new Database(PERSISTENT_DB_PATH, { readonly: true });
    const task = pdb.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
    pdb.close();

    if (!task?.metadata) {
      process.stdout.write(NOOP);
      return;
    }

    const meta = JSON.parse(task.metadata);
    planTaskId = meta.plan_task_id;
    planId = meta.plan_id;
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  if (!planTaskId || !planId) {
    process.stdout.write(NOOP);
    return;
  }

  // Update the plan task to completed
  try {
    if (!fs.existsSync(PLANS_DB_PATH)) {
      process.stdout.write(NOOP);
      return;
    }

    const db = new Database(PLANS_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');

    const planTask = db.prepare('SELECT status, phase_id, verification_strategy, title, todo_task_id FROM plan_tasks WHERE id = ?').get(planTaskId);
    if (!planTask || planTask.status === 'completed' || planTask.status === 'pending_audit') {
      db.close();
      process.stdout.write(NOOP);
      return;
    }

    // Cross-check: if plan task has a linked todo_task_id, verify it's completed before cascading
    if (planTask.todo_task_id) {
      try {
        if (fs.existsSync(TODO_DB_PATH)) {
          const todoDb = new Database(TODO_DB_PATH, { readonly: true });
          const todoTask = todoDb.prepare('SELECT status FROM tasks WHERE id = ?').get(planTask.todo_task_id);
          todoDb.close();

          if (todoTask && todoTask.status !== 'completed') {
            // Linked todo task is not completed — do NOT cascade plan task completion
            db.close();
            const warning = `Plan task ${planTaskId} completion blocked: linked todo task ${planTask.todo_task_id} is still in status "${todoTask.status}"`;
            process.stderr.write(`[plan-persistent-sync] ${warning}\n`);
            process.stdout.write(JSON.stringify({
              additionalContext: `[PLAN SYNC BLOCKED] ${warning}. The plan task remains in_progress until the linked todo task completes.`,
            }));
            return;
          }
          // If todoTask doesn't exist in DB (deleted?), allow completion (fail-open)
        }
      } catch (todoErr) {
        // Fail-open: DB errors should not block plan completion
        process.stderr.write(`[plan-persistent-sync] Warning: could not verify todo task status: ${todoErr.message}\n`);
      }
    }

    const now = new Date().toISOString();
    let phaseCompleted = false;
    let planCompleted = false;

    if (planTask.verification_strategy) {
      // Route through audit gate — set pending_audit instead of completed
      db.prepare(
        "UPDATE plan_tasks SET status = 'pending_audit', updated_at = ? WHERE id = ?"
      ).run(now, planTaskId);

      db.prepare(
        "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', ?, 'pending_audit', ?, 'plan-persistent-sync')"
      ).run(randomUUID(), planTaskId, planTask.status, now);

      // Create audit record
      const auditId = randomUUID();
      // Ensure plan_audits table exists (may not on first run after upgrade)
      db.exec(`CREATE TABLE IF NOT EXISTS plan_audits (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_id TEXT NOT NULL,
        verification_strategy TEXT NOT NULL, verdict TEXT, evidence TEXT,
        failure_reason TEXT, auditor_agent_id TEXT, requested_at TEXT NOT NULL,
        completed_at TEXT, attempt_number INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT valid_audit_verdict CHECK (verdict IS NULL OR verdict IN ('pass','fail'))
      )`);
      const attemptNum = (db.prepare('SELECT COUNT(*) as c FROM plan_audits WHERE task_id = ?')
        .get(planTaskId)?.c || 0) + 1;
      db.prepare(
        'INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(auditId, planTaskId, planId, planTask.verification_strategy, now, attemptNum);

      db.close();

      // Spawn auditor inline (same logic as plan-audit-spawner.js)
      try {
        const { enqueueSession } = await import('./lib/session-queue.js');
        const { AGENT_TYPES, HOOK_TYPES } = await import('./agent-tracker.js');

        enqueueSession({
          title: `Plan audit: ${planTask.title || planTaskId}`,
          agentType: AGENT_TYPES.PLAN_AUDITOR,
          hookType: HOOK_TYPES.PLAN_AUDITOR,
          tagContext: 'plan-auditor',
          source: 'plan-persistent-sync',
          model: 'claude-sonnet-4-6',
          agent: 'plan-auditor',
          lane: 'audit',
          priority: 'normal',
          ttlMs: 5 * 60 * 1000,
          projectDir: PROJECT_DIR,
          metadata: { taskId: planTaskId, planId },
          buildPrompt: (agentId) => {
            return `[Automation][plan-auditor][AGENT:${agentId}] Audit plan task ${planTaskId}.

## Task
"${planTask.title || planTaskId}"

## Verification Strategy
${planTask.verification_strategy}

## Your Job
You are an INDEPENDENT auditor. Verify the verification strategy against actual artifacts.
Do NOT trust the agent's claims — check actual files, test results, PR status, directory contents, etc.

## CRITICAL: File Path Verification
If the verification_strategy references specific file paths (e.g., "Results at .claude/releases/X/test-results.json",
"Report generated at .claude/releases/X/report.md", or any path starting with ./ or .claude/), you MUST verify those
files exist on disk using the Read tool. If the referenced files do NOT exist, the audit FAILS — the work was not
actually completed regardless of what the agent claimed. Missing artifact files are an automatic FAIL verdict.

## Verdict (pick ONE, then exit immediately)
- PASS: mcp__plan-orchestrator__verification_audit_pass({ task_id: "${planTaskId}", evidence: "<what you found>" })
- FAIL: mcp__plan-orchestrator__verification_audit_fail({ task_id: "${planTaskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 5 minutes. Be efficient.`;
          },
        });
      } catch (err) {
        process.stderr.write(`[plan-persistent-sync] Warning: could not enqueue auditor: ${err.message}\n`);
      }

      // pending_audit blocks cascade — skip phase/plan auto-completion
    } else {
      // No verification strategy — complete directly (existing behavior)
      db.prepare(
        "UPDATE plan_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, planTaskId);

      db.prepare(
        "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', ?, 'completed', ?, 'plan-persistent-sync')"
      ).run(randomUUID(), planTaskId, planTask.status, now);

      // Check if phase should auto-complete (or auto-skip)
      const allTasks = db.prepare('SELECT status FROM plan_tasks WHERE phase_id = ?')
        .all(planTask.phase_id);
      const allTasksResolved = allTasks.every(t => t.status === 'completed' || t.status === 'skipped');

      if (allTasksResolved) {
        const phase = db.prepare('SELECT status FROM phases WHERE id = ?').get(planTask.phase_id);
        if (phase && phase.status !== 'completed' && phase.status !== 'skipped') {
          const hasAnyCompleted = allTasks.some(t => t.status === 'completed');
          if (hasAnyCompleted) {
            db.prepare(
              "UPDATE phases SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
            ).run(now, now, planTask.phase_id);
            db.prepare(
              "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'phase', ?, 'status', ?, 'completed', ?, 'plan-persistent-sync')"
            ).run(randomUUID(), planTask.phase_id, phase.status, now);
            phaseCompleted = true;
          } else {
            db.prepare(
              "UPDATE phases SET status = 'skipped', updated_at = ? WHERE id = ?"
            ).run(now, planTask.phase_id);
            db.prepare(
              "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'phase', ?, 'status', ?, 'skipped', ?, 'plan-persistent-sync')"
            ).run(randomUUID(), planTask.phase_id, phase.status, now);
          }
        }
      }

      // Check if plan should auto-complete
      const allPhases = db.prepare('SELECT status, required FROM phases WHERE plan_id = ?').all(planId);
      const allPhasesResolved = allPhases.every(p => p.status === 'completed' || p.status === 'skipped');
      const anyRequiredSkipped = allPhases.some(p => p.status === 'skipped' && p.required);

      if (allPhasesResolved && !anyRequiredSkipped) {
        const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
        if (plan && plan.status === 'active') {
          db.prepare(
            "UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
          ).run(now, now, planId);
          db.prepare(
            "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'status', 'active', 'completed', ?, 'plan-persistent-sync')"
          ).run(randomUUID(), planId, now);
          planCompleted = true;
        }
      }

      db.close();
    }

    // Audit trail for plan lifecycle events
    try {
      const { auditEvent } = await import('./lib/session-audit.js');
      auditEvent(planTask.verification_strategy ? 'plan_task_pending_audit' : 'plan_task_completed', {
        plan_id: planId,
        plan_task_id: planTaskId,
        trigger: 'persistent_task_complete',
        persistent_task_id: persistentTaskId,
      });
      if (phaseCompleted) {
        auditEvent('plan_phase_completed', {
          plan_id: planId,
          phase_id: planTask.phase_id,
          trigger: 'all_tasks_complete',
        });
      }
      if (planCompleted) {
        auditEvent('plan_completed', {
          plan_id: planId,
          trigger: 'all_phases_complete',
        });
      }
    } catch (_) { /* non-fatal */ }

    const details = [
      planTask.verification_strategy
        ? `Persistent task ${persistentTaskId} completion routed plan task ${planTaskId} to pending_audit.`
        : `Persistent task ${persistentTaskId} completion synced to plan task ${planTaskId}.`,
      phaseCompleted ? 'Phase auto-completed.' : '',
      planCompleted ? 'Plan auto-completed!' : '',
    ].filter(Boolean).join(' ');

    process.stdout.write(JSON.stringify({
      additionalContext: `[PLAN SYNC] ${details}`,
    }));
    return;
  } catch {
    // Non-fatal — the tool already ran
    process.stdout.write(NOOP);
    return;
  }
}

main().catch(() => {
  process.stdout.write(NOOP);
});
