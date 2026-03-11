#!/usr/bin/env node
/**
 * PostToolUse Hook: Plan Work Tracker
 *
 * Fires after mcp__todo-db__summarize_work. When the completed todo task
 * has plan linkage metadata (plan_task_id), auto-updates the plan task status
 * and checks if phase dependencies are now met.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal
}

const NOOP = JSON.stringify({ continue: true });

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!Database || !fs.existsSync(PLANS_DB_PATH) || !fs.existsSync(TODO_DB_PATH)) {
    process.stdout.write(NOOP);
    return;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  // Extract task_id from the tool response
  let todoTaskId = null;
  try {
    const response = event?.tool_response;
    if (response && typeof response === 'object') {
      todoTaskId = response.task_id || response.id;
    } else if (typeof response === 'string') {
      const parsed = JSON.parse(response);
      todoTaskId = parsed.task_id || parsed.id;
    }
    if (!todoTaskId && response?.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          const parsed = JSON.parse(block.text);
          todoTaskId = parsed.task_id || parsed.id;
          break;
        }
      }
    }
  } catch {
    // Could not extract task ID
  }

  if (!todoTaskId) {
    process.stdout.write(NOOP);
    return;
  }

  // Check todo.db for plan linkage
  let planTaskId = null;
  let planId = null;
  try {
    const todoDB = new Database(TODO_DB_PATH, { readonly: true });
    const task = todoDB.prepare('SELECT metadata FROM tasks WHERE id = ?').get(todoTaskId);
    todoDB.close();

    if (task?.metadata) {
      const meta = JSON.parse(task.metadata);
      planTaskId = meta.plan_task_id;
      planId = meta.plan_id;
    }
  } catch {
    // Non-fatal
  }

  if (!planTaskId) {
    process.stdout.write(NOOP);
    return;
  }

  // Update plan task status
  let taskTitle = '';
  let phaseProgress = '';
  let readyTasks = [];
  try {
    const db = new Database(PLANS_DB_PATH);

    // Mark plan task as completed
    const planTask = db.prepare('SELECT id, title, phase_id, status FROM plan_tasks WHERE id = ?').get(planTaskId);
    if (planTask && planTask.status !== 'completed') {
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE plan_tasks SET status = 'completed', completed_at = ? WHERE id = ?"
      ).run(now, planTaskId);

      // Record state change
      db.prepare(
        "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', ?, 'completed', ?, 'plan-work-tracker')"
      ).run(crypto.randomUUID(), planTaskId, planTask.status, now);

      taskTitle = planTask.title;

      // Check phase progress
      const phaseId = planTask.phase_id;
      const totalTasks = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ?"
      ).get(phaseId);
      const completedTasks = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ? AND status IN ('completed', 'skipped')"
      ).get(phaseId);
      phaseProgress = `${completedTasks.count}/${totalTasks.count}`;

      // Auto-complete phase if all tasks done
      if (completedTasks.count === totalTasks.count) {
        db.prepare(
          "UPDATE phases SET status = 'completed', completed_at = ? WHERE id = ? AND status != 'completed'"
        ).run(now, phaseId);
      }

      // Check for newly ready tasks (deps met)
      if (planId) {
        const pendingTasks = db.prepare(
          "SELECT pt.id, pt.title FROM plan_tasks pt WHERE pt.plan_id = ? AND pt.status IN ('pending', 'blocked')"
        ).all(planId);

        for (const pt of pendingTasks) {
          // Check if all dependencies are met
          const unmetDeps = db.prepare(`
            SELECT d.id FROM dependencies d
            LEFT JOIN plan_tasks bt ON d.blocker_type = 'task' AND d.blocker_id = bt.id
            LEFT JOIN phases bp ON d.blocker_type = 'phase' AND d.blocker_id = bp.id
            WHERE d.blocked_type = 'task' AND d.blocked_id = ?
            AND (
              (d.blocker_type = 'task' AND (bt.status IS NULL OR bt.status NOT IN ('completed', 'skipped')))
              OR (d.blocker_type = 'phase' AND (bp.status IS NULL OR bp.status NOT IN ('completed', 'skipped')))
            )
          `).all(pt.id);

          if (unmetDeps.length === 0) {
            db.prepare("UPDATE plan_tasks SET status = 'ready' WHERE id = ? AND status IN ('pending', 'blocked')").run(pt.id);
            readyTasks.push(pt.title);
          }
        }
      }
    }

    db.close();
  } catch (err) {
    process.stderr.write(`[plan-work-tracker] DB error: ${err.message}\n`);
    process.stdout.write(NOOP);
    return;
  }

  if (taskTitle) {
    let msg = `Plan update: Task '${taskTitle}' completed. Phase ${phaseProgress} done.`;
    if (readyTasks.length > 0) {
      msg += ` Next ready: ${readyTasks.join(', ')}.`;
    }

    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: msg,
      },
    }));
  } else {
    process.stdout.write(NOOP);
  }
}

main().catch(() => {
  process.stdout.write(NOOP);
});
