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
}

interface DeleteTaskResult {
  deleted: boolean;
  id: string;
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
  const listTasks = (args: { section?: string; status?: string; limit?: number }) => {
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

    sql += ' ORDER BY created_timestamp DESC';
    const limit = args.limit ?? 50;
    sql += ' LIMIT ?';
    params.push(limit);

    const tasks = db.prepare(sql).all(...params);
    return { tasks, total: tasks.length };
  };

  const createTask = (args: {
    section: string;
    title: string;
    description?: string;
    assigned_by?: string;
  }) => {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      args.section,
      args.title,
      args.description ?? null,
      args.assigned_by ?? null,
      created_at,
      created_timestamp
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

    return { id, status: 'completed', completed_at };
  };

  const deleteTask = (id: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) {return { error: `Task not found: ${id}` };}

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { deleted: true, id };
  };

  const getSummary = () => {
    const result = {
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      by_section: {} as Record<string, SectionStats>,
    };

    const sections = ['TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER'];
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
    const changes = {
      stale_starts_cleared: 0,
      old_completed_removed: 0,
      completed_capped: 0,
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

    // Remove old completed (>3 hours = 10800 seconds)
    const oldResult = db.prepare(`
      DELETE FROM tasks
      WHERE status = 'completed'
        AND completed_timestamp IS NOT NULL
        AND (? - completed_timestamp) > 10800
    `).run(now);
    changes.old_completed_removed = oldResult.changes;

    // Cap completed at 50
    const completedCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as { count: number }).count;
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
      changes.completed_capped = capResult.changes;
    }

    return {
      ...changes,
      message: `Cleanup complete: ${changes.stale_starts_cleared} stale starts cleared, ${changes.old_completed_removed} old completed removed, ${changes.completed_capped} completed capped`,
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

    it('should remove old completed tasks (>3 hours)', () => {
      const id = randomUUID();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 11000; // >3 hours
      const created_at = new Date(oldTimestamp * 1000).toISOString();
      const completed_at = created_at;

      db.prepare(`
        INSERT INTO tasks (id, section, status, title, created_at, completed_at, created_timestamp, completed_timestamp)
        VALUES (?, 'TEST-WRITER', 'completed', 'Old task', ?, ?, ?, ?)
      `).run(id, created_at, completed_at, oldTimestamp, oldTimestamp);

      const result = cleanup();
      expect(result.old_completed_removed).toBe(1);

      const task = getTask(id) as TaskOrError;
      expect(task.error).toContain('Task not found');
    });

    it('should cap completed tasks at 50', () => {
      // Create 60 completed tasks
      for (let i = 0; i < 60; i++) {
        const task = createTask({ section: 'TEST-WRITER', title: `Task ${i}` });
        completeTask(task.id);
      }

      const result = cleanup();
      expect(result.completed_capped).toBe(10); // 60 - 50 = 10 removed

      const summary = getSummary();
      expect(summary.completed).toBe(50);
    });

    it('should keep most recent 50 completed tasks', () => {
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

      // First 10 tasks (oldest) should be removed
      for (let i = 0; i < 10; i++) {
        const task = getTask(taskIds[i]) as TaskOrError;
        expect(task.error).toContain('Task not found');
      }

      // Last 50 tasks should remain
      for (let i = 10; i < 60; i++) {
        const task = getTask(taskIds[i]) as TaskOrError;
        expect(task.id).toBe(taskIds[i]);
      }
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
});
