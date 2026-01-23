#!/usr/bin/env node

/**
 * TODO Database Maintenance Script for Claude Code Hooks
 *
 * This script maintains the SQLite todo.db by:
 * 1. Clearing stale "in_progress" tasks (>30 min without completion)
 * 2. Removing completed tasks older than 3 hours
 * 3. Capping completed tasks at 50 (removes oldest)
 * 4. Spawning Claude to process pending tasks when threshold is met
 *
 * Exit codes:
 * - 0: Success (stdout provides summary)
 * - 1: Script error (non-blocking warning)
 *
 * Usage:
 *   node todo-maintenance.js cleanup      # Full cleanup (for SessionStart/UserPromptSubmit)
 *
 * @version 2.0.0 - Database-only version for x_test
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';

// Try to import better-sqlite3 for database operations
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  // G001: Log warning when database module is unavailable
  console.error(`Warning: better-sqlite3 not available: ${err.message}`);
}

// Debug logging - writes to file since stdout is used for hook response
const DEBUG = process.env.DEBUG_TODO_MAINTENANCE === 'true';
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'hooks', 'todo-maintenance-debug.log');

function debugLog(message, data = null) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] ${message}`;
  if (data !== null) {
    logLine += '\n' + JSON.stringify(data, null, 2);
  }
  logLine += '\n---\n';
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, logLine);
  } catch (err) {
    // Ignore write errors
  }
}

// Configuration
const CONFIG = {
  STALE_STARTED_MINUTES: 30,      // Clear start time after 30 minutes without completion
  COMPLETED_RETENTION_HOURS: 3,   // Remove completed tasks after 3 hours from completion
  MAX_COMPLETED_TASKS: 50,        // Maximum completed tasks to keep (removes oldest beyond this)
  STATE_FILENAME: 'todo-maintenance-state.json',
  PENDING_THRESHOLD: 5,           // Spawn Claude when pending tasks >= this
  COOLDOWN_MINUTES: getCooldown('todo_maintenance', 15), // Dynamic from config
};

/**
 * Validate and resolve project directory path (G003)
 * @param {string} inputPath
 * @returns {string|null} Resolved absolute path or null if invalid
 */
function validateProjectDir(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return null;
  }

  // Resolve to absolute path
  const resolved = path.resolve(inputPath);

  // Basic validation: must be a directory that exists
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    // Directory doesn't exist - allow for new projects
  }

  // Reject paths with suspicious patterns (basic path traversal protection)
  if (resolved.includes('\0') || resolved.includes('..')) {
    return null;
  }

  return resolved;
}

// Valid task sections for x_test
const VALID_SECTIONS = ['TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER'];

/**
 * Perform cleanup on the TODO database
 * @param {string} projectDir
 * @param {Date} now
 * @returns {object|null} Cleanup results or null if database not available
 */
function performDatabaseCleanup(projectDir, now = new Date()) {
  if (!Database) {
    debugLog('Database module not available - skipping database cleanup');
    return null;
  }

  const dbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(dbPath)) {
    debugLog('Database file not found - skipping database cleanup', { dbPath });
    return null;
  }

  try {
    const db = new Database(dbPath);
    const nowTimestamp = Math.floor(now.getTime() / 1000);
    const changes = {
      staleStartsCleared: 0,
      completedRemoved: 0,
      completedCapped: 0
    };

    // Clear stale starts (>30 min without completion)
    const staleResult = db.prepare(`
      UPDATE tasks
      SET status = 'pending', started_at = NULL
      WHERE status = 'in_progress'
        AND started_at IS NOT NULL
        AND (? - created_timestamp) > 1800
    `).run(nowTimestamp);
    changes.staleStartsCleared = staleResult.changes;

    // Remove completed tasks older than 3 hours
    const oldResult = db.prepare(`
      DELETE FROM tasks
      WHERE status = 'completed'
        AND completed_timestamp IS NOT NULL
        AND (? - completed_timestamp) > 10800
    `).run(nowTimestamp);
    changes.completedRemoved = oldResult.changes;

    // Cap completed tasks at 50 (keep most recent)
    const completedCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get().count;
    if (completedCount > 50) {
      const toRemove = completedCount - 50;
      const capResult = db.prepare(`
        DELETE FROM tasks WHERE id IN (
          SELECT id FROM tasks
          WHERE status = 'completed'
          ORDER BY completed_timestamp ASC
          LIMIT ?
        )
      `).run(toRemove);
      changes.completedCapped = capResult.changes;
    }

    db.close();

    debugLog('Database cleanup complete', changes);
    return changes;
  } catch (err) {
    debugLog('Database cleanup error', { error: err.message });
    return null;
  }
}

