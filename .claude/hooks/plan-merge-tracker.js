#!/usr/bin/env node
/**
 * PostToolUse Hook: Plan Merge Tracker
 *
 * Fires after Bash tool calls. When `gh pr merge` is detected in the command,
 * looks up the PR number in plans.db and auto-completes the linked task.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[plan-merge-tracker] Warning:', err.message);
  // Non-fatal
}

const NOOP = JSON.stringify({ continue: true });

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!Database || !fs.existsSync(PLANS_DB_PATH)) {
    process.stdout.write(NOOP);
    return;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    console.error('[plan-merge-tracker] Warning:', err.message);
    process.stdout.write(NOOP);
    return;
  }

  // Only fire on Bash tool calls
  if (event?.tool_name !== 'Bash') {
    process.stdout.write(NOOP);
    return;
  }

  const command = event?.tool_input?.command || '';

  // Check for `gh pr merge`
  if (!command.includes('gh pr merge')) {
    process.stdout.write(NOOP);
    return;
  }

  // Extract PR number from command (e.g., `gh pr merge 45 --squash`)
  const prMatch = command.match(/gh\s+pr\s+merge\s+(\d+)/);
  if (!prMatch) {
    process.stdout.write(NOOP);
    return;
  }

  const prNumber = parseInt(prMatch[1], 10);

  try {
    const db = new Database(PLANS_DB_PATH);

    // Find plan task with this PR number
    const planTask = db.prepare(
      "SELECT id, title, phase_id, plan_id, status FROM plan_tasks WHERE pr_number = ?"
    ).get(prNumber);

    if (!planTask || planTask.status === 'completed') {
      db.close();
      process.stdout.write(NOOP);
      return;
    }

    const now = new Date().toISOString();

    // Mark PR as merged and complete the task
    db.prepare(
      "UPDATE plan_tasks SET pr_merged = 1, status = 'completed', completed_at = ? WHERE id = ?"
    ).run(now, planTask.id);

    // Record state change
    db.prepare(
      "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', ?, 'completed', ?, 'plan-merge-tracker')"
    ).run(crypto.randomUUID(), planTask.id, planTask.status, now);

    // Check phase progress
    const totalTasks = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ?"
    ).get(planTask.phase_id);
    const completedTasks = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ? AND status IN ('completed', 'skipped')"
    ).get(planTask.phase_id);

    const phaseProgress = `${completedTasks.count}/${totalTasks.count}`;

    // Auto-complete phase if all tasks done
    if (completedTasks.count === totalTasks.count) {
      db.prepare(
        "UPDATE phases SET status = 'completed', completed_at = ? WHERE id = ? AND status != 'completed'"
      ).run(now, planTask.phase_id);
    }

    // Check for newly ready tasks (deps met)
    const readyTasks = [];
    const pendingTasks = db.prepare(
      "SELECT pt.id, pt.title FROM plan_tasks pt WHERE pt.plan_id = ? AND pt.status IN ('pending', 'blocked')"
    ).all(planTask.plan_id);

    for (const pt of pendingTasks) {
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

    db.close();

    let msg = `Plan progress: PR #${prNumber} merged. Task '${planTask.title}' complete. Phase now ${phaseProgress}.`;
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
  } catch (err) {
    process.stderr.write(`[plan-merge-tracker] DB error: ${err.message}\n`);
    process.stdout.write(NOOP);
  }
}

main().catch(() => {
  process.stdout.write(NOOP);
});
