#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Workstream Notifier
 *
 * Fires on every CTO prompt in interactive sessions. Checks for new workstream
 * changes since the last check and injects a summary into the model context,
 * so the deputy-CTO stays aware of dependency additions, satisfactions, and
 * assessment results as they happen.
 *
 * Only runs for interactive (non-spawned) sessions. Workstream changes are
 * written by the workstream-manager agent via the workstream MCP server.
 *
 * Input: JSON on stdin from Claude Code UserPromptSubmit event
 * Output: JSON on stdout with continue + optional additionalContext
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LAST_CHECK_FILE = path.join(STATE_DIR, 'workstream-notifier-last-check.json');
const WS_DB_PATH = path.join(STATE_DIR, 'workstream.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// ============================================================================
// State Management
// ============================================================================

function readLastCheck() {
  try {
    if (fs.existsSync(LAST_CHECK_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
      return data.last_check || null;
    }
  } catch (err) {
    // Non-fatal
  }
  return null;
}

function writeLastCheck(timestamp) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ last_check: timestamp }, null, 2) + '\n');
  } catch (err) {
    // Non-fatal
  }
}

// ============================================================================
// Time Formatting
// ============================================================================

function formatTimeAgo(isoTimestamp) {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

// ============================================================================
// Task Title Lookup
// ============================================================================

/**
 * Look up task titles from todo.db for display in the notification.
 * Returns a Map<taskId, title>.
 */
function loadTaskTitles(taskIds) {
  const titles = new Map();
  if (!taskIds.length || !fs.existsSync(TODO_DB_PATH)) return titles;
  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    for (const id of taskIds) {
      try {
        const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(id);
        if (row?.title) titles.set(id, row.title);
      } catch (err) {
        // Non-fatal per-task lookup failure
      }
    }
    db.close();
  } catch (err) {
    // Non-fatal
  }
  return titles;
}

// ============================================================================
// Workstream Change Formatting
// ============================================================================

function formatChange(change, titles) {
  const timeAgo = formatTimeAgo(change.created_at);

  function getTitle(taskId) {
    return taskId ? (titles.get(taskId) || taskId) : '(unknown)';
  }

  // Parse the details JSON for structured change data
  let details = {};
  try {
    if (change.details) details = JSON.parse(change.details);
  } catch (err) {
    // Ignore — use empty details
  }

  switch (change.change_type) {
    case 'dependency_added': {
      const blocked = getTitle(details.blocked_task_id || change.task_id);
      const blocker = getTitle(details.blocker_task_id);
      return `[DEP ADDED] "${blocked}" blocked by "${blocker}"\n   Reason: "${change.reasoning}"\n   (${timeAgo})`;
    }
    case 'dependency_removed': {
      const taskTitle = getTitle(change.task_id);
      return `[DEP REMOVED] Dependency removed for "${taskTitle}"\n   Reason: "${change.reasoning}"\n   (${timeAgo})`;
    }
    case 'dependency_satisfied': {
      const blocked = getTitle(details.blocked_task_id || change.task_id);
      const blocker = getTitle(details.blocker_task_id);
      return `[DEP SATISFIED] "${blocked}" unblocked (blocker "${blocker}" completed)\n   (${timeAgo})`;
    }
    case 'priority_changed': {
      const taskTitle = getTitle(change.task_id);
      const oldPriority = details.old_priority || '?';
      const newPriority = details.new_priority || '?';
      return `[PRIORITY] "${taskTitle}" reordered ${oldPriority} → ${newPriority}\n   Reason: "${change.reasoning}"\n   (${timeAgo})`;
    }
    case 'assessment_clear': {
      const taskTitle = getTitle(change.task_id);
      return `[ASSESSMENT] "${taskTitle}" — cleared for concurrent execution\n   Reason: "${change.reasoning}"\n   (${timeAgo})`;
    }
    default: {
      const taskTitle = getTitle(change.task_id);
      return `[${change.change_type.toUpperCase()}] task "${taskTitle}"\n   Reason: "${change.reasoning}"\n   (${timeAgo})`;
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Only for interactive (non-spawned) sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // If workstream.db doesn't exist, no workstream activity yet — skip
  if (!fs.existsSync(WS_DB_PATH)) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  const now = new Date().toISOString();
  const lastCheck = readLastCheck();

  // Update last check timestamp before reading (ensures we always advance)
  writeLastCheck(now);

  // Query workstream_changes since last check
  let changes = [];
  try {
    const db = new Database(WS_DB_PATH, { readonly: true });

    let query;
    let params;
    if (lastCheck) {
      query = "SELECT * FROM workstream_changes WHERE created_at > ? ORDER BY created_at DESC LIMIT 10";
      params = [lastCheck];
    } else {
      // First run — grab recent changes from the last 5 minutes to avoid flooding
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      query = "SELECT * FROM workstream_changes WHERE created_at > ? ORDER BY created_at DESC LIMIT 10";
      params = [fiveMinutesAgo];
    }

    changes = db.prepare(query).all(...params);
    db.close();
  } catch (err) {
    // Non-fatal — workstream_changes table may not exist yet
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  if (!changes || changes.length === 0) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Collect all task IDs for title lookup
  const allTaskIds = new Set();
  for (const change of changes) {
    if (change.task_id) allTaskIds.add(change.task_id);
    // Parse details for additional task IDs
    try {
      const details = JSON.parse(change.details || '{}');
      if (details.blocked_task_id) allTaskIds.add(details.blocked_task_id);
      if (details.blocker_task_id) allTaskIds.add(details.blocker_task_id);
    } catch (err) {
      // Ignore
    }
  }
  const titles = loadTaskTitles([...allTaskIds]);

  // Build summary
  const lines = [
    `[WORKSTREAM UPDATES]`,
    `${changes.length} workstream change${changes.length !== 1 ? 's' : ''} since your last prompt:`,
    '',
  ];

  changes.forEach((change, i) => {
    lines.push(`${i + 1}. ${formatChange(change, titles)}`);
  });

  lines.push(
    '',
    `Review: mcp__workstream__get_change_log({ limit: 10 })`,
    `Dependencies: mcp__workstream__list_dependencies()`,
  );

  const additionalContext = lines.join('\n');

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ continue: true }));
});