/**
 * Get pending task count from database
 * @param {string} projectDir
 * @returns {number} Pending count or 0 if database not available
 */
function getDatabasePendingCount(projectDir) {
  if (!Database) return 0;

  const dbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(dbPath)) return 0;

  try {
    const db = new Database(dbPath);
    const result = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get();
    db.close();
    return result.count;
  } catch (err) {
    // G001: Log database errors instead of silently returning 0
    debugLog('getDatabasePendingCount error', { error: err.message });
    return 0;
  }
}

/**
 * Get task summary from database
 * @param {string} projectDir
 * @returns {object} Summary with pending, in_progress, completed counts
 */
function getDatabaseSummary(projectDir) {
  const summary = { pending: 0, in_progress: 0, completed: 0, total: 0 };

  if (!Database) return summary;

  const dbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(dbPath)) return summary;

  try {
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
    db.close();

    for (const row of rows) {
      summary[row.status] = row.count;
      summary.total += row.count;
    }
    return summary;
  } catch (err) {
    // G001: Log database errors instead of silently returning empty summary
    debugLog('getDatabaseSummary error', { error: err.message });
    return summary;
  }
}

/**
 * Get the path to the cooldown state file
 * @param {string} projectDir
 * @returns {string}
 */
function getStatePath(projectDir) {
  return path.join(projectDir, '.claude', 'hooks', CONFIG.STATE_FILENAME);
}

/**
 * Read the cooldown state from file
 * @param {string} statePath
 * @returns {object} { lastSpawnTime: number | null }
 */
function readCooldownState(statePath) {
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(content);
    return {
      lastSpawnTime: state.lastSpawnTime || null
    };
  } catch {
    // File doesn't exist or is invalid - return empty state
    return { lastSpawnTime: null };
  }
}

/**
 * Write the cooldown state to file
 * @param {string} statePath
 * @param {object} state
 */
function writeCooldownState(statePath, state) {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    // Non-fatal - just log and continue
    console.error(`Warning: Could not write cooldown state: ${err.message}`);
  }
}

/**
 * Check if we're within the cooldown period
 * @param {string} statePath
 * @param {Date} now
 * @returns {boolean} true if still in cooldown (should skip spawn)
 */
function isInCooldown(statePath, now = new Date()) {
  const state = readCooldownState(statePath);

  if (!state.lastSpawnTime) {
    return false; // Never spawned before
  }

  const lastSpawn = new Date(state.lastSpawnTime);
  const minutesSinceSpawn = (now - lastSpawn) / (1000 * 60);

  return minutesSinceSpawn < CONFIG.COOLDOWN_MINUTES;
}

/**
 * Record a spawn event in the cooldown state
 * @param {string} statePath
 * @param {Date} now
 */
function recordSpawn(statePath, now = new Date()) {
  writeCooldownState(statePath, {
    lastSpawnTime: now.toISOString()
  });
}

/**
 * Get the path to the prompt file
 * @param {string} projectDir
 * @returns {string}
 */
function getPromptPath(projectDir) {
  return path.join(projectDir, '.claude', 'hooks', 'todo-processing-prompt.md');
}

/**
 * Read the TODO processing prompt from file
 * @param {string} promptPath
 * @returns {string|null}
 */
function readPrompt(promptPath) {
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch (err) {
    console.error(`Warning: Could not read prompt file: ${err.message}`);
    return null;
  }
}

/**
 * Spawn Claude Code to process pending TODO items (fire and forget)
 * @param {string} projectDir
 * @param {number} pendingCount
 */
function spawnClaudeForTodoProcessing(projectDir, pendingCount) {
  // Read prompt from file
  const promptPath = getPromptPath(projectDir);
  const prompt = readPrompt(promptPath);

  if (!prompt) {
    console.error('Warning: No prompt file found, skipping Claude spawn');
    return false;
  }

  try {
    // Prefix with [Task][type] so CTO report can track task types
    const taggedPrompt = `[Task][todo-processing] ${prompt}`;

    // Register spawn with agent tracker
    registerSpawn({
      type: AGENT_TYPES.TODO_PROCESSING,
      hookType: HOOK_TYPES.TODO_MAINTENANCE,
      description: `Processing ${pendingCount} pending TODO items`,
      prompt: taggedPrompt,
      metadata: { pendingCount },
      projectDir
    });

    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '-p',
      taggedPrompt
    ], {
      detached: true,           // Don't tie to parent process
      stdio: 'ignore',          // Don't capture output (fire and forget)
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_SPAWNED_SESSION: 'true'  // Prevent chain reaction
      }
    });

    // Allow parent to exit independently
    claude.unref();

    return true;
  } catch (err) {
    console.error(`Warning: Failed to spawn Claude for TODO processing: ${err.message}`);
    return false;
  }
}

