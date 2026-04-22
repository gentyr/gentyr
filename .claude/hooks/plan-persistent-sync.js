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

    const planTask = db.prepare('SELECT status, phase_id FROM plan_tasks WHERE id = ?').get(planTaskId);
    if (!planTask || planTask.status === 'completed') {
      db.close();
      process.stdout.write(NOOP);
      return;
    }

    const now = new Date().toISOString();

    // Mark plan task completed
    db.prepare(
      "UPDATE plan_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(now, now, planTaskId);

    // Record state change
    db.prepare(
      "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', ?, 'completed', ?, 'plan-persistent-sync')"
    ).run(randomUUID(), planTaskId, planTask.status, now);

    // Check if phase should auto-complete (or auto-skip)
    const allTasks = db.prepare('SELECT status FROM plan_tasks WHERE phase_id = ?')
      .all(planTask.phase_id);
    const allTasksResolved = allTasks.every(t => t.status === 'completed' || t.status === 'skipped');

    let phaseCompleted = false;
    if (allTasksResolved) {
      const phase = db.prepare('SELECT status FROM phases WHERE id = ?').get(planTask.phase_id);
      if (phase && phase.status !== 'completed' && phase.status !== 'skipped') {
        const hasAnyCompleted = allTasks.some(t => t.status === 'completed');
        if (hasAnyCompleted) {
          // At least one task genuinely completed — phase is completed
          db.prepare(
            "UPDATE phases SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
          ).run(now, now, planTask.phase_id);
          db.prepare(
            "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'phase', ?, 'status', ?, 'completed', ?, 'plan-persistent-sync')"
          ).run(randomUUID(), planTask.phase_id, phase.status, now);
          phaseCompleted = true;
        } else {
          // ALL tasks were skipped — phase becomes skipped, not completed
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
    // Only auto-complete if ALL phases are completed (no skipped required phases)
    const allPhases = db.prepare('SELECT status, required FROM phases WHERE plan_id = ?').all(planId);
    const allPhasesResolved = allPhases.every(p => p.status === 'completed' || p.status === 'skipped');
    const anyRequiredSkipped = allPhases.some(p => p.status === 'skipped' && p.required);

    let planCompleted = false;
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

    // Audit trail for plan lifecycle events
    try {
      const { auditEvent } = await import('./lib/session-audit.js');
      auditEvent('plan_task_completed', {
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
      `Persistent task ${persistentTaskId} completion synced to plan task ${planTaskId}.`,
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
