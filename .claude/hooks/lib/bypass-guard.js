/**
 * CTO Bypass Request Guard
 *
 * Shared module that checks whether a task has a pending CTO bypass request
 * that blocks revival/spawning. Called from every revival path to ensure
 * bypassed tasks are not revived until the CTO resolves the request.
 *
 * @module lib/bypass-guard
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // SQLite unavailable — all checks return unblocked
}

/**
 * Check if a task has a pending CTO bypass request that blocks revival.
 *
 * @param {string} taskType - 'persistent' or 'todo'
 * @param {string} taskId - Task ID to check
 * @returns {{ blocked: boolean, requestId?: string, summary?: string, category?: string }}
 */
export function checkBypassBlock(taskType, taskId) {
  if (!Database || !taskType || !taskId) return { blocked: false };
  if (!fs.existsSync(BYPASS_DB_PATH)) return { blocked: false };

  let db;
  try {
    db = new Database(BYPASS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');

    const request = db.prepare(
      "SELECT id, summary, category, auto_resume_at FROM bypass_requests WHERE task_type = ? AND task_id = ? AND status = 'pending' LIMIT 1"
    ).get(taskType, taskId);

    if (!request) return { blocked: false };
    return {
      blocked: true,
      requestId: request.id,
      summary: request.summary,
      category: request.category,
      ...(request.auto_resume_at ? { auto_resume_at: request.auto_resume_at } : {}),
    };
  } catch (_) {
    // On any error, fail open (don't block revival)
    return { blocked: false };
  } finally {
    try { db?.close(); } catch (_) { /* best-effort */ }
  }
}

/**
 * Get resolved bypass request context for injection into revival prompts.
 * Returns the most recent resolved (approved/rejected) request for a task.
 *
 * @param {string} taskType - 'persistent' or 'todo'
 * @param {string} taskId - Task ID to check
 * @returns {{ decision: string, context: string, requestId: string, category: string, summary: string } | null}
 */
export function getBypassResolutionContext(taskType, taskId) {
  if (!Database || !taskType || !taskId) return null;
  if (!fs.existsSync(BYPASS_DB_PATH)) return null;

  let db;
  try {
    db = new Database(BYPASS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');

    const request = db.prepare(
      "SELECT id, status, resolution_context, category, summary FROM bypass_requests WHERE task_type = ? AND task_id = ? AND status IN ('approved', 'rejected') ORDER BY resolved_at DESC LIMIT 1"
    ).get(taskType, taskId);

    if (!request) return null;
    return {
      decision: request.status,
      context: request.resolution_context || '',
      requestId: request.id,
      category: request.category,
      summary: request.summary,
    };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* best-effort */ }
  }
}