/**
 * Check if we should spawn Claude and do so if appropriate
 * @param {string} projectDir
 * @param {number} pendingCount
 * @param {Date} now
 * @returns {string|null} Message about what happened, or null if nothing
 */
function maybeSpawnClaude(projectDir, pendingCount, now = new Date()) {
  if (pendingCount < CONFIG.PENDING_THRESHOLD) {
    return null; // Not enough pending tasks
  }

  const statePath = getStatePath(projectDir);

  if (isInCooldown(statePath, now)) {
    const state = readCooldownState(statePath);
    const lastSpawn = new Date(state.lastSpawnTime);
    const minutesAgo = Math.round((now - lastSpawn) / (1000 * 60));
    return `Skipped Claude spawn (${pendingCount} pending): cooldown active (${minutesAgo}/${CONFIG.COOLDOWN_MINUTES} min)`;
  }

  // Spawn Claude
  const spawned = spawnClaudeForTodoProcessing(projectDir, pendingCount);

  if (spawned) {
    recordSpawn(statePath, now);
    return `Spawned Claude to process ${pendingCount} pending TODO items`;
  }

  return 'Failed to spawn Claude for TODO processing';
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'cleanup';

  debugLog('TODO maintenance hook triggered', { mode, args: process.argv });

  // CHAIN REACTION PREVENTION: If this is a spawned session, skip processing
  const isSpawnedSession = process.env.CLAUDE_SPAWNED_SESSION === 'true';

  debugLog('Environment check', {
    isSpawnedSession,
    CLAUDE_SPAWNED_SESSION: process.env.CLAUDE_SPAWNED_SESSION,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    cwd: process.cwd()
  });

  if (isSpawnedSession) {
    // Allow spawned sessions to run without triggering more spawns
    debugLog('Spawned session detected - skipping spawn logic');
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
      systemMessage: 'Spawned session - spawn logic skipped'
    }));
    process.exit(0);
  }

  // G003: Validate project directory
  const rawProjectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = validateProjectDir(rawProjectDir);

  if (!projectDir) {
    debugLog('Invalid project directory', { rawProjectDir });
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage: 'todo-maintenance: invalid project directory'
    }));
    process.exit(0);
  }

  // Run database cleanup
  const dbChanges = performDatabaseCleanup(projectDir);

  // Get summary
  const summary = getDatabaseSummary(projectDir);

  // Build changes summary
  const changesSummary = [];
  if (dbChanges) {
    if (dbChanges.staleStartsCleared > 0) {
      changesSummary.push(`${dbChanges.staleStartsCleared} stale starts cleared`);
    }
    if (dbChanges.completedRemoved > 0) {
      changesSummary.push(`${dbChanges.completedRemoved} old completed removed`);
    }
    if (dbChanges.completedCapped > 0) {
      changesSummary.push(`${dbChanges.completedCapped} completed capped`);
    }
  }

  // Check if we should spawn Claude (only if not a spawned session)
  let spawnMessage = null;
  if (mode === 'cleanup') {
    spawnMessage = maybeSpawnClaude(projectDir, summary.pending);
  }

  const message = changesSummary.length > 0
    ? `todo-db cleaned: ${changesSummary.join(', ')}. Tasks: ${summary.pending} pending, ${summary.in_progress} in-progress, ${summary.completed} completed`
    : `todo-db: ${summary.pending} pending, ${summary.in_progress} in-progress, ${summary.completed} completed`;

  // Append spawn message if present
  const fullMessage = spawnMessage ? `${message}. ${spawnMessage}` : message;

  // Output JSON for Claude Code hooks
  const output = {
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: fullMessage
    }
  };
  debugLog('Outputting cleanup response', output);
  console.log(JSON.stringify(output));

  process.exit(0);
}

// Run main
main().catch(err => {
  debugLog('Uncaught error in main', { error: err.message, stack: err.stack });
  console.error(`Script error: ${err.message}`);
  process.exit(1);
});
