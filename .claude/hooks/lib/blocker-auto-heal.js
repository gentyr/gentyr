/**
 * Blocker Auto-Heal — Self-Healing Orchestrator
 *
 * Decision tree for handling persistent monitor failures:
 *   rate_limit + transient → cooldown (handled by caller)
 *   auth_error → spawn credential-diagnosis task or escalate
 *   crash/infra → spawn investigation task or escalate
 *   fix_attempts >= max → escalate to CTO (submit_bypass_request)
 *
 * Follows the demo-failure-spawner.js pattern for dedup and escalation.
 *
 * IMPORTANT: This module must NOT import session-queue.js (circular dep).
 * It operates on persistent-tasks.db and todo.db directly via better-sqlite3.
 *
 * @module lib/blocker-auto-heal
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getCooldown } from '../config-reader.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'blocker-auto-heal.log');

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) { /* non-fatal */ }

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [blocker-auto-heal] ${message}\n`;
  // No stderr — this module may be imported in SessionStart hook chains
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* non-fatal */ }
}

function generateId() {
  return 'bheal-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Check if a fix task is already in-flight for this persistent task.
 * @param {string} persistentTaskId
 * @returns {boolean}
 */
function isFixInFlight(persistentTaskId) {
  if (!Database) return false;

  // Check 1: blocker_diagnosis status
  try {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      const ptDb = new Database(ptDbPath, { readonly: true });
      ptDb.pragma('busy_timeout = 3000');
      const tableExists = ptDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
      if (tableExists) {
        const active = ptDb.prepare(
          "SELECT id FROM blocker_diagnosis WHERE persistent_task_id = ? AND status = 'fix_in_progress' AND fix_attempts < max_fix_attempts LIMIT 1"
        ).get(persistentTaskId);
        ptDb.close();
        if (active) return true;
      } else {
        ptDb.close();
      }
    }
  } catch (_) { /* non-fatal */ }

  // Check 2: todo-db for self-heal tasks
  try {
    const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
    if (fs.existsSync(todoDbPath)) {
      const todoDb = new Database(todoDbPath, { readonly: true });
      todoDb.pragma('busy_timeout = 3000');
      const pending = todoDb.prepare(
        "SELECT id FROM tasks WHERE persistent_task_id = ? AND assigned_by = 'self-heal-system' AND status IN ('pending', 'in_progress') LIMIT 1"
      ).get(persistentTaskId);
      todoDb.close();
      if (pending) return true;
    }
  } catch (_) { /* non-fatal */ }

  return false;
}

/**
 * Get or create a blocker_diagnosis record for this persistent task + error type.
 * Returns the existing record if one matches (same task + error_type + active/fix_in_progress status).
 * @param {string} persistentTaskId
 * @param {object} diagnosis
 * @returns {object|null}
 */
function getOrCreateDiagnosis(persistentTaskId, diagnosis) {
  if (!Database) return null;

  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) return null;

  let ptDb;
  try {
    ptDb = new Database(ptDbPath);
    ptDb.pragma('busy_timeout = 3000');
  } catch (_) { return null; }

  try {
    // Check if blocker_diagnosis table exists
    const tableExists = ptDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
    if (!tableExists) {
      ptDb.close();
      return null;
    }

    // Look for existing diagnosis with same error type (any non-resolved status)
    const existing = ptDb.prepare(
      "SELECT * FROM blocker_diagnosis WHERE persistent_task_id = ? AND error_type = ? AND status IN ('active', 'fix_in_progress', 'escalated') LIMIT 1"
    ).get(persistentTaskId, diagnosis.error_type);

    if (existing) {
      ptDb.close();
      return existing;
    }

    // Create new diagnosis record
    const maxAttempts = getCooldown('self_heal_max_fix_attempts', 3);
    const id = generateId();
    ptDb.prepare(
      "INSERT INTO blocker_diagnosis (id, persistent_task_id, error_type, is_transient, diagnosis_details, max_fix_attempts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)"
    ).run(id, persistentTaskId, diagnosis.error_type, diagnosis.is_transient ? 1 : 0, JSON.stringify(diagnosis), maxAttempts, new Date().toISOString());

    const created = ptDb.prepare("SELECT * FROM blocker_diagnosis WHERE id = ?").get(id);
    ptDb.close();
    return created;
  } catch (e) {
    try { ptDb.close(); } catch (_) { /* non-fatal */ }
    log(`Failed to get/create diagnosis: ${e.message}`);
    return null;
  }
}

/**
 * Build a fix task description based on the error type.
 * @param {string} persistentTaskId
 * @param {object} diagnosis
 * @param {object} diagRecord
 * @returns {string}
 */
function buildFixTaskDescription(persistentTaskId, diagnosis, diagRecord) {
  const base = `## Self-Healing Investigation\n\nPersistent task \`${persistentTaskId}\` has failed ${diagRecord.fix_attempts + 1} time(s) with error type: **${diagnosis.error_type}**.\n\n`;

  const errorContext = diagnosis.sample_error
    ? `### Error Details\n\`\`\`\n${diagnosis.sample_error}\n\`\`\`\n\n`
    : '';

  let instructions = '';
  switch (diagnosis.error_type) {
    case 'auth_error':
      instructions = `### Investigation Steps
1. Check if MCP servers are loading correctly in agent sessions (check mcp-daemon health: \`curl -sf http://localhost:18090/health\`)
2. Verify 1Password connectivity (\`op whoami\`)
3. Check for expired tokens or revoked credentials
4. Review the persistent task's recent session JSONL for specific error messages
5. If credentials are expired, use \`op_vault_map\` + \`populate_secrets_local\` to refresh
6. Report findings via \`report_to_deputy_cto\``;
      break;
    case 'crash':
      instructions = `### Investigation Steps
1. Check the persistent task's child tasks for failures (\`list_tasks\` with persistent_task_id filter)
2. Read recent session JSONL tails for crash details
3. Check system resource usage (memory pressure, disk space)
4. Look for infrastructure issues (MCP daemon health, worktree state)
5. If the crash is in application code, create a fix task with specific file/line context
6. Report findings via \`report_to_deputy_cto\``;
      break;
    case 'timeout':
      instructions = `### Investigation Steps
1. Check child tasks for stalls (\`list_tasks\` with persistent_task_id filter)
2. Check for resource contention (display lock queue, session concurrency)
3. Review worktree state for abandoned or stuck processes
4. Check if any child task is waiting on a missing prerequisite
5. Report findings via \`report_to_deputy_cto\``;
      break;
    default:
      instructions = `### Investigation Steps
1. Check the persistent task state (\`get_persistent_task\`)
2. Review child task statuses (\`list_tasks\` with persistent_task_id filter)
3. Check system health (MCP daemon, session queue, memory pressure)
4. Report findings via \`report_to_deputy_cto\``;
  }

  const priorAttempts = diagRecord.fix_attempts > 0
    ? `\n### Prior Fix Attempts\nThis is attempt #${diagRecord.fix_attempts + 1} of ${diagRecord.max_fix_attempts}. Previous fix task IDs: ${diagRecord.fix_task_ids || 'none'}. Do NOT re-investigate the same hypotheses — try a different approach.\n`
    : '';

  return base + errorContext + instructions + priorAttempts;
}

