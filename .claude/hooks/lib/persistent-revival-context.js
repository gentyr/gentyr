/**
 * Persistent Revival Context Builder
 *
 * Assembles a structured revival context block for persistent monitor sessions
 * being revived after their previous session died. Reads from:
 *   - persistent-tasks.db: last_summary, amendments
 *   - todo.db: sub-task status
 *   - ~/.claude/projects/<encoded>/: session JSONL files for compaction context
 *
 * All reads are wrapped in try/catch and degrade gracefully to empty strings.
 * This module is READ-ONLY and never writes to any database.
 *
 * @module lib/persistent-revival-context
 * @version 1.0.0
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Build revival context for a persistent monitor being revived.
 * Read-only — all reads wrapped in try/catch, degrades to empty string.
 *
 * @param {string} taskId - persistent task ID
 * @param {string} projectDir - project directory
 * @param {object} [options]
 * @param {string} [options.monitorSessionId] - previous monitor session ID (for compaction context)
 * @returns {string} formatted context block
 */
export function buildRevivalContext(taskId, projectDir, options = {}) {
  const sections = [];

  try {
    const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
    if (!fs.existsSync(ptDbPath)) return '';

    const db = new Database(ptDbPath, { readonly: true });

    // 1. Last summary
    try {
      const task = db.prepare("SELECT last_summary, cycle_count, activated_at FROM persistent_tasks WHERE id = ?").get(taskId);
      if (task?.last_summary) {
        sections.push(`### Last Monitor State\n${task.last_summary}`);
      }
    } catch (_) { /* non-fatal */ }

    // 2. Recent amendments (last 5 only, reversed to chronological)
    try {
      const totalCount = db.prepare("SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ?").get(taskId)?.cnt || 0;
      const amendments = db.prepare(
        "SELECT content, amendment_type, created_at FROM amendments WHERE persistent_task_id = ? ORDER BY created_at DESC LIMIT 5"
      ).all(taskId).reverse();
      if (amendments.length > 0) {
        const header = totalCount > 5 ? `### Recent Amendments (last 5 of ${totalCount})` : `### Amendments (${totalCount})`;
        const lines = amendments.map((a, i) => `${i + 1}. [${a.amendment_type}] ${a.content}`);
        sections.push(`${header}\n${lines.join('\n')}`);
      }
    } catch (_) { /* non-fatal */ }

    // 3. Child agent status from sub_tasks + todo.db
    try {
      const subtaskIds = db.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(taskId);
      if (subtaskIds.length > 0) {
        const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
        if (fs.existsSync(todoDbPath)) {
          const todoDb = new Database(todoDbPath, { readonly: true });
          const ids = subtaskIds.map(r => r.todo_task_id);
          const placeholders = ids.map(() => '?').join(',');
          const completed = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`).get(...ids).cnt;
          const inProgress = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'in_progress'`).get(...ids).cnt;
          const pending = ids.length - completed - inProgress;

          // Last 5 tasks with status (most recently created first)
          const recent = todoDb.prepare(`SELECT title, status, section FROM tasks WHERE id IN (${placeholders}) ORDER BY created_timestamp DESC LIMIT 5`).all(...ids);
          todoDb.close();

          const lines = [`Completed: ${completed} | In Progress: ${inProgress} | Pending: ${pending}`];
          for (const t of recent) {
            lines.push(`- [${t.status}] "${t.title}" (${t.section})`);
          }
          sections.push(`### Child Agent Status\n${lines.join('\n')}`);
        }
      }
    } catch (_) { /* non-fatal */ }

    db.close();
  } catch (_) { /* non-fatal — entire context is optional */ }

  // 4. Compaction context from previous monitor session (optional)
  if (options.monitorSessionId) {
    try {
      // Encode the project directory path the same way Claude Code does:
      // replace all non-alphanumeric characters with '-'
      const projectPathEncoded = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
      const homeDir = process.env.HOME || os.homedir();

      // Try both with and without leading '-' (matches getSessionDir in session-reaper.js)
      const candidateDirs = [
        path.join(homeDir, '.claude', 'projects', projectPathEncoded),
        path.join(homeDir, '.claude', 'projects', projectPathEncoded.replace(/^-/, '')),
      ];

      let sessionsDir = null;
      for (const dir of candidateDirs) {
        if (fs.existsSync(dir)) {
          sessionsDir = dir;
          break;
        }
      }

      if (sessionsDir) {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

        // Find session file containing the monitor session ID or a compact_boundary
        for (const file of files) {
          const filePath = path.join(sessionsDir, file);
          const stat = fs.statSync(filePath);
          const readSize = Math.min(stat.size, 8192);
          const buf = Buffer.alloc(readSize);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
          fs.closeSync(fd);
          const tail = buf.toString('utf8');

          if (tail.includes(options.monitorSessionId) || tail.includes('compact_boundary')) {
            // Extract compaction summary: find a summary/compaction entry in the tail
            const lines = tail.split('\n').filter(l => l.trim());
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const entry = JSON.parse(lines[i]);
                // Look for compaction summary entries
                if (
                  entry.type === 'summary' ||
                  (entry.message && typeof entry.message === 'string' && entry.message.includes('continued from')) ||
                  (entry.type === 'system' && entry.subtype === 'compact_boundary')
                ) {
                  const summary = (entry.message || entry.summary || entry.content || '').toString().slice(0, 2000);
                  if (summary) {
                    sections.push(`### Previous Session Context\n${summary}`);
                  }
                  break;
                }
              } catch { continue; }
            }
            break; // Only check the first matching file
          }
        }
      }
    } catch (_) { /* non-fatal — compaction context is optional */ }
  }

  if (sections.length === 0) return '';
  return `## Revival Context (auto-generated)\n\n${sections.join('\n\n')}`;
}
