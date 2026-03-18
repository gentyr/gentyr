#!/usr/bin/env node
/**
 * SessionStart Hook: Plan Briefing
 *
 * Runs on every interactive session start. Queries plans.db for active plans
 * and injects a compact briefing into additionalContext so the model has
 * plan awareness from the first prompt.
 *
 * Skipped for spawned sessions (CLAUDE_SPAWNED_SESSION=true).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[plan-briefing] Warning:', err.message);
  // Non-fatal
}

// Read stdin (SessionStart hook contract)
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 100);
  });
}

function getPlanBriefing() {
  if (!Database || !fs.existsSync(PLANS_DB_PATH)) {
    return null;
  }

  try {
    const db = new Database(PLANS_DB_PATH, { readonly: true });

    // Get active plans
    const plans = db.prepare(
      "SELECT id, title, status FROM plans WHERE status = 'active' ORDER BY updated_at DESC"
    ).all();

    if (plans.length === 0) {
      db.close();
      return null;
    }

    const totalPlans = db.prepare("SELECT COUNT(*) as count FROM plans").get();
    const lines = [];
    let totalReady = 0;
    const readyTaskNames = [];

    for (const plan of plans) {
      // Phase counts
      const phaseTotal = db.prepare(
        "SELECT COUNT(*) as count FROM phases WHERE plan_id = ?"
      ).get(plan.id);
      const phaseComplete = db.prepare(
        "SELECT COUNT(*) as count FROM phases WHERE plan_id = ? AND status = 'completed'"
      ).get(plan.id);

      // Task counts
      const taskTotal = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ?"
      ).get(plan.id);
      const taskComplete = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'completed'"
      ).get(plan.id);

      // Progress
      const pct = taskTotal.count > 0 ? Math.round((taskComplete.count / taskTotal.count) * 100) : 0;

      // Ready + active counts
      const readyCount = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'ready'"
      ).get(plan.id);
      const activeCount = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'"
      ).get(plan.id);

      totalReady += readyCount.count;

      lines.push(
        `  ${plan.title}: Phase ${phaseComplete.count}/${phaseTotal.count}, ` +
        `${taskComplete.count}/${taskTotal.count} tasks (${pct}%) | ` +
        `${activeCount.count} agents running | ${readyCount.count} ready`
      );

      // Collect ready task names
      if (readyCount.count > 0) {
        const readyTasks = db.prepare(
          "SELECT title FROM plan_tasks WHERE plan_id = ? AND status = 'ready' ORDER BY task_order LIMIT 5"
        ).all(plan.id);
        for (const t of readyTasks) {
          readyTaskNames.push(t.title);
        }
      }
    }

    // Recent completions (24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentCompleted = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE status = 'completed' AND completed_at > ?"
    ).get(oneDayAgo);
    const recentPRs = db.prepare(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE pr_merged = 1 AND completed_at > ?"
    ).get(oneDayAgo);

    db.close();

    const briefing = [
      `[PLAN BRIEFING]`,
      `Active plans: ${plans.length} of ${totalPlans.count}`,
      ...lines,
    ];

    if (recentCompleted.count > 0 || recentPRs.count > 0) {
      briefing.push(`Recent: ${recentCompleted.count} tasks completed (24h) | ${recentPRs.count} PRs merged`);
    }

    if (readyTaskNames.length > 0) {
      briefing.push(`Ready to spawn: ${readyTaskNames.join(', ')}`);
    }

    return briefing.join('\n');
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  // Skip spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  await readStdin();

  const result = getPlanBriefing();
  const briefing = typeof result === 'string' ? result : null;

  if (briefing) {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[plan-briefing] ${briefing.split('\n').length} plan lines injected`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: briefing,
      },
    }));
  } else if (result && result.error) {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[plan-briefing] Error: ${result.error}`,
    }));
  } else {
    console.log(JSON.stringify({ continue: true }));
  }

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