/**
 * Spawn a fix task in todo-db.
 * Returns the task ID or null on failure.
 * @param {string} persistentTaskId
 * @param {object} diagnosis
 * @param {object} diagRecord
 * @returns {string|null}
 */
function spawnFixTask(persistentTaskId, diagnosis, diagRecord) {
  if (!Database) return null;

  const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) return null;

  let todoDb;
  try {
    todoDb = new Database(todoDbPath);
    todoDb.pragma('busy_timeout = 3000');

    // Resolve deep-investigation category ID
    let categoryId = null;
    try {
      const cat = todoDb.prepare("SELECT id FROM task_categories WHERE name = 'Deep Investigation' OR deprecated_section = 'INVESTIGATOR & PLANNER' LIMIT 1").get();
      categoryId = cat?.id || null;
    } catch (_) { /* non-fatal — will use section fallback */ }

    const taskId = generateId();
    const now = new Date();
    const title = `Self-heal: ${diagnosis.error_type} blocker for persistent task`;
    const description = buildFixTaskDescription(persistentTaskId, diagnosis, diagRecord);

    // Build the INSERT statement dynamically based on whether we have a category_id
    const columns = 'id, section, status, title, description, assigned_by, created_at, created_timestamp, priority, persistent_task_id' + (categoryId ? ', category_id' : '');
    const placeholders = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?' + (categoryId ? ', ?' : '');
    const values = [
      taskId, 'INVESTIGATOR & PLANNER', 'pending', title, description, 'self-heal-system',
      now.toISOString(), Math.floor(now.getTime() / 1000), 'urgent', persistentTaskId,
    ];
    if (categoryId) values.push(categoryId);

    todoDb.prepare(`INSERT INTO tasks (${columns}) VALUES (${placeholders})`).run(...values);
    todoDb.close();

    // Update blocker_diagnosis with fix task info
    try {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        const existingIds = diagRecord.fix_task_ids ? JSON.parse(diagRecord.fix_task_ids) : [];
        existingIds.push(taskId);
        ptDb.prepare(
          "UPDATE blocker_diagnosis SET status = 'fix_in_progress', fix_attempts = fix_attempts + 1, fix_task_ids = ? WHERE id = ?"
        ).run(JSON.stringify(existingIds), diagRecord.id);
        ptDb.close();
      }
    } catch (_) { /* non-fatal */ }

    log(`Spawned fix task ${taskId} for persistent task ${persistentTaskId} (error: ${diagnosis.error_type}, attempt: ${diagRecord.fix_attempts + 1})`);
    return taskId;
  } catch (e) {
    try { if (todoDb) todoDb.close(); } catch (_) { /* non-fatal */ }
    log(`Failed to spawn fix task: ${e.message}`);
    return null;
  }
}

