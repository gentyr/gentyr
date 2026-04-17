#!/usr/bin/env node
/**
 * Plan Activation Spawner
 *
 * PostToolUse hook on mcp__plan-orchestrator__update_plan_status.
 * When a plan transitions to 'active' and has no persistent_task_id,
 * creates a persistent task for the plan-manager and enqueues it.
 *
 * This ensures plans always have an automated orchestrator driving
 * phase advancement — without this, plans stall after any phase
 * completes because nothing polls get_spawn_ready_tasks.
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
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const NOOP = JSON.stringify({});

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [plan-activation-spawner] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* non-fatal */ }
}

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

  // Extract tool response data (same multi-format parsing as persistent-task-spawner)
  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    process.stdout.write(NOOP);
    return;
  }

  let responseData = null;

  // Format 1: MCP content wrapper
  if (toolResponse && typeof toolResponse === 'object' && Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try { responseData = JSON.parse(block.text); break; } catch (_) {}
      }
    }
  }

  // Format 2: Bare content array
  if (!responseData && Array.isArray(toolResponse)) {
    for (const block of toolResponse) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try { responseData = JSON.parse(block.text); break; } catch (_) {}
      }
    }
  }

  // Format 3: Plain string
  if (!responseData && typeof toolResponse === 'string') {
    try { responseData = JSON.parse(toolResponse); } catch (_) {}
  }

  // Format 4: Plain object
  if (!responseData && toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
    responseData = toolResponse;
  }

  if (!responseData) {
    process.stdout.write(NOOP);
    return;
  }

  // Only fire when status transitioned to 'active'
  if (responseData.new_status !== 'active' || responseData.error) {
    process.stdout.write(NOOP);
    return;
  }

  const planId = responseData.plan_id;
  if (!planId) {
    process.stdout.write(NOOP);
    return;
  }

  // Lazy-load SQLite
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    log('better-sqlite3 not available — cannot spawn plan-manager');
    process.stdout.write(NOOP);
    return;
  }

  // Check if plan already has a persistent_task_id
  let planTitle;
  try {
    if (!fs.existsSync(PLANS_DB_PATH)) {
      process.stdout.write(NOOP);
      return;
    }

    const planDb = new Database(PLANS_DB_PATH, { readonly: true });
    planDb.pragma('busy_timeout = 3000');
    const plan = planDb.prepare('SELECT title, persistent_task_id FROM plans WHERE id = ?').get(planId);
    planDb.close();

    if (!plan) {
      log(`Plan ${planId} not found`);
      process.stdout.write(NOOP);
      return;
    }

    if (plan.persistent_task_id) {
      log(`Plan ${planId} already has persistent_task_id ${plan.persistent_task_id} — skipping`);
      process.stdout.write(NOOP);
      return;
    }

    planTitle = plan.title;
  } catch (err) {
    log(`Error reading plan: ${err.message}`);
    process.stdout.write(NOOP);
    return;
  }

  // Create persistent task for plan-manager
  const ptId = randomUUID();
  const now = new Date().toISOString();

  try {
    if (!fs.existsSync(PT_DB_PATH)) {
      log(`persistent-tasks.db not found at ${PT_DB_PATH} — cannot create plan-manager task`);
      process.stdout.write(JSON.stringify({
        additionalContext: `[PLAN ACTIVATION] Plan "${planTitle}" activated but persistent-tasks.db not found. No plan-manager spawned — plan phases will NOT auto-advance. Create a persistent task manually with plan_id=${planId}.`,
      }));
      return;
    }

    const ptDb = new Database(PT_DB_PATH);
    ptDb.pragma('journal_mode = WAL');
    ptDb.pragma('busy_timeout = 3000');

    // Ensure table exists (it should, but be safe)
    const tableCheck = ptDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='persistent_tasks'"
    ).get();
    if (!tableCheck) {
      ptDb.close();
      log('persistent_tasks table does not exist');
      process.stdout.write(NOOP);
      return;
    }

    const prompt = `You are a plan-manager for plan "${planTitle}" (ID: ${planId}). ` +
      `Follow the plan-manager agent instructions. Your plan ID is ${planId}. ` +
      `Your persistent task ID is ${ptId}. ` +
      `Check get_spawn_ready_tasks, create and activate persistent tasks for ready plan tasks, ` +
      `monitor their progress, and advance the plan through all phases until complete.`;

    const metadata = JSON.stringify({
      plan_id: planId,
      plan_title: planTitle,
    });

    // Insert the persistent task as 'active' (not draft — we're activating immediately)
    ptDb.prepare(
      `INSERT INTO persistent_tasks (id, title, prompt, outcome_criteria, status, metadata, created_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
    ).run(
      ptId,
      `Plan Manager: ${planTitle}`,
      prompt,
      `All phases of plan ${planId} are completed or skipped.`,
      metadata,
      now,
      now,
    );

    // Record activation event
    ptDb.prepare(
      "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'activated', ?, ?)"
    ).run(randomUUID(), ptId, JSON.stringify({ source: 'plan-activation-spawner', plan_id: planId }), now);

    ptDb.close();
    log(`Created persistent task ${ptId} for plan ${planId}`);
  } catch (err) {
    log(`Error creating persistent task: ${err.message}`);
    process.stdout.write(JSON.stringify({
      additionalContext: `[PLAN ACTIVATION] Failed to create plan-manager persistent task: ${err.message}. Plan phases will NOT auto-advance.`,
    }));
    return;
  }

  // Atomically link persistent task to plan (TOCTOU-safe: only succeeds if still NULL)
  let linked = false;
  try {
    const planDb = new Database(PLANS_DB_PATH);
    planDb.pragma('journal_mode = WAL');
    planDb.pragma('busy_timeout = 3000');
    const result = planDb.prepare(
      'UPDATE plans SET persistent_task_id = ?, updated_at = ? WHERE id = ? AND persistent_task_id IS NULL'
    ).run(ptId, now, planId);

    if (result.changes === 0) {
      // Another hook instance won the race — clean up our orphaned persistent task
      planDb.close();
      log(`Plan ${planId} was already claimed by another hook instance — cleaning up orphaned persistent task ${ptId}`);
      try {
        const ptDb2 = new Database(PT_DB_PATH);
        ptDb2.pragma('busy_timeout = 3000');
        ptDb2.prepare("DELETE FROM persistent_tasks WHERE id = ?").run(ptId);
        ptDb2.prepare("DELETE FROM events WHERE persistent_task_id = ?").run(ptId);
        ptDb2.close();
      } catch (_) { /* non-fatal — orphaned task is harmless in paused/active state */ }
      process.stdout.write(NOOP);
      return;
    }

    // Record state change
    planDb.prepare(
      "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'persistent_task_id', NULL, ?, ?, 'plan-activation-spawner')"
    ).run(randomUUID(), planId, ptId, now);

    planDb.close();
    linked = true;
    log(`Linked persistent task ${ptId} to plan ${planId}`);
  } catch (err) {
    log(`Error linking persistent task to plan: ${err.message}`);
    // Non-fatal — the persistent task exists, it just won't be linked
  }

  // Enqueue the plan-manager monitor session
  try {
    const { enqueueSession } = await import('./lib/session-queue.js');

    const monitorPrompt = [
      `[Automation][persistent-monitor][plan-manager] You are the plan-manager for plan "${planTitle}" (ID: ${planId}).`,
      `Your persistent task ID is ${ptId}.`,
      '',
      `Follow the plan-manager agent instructions in your agent definition.`,
      `Your job: poll get_spawn_ready_tasks, create persistent tasks for ready plan steps,`,
      `monitor them, and advance the plan until all phases complete.`,
      '',
      `Environment: GENTYR_PLAN_MANAGER=true, GENTYR_PLAN_ID=${planId}, GENTYR_PERSISTENT_TASK_ID=${ptId}`,
    ].join('\n');

    const result = enqueueSession({
      title: `[Plan Manager] ${planTitle}`,
      agentType: 'persistent-task-monitor',
      hookType: 'persistent-task-monitor',
      tagContext: 'plan-manager',
      source: 'plan-activation-spawner',
      priority: 'critical',
      lane: 'persistent',
      ttlMs: 0,
      prompt: monitorPrompt,
      projectDir: PROJECT_DIR,
      extraEnv: {
        GENTYR_PLAN_MANAGER: 'true',
        GENTYR_PLAN_ID: planId,
        GENTYR_PERSISTENT_TASK_ID: ptId,
        GENTYR_PERSISTENT_MONITOR: 'true',
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
      },
      metadata: {
        persistentTaskId: ptId,
        planId,
      },
    });

    if (result.blocked) {
      log(`Plan-manager enqueue blocked: ${result.blocked}`);
      process.stdout.write(JSON.stringify({
        additionalContext: `[PLAN ACTIVATION] Plan "${planTitle}" activated. Persistent task ${ptId} created but monitor enqueue was blocked (${result.blocked}). The plan-manager will start when the block clears.`,
      }));
      return;
    }

    log(`Plan-manager monitor enqueued: queueId=${result.queueId}, planId=${planId}, ptId=${ptId}`);

    try {
      const { auditEvent } = await import('./lib/session-audit.js');
      auditEvent('plan_manager_spawned', { plan_id: planId, persistent_task_id: ptId, queue_id: result.queueId, plan_title: planTitle });
    } catch (_) { /* non-fatal */ }

    process.stdout.write(JSON.stringify({
      additionalContext: `[PLAN ACTIVATION] Plan "${planTitle}" activated with plan-manager persistent task ${ptId}. Monitor enqueued (queueId: ${result.queueId}). The plan-manager will automatically advance phases as they complete.`,
    }));
  } catch (err) {
    log(`Error enqueuing plan-manager: ${err.message}`);
    process.stdout.write(JSON.stringify({
      additionalContext: `[PLAN ACTIVATION] Persistent task ${ptId} created for plan "${planTitle}" but failed to enqueue monitor: ${err.message}. Resume manually with: mcp__persistent-task__resume_persistent_task({ id: "${ptId}" })`,
    }));
  }
}

main().catch((err) => {
  try { log(`Unhandled error: ${err.message}`); } catch (_) {}
  process.stdout.write(NOOP);
});
