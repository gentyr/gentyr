/**
 * Regression test for sub-task archival blindness.
 *
 * Once todo-maintenance archives a completed sub-task (moves it from `tasks`
 * to `archived_tasks` after 3h), any reader that queries `tasks` only sees
 * the completion vanish. `resolveSubTaskStatuses` UNIONs both tables so the
 * count stays accurate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { resolveSubTaskStatuses } from '../sub-task-status.js';

// Minimal schemas matching the real DBs (just enough to exercise the resolver).
const TODO_SCHEMA = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  section TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  category_id TEXT,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL
);
CREATE TABLE archived_tasks (
  id TEXT PRIMARY KEY,
  section TEXT,
  category_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  archived_timestamp INTEGER NOT NULL,
  original_status TEXT,
  deletion_reason TEXT
);
`;

describe('resolveSubTaskStatuses — archival blindness fix', () => {
  let tmpDir: string;
  let todoDbPath: string;
  let todoDb: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtask-archival-'));
    todoDbPath = path.join(tmpDir, 'todo.db');
    todoDb = new Database(todoDbPath);
    todoDb.exec(TODO_SCHEMA);
  });

  afterEach(() => {
    try { todoDb.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedLiveTask(id: string, status: string, title = `Task ${id}`) {
    const nowIso = new Date().toISOString();
    const nowTs = Math.floor(Date.now() / 1000);
    todoDb.prepare(
      "INSERT INTO tasks (id, section, status, title, category_id, created_at, created_timestamp) VALUES (?, 'general', ?, ?, NULL, ?, ?)"
    ).run(id, status, title, nowIso, nowTs);
  }

  function seedArchivedTask(id: string, originalStatus: string, title = `Task ${id}`) {
    const nowIso = new Date().toISOString();
    const nowTs = Math.floor(Date.now() / 1000);
    todoDb.prepare(
      `INSERT INTO archived_tasks
        (id, section, category_id, title, created_at, created_timestamp, archived_at, archived_timestamp, original_status, deletion_reason)
       VALUES (?, 'general', NULL, ?, ?, ?, ?, ?, ?, 'completed_older_than_3h')`
    ).run(id, title, nowIso, nowTs, nowIso, nowTs, originalStatus);
  }

  it('returns archived completed tasks with archived=true and status=completed', () => {
    seedLiveTask('live-pending', 'pending');
    seedLiveTask('live-progress', 'in_progress');
    seedArchivedTask('arch-completed', 'completed');

    const result = resolveSubTaskStatuses(todoDb, [
      'live-pending', 'live-progress', 'arch-completed',
    ]);

    expect(result.size).toBe(3);
    expect(result.get('live-pending')).toMatchObject({ status: 'pending', archived: false });
    expect(result.get('live-progress')).toMatchObject({ status: 'in_progress', archived: false });
    expect(result.get('arch-completed')).toMatchObject({ status: 'completed', archived: true });
  });

  it('counts completed accurately when most sub-tasks have been archived (the Stripe/OpenClaw scenario)', () => {
    // 19 sub-tasks total: 2 pending live, 1 in_progress live, 16 archived completed
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) { const id = `p${i}`; seedLiveTask(id, 'pending'); ids.push(id); }
    for (let i = 0; i < 1; i++) { const id = `r${i}`; seedLiveTask(id, 'in_progress'); ids.push(id); }
    for (let i = 0; i < 16; i++) { const id = `c${i}`; seedArchivedTask(id, 'completed'); ids.push(id); }

    const result = resolveSubTaskStatuses(todoDb, ids);

    let pending = 0, inProgress = 0, completed = 0;
    for (const r of result.values()) {
      if (r.status === 'pending') pending++;
      else if (r.status === 'in_progress') inProgress++;
      else if (r.status === 'completed') completed++;
    }

    expect(result.size).toBe(19);
    expect(pending).toBe(2);
    expect(inProgress).toBe(1);
    expect(completed).toBe(16); // was 0 before the fix
  });

  it('falls back to original_status=completed when column is NULL (legacy rows)', () => {
    // INSERT bypassing original_status (simulates pre-migration row)
    todoDb.prepare(
      `INSERT INTO archived_tasks (id, section, category_id, title, created_at, created_timestamp, archived_at, archived_timestamp)
       VALUES ('legacy-a', 'general', NULL, 'Legacy', ?, ?, ?, ?)`
    ).run(new Date().toISOString(), 0, new Date().toISOString(), 0);

    const result = resolveSubTaskStatuses(todoDb, ['legacy-a']);
    expect(result.get('legacy-a')).toMatchObject({ status: 'completed', archived: true });
  });

  it('prefers the live row when the same id exists in both tables (INSERT OR REPLACE echo)', () => {
    // delete_task uses INSERT OR REPLACE; if the DELETE step is interrupted
    // both rows can transiently coexist. The live row must win.
    seedLiveTask('dup', 'in_progress', 'Live version');
    seedArchivedTask('dup', 'completed', 'Archived version');

    const result = resolveSubTaskStatuses(todoDb, ['dup']);
    expect(result.size).toBe(1);
    expect(result.get('dup')).toMatchObject({
      status: 'in_progress',
      archived: false,
      title: 'Live version',
    });
  });

  it('returns an empty map for an empty input', () => {
    expect(resolveSubTaskStatuses(todoDb, []).size).toBe(0);
  });

  it('ignores unknown ids without throwing', () => {
    seedLiveTask('a', 'pending');
    const result = resolveSubTaskStatuses(todoDb, ['a', 'does-not-exist']);
    expect(result.size).toBe(1);
    expect(result.has('a')).toBe(true);
    expect(result.has('does-not-exist')).toBe(false);
  });
});