/**
 * Escalate to CTO via bypass request and pause the persistent task.
 * @param {string} persistentTaskId
 * @param {object} diagnosis
 * @param {object} diagRecord
 */
function escalateToCto(persistentTaskId, diagnosis, diagRecord) {
  if (!Database) return;

  // Update blocker_diagnosis to escalated
  try {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      const ptDb = new Database(ptDbPath);
      ptDb.pragma('busy_timeout = 3000');
      const tableExists = ptDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
      if (tableExists) {
        ptDb.prepare("UPDATE blocker_diagnosis SET status = 'escalated' WHERE id = ?").run(diagRecord.id);
      }
      ptDb.close();
    }
  } catch (_) { /* non-fatal */ }

  // Submit bypass request
  const bypassDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(bypassDbPath)) {
    log(`Cannot escalate: bypass-requests.db not found at ${bypassDbPath}`);
    return;
  }

  let bypassDb;
  try {
    bypassDb = new Database(bypassDbPath);
    bypassDb.pragma('busy_timeout = 3000');

    // Dedup: check for existing pending request
    const existing = bypassDb.prepare(
      "SELECT id FROM bypass_requests WHERE task_type = 'persistent' AND task_id = ? AND status = 'pending' LIMIT 1"
    ).get(persistentTaskId);

    if (!existing) {
      // Fetch actual task title from persistent-tasks.db
      let taskTitle = `Persistent task ${persistentTaskId}`;
      try {
        const ptDbPath2 = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
        if (fs.existsSync(ptDbPath2)) {
          const ptDbRo = new Database(ptDbPath2, { readonly: true });
          ptDbRo.pragma('busy_timeout = 3000');
          const row = ptDbRo.prepare('SELECT title FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
          if (row?.title) taskTitle = row.title;
          ptDbRo.close();
        }
      } catch (_) { /* non-fatal — use generic title */ }

      const category = diagnosis.error_type === 'auth_error' ? 'infrastructure' : 'general';
      const summary = `Self-healing exhausted after ${diagRecord.fix_attempts} fix attempts for ${diagnosis.error_type}. ${diagnosis.sample_error || ''}`.slice(0, 500);
      bypassDb.prepare(`
        INSERT INTO bypass_requests (id, task_type, task_id, task_title, agent_id, category, summary, details, status, created_at)
        VALUES (?, 'persistent', ?, ?, 'self-heal-system', ?, ?, ?, 'pending', ?)
      `).run(
        generateId(),
        persistentTaskId,
        taskTitle,
        category,
        summary,
        JSON.stringify({ diagnosis, fix_attempts: diagRecord.fix_attempts, fix_task_ids: diagRecord.fix_task_ids }),
        new Date().toISOString()
      );
      log(`Escalated to CTO: persistent task ${persistentTaskId} after ${diagRecord.fix_attempts} fix attempts`);
    }

    bypassDb.close();
  } catch (e) {
    try { if (bypassDb) bypassDb.close(); } catch (_) { /* non-fatal */ }
    log(`Failed to submit bypass request: ${e.message}`);
  }

  // Pause the persistent task
  try {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      const ptDb = new Database(ptDbPath);
      ptDb.pragma('busy_timeout = 3000');
      ptDb.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'").run(persistentTaskId);
      try {
        ptDb.prepare(
          "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'paused', ?, ?)"
        ).run(generateId(), persistentTaskId, JSON.stringify({ reason: 'self_heal_exhausted', error_type: diagnosis.error_type }), new Date().toISOString());
      } catch (_) { /* non-fatal */ }
      ptDb.close();
    }
  } catch (e) {
    log(`Failed to pause persistent task: ${e.message}`);
  }
}

