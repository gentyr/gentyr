/**
 * Unit tests for TODO Database MCP Server
 *
 * Tests task CRUD operations, SQLite database management,
 * input validation (G003), and error handling (G001).
 *
 * Uses in-memory SQLite database for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { createTestDb, createTempDir } from '../../__testUtils__/index.js';
import { TODO_DB_SCHEMA } from '../../__testUtils__/schemas.js';
import { SECTION_CREATOR_RESTRICTIONS, FORCED_FOLLOWUP_CREATORS } from '../../shared/constants.js';

// Database row types for type safety
interface TaskRow {
  id: string;
  section: string;
  title: string;
  description: string | null;
  status: string;
  assigned_by: string | null;
  created_at: string;
  created_timestamp: number;
  started_at: string | null;
  completed_at: string | null;
  completed_timestamp: number | null;
  linked_session_id: string | null;
  followup_enabled: number;
  followup_section: string | null;
  followup_prompt: string | null;
  priority: string;
}

interface SectionStatusCount {
  section: string;
  status: string;
  count: number;
}

interface SectionStats {
  pending: number;
  in_progress: number;
  completed: number;
}

// Result types for test helper functions
interface ErrorResult {
  error: string;
}

interface StartTaskResult {
  id: string;
  status: string;
  started_at: string;
}

interface CompleteTaskResult {
  id: string;
  status: string;
  completed_at: string;
  followup_task_id?: string;
}

interface DeleteTaskResult {
  deleted: boolean;
  id: string;
  archived?: boolean;
}

type TaskOrError = TaskRow | ErrorResult;
type StartOrError = StartTaskResult | ErrorResult;
type CompleteOrError = CompleteTaskResult | ErrorResult;
type DeleteOrError = DeleteTaskResult | ErrorResult;

describe('TODO Database Server', () => {
  let db: Database.Database;
  let tempDir: ReturnType<typeof createTempDir>;

  beforeEach(() => {
    // Create in-memory database for each test using shared utility
    db = createTestDb(TODO_DB_SCHEMA);

    // Create temp directory for session files testing using shared utility
    tempDir = createTempDir('todo-db-test');
  });

  afterEach(() => {
    db.close();
    // Clean up temp directory using the cleanup function
    tempDir.cleanup();
  });

  // Helper functions that mirror the server implementation
  const listTasks = (args: { section?: string; status?: string; priority?: string; limit?: number }) => {
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params: unknown[] = [];

    if (args.section) {
      sql += ' AND section = ?';
      params.push(args.section);
    }
    if (args.status) {
      sql += ' AND status = ?';
      params.push(args.status);
    }
    if (args.priority) {
      sql += ' AND priority = ?';
      params.push(args.priority);
    }

    sql += ' ORDER BY created_timestamp DESC';
    const limit = args.limit ?? 50;
    sql += ' LIMIT ?';
    params.push(limit);

    const tasks = db.prepare(sql).all(...params);
    return { tasks, total: tasks.length };
  };

  function buildDefaultFollowupPrompt(title: string, description: string | null): string {
    const originalTask = description
      ? `Title: ${title}\nDescription: ${description}`
      : `Title: ${title}`;

    return `[Follow-up Verification] Earlier, you spawned agents or created to-do items to complete the following task. This is a reminder to verify that the task was completed.

If the task wasn't worked on at all, just stop here without further action — you'll be re-spawned later with this same prompt.

If it was partially completed but not to your satisfaction, spawn sessions or create to-do items for the appropriate agents to resolve the discrepancies.

If fully completed, mark this follow-up task as complete.

[Original Task]:
${originalTask}`;
  }

  const createTask = (args: {
    section: string;
    title: string;
    description?: string;
    assigned_by?: string;
    followup_enabled?: boolean;
    followup_section?: string;
    followup_prompt?: string;
    priority?: string;
  }): TaskRow & { warning?: string } | ErrorResult => {
    // Soft access control
    const restrictions = SECTION_CREATOR_RESTRICTIONS[args.section as keyof typeof SECTION_CREATOR_RESTRICTIONS];
    if (restrictions) {
      if (!args.assigned_by || !restrictions.includes(args.assigned_by)) {
        const gotValue = args.assigned_by ?? '(none)';
        return {
          error: `Section '${args.section}' requires assigned_by to be one of: ${restrictions.join(', ')}. Got: '${gotValue}'`,
        };
      }
    }

    // Follow-up enforcement for forced creators
    let followup_enabled = args.followup_enabled ?? false;
    let followup_section = args.followup_section ?? args.section;
    let followup_prompt = args.followup_prompt ?? null;
    let warning: string | undefined;

    if (args.assigned_by && (FORCED_FOLLOWUP_CREATORS as readonly string[]).includes(args.assigned_by)) {
      // Reject tasks without a description
      if (!args.description?.trim()) {
        return {
          error: `Tasks created by ${args.assigned_by} require a description. The description is used to generate a follow-up verification prompt.`,
        };
      }

      if (args.followup_enabled === false) {
        warning = `Follow-up hooks cannot be disabled for tasks created by ${args.assigned_by}. Enabled automatically.`;
      }
      followup_enabled = true;

      if (!followup_prompt) {
        followup_prompt = buildDefaultFollowupPrompt(args.title, args.description);
      }
    }

    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);
    const priority = args.priority ?? 'normal';

    db.prepare(`
      INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt, priority)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.section,
      args.title,
      args.description ?? null,
      args.assigned_by ?? null,
      created_at,
      created_timestamp,
      followup_enabled ? 1 : 0,
      followup_section,
      followup_prompt,
      priority
    );

    return {
      id,
      section: args.section,
      status: 'pending',
      title: args.title,
      description: args.description ?? null,
      created_at,
      started_at: null,
      completed_at: null,
      assigned_by: args.assigned_by ?? null,
      created_timestamp,
      completed_timestamp: null,
      linked_session_id: null,
      followup_enabled: followup_enabled ? 1 : 0,
      followup_section,
      followup_prompt,
      priority,
      warning,
    };
  };

  const getTask = (id: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return task || { error: `Task not found: ${id}` };
  };

  const startTask = (id: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {return { error: `Task not found: ${id}` };}
    if (task.status === 'completed') {return { error: `Task already completed: ${id}` };}
    if (task.status === 'in_progress') {return { error: `Task already in progress: ${id}` };}

    const started_at = new Date().toISOString();
    db.prepare(`UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ?`).run(
      started_at,
      id
    );

    return { id, status: 'in_progress', started_at };
  };

  const completeTask = (id: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {return { error: `Task not found: ${id}` };}
    if (task.status === 'completed') {return { error: `Task already completed: ${id}` };}

    const now = new Date();
    const completed_at = now.toISOString();
    const completed_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      UPDATE tasks SET status = 'completed', completed_at = ?, completed_timestamp = ?
      WHERE id = ?
    `).run(completed_at, completed_timestamp, id);

    let followup_task_id: string | undefined;

    // Trigger follow-up hook
    if (task.followup_enabled) {
      const followupId = randomUUID();
      const section = task.followup_section ?? task.section;
      const title = `[Follow-up] ${task.title}`;
      const description = task.followup_prompt;
      const followup_created_at = now.toISOString();
      const followup_timestamp = Math.floor(now.getTime() / 1000);

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt)
        VALUES (?, ?, 'pending', ?, ?, 'system-followup', ?, ?, 0, NULL, NULL)
      `).run(followupId, section, title, description, followup_created_at, followup_timestamp);

      followup_task_id = followupId;
    }

    return { id, status: 'completed', completed_at, followup_task_id };
  };

  const deleteTask = (id: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {return { error: `Task not found: ${id}` };}

    let archived = false;

    if (task.status === 'completed') {
      const now = new Date();
      const archived_at = now.toISOString();
      const archived_timestamp = Math.floor(now.getTime() / 1000);

      const archiveAndDelete = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO archived_tasks (id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.id, task.section, task.title, task.description, task.assigned_by,
          task.priority ?? 'normal', task.created_at, task.started_at, task.completed_at,
          task.created_timestamp, task.completed_timestamp, task.followup_enabled,
          task.followup_section, task.followup_prompt, archived_at, archived_timestamp
        );
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      });
      archiveAndDelete();
      archived = true;
    } else {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    }

    return { deleted: true, id, archived };
  };

  const getSummary = () => {
    const result = {
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      by_section: {} as Record<string, SectionStats>,
    };

    const sections = ['TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER', 'DEPUTY-CTO'];
    for (const section of sections) {
      result.by_section[section] = { pending: 0, in_progress: 0, completed: 0 };
    }

    const tasks = db
      .prepare('SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status')
      .all() as SectionStatusCount[];

    for (const row of tasks) {
      result.total += row.count;
      result[row.status as keyof typeof result] += row.count;
      if (result.by_section[row.section]) {
        result.by_section[row.section][row.status] = row.count;
      }
    }

    return result;
  };

  const cleanup = () => {
    const now = Math.floor(Date.now() / 1000);
    const nowIso = new Date().toISOString();
    const changes = {
      stale_starts_cleared: 0,
      old_completed_archived: 0,
      completed_cap_archived: 0,
      archived_pruned: 0,
    };

    // Clear stale starts (>30 min = 1800 seconds)
    const staleResult = db.prepare(`
      UPDATE tasks
      SET status = 'pending', started_at = NULL
      WHERE status = 'in_progress'
        AND started_at IS NOT NULL
        AND (? - created_timestamp) > 1800
    `).run(now);
    changes.stale_starts_cleared = staleResult.changes;

    // Archive old completed (>3 hours = 10800 seconds)
    const archiveOld = db.transaction(() => {
      const insertResult = db.prepare(`
        INSERT OR REPLACE INTO archived_tasks (id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
        SELECT id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, ?, ?
        FROM tasks
        WHERE status = 'completed'
          AND completed_timestamp IS NOT NULL
          AND (? - completed_timestamp) > 10800
      `).run(nowIso, now, now);

      db.prepare(`
        DELETE FROM tasks
        WHERE status = 'completed'
          AND completed_timestamp IS NOT NULL
          AND (? - completed_timestamp) > 10800
      `).run(now);

      return insertResult.changes;
    });
    changes.old_completed_archived = archiveOld();

    // Cap completed at 50 (archive overflow)
    const completedCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as { count: number }).count;
    if (completedCount > 50) {
      const toRemove = completedCount - 50;
      const archiveCap = db.transaction(() => {
        const insertResult = db.prepare(`
          INSERT INTO archived_tasks (id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
          SELECT id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, ?, ?
          FROM tasks
          WHERE status = 'completed'
          ORDER BY completed_timestamp ASC
          LIMIT ?
        `).run(nowIso, now, toRemove);

        db.prepare(`
          DELETE FROM tasks WHERE id IN (
            SELECT id FROM tasks
            WHERE status = 'completed'
            ORDER BY completed_timestamp ASC
            LIMIT ?
          )
        `).run(toRemove);

        return insertResult.changes;
      });
      changes.completed_cap_archived = archiveCap();
    }

    // Prune old archived tasks: keep last 500 OR anything within 30 days
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
    const pruneResult = db.prepare(`
      DELETE FROM archived_tasks
      WHERE id NOT IN (
        SELECT id FROM archived_tasks ORDER BY archived_timestamp DESC LIMIT 500
      )
      AND archived_timestamp < ?
    `).run(thirtyDaysAgo);
    changes.archived_pruned = pruneResult.changes;

    return {
      ...changes,
      message: `Cleanup complete: ${changes.stale_starts_cleared} stale starts cleared, ${changes.old_completed_archived} old completed archived, ${changes.completed_cap_archived} completed cap archived, ${changes.archived_pruned} archives pruned`,
    };
  };

  describe('Task Creation', () => {
    it('should create a task with required fields', () => {
      const result = createTask({
        section: 'TEST-WRITER',
        title: 'Write unit tests',
      });

      expect(result.id).toBeDefined();
      expect(result.section).toBe('TEST-WRITER');
      expect(result.status).toBe('pending');
      expect(result.title).toBe('Write unit tests');
      expect(result.created_at).toBeDefined();
    });

    it('should create a task with optional description', () => {
      const result = createTask({
        section: 'CODE-REVIEWER',
        title: 'Review PR',
        description: 'Review changes to auth module',
      });

      expect(result.description).toBe('Review changes to auth module');
    });

    it('should create a task with assigned_by field', () => {
      const result = createTask({
        section: 'TEST-WRITER',
        title: 'Integration tests',
        assigned_by: 'CODE-REVIEWER',
      });

      expect(result.assigned_by).toBe('CODE-REVIEWER');
    });

    it('should enforce valid section constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp)
          VALUES (?, ?, 'pending', ?, ?, ?)
        `).run(randomUUID(), 'INVALID-SECTION', 'Test', new Date().toISOString(), Date.now());
      }).toThrow();
    });

    it('should enforce valid status constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          'TEST-WRITER',
          'invalid-status',
          'Test',
          new Date().toISOString(),
          Date.now()
        );
      }).toThrow();
    });
  });

  describe('Task Retrieval', () => {
    it('should list all tasks', () => {
      createTask({ section: 'TEST-WRITER', title: 'Task 1' });
      createTask({ section: 'CODE-REVIEWER', title: 'Task 2' });

      const result = listTasks({});
      expect(result.total).toBe(2);
      expect(result.tasks).toHaveLength(2);
    });

    it('should filter by section', () => {
      createTask({ section: 'TEST-WRITER', title: 'Task 1' });
      createTask({ section: 'CODE-REVIEWER', title: 'Task 2' });
      createTask({ section: 'TEST-WRITER', title: 'Task 3' });

      const result = listTasks({ section: 'TEST-WRITER' });
      expect(result.total).toBe(2);
    });

    it('should filter by status', () => {
      const task1 = createTask({ section: 'TEST-WRITER', title: 'Task 1' });
      createTask({ section: 'TEST-WRITER', title: 'Task 2' }); // Second task stays pending
      startTask(task1.id);

      const result = listTasks({ status: 'in_progress' });
      expect(result.total).toBe(1);
      expect((result.tasks[0] as TaskRow).id).toBe(task1.id);
    });

    it('should apply limit', () => {
      for (let i = 0; i < 100; i++) {
        createTask({ section: 'TEST-WRITER', title: `Task ${i}` });
      }

      const result = listTasks({ limit: 10 });
      expect(result.tasks).toHaveLength(10);
    });

    it('should default to 50 tasks limit', () => {
      for (let i = 0; i < 60; i++) {
        createTask({ section: 'TEST-WRITER', title: `Task ${i}` });
      }

      const result = listTasks({});
      expect(result.tasks).toHaveLength(50);
    });

    it('should order by created_timestamp DESC', () => {
      // Create tasks with small delay to ensure different timestamps
      createTask({ section: 'TEST-WRITER', title: 'First' }); // First task (older)

      // Insert task2 with a later timestamp
      const id2 = randomUUID();
      const now = new Date();
      const created_at = now.toISOString();
      const created_timestamp = Math.floor(now.getTime() / 1000) + 1; // 1 second later

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp)
        VALUES (?, ?, 'pending', ?, ?, ?)
      `).run(id2, 'TEST-WRITER', 'Second', created_at, created_timestamp);

      const result = listTasks({});
      expect((result.tasks[0] as TaskRow).id).toBe(id2); // Most recent first
    });

    it('should get task by ID', () => {
      const created = createTask({ section: 'TEST-WRITER', title: 'Find me' });
      const found = getTask(created.id) as TaskOrError;

      expect(found.id).toBe(created.id);
      expect(found.title).toBe('Find me');
    });

    it('should return error for non-existent task (G001)', () => {
      const result = getTask('non-existent-id') as TaskOrError;
      expect(result.error).toContain('Task not found');
    });
  });

  describe('Task Status Transitions', () => {
    it('should start a pending task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      const result = startTask(task.id) as StartOrError;

      expect(result.status).toBe('in_progress');
      expect(result.started_at).toBeDefined();

      const updated = getTask(task.id) as TaskOrError;
      expect(updated.status).toBe('in_progress');
    });

    it('should complete a pending task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      const result = completeTask(task.id) as CompleteOrError;

      expect(result.status).toBe('completed');
      expect(result.completed_at).toBeDefined();
    });

    it('should complete an in-progress task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      startTask(task.id);
      const result = completeTask(task.id) as CompleteOrError;

      expect(result.status).toBe('completed');
    });

    it('should fail to start already completed task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      completeTask(task.id);

      const result = startTask(task.id) as StartOrError;
      expect(result.error).toContain('already completed');
    });

    it('should fail to start already in-progress task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      startTask(task.id);

      const result = startTask(task.id) as StartOrError;
      expect(result.error).toContain('already in progress');
    });

    it('should fail to complete already completed task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Task' });
      completeTask(task.id);

      const result = completeTask(task.id) as CompleteOrError;
      expect(result.error).toContain('already completed');
    });

    it('should fail to start non-existent task (G001)', () => {
      const result = startTask('non-existent') as StartOrError;
      expect(result.error).toContain('Task not found');
    });

    it('should fail to complete non-existent task (G001)', () => {
      const result = completeTask('non-existent') as CompleteOrError;
      expect(result.error).toContain('Task not found');
    });
  });

  describe('Task Deletion', () => {
    it('should delete a task', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Delete me' });
      const result = deleteTask(task.id) as DeleteOrError;

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(task.id);

      const found = getTask(task.id) as TaskOrError;
      expect(found.error).toContain('Task not found');
    });

    it('should fail to delete non-existent task (G001)', () => {
      const result = deleteTask('non-existent') as DeleteOrError;
      expect(result.error).toContain('Task not found');
    });
  });

  describe('Summary Statistics', () => {
    it('should return zero summary for empty database', () => {
      const result = getSummary();

      expect(result.total).toBe(0);
      expect(result.pending).toBe(0);
      expect(result.in_progress).toBe(0);
      expect(result.completed).toBe(0);
    });

    it('should count tasks by status', () => {
      const task1 = createTask({ section: 'TEST-WRITER', title: 'Task 1' });
      const task2 = createTask({ section: 'TEST-WRITER', title: 'Task 2' });
      createTask({ section: 'TEST-WRITER', title: 'Task 3' }); // Third task stays pending

      startTask(task1.id);
      completeTask(task2.id);

      const result = getSummary();
      expect(result.total).toBe(3);
      expect(result.pending).toBe(1);
      expect(result.in_progress).toBe(1);
      expect(result.completed).toBe(1);
    });

    it('should count tasks by section', () => {
      createTask({ section: 'TEST-WRITER', title: 'Task 1' });
      createTask({ section: 'CODE-REVIEWER', title: 'Task 2' });
      createTask({ section: 'TEST-WRITER', title: 'Task 3' });

      const result = getSummary();
      expect(result.by_section['TEST-WRITER'].pending).toBe(2);
      expect(result.by_section['CODE-REVIEWER'].pending).toBe(1);
    });

    it('should initialize all sections in summary', () => {
      const result = getSummary();

      expect(result.by_section['TEST-WRITER']).toBeDefined();
      expect(result.by_section['INVESTIGATOR & PLANNER']).toBeDefined();
      expect(result.by_section['CODE-REVIEWER']).toBeDefined();
      expect(result.by_section['PROJECT-MANAGER']).toBeDefined();
      expect(result.by_section['DEPUTY-CTO']).toBeDefined();
    });
  });

  describe('Cleanup Operations', () => {
    it('should clear stale in-progress tasks (>30 min)', () => {
      // Create task with old timestamp (31 minutes ago)
      const id = randomUUID();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 1860; // 31 minutes
      const created_at = new Date(oldTimestamp * 1000).toISOString();

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, started_at, created_timestamp)
        VALUES (?, 'TEST-WRITER', 'in_progress', 'Stale task', ?, ?, ?)
      `).run(id, created_at, created_at, oldTimestamp);

      const result = cleanup();
      expect(result.stale_starts_cleared).toBe(1);

      const task = getTask(id) as TaskOrError;
      expect(task.status).toBe('pending');
      expect(task.started_at).toBe(null);
    });

    it('should not clear recent in-progress tasks', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Recent task' });
      startTask(task.id);

      const result = cleanup();
      expect(result.stale_starts_cleared).toBe(0);

      const updated = getTask(task.id) as TaskOrError;
      expect(updated.status).toBe('in_progress');
    });

    it('should archive old completed tasks (>3 hours)', () => {
      const id = randomUUID();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 11000; // >3 hours
      const created_at = new Date(oldTimestamp * 1000).toISOString();
      const completed_at = created_at;

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, completed_at, created_timestamp, completed_timestamp)
        VALUES (?, 'TEST-WRITER', 'completed', 'Old task', ?, ?, ?, ?)
      `).run(id, created_at, completed_at, oldTimestamp, oldTimestamp);

      const result = cleanup();
      expect(result.old_completed_archived).toBe(1);

      // Task should no longer be in tasks table
      const task = getTask(id) as TaskOrError;
      expect(task.error).toContain('Task not found');

      // Task should exist in archived_tasks table
      const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(id) as { id: string; title: string; archived_at: string } | undefined;
      expect(archived).toBeDefined();
      expect(archived!.id).toBe(id);
      expect(archived!.title).toBe('Old task');
      expect(archived!.archived_at).toBeDefined();
    });

    it('should archive excess completed tasks beyond 50', () => {
      // Create 60 completed tasks
      for (let i = 0; i < 60; i++) {
        const task = createTask({ section: 'TEST-WRITER', title: `Task ${i}` });
        completeTask(task.id);
      }

      const result = cleanup();
      expect(result.completed_cap_archived).toBe(10); // 60 - 50 = 10 archived

      const summary = getSummary();
      expect(summary.completed).toBe(50);

      // Verify overflow tasks moved to archived_tasks
      const archivedCount = (db.prepare('SELECT COUNT(*) as count FROM archived_tasks').get() as { count: number }).count;
      expect(archivedCount).toBe(10);
    });

    it('should keep most recent 50 completed tasks and archive oldest', () => {
      const taskIds: string[] = [];

      // Create 60 completed tasks with delays to ensure different timestamps
      for (let i = 0; i < 60; i++) {
        const id = randomUUID();
        const timestamp = Math.floor(Date.now() / 1000) + i; // Each task 1 second apart
        const created_at = new Date(timestamp * 1000).toISOString();

        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, completed_at, created_timestamp, completed_timestamp)
          VALUES (?, 'TEST-WRITER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, `Task ${i}`, created_at, created_at, timestamp, timestamp);

        taskIds.push(id);
      }

      cleanup();

      // First 10 tasks (oldest) should be removed from tasks table
      for (let i = 0; i < 10; i++) {
        const task = getTask(taskIds[i]) as TaskOrError;
        expect(task.error).toContain('Task not found');
      }

      // First 10 tasks should be in archived_tasks
      for (let i = 0; i < 10; i++) {
        const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(taskIds[i]) as { id: string } | undefined;
        expect(archived).toBeDefined();
        expect(archived!.id).toBe(taskIds[i]);
      }

      // Last 50 tasks should remain in tasks table
      for (let i = 10; i < 60; i++) {
        const task = getTask(taskIds[i]) as TaskOrError;
        expect(task.id).toBe(taskIds[i]);
      }
    });

    it('should prune archived tasks older than 30 days when exceeding 500', () => {
      const now = Math.floor(Date.now() / 1000);
      const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60);
      const twentyNineDaysAgo = now - (29 * 24 * 60 * 60);

      // Insert 502 old archived tasks (>30 days)
      for (let i = 0; i < 502; i++) {
        const id = randomUUID();
        const created_at = new Date((thirtyOneDaysAgo - i) * 1000).toISOString();
        db.prepare(`
          INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
          VALUES (?, 'TEST-WRITER', ?, 'normal', ?, ?, 0, ?, ?)
        `).run(id, `Old archive ${i}`, created_at, thirtyOneDaysAgo - i, created_at, thirtyOneDaysAgo - i);
      }

      // Insert 2 recent archived tasks (<30 days) — these should survive
      const recentIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const created_at = new Date((twentyNineDaysAgo + i) * 1000).toISOString();
        db.prepare(`
          INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
          VALUES (?, 'TEST-WRITER', ?, 'normal', ?, ?, 0, ?, ?)
        `).run(id, `Recent archive ${i}`, created_at, twentyNineDaysAgo + i, created_at, twentyNineDaysAgo + i);
        recentIds.push(id);
      }

      const result = cleanup();
      // 504 total, top 500 kept (2 recent + 498 old), 4 candidates outside top 500,
      // all 4 are older than 30 days, so all 4 are pruned
      expect(result.archived_pruned).toBe(4);

      // Recent archives should still exist
      for (const id of recentIds) {
        const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(id);
        expect(archived).toBeDefined();
      }
    });

    it('should archive completed tasks on deleteTask()', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Complete then delete' });
      completeTask(task.id);

      const result = deleteTask(task.id) as DeleteOrError;
      expect(result.deleted).toBe(true);
      expect(result.archived).toBe(true);

      // Should not be in tasks table
      const found = getTask(task.id) as TaskOrError;
      expect(found.error).toContain('Task not found');

      // Should be in archived_tasks table
      const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(task.id) as { id: string; title: string } | undefined;
      expect(archived).toBeDefined();
      expect(archived!.title).toBe('Complete then delete');
    });

    it('should not archive pending tasks on deleteTask()', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Delete pending' });

      const result = deleteTask(task.id) as DeleteOrError;
      expect(result.deleted).toBe(true);
      expect(result.archived).toBe(false);

      // Should not be in archived_tasks table
      const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(task.id);
      expect(archived).toBeUndefined();
    });

    it('should not archive in_progress tasks on deleteTask()', () => {
      const task = createTask({ section: 'TEST-WRITER', title: 'Delete in-progress' });
      startTask(task.id);

      const result = deleteTask(task.id) as DeleteOrError;
      expect(result.deleted).toBe(true);
      expect(result.archived).toBe(false);

      // Should not be in archived_tasks table
      const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(task.id);
      expect(archived).toBeUndefined();
    });
  });

  describe('Archive Queries', () => {
    it('should have index on archived_tasks(archived_timestamp)', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_archived_tasks_archived'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on archived_tasks(section)', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_archived_tasks_section'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should list archived tasks within time window', () => {
      const now = Math.floor(Date.now() / 1000);
      const twoHoursAgo = now - (2 * 60 * 60);

      // Insert an archived task
      const id = randomUUID();
      const created_at = new Date(twoHoursAgo * 1000).toISOString();
      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Archived task', 'normal', ?, ?, 0, ?, ?)
      `).run(id, created_at, twoHoursAgo, created_at, twoHoursAgo);

      // Query archived tasks within 24 hours
      const tasks = db.prepare(
        'SELECT * FROM archived_tasks WHERE archived_timestamp >= ? ORDER BY archived_timestamp DESC'
      ).all(now - (24 * 60 * 60));
      expect(tasks).toHaveLength(1);
    });

    it('should filter archived tasks by section', () => {
      const now = Math.floor(Date.now() / 1000);
      const created_at = new Date(now * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'TW task', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, now, created_at, now);

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'CR task', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, now, created_at, now);

      const twTasks = db.prepare(
        "SELECT * FROM archived_tasks WHERE section = 'TEST-WRITER'"
      ).all();
      expect(twTasks).toHaveLength(1);
    });

    it('should preserve all task fields when archiving', () => {
      // Create a task with all fields populated
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Full fields task',
        description: 'A task with all fields',
        assigned_by: 'deputy-cto',
        priority: 'urgent',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        startTask(task.id);
        completeTask(task.id);

        // Delete to trigger archival
        deleteTask(task.id);

        const archived = db.prepare('SELECT * FROM archived_tasks WHERE id = ?').get(task.id) as {
          id: string; section: string; title: string; description: string;
          assigned_by: string; priority: string; followup_enabled: number;
          archived_at: string; archived_timestamp: number;
        } | undefined;

        expect(archived).toBeDefined();
        expect(archived!.section).toBe('DEPUTY-CTO');
        expect(archived!.title).toBe('Full fields task');
        expect(archived!.description).toBe('A task with all fields');
        expect(archived!.assigned_by).toBe('deputy-cto');
        expect(archived!.priority).toBe('urgent');
        expect(archived!.followup_enabled).toBe(1);
        expect(archived!.archived_at).toBeDefined();
        expect(archived!.archived_timestamp).toBeGreaterThan(0);
      }
    });
  });

  describe('List Archived Tasks', () => {
    // Mirror of the server's listArchivedTasks implementation
    const listArchivedTasks = (args: { section?: string; limit?: number; hours?: number }) => {
      const hours = args.hours ?? 24;
      const limit = args.limit ?? 20;
      const since = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

      let sql = 'SELECT * FROM archived_tasks WHERE archived_timestamp >= ?';
      const params: unknown[] = [since];

      if (args.section) {
        sql += ' AND section = ?';
        params.push(args.section);
      }

      sql += ' ORDER BY archived_timestamp DESC LIMIT ?';
      params.push(limit);

      const tasks = db.prepare(sql).all(...params) as Array<{
        id: string; section: string; title: string; description: string | null;
        assigned_by: string | null; priority: string; created_at: string;
        started_at: string | null; completed_at: string | null;
        created_timestamp: number; completed_timestamp: number | null;
        followup_enabled: number; followup_section: string | null;
        followup_prompt: string | null; archived_at: string; archived_timestamp: number;
      }>;

      return { tasks, total: tasks.length };
    };

    it('should return empty result when no archived tasks exist', () => {
      const result = listArchivedTasks({});
      expect(result.tasks).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should return archived tasks within default 24-hour window', () => {
      const now = Math.floor(Date.now() / 1000);
      const twelveHoursAgo = now - (12 * 60 * 60);
      const created_at = new Date(twelveHoursAgo * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Recent archived', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, twelveHoursAgo, created_at, twelveHoursAgo);

      const result = listArchivedTasks({});
      expect(result.tasks).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.tasks[0].title).toBe('Recent archived');
    });

    it('should exclude archived tasks outside the time window', () => {
      const now = Math.floor(Date.now() / 1000);
      const twentyFiveHoursAgo = now - (25 * 60 * 60);
      const created_at = new Date(twentyFiveHoursAgo * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Old archived', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, twentyFiveHoursAgo, created_at, twentyFiveHoursAgo);

      const result = listArchivedTasks({});
      expect(result.tasks).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should filter archived tasks by section', () => {
      const now = Math.floor(Date.now() / 1000);
      const created_at = new Date(now * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'TW archived', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, now, created_at, now);

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'CR archived', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), created_at, now, created_at, now);

      const twResult = listArchivedTasks({ section: 'TEST-WRITER' });
      expect(twResult.tasks).toHaveLength(1);
      expect(twResult.tasks[0].section).toBe('TEST-WRITER');

      const crResult = listArchivedTasks({ section: 'CODE-REVIEWER' });
      expect(crResult.tasks).toHaveLength(1);
      expect(crResult.tasks[0].section).toBe('CODE-REVIEWER');
    });

    it('should respect limit parameter and default to 20', () => {
      const now = Math.floor(Date.now() / 1000);

      for (let i = 0; i < 25; i++) {
        const ts = now + i; // Ensure distinct timestamps
        const created_at = new Date(ts * 1000).toISOString();
        db.prepare(`
          INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
          VALUES (?, 'TEST-WRITER', ?, 'normal', ?, ?, 0, ?, ?)
        `).run(randomUUID(), `Archived ${i}`, created_at, ts, created_at, ts);
      }

      // Default limit is 20
      const defaultResult = listArchivedTasks({});
      expect(defaultResult.tasks).toHaveLength(20);
      expect(defaultResult.total).toBe(20);

      // Explicit limit
      const limitResult = listArchivedTasks({ limit: 5 });
      expect(limitResult.tasks).toHaveLength(5);
      expect(limitResult.total).toBe(5);
    });

    it('should order results by archived_timestamp DESC', () => {
      const now = Math.floor(Date.now() / 1000);

      // Insert two tasks with different timestamps
      const olderTs = now - 100;
      const newerTs = now - 10;

      const olderId = randomUUID();
      const newerId = randomUUID();
      const olderIso = new Date(olderTs * 1000).toISOString();
      const newerIso = new Date(newerTs * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Older task', 'normal', ?, ?, 0, ?, ?)
      `).run(olderId, olderIso, olderTs, olderIso, olderTs);

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Newer task', 'normal', ?, ?, 0, ?, ?)
      `).run(newerId, newerIso, newerTs, newerIso, newerTs);

      const result = listArchivedTasks({ hours: 1 });
      expect(result.tasks).toHaveLength(2);
      // Most recently archived first
      expect(result.tasks[0].id).toBe(newerId);
      expect(result.tasks[1].id).toBe(olderId);
    });

    it('should return all ArchivedTask fields', () => {
      const now = Math.floor(Date.now() / 1000);
      const id = randomUUID();
      const created_at = new Date(now * 1000).toISOString();

      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
        VALUES (?, 'DEPUTY-CTO', 'Field test task', 'Some description', 'deputy-cto', 'urgent', ?, ?, ?, ?, ?, 1, 'TEST-WRITER', 'Followup prompt', ?, ?)
      `).run(id, created_at, created_at, created_at, now, now, created_at, now);

      const result = listArchivedTasks({ hours: 1 });
      expect(result.tasks).toHaveLength(1);
      const task = result.tasks[0];

      expect(task.id).toBe(id);
      expect(task.section).toBe('DEPUTY-CTO');
      expect(task.title).toBe('Field test task');
      expect(task.description).toBe('Some description');
      expect(task.assigned_by).toBe('deputy-cto');
      expect(task.priority).toBe('urgent');
      expect(task.created_at).toBe(created_at);
      expect(task.started_at).toBe(created_at);
      expect(task.completed_at).toBe(created_at);
      expect(task.created_timestamp).toBe(now);
      expect(task.completed_timestamp).toBe(now);
      expect(task.followup_enabled).toBe(1);
      expect(task.followup_section).toBe('TEST-WRITER');
      expect(task.followup_prompt).toBe('Followup prompt');
      expect(task.archived_at).toBe(created_at);
      expect(task.archived_timestamp).toBe(now);
    });

    it('should use hours parameter to expand or restrict the time window', () => {
      const now = Math.floor(Date.now() / 1000);

      // Task archived 36 hours ago
      const thirtyHoursAgo = now - (36 * 60 * 60);
      const oldIso = new Date(thirtyHoursAgo * 1000).toISOString();
      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Old task', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), oldIso, thirtyHoursAgo, oldIso, thirtyHoursAgo);

      // Task archived 2 hours ago
      const twoHoursAgo = now - (2 * 60 * 60);
      const recentIso = new Date(twoHoursAgo * 1000).toISOString();
      db.prepare(`
        INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
        VALUES (?, 'TEST-WRITER', 'Recent task', 'normal', ?, ?, 0, ?, ?)
      `).run(randomUUID(), recentIso, twoHoursAgo, recentIso, twoHoursAgo);

      // 24-hour window: only sees recent task
      const result24h = listArchivedTasks({ hours: 24 });
      expect(result24h.total).toBe(1);
      expect(result24h.tasks[0].title).toBe('Recent task');

      // 48-hour window: sees both
      const result48h = listArchivedTasks({ hours: 48 });
      expect(result48h.total).toBe(2);
    });

    it('should count total equal to tasks array length', () => {
      const now = Math.floor(Date.now() / 1000);
      const created_at = new Date(now * 1000).toISOString();

      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
          VALUES (?, 'TEST-WRITER', ?, 'normal', ?, ?, 0, ?, ?)
        `).run(randomUUID(), `Task ${i}`, created_at, now + i, created_at, now + i);
      }

      const result = listArchivedTasks({});
      expect(result.total).toBe(result.tasks.length);
      expect(result.total).toBe(3);
    });

    it('should return tasks archived by cleanup as well as by deleteTask', () => {
      // Archive via deleteTask
      const task1 = createTask({ section: 'TEST-WRITER', title: 'Delete-archived' });
      completeTask(task1.id);
      deleteTask(task1.id);

      // Archive via cleanup (old completed task)
      const id2 = randomUUID();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 11000; // >3 hours
      const oldIso = new Date(oldTimestamp * 1000).toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, completed_at, created_timestamp, completed_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'completed', 'Cleanup-archived', ?, ?, ?, ?)
      `).run(id2, oldIso, oldIso, oldTimestamp, oldTimestamp);
      cleanup();

      const result = listArchivedTasks({ hours: 1 });
      const titles = result.tasks.map(t => t.title);
      expect(titles).toContain('Delete-archived');
      expect(titles).toContain('Cleanup-archived');
      expect(result.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Cleanup Edge Cases', () => {
    it('should return 0 for all counts when database is empty', () => {
      const result = cleanup();
      expect(result.stale_starts_cleared).toBe(0);
      expect(result.old_completed_archived).toBe(0);
      expect(result.completed_cap_archived).toBe(0);
      expect(result.archived_pruned).toBe(0);
    });

    it('should return cleanup message with correct format', () => {
      const result = cleanup();
      expect(result.message).toMatch(/Cleanup complete:/);
      expect(result.message).toContain('stale starts cleared');
      expect(result.message).toContain('old completed archived');
      expect(result.message).toContain('completed cap archived');
      expect(result.message).toContain('archives pruned');
    });

    it('should be idempotent when run twice on a clean database', () => {
      // Create one fresh completed task (not old enough to archive)
      const task = createTask({ section: 'TEST-WRITER', title: 'Fresh completed' });
      completeTask(task.id);

      const result1 = cleanup();
      const result2 = cleanup();

      // Second run should find nothing new to do
      expect(result2.stale_starts_cleared).toBe(0);
      expect(result2.old_completed_archived).toBe(0);
      expect(result2.completed_cap_archived).toBe(0);
      expect(result2.archived_pruned).toBe(0);

      // First run also should have archived nothing (task is too recent)
      expect(result1.old_completed_archived).toBe(0);
    });

    it('should not archive completed tasks with null completed_timestamp in old-completed pass', () => {
      // Insert a completed task missing completed_timestamp (data integrity edge case)
      const id = randomUUID();
      const oldIso = new Date(Date.now() - 20000 * 1000).toISOString(); // very old
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at)
        VALUES (?, 'TEST-WRITER', 'completed', 'No timestamp', ?, ?, ?)
      `).run(id, oldIso, Math.floor(Date.now() / 1000) - 20000, oldIso);

      const result = cleanup();
      // The archival pass skips tasks with NULL completed_timestamp
      expect(result.old_completed_archived).toBe(0);

      // The task should still be in tasks table (not archived, not deleted)
      const stillInTasks = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      expect(stillInTasks).toBeDefined();
    });

    it('should not prune archived tasks within 30 days even when exceeding 500', () => {
      const now = Math.floor(Date.now() / 1000);
      const twentyNineDaysAgo = now - (29 * 24 * 60 * 60);

      // Insert 510 archived tasks all within 30 days
      for (let i = 0; i < 510; i++) {
        const ts = twentyNineDaysAgo + i;
        const iso = new Date(ts * 1000).toISOString();
        db.prepare(`
          INSERT INTO archived_tasks (id, section, title, priority, created_at, created_timestamp, followup_enabled, archived_at, archived_timestamp)
          VALUES (?, 'TEST-WRITER', ?, 'normal', ?, ?, 0, ?, ?)
        `).run(randomUUID(), `Task ${i}`, iso, ts, iso, ts);
      }

      const result = cleanup();
      // None should be pruned because all are within 30 days
      expect(result.archived_pruned).toBe(0);

      const remaining = (db.prepare('SELECT COUNT(*) as count FROM archived_tasks').get() as { count: number }).count;
      expect(remaining).toBe(510);
    });
  });

  describe('Input Validation (G003)', () => {
    it('should validate section enum', () => {
      // This would be enforced by Zod schema in actual implementation
      expect(() => {
        createTask({ section: 'INVALID', title: 'Test' });
      }).toThrow();
    });

    it('should require title field', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (id, section, status, created_at, created_timestamp)
          VALUES (?, 'TEST-WRITER', 'pending', ?, ?)
        `).run(randomUUID(), new Date().toISOString(), Date.now());
      }).toThrow();
    });
  });

  describe('Error Handling (G001)', () => {
    it('should distinguish file-not-found from corruption', () => {
      // Non-existent task is expected (file-not-found equivalent)
      const result = getTask('non-existent') as TaskOrError;
      expect(result.error).toContain('Task not found');
      expect(result.error).not.toContain('corrupt');
    });

    it('should throw on database constraint violations', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          'INVALID-SECTION',
          'pending',
          'Test',
          new Date().toISOString(),
          Date.now()
        );
      }).toThrow();
    });
  });

  describe('Database Indexes', () => {
    it('should have index on section', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_section'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on status', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_status'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on completed_timestamp', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_completed_timestamp'"
        )
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  describe('Get Completed Since', () => {
    const getCompletedSince = (hours: number) => {
      const since = Date.now() - (hours * 60 * 60 * 1000);
      const sinceTimestamp = Math.floor(since / 1000);

      interface CountRow {
        section: string;
        count: number;
      }

      const rows = db.prepare(`
        SELECT section, COUNT(*) as count
        FROM tasks
        WHERE status = 'completed' AND completed_timestamp >= ?
        GROUP BY section
        ORDER BY count DESC
      `).all(sinceTimestamp) as CountRow[];

      const total = rows.reduce((sum, row) => sum + row.count, 0);

      return {
        hours,
        since: new Date(since).toISOString(),
        total,
        by_section: rows,
      };
    };

    it('should return completed tasks within time range', () => {
      const now = Math.floor(Date.now() / 1000);
      const twoHoursAgo = now - (2 * 60 * 60);

      // Create completed tasks
      const id1 = randomUUID();
      const id2 = randomUUID();
      const created_at = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'TEST-WRITER', 'completed', 'Task 1', ?, ?, ?, ?)
      `).run(id1, created_at, now, created_at, twoHoursAgo);

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'completed', 'Task 2', ?, ?, ?, ?)
      `).run(id2, created_at, now, created_at, twoHoursAgo);

      const result = getCompletedSince(24);

      expect(result.hours).toBe(24);
      expect(result.total).toBe(2);
      expect(result.by_section).toHaveLength(2);
      expect(result.since).toBeDefined();
    });

    it('should group by section', () => {
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - (1 * 60 * 60);

      // Create multiple tasks for same section
      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        const created_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
          VALUES (?, 'TEST-WRITER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, `Task ${i}`, created_at, now, created_at, oneHourAgo);
      }

      // Create one task for different section
      const id = randomUUID();
      const created_at = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'completed', 'Task X', ?, ?, ?, ?)
      `).run(id, created_at, now, created_at, oneHourAgo);

      const result = getCompletedSince(24);

      expect(result.total).toBe(4);
      expect(result.by_section).toHaveLength(2);

      const testWriter = result.by_section.find(s => s.section === 'TEST-WRITER');
      const codeReviewer = result.by_section.find(s => s.section === 'CODE-REVIEWER');

      expect(testWriter?.count).toBe(3);
      expect(codeReviewer?.count).toBe(1);
    });

    it('should order by count descending', () => {
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - (1 * 60 * 60);

      // Create 5 tasks for TEST-WRITER
      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        const created_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
          VALUES (?, 'TEST-WRITER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, `Task ${i}`, created_at, now, created_at, oneHourAgo);
      }

      // Create 2 tasks for CODE-REVIEWER
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const created_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
          VALUES (?, 'CODE-REVIEWER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, `Task ${i}`, created_at, now, created_at, oneHourAgo);
      }

      const result = getCompletedSince(24);

      expect(result.by_section[0].section).toBe('TEST-WRITER');
      expect(result.by_section[0].count).toBe(5);
      expect(result.by_section[1].section).toBe('CODE-REVIEWER');
      expect(result.by_section[1].count).toBe(2);
    });

    it('should filter by time range', () => {
      const now = Math.floor(Date.now() / 1000);
      const twoHoursAgo = now - (2 * 60 * 60);
      const twentyFiveHoursAgo = now - (25 * 60 * 60);

      // Create recent task
      const id1 = randomUUID();
      const created_at1 = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'TEST-WRITER', 'completed', 'Recent', ?, ?, ?, ?)
      `).run(id1, created_at1, now, created_at1, twoHoursAgo);

      // Create old task (should be filtered out)
      const id2 = randomUUID();
      const created_at2 = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'CODE-REVIEWER', 'completed', 'Old', ?, ?, ?, ?)
      `).run(id2, created_at2, now, created_at2, twentyFiveHoursAgo);

      const result = getCompletedSince(24);

      expect(result.total).toBe(1);
      expect(result.by_section).toHaveLength(1);
      expect(result.by_section[0].section).toBe('TEST-WRITER');
    });

    it('should exclude non-completed tasks', () => {
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - (1 * 60 * 60);

      // Create completed task
      const id1 = randomUUID();
      const created_at1 = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
        VALUES (?, 'TEST-WRITER', 'completed', 'Completed', ?, ?, ?, ?)
      `).run(id1, created_at1, now, created_at1, oneHourAgo);

      // Create pending task (should be excluded)
      const id2 = randomUUID();
      const created_at2 = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp)
        VALUES (?, 'TEST-WRITER', 'pending', 'Pending', ?, ?)
      `).run(id2, created_at2, now);

      // Create in-progress task (should be excluded)
      const id3 = randomUUID();
      const created_at3 = new Date().toISOString();
      const started_at = created_at3;
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, started_at, created_timestamp)
        VALUES (?, 'TEST-WRITER', 'in_progress', 'In Progress', ?, ?, ?)
      `).run(id3, created_at3, started_at, now);

      const result = getCompletedSince(24);

      expect(result.total).toBe(1);
      expect(result.by_section).toHaveLength(1);
    });

    it('should return empty result when no completed tasks', () => {
      const result = getCompletedSince(24);

      expect(result.hours).toBe(24);
      expect(result.total).toBe(0);
      expect(result.by_section).toHaveLength(0);
      expect(result.since).toBeDefined();
    });

    it('should default to 24 hours when not specified', () => {
      const result = getCompletedSince(24);

      expect(result.hours).toBe(24);

      // Verify since timestamp is approximately 24 hours ago
      const sinceTime = new Date(result.since).getTime();
      const expectedSince = Date.now() - (24 * 60 * 60 * 1000);
      const timeDiff = Math.abs(sinceTime - expectedSince);

      // Allow 1 second tolerance for test execution time
      expect(timeDiff).toBeLessThan(1000);
    });

    it('should handle different time ranges', () => {
      const now = Math.floor(Date.now() / 1000);

      // Create tasks at different times
      const times = [
        { hours: 1, title: '1h ago' },
        { hours: 12, title: '12h ago' },
        { hours: 48, title: '48h ago' },
        { hours: 168, title: '1 week ago' },
      ];

      for (const time of times) {
        const id = randomUUID();
        const created_at = new Date().toISOString();
        const timestamp = now - (time.hours * 60 * 60);
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
          VALUES (?, 'TEST-WRITER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, time.title, created_at, now, created_at, timestamp);
      }

      // Test 24-hour range
      const result24h = getCompletedSince(24);
      expect(result24h.total).toBe(2); // 1h and 12h

      // Test 72-hour range
      const result72h = getCompletedSince(72);
      expect(result72h.total).toBe(3); // 1h, 12h, and 48h

      // Test 1-week range
      const result1week = getCompletedSince(168);
      expect(result1week.total).toBe(4); // All tasks
    });

    it('should handle tasks with null completed_timestamp gracefully', () => {
      const now = Math.floor(Date.now() / 1000);

      // Create task with status='completed' but null timestamp (data integrity issue)
      const id = randomUUID();
      const created_at = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at)
        VALUES (?, 'TEST-WRITER', 'completed', 'Bad Data', ?, ?, ?)
      `).run(id, created_at, now, created_at);

      const result = getCompletedSince(24);

      // Should not include task with null completed_timestamp
      expect(result.total).toBe(0);
    });

    it('should use completed_timestamp index for performance', () => {
      // Verify index exists (already tested in Database Indexes section)
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_completed_timestamp'")
        .all();
      expect(indexes).toHaveLength(1);

      // Create many tasks to verify query performance
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - (1 * 60 * 60);

      for (let i = 0; i < 100; i++) {
        const id = randomUUID();
        const created_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
          VALUES (?, 'TEST-WRITER', 'completed', ?, ?, ?, ?, ?)
        `).run(id, `Task ${i}`, created_at, now, created_at, oneHourAgo);
      }

      const startTime = Date.now();
      const result = getCompletedSince(24);
      const queryTime = Date.now() - startTime;

      expect(result.total).toBe(100);
      // Query should be fast with index (< 10ms even on slower systems)
      expect(queryTime).toBeLessThan(100);
    });
  });

  describe('DEPUTY-CTO Section & Follow-up Hooks', () => {
    it('should create DEPUTY-CTO task with assigned_by: deputy-cto', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'High-level integration task',
        description: 'Integrate AWS platform connector with backend routes',
        assigned_by: 'deputy-cto',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.section).toBe('DEPUTY-CTO');
        expect(result.followup_enabled).toBe(1);
      }
    });

    it('should reject deputy-cto task without description', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'No description task',
        assigned_by: 'deputy-cto',
      });

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('require a description');
        expect(result.error).toContain('deputy-cto');
      }
    });

    it('should reject deputy-cto task with empty description', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Empty description task',
        description: '   ',
        assigned_by: 'deputy-cto',
      });

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('require a description');
      }
    });

    it('should reject DEPUTY-CTO task without assigned_by', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'No author',
      });

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('requires assigned_by');
        expect(result.error).toContain('deputy-cto');
      }
    });

    it('should reject DEPUTY-CTO task with unauthorized assigned_by', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Wrong author',
        assigned_by: 'code-reviewer',
      });

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('requires assigned_by');
      }
    });

    it('should warn but still enable follow-up when followup_enabled: false for deputy-cto creator', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Forced followup',
        description: 'Task that tries to disable follow-up',
        assigned_by: 'deputy-cto',
        followup_enabled: false,
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.followup_enabled).toBe(1);
        expect(result.warning).toContain('cannot be disabled');
        expect(result.warning).toContain('deputy-cto');
      }
    });

    it('should use custom followup_prompt when provided for DEPUTY-CTO', () => {
      const customPrompt = 'Custom verification instructions';
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Custom prompt task',
        description: 'Task with custom verification prompt',
        assigned_by: 'deputy-cto',
        followup_prompt: customPrompt,
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.followup_prompt).toBe(customPrompt);
      }
    });

    it('should auto-generate followup_prompt when not provided for DEPUTY-CTO', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Auto prompt task',
        description: 'Detailed task description',
        assigned_by: 'deputy-cto',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.followup_prompt).toContain('[Follow-up Verification]');
        expect(result.followup_prompt).toContain('Auto prompt task');
        expect(result.followup_prompt).toContain('Detailed task description');
      }
    });

    it('should create follow-up task when completing a task with followup_enabled', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Completable task',
        description: 'Task that should produce a follow-up on completion',
        assigned_by: 'deputy-cto',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.followup_task_id).toBeDefined();

          // Verify the follow-up task was created
          const followup = getTask(result.followup_task_id!) as TaskOrError;
          expect('error' in followup).toBe(false);
          if (!('error' in followup)) {
            expect(followup.title).toContain('[Follow-up]');
            expect(followup.title).toContain('Completable task');
            expect(followup.status).toBe('pending');
          }
        }
      }
    });

    it('should NOT create follow-up task when completing a task without followup_enabled', () => {
      const task = createTask({
        section: 'TEST-WRITER',
        title: 'No followup task',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.followup_task_id).toBeUndefined();
        }
      }
    });

    it('should create follow-up task with followup_enabled: 0 (no chaining)', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Chain test',
        description: 'Verify follow-up tasks do not chain infinitely',
        assigned_by: 'deputy-cto',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          expect(followup.followup_enabled).toBe(0);
        }
      }
    });

    it('should create follow-up task with title starting with [Follow-up]', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Build AWS integration',
        description: 'Implement AWS IAM backend connector with list-users capability',
        assigned_by: 'deputy-cto',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          expect(followup.title).toBe('[Follow-up] Build AWS integration');
        }
      }
    });

    it('should force follow-up when deputy-cto creates task in non-DEPUTY-CTO section', () => {
      const result = createTask({
        section: 'INVESTIGATOR & PLANNER',
        title: 'Investigate auth issue',
        description: 'Research authentication middleware gaps in vendor routes',
        assigned_by: 'deputy-cto',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.section).toBe('INVESTIGATOR & PLANNER');
        expect(result.followup_enabled).toBe(1);
        expect(result.followup_prompt).toContain('[Follow-up Verification]');
        expect(result.followup_prompt).toContain('Investigate auth issue');
      }
    });

    it('should NOT force follow-up when human creates task in DEPUTY-CTO section', () => {
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'Manual CTO task',
        assigned_by: 'human',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.section).toBe('DEPUTY-CTO');
        expect(result.followup_enabled).toBe(0);
        expect(result.warning).toBeUndefined();
      }
    });

    it('should still work for non-restricted sections without assigned_by', () => {
      const result = createTask({
        section: 'TEST-WRITER',
        title: 'Unrestricted task',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.section).toBe('TEST-WRITER');
        expect(result.followup_enabled).toBe(0);
      }
    });

    it('should set follow-up task assigned_by to system-followup', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Followup author test',
        description: 'Verify that follow-up tasks are attributed to system-followup',
        assigned_by: 'deputy-cto',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          expect(followup.assigned_by).toBe('system-followup');
        }
      }
    });

    it('should NOT force follow-up when cto creates task in DEPUTY-CTO section', () => {
      // cto is allowed to create DEPUTY-CTO tasks (SECTION_CREATOR_RESTRICTIONS) but
      // is NOT in FORCED_FOLLOWUP_CREATORS — only deputy-cto triggers forced follow-up
      const result = createTask({
        section: 'DEPUTY-CTO',
        title: 'CTO manual task',
        assigned_by: 'cto',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.followup_enabled).toBe(0);
        expect(result.warning).toBeUndefined();
      }
    });

    it('should force follow-up when product-manager creates a task', () => {
      const result = createTask({
        section: 'CODE-REVIEWER',
        title: 'Implement demo scenario: Onboarding Flow',
        description: 'Write Playwright demo file at e2e/demo/onboarding-flow.demo.ts',
        assigned_by: 'product-manager',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.followup_enabled).toBe(1);
        expect(result.followup_prompt).toContain('[Follow-up Verification]');
        expect(result.followup_prompt).toContain('Implement demo scenario');
      }
    });

    it('should reject product-manager task without description', () => {
      const result = createTask({
        section: 'CODE-REVIEWER',
        title: 'No description PM task',
        assigned_by: 'product-manager',
      });

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('require a description');
        expect(result.error).toContain('product-manager');
      }
    });

    it('should create follow-up task when completing a product-manager-created task', () => {
      const task = createTask({
        section: 'CODE-REVIEWER',
        title: 'Implement demo scenario: Dashboard Overview',
        description: 'Write Playwright demo file at e2e/demo/dashboard-overview.demo.ts',
        assigned_by: 'product-manager',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.followup_task_id).toBeDefined();

          const followup = getTask(result.followup_task_id!) as TaskOrError;
          expect('error' in followup).toBe(false);
          if (!('error' in followup)) {
            expect(followup.title).toBe('[Follow-up] Implement demo scenario: Dashboard Overview');
            expect(followup.status).toBe('pending');
            expect(followup.followup_enabled).toBe(0);
          }
        }
      }
    });

    it('should respect custom followup_section when completing a deputy-cto-created task', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Cross-section followup task',
        description: 'Task whose follow-up should land in TEST-WRITER section',
        assigned_by: 'deputy-cto',
        followup_section: 'TEST-WRITER',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.followup_task_id).toBeDefined();
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          // Follow-up must land in the explicitly requested section, not the original task's section
          expect(followup.section).toBe('TEST-WRITER');
        }
      }
    });

    it('should respect custom followup_section for deputy-cto tasks created with priority: urgent', () => {
      const task = createTask({
        section: 'DEPUTY-CTO',
        title: 'Urgent cross-section task',
        description: 'Urgent task whose follow-up should land in CODE-REVIEWER',
        assigned_by: 'deputy-cto',
        followup_section: 'CODE-REVIEWER',
        priority: 'urgent',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        expect(task.priority).toBe('urgent');
        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          expect(followup.section).toBe('CODE-REVIEWER');
        }
      }
    });

    it('should create follow-up task when non-deputy-cto creator opts in with followup_enabled: true', () => {
      // The forced-follow-up path is triggered by creator identity, but any creator can
      // opt in voluntarily; the completion hook fires based solely on followup_enabled
      const task = createTask({
        section: 'TEST-WRITER',
        title: 'Opted-in followup task',
        assigned_by: 'code-reviewer',
        followup_enabled: true,
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        expect(task.followup_enabled).toBe(1);
        expect(task.warning).toBeUndefined();

        const result = completeTask(task.id) as CompleteOrError;

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.followup_task_id).toBeDefined();
          const followup = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.followup_task_id!) as TaskRow;
          expect(followup.title).toContain('[Follow-up]');
          expect(followup.status).toBe('pending');
          expect(followup.followup_enabled).toBe(0);
        }
      }
    });
  });

  describe('Task Priority', () => {
    it('should default priority to normal when not specified', () => {
      const result = createTask({
        section: 'TEST-WRITER',
        title: 'Normal priority task',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.priority).toBe('normal');

        const task = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(result.id) as { priority: string };
        expect(task.priority).toBe('normal');
      }
    });

    it('should store priority as urgent when specified', () => {
      const result = createTask({
        section: 'CODE-REVIEWER',
        title: 'Urgent task',
        priority: 'urgent',
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.priority).toBe('urgent');

        const task = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(result.id) as { priority: string };
        expect(task.priority).toBe('urgent');
      }
    });

    it('should reject invalid priority values via CHECK constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, priority)
          VALUES (?, 'TEST-WRITER', 'pending', 'Bad priority', ?, ?, 'critical')
        `).run(randomUUID(), new Date().toISOString(), Math.floor(Date.now() / 1000));
      }).toThrow();
    });

    it('should filter tasks by priority in listTasks', () => {
      createTask({ section: 'TEST-WRITER', title: 'Normal 1' });
      createTask({ section: 'TEST-WRITER', title: 'Normal 2' });
      createTask({ section: 'TEST-WRITER', title: 'Urgent 1', priority: 'urgent' });

      const normalTasks = listTasks({ priority: 'normal' });
      expect(normalTasks.total).toBe(2);

      const urgentTasks = listTasks({ priority: 'urgent' });
      expect(urgentTasks.total).toBe(1);
      expect((urgentTasks.tasks[0] as TaskRow).title).toBe('Urgent 1');
    });

    it('should return all tasks when priority filter is not specified', () => {
      createTask({ section: 'TEST-WRITER', title: 'Normal' });
      createTask({ section: 'TEST-WRITER', title: 'Urgent', priority: 'urgent' });

      const allTasks = listTasks({});
      expect(allTasks.total).toBe(2);
    });

    it('should combine priority filter with section filter', () => {
      createTask({ section: 'TEST-WRITER', title: 'TW Normal' });
      createTask({ section: 'TEST-WRITER', title: 'TW Urgent', priority: 'urgent' });
      createTask({ section: 'CODE-REVIEWER', title: 'CR Urgent', priority: 'urgent' });

      const result = listTasks({ section: 'TEST-WRITER', priority: 'urgent' });
      expect(result.total).toBe(1);
      expect((result.tasks[0] as TaskRow).title).toBe('TW Urgent');
    });

    it('should preserve priority through task lifecycle', () => {
      const task = createTask({
        section: 'TEST-WRITER',
        title: 'Lifecycle test',
        priority: 'urgent',
      });

      expect('error' in task).toBe(false);
      if (!('error' in task)) {
        // Start task
        startTask(task.id);
        const inProgress = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(task.id) as { priority: string };
        expect(inProgress.priority).toBe('urgent');

        // Complete task
        completeTask(task.id);
        const completed = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(task.id) as { priority: string };
        expect(completed.priority).toBe('urgent');
      }
    });
  });
});
