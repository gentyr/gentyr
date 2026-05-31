#!/usr/bin/env node
/**
 * Quota Crash Detector
 *
 * Inspects a dead session's JSONL tail for the "You've hit your limit · resets ..."
 * assistant message that Claude Code emits when an Anthropic account quota is
 * exhausted mid-session. Used by the session reaper to distinguish quota deaths
 * from ordinary crashes, so the linked persistent task can be paused (instead
 * of auto-revived into the same wall) and the CTO can be notified.
 *
 * The match is intentionally permissive — we want to catch any phrasing that
 * resembles the quota-exhausted message rather than miss a real exhaustion
 * because the wording shifted slightly between Claude Code versions.
 *
 * Detection is read-only and side-effect-free. The reaper decides what to do
 * with the result.
 *
 * Both exported functions are synchronous so they can be called from
 * `reapSyncPass()` without restructuring the synchronous reaper into async.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // SQLite unavailable — detection still works, side effects are skipped.
}

const TAIL_LINES = 50;
const QUOTA_PATTERNS = [
  /you'?ve hit your limit/i,
  /\bresets\b.{0,80}\b(am|pm|utc|gmt|[a-z]+\/[a-z_]+)\b/i,
  /usage limit reached/i,
  /quota (?:exhausted|exceeded)/i,
];
const RESET_TIME_PATTERN = /resets\s+(.{1,80}?)(?:\.|\n|$)/i;

/**
 * Read the last N lines of a file without loading the whole thing into memory.
 * Returns an array of lines, oldest first. Skips empty lines.
 * @param {string} filePath
 * @param {number} maxLines
 * @returns {string[]}
 */
function readTailLines(filePath, maxLines = TAIL_LINES) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];
    // Read up to last 256KB. JSONL message lines are typically <2KB so this
    // comfortably covers 50+ messages without paging huge files.
    const readSize = Math.min(stat.size, 256 * 1024);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Extract the visible text of an assistant message from a JSONL line.
 * Handles both string content and content-array shapes Claude Code emits.
 * Returns '' for non-assistant lines or unparseable lines.
 * @param {string} line
 * @returns {string}
 */
function assistantText(line) {
  try {
    const obj = JSON.parse(line);
    const msg = obj.message || obj;
    const role = msg.role || obj.type;
    if (role !== 'assistant') return '';
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Detect a quota-exhaustion message in a session JSONL file.
 *
 * @param {string} jsonlPath - absolute path to the session JSONL
 * @returns {{ detected: true, rawText: string, resetHint: string|null, matchedPattern: string } | null}
 *   Returns null if no quota message is found, or if the file cannot be read.
 */
export function detectQuotaCrashInJsonl(jsonlPath) {
  if (!jsonlPath) return null;
  const lines = readTailLines(jsonlPath, TAIL_LINES);
  if (lines.length === 0) return null;

  // Scan newest-to-oldest so we report the most recent quota error if multiple appear.
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = assistantText(lines[i]);
    if (!text) continue;
    for (const pat of QUOTA_PATTERNS) {
      if (pat.test(text)) {
        const resetMatch = text.match(RESET_TIME_PATTERN);
        const resetHint = resetMatch ? resetMatch[1].trim() : null;
        return {
          detected: true,
          rawText: text.slice(0, 500),
          resetHint,
          matchedPattern: pat.source,
        };
      }
    }
  }
  return null;
}

/**
 * Side-effect handler for a confirmed quota crash on a reaped session.
 *
 * - Pauses the linked persistent task with `do_not_auto_resume: true` and a
 *   `pause_reason: 'quota_exhaustion'` marker, so `requeueDeadPersistentMonitor`
 *   and `persistent_stale_pause_resume` both skip it. The quota-recovery-daemon
 *   re-activates these tasks directly once the quota window clears.
 *
 * Safe to call repeatedly — the pause is idempotent. All DB writes are
 * best-effort; failures log but do not throw, because the reaper must continue
 * regardless.
 *
 * SYNCHRONOUS — callable from `reapSyncPass()` without async restructuring.
 *
 * @param {object} params
 * @param {object} params.detection - return value from detectQuotaCrashInJsonl
 * @param {object} params.metadata - parsed queue_items.metadata for the dead session
 * @param {string} params.agentId - the dead session's agent id
 * @param {string} params.projectDir - absolute project dir for DB paths
 * @param {function} [params.log] - optional logger (msg) => void
 * @returns {{ paused_persistent?: string, error?: string }}
 */
export function handleQuotaCrashOnReap({ detection, metadata, agentId, projectDir, log }) {
  const logger = log || (() => {});
  const out = {};
  if (!detection || !detection.detected) return out;
  if (!metadata) return out;
  if (!Database) {
    logger('quota-detector: better-sqlite3 unavailable — skipping side effects');
    return { error: 'sqlite_unavailable' };
  }

  const taskId = metadata.taskId || metadata.persistentTaskId || null;
  if (!taskId) return out;

  const taskType = metadata.taskType === 'persistent' || metadata.persistentTaskId ? 'persistent' : 'todo';

  // Pause the persistent task (if applicable). The quota-recovery-daemon
  // re-activates quota-paused tasks directly once the quota window clears.
  if (taskType === 'persistent') {
    const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      let ptDb;
      try {
        ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        const row = ptDb.prepare('SELECT id, status, metadata FROM persistent_tasks WHERE id = ?').get(taskId);
        if (row && (row.status === 'active' || row.status === 'draft')) {
          let meta = {};
          try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
          meta.pause_reason = 'quota_exhaustion';
          meta.do_not_auto_resume = true;
          meta.quota_reset_hint = detection.resetHint || null;
          meta.quota_detected_at = new Date().toISOString();

          // Update status AND insert a 'paused' event row atomically. Downstream
          // consumers (notably hourly-automation.js `persistent_stale_pause_resume`)
          // key auto-resume off the `events` table, not the `status` column —
          // without an event row the task is permanently quarantined from
          // auto-recovery after the quota window clears. INSERT mirrors
          // `recordEvent()` in packages/mcp-servers/src/persistent-task/server.ts.
          const tx = ptDb.transaction(() => {
            ptDb.prepare("UPDATE persistent_tasks SET status = 'paused', metadata = ? WHERE id = ?")
              .run(JSON.stringify(meta), taskId);
            ptDb.prepare(
              'INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)'
            ).run(
              crypto.randomUUID(),
              taskId,
              'paused',
              JSON.stringify({
                reason: 'quota_exhaustion',
                quota_reset_hint: detection.resetHint || null,
                quota_detected_at: meta.quota_detected_at,
              }),
              new Date().toISOString(),
            );
          });
          tx();

          out.paused_persistent = taskId;
          logger(`quota-detector: paused persistent task ${taskId} (reset hint: ${detection.resetHint || 'unknown'})`);
        }
      } catch (err) {
        logger(`quota-detector: persistent-task pause failed for ${taskId}: ${err.message}`);
      } finally {
        try { ptDb && ptDb.close(); } catch { /* best-effort */ }
      }
    }
  }

  return out;
}

// CLI mode for ad-hoc testing: node lib/quota-detector.js <jsonl-path>
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: quota-detector.js <jsonl-path>\n');
    process.exit(2);
  }
  const result = detectQuotaCrashInJsonl(target);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