/**
 * Main decision entry point.
 * Called from requeueDeadPersistentMonitor() after rate-limit cooldown check.
 *
 * @param {string} taskId - persistent task ID
 * @param {object} diagnosis - structured diagnosis from diagnoseSessionFailure()
 * @returns {{ action: 'cooldown'|'fix_spawned'|'escalated'|'retry', fixTaskId?: string }}
 */
export function handleBlocker(taskId, diagnosis) {
  if (!diagnosis || !Database) return { action: 'retry' };

  // Rate limits handled by caller (Phase 2a)
  if (diagnosis.error_type === 'rate_limit' && diagnosis.is_transient) {
    return { action: 'cooldown' };
  }

  // Unknown/no errors — just retry
  if (diagnosis.error_type === 'unknown' || diagnosis.consecutive_errors === 0) {
    return { action: 'retry' };
  }

  // Check if fix is already in flight
  if (isFixInFlight(taskId)) {
    log(`Fix already in flight for ${taskId} — will retry (monitor will check fix status)`);
    return { action: 'retry' };
  }

  // Get or create diagnosis record
  const diagRecord = getOrCreateDiagnosis(taskId, diagnosis);
  if (!diagRecord) return { action: 'retry' };

  // After 3 immediate fix attempts, apply exponential backoff between attempts
  if (diagRecord.fix_attempts >= 3) {
    const baseMinutes = getCooldown('crash_backoff_base_minutes', 5);
    const maxMinutes = getCooldown('crash_backoff_max_minutes', 60);
    const backoffMinutes = Math.min(maxMinutes, baseMinutes * Math.pow(2, diagRecord.fix_attempts - 3));

    // Update blocker_diagnosis with cooldown
    try {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        const cooldownUntil = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
        ptDb.prepare("UPDATE blocker_diagnosis SET status = 'cooling_down', cooldown_until = ? WHERE id = ?")
          .run(cooldownUntil, diagRecord.id);
        ptDb.close();
      }
    } catch (_) { /* non-fatal */ }

    log(`Fix attempt ${diagRecord.fix_attempts} for ${taskId}: applying ${backoffMinutes}min backoff before next fix`);
    return { action: 'cooldown_then_fix' };
  }

  // Spawn fix task
  const fixTaskId = spawnFixTask(taskId, diagnosis, diagRecord);
  if (fixTaskId) {
    return { action: 'fix_spawned', fixTaskId };
  }

  // Fallback: couldn't spawn fix task, just retry
  return { action: 'retry' };
}
