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
import { execFileSync } from 'child_process';

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
    const resolvedTasks = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ? AND status IN ('completed', 'skipped')"
    ).get(planTask.phase_id);
    const actuallyCompletedTasks = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE phase_id = ? AND status = 'completed'"
    ).get(planTask.phase_id);

    const phaseProgress = `${resolvedTasks.count}/${totalTasks.count}`;

    // Auto-complete/skip phase if all tasks resolved
    if (resolvedTasks.count === totalTasks.count) {
      if (actuallyCompletedTasks.count > 0) {
        // At least one task genuinely completed — phase is completed
        db.prepare(
          "UPDATE phases SET status = 'completed', completed_at = ? WHERE id = ? AND status NOT IN ('completed', 'skipped')"
        ).run(now, planTask.phase_id);
      } else {
        // ALL tasks were skipped — phase becomes skipped
        db.prepare(
          "UPDATE phases SET status = 'skipped', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'skipped')"
        ).run(now, planTask.phase_id);
      }
    }

    // Check if plan should auto-complete
    // Only auto-complete if ALL phases are completed (no skipped required phases)
    const allPhases = db.prepare('SELECT status, required FROM phases WHERE plan_id = ?').all(planTask.plan_id);
    const allPhasesResolved = allPhases.every(p => p.status === 'completed' || p.status === 'skipped');
    const anyRequiredSkipped = allPhases.some(p => p.status === 'skipped' && p.required);

    let planCompleted = false;
    if (allPhasesResolved && !anyRequiredSkipped) {
      const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planTask.plan_id);
      if (plan && plan.status === 'active') {
        db.prepare(
          "UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
        ).run(now, now, planTask.plan_id);
        db.prepare(
          "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'status', 'active', 'completed', ?, 'plan-merge-tracker')"
        ).run(crypto.randomUUID(), planTask.plan_id, now);
        planCompleted = true;
      }
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

    // Broadcast worktree freshness signal on merge
    try {
      const { broadcastSignal } = await import('./lib/session-signals.js');
      // Detect base branch
      let baseBranch = 'main';
      try {
        execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
        baseBranch = 'preview';
      } catch { /* no preview branch */ }

      // Fetch latest (single fetch updates all worktrees via shared .git)
      try {
        execFileSync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
        });
      } catch { /* fetch failed, non-fatal */ }

      broadcastSignal({
        fromAgentId: process.env.CLAUDE_AGENT_ID || 'merge-tracker',
        tier: 'instruction',
        message: `PR #${prNumber} merged to ${baseBranch}. New commits available on origin/${baseBranch}. Your worktree will be auto-synced by the preview watcher. If urgent, run: git fetch origin && git merge origin/${baseBranch} --no-edit`,
        projectDir: PROJECT_DIR,
      });
    } catch {
      // Non-fatal — broadcast failure must not break the merge tracker
    }

    // Audit trail for plan lifecycle events
    try {
      const { auditEvent } = await import('./lib/session-audit.js');
      auditEvent('plan_task_completed', {
        plan_id: planTask.plan_id,
        plan_task_id: planTask.id,
        task_title: planTask.title,
        trigger: 'pr_merge',
        pr_number: prNumber,
        phase_progress: phaseProgress,
      });
      if (resolvedTasks.count === totalTasks.count) {
        auditEvent('plan_phase_completed', {
          plan_id: planTask.plan_id,
          phase_id: planTask.phase_id,
          trigger: 'all_tasks_complete',
        });
      }
      if (readyTasks.length > 0) {
        auditEvent('plan_tasks_ready', {
          plan_id: planTask.plan_id,
          ready_tasks: readyTasks,
          trigger: 'dependency_resolved',
        });
      }
    } catch (_) { /* non-fatal */ }

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
