/**
 * Unit tests for Deputy-CTO MCP Server
 *
 * Tests G001 fail-closed behavior for autonomous mode configuration,
 * question management, commit approval/rejection, and task spawning.
 *
 * Uses in-memory SQLite database and temporary file fixtures for isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { createTestDb, createTempDir } from '../../__testUtils__/index.js';
import { DEPUTY_CTO_SCHEMA } from '../../__testUtils__/schemas.js';

// Database row types for type safety
interface QuestionRow {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string;
  context?: string;
  created_at: string;
  created_timestamp: number;
  answered_at?: string;
  answer?: string;
}

describe('Deputy-CTO Server', () => {
  let db: Database.Database;
  let tempDir: ReturnType<typeof createTempDir>;
  let configPath: string;
  let statePath: string;

  beforeEach(() => {
    // Create in-memory database for each test using shared utility
    db = createTestDb(DEPUTY_CTO_SCHEMA);

    // Create temp directory for file testing using shared utility
    tempDir = createTempDir('deputy-cto-test');
    configPath = path.join(tempDir.path, 'autonomous-mode.json');
    statePath = path.join(tempDir.path, 'hourly-automation-state.json');
  });

  afterEach(() => {
    db.close();
    // Clean up temp directory using the cleanup function
    tempDir.cleanup();
  });

  // Helper functions that mirror server implementation
  interface AutonomousModeConfig {
    enabled: boolean;
    planExecutorEnabled: boolean;
    claudeMdRefactorEnabled: boolean;
    lastModified: string | null;
    modifiedBy: string | null;
  }

  const getAutonomousConfig = (filePath: string): AutonomousModeConfig => {
    const defaults: AutonomousModeConfig = {
      enabled: false,
      planExecutorEnabled: true,
      claudeMdRefactorEnabled: true,
      lastModified: null,
      modifiedBy: null,
    };

    if (!fs.existsSync(filePath)) {
      return defaults;
    }

    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...defaults, ...config };
    } catch (err) {
      // G001: Config corruption logged but fail-safe to disabled mode
      console.error(`[deputy-cto] Config file corrupted - autonomous mode DISABLED: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[deputy-cto] Fix: Delete or repair the config file`);
      return defaults;
    }
  };

  const getNextRunMinutes = (filePath: string, cooldownMinutes: number = 55): number | null => {
    if (!fs.existsSync(filePath)) {
      return 0; // First run would happen immediately
    }

    try {
      const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const lastRun = state.lastRun || 0;
      const now = Date.now();
      const timeSinceLastRun = now - lastRun;
      const cooldownMs = cooldownMinutes * 60 * 1000;

      if (timeSinceLastRun >= cooldownMs) {
        return 0; // Would run now if service triggers
      }

      return Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
    } catch (err) {
      // G001: State file corruption - return null to indicate unknown state
      console.error(`[deputy-cto] State file corrupted: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[deputy-cto] Fix: Delete the state file to reset.`);
      return null;
    }
  };

  const getAutonomousModeStatus = (cfgPath: string, stPath: string) => {
    const config = getAutonomousConfig(cfgPath);
    const nextRunIn = config.enabled ? getNextRunMinutes(stPath) : null;

    let message: string;
    if (!config.enabled) {
      message = 'Autonomous Deputy CTO Mode is DISABLED.';
    } else if (nextRunIn === null) {
      message = 'Autonomous Deputy CTO Mode is ENABLED. Status unknown (state file error).';
    } else if (nextRunIn === 0) {
      message = 'Autonomous Deputy CTO Mode is ENABLED. Ready to run (waiting for service trigger).';
    } else {
      message = `Autonomous Deputy CTO Mode is ENABLED. Next run in ~${nextRunIn} minute(s).`;
    }

    return {
      enabled: config.enabled,
      planExecutorEnabled: config.planExecutorEnabled,
      claudeMdRefactorEnabled: config.claudeMdRefactorEnabled,
      lastModified: config.lastModified,
      nextRunIn,
      message,
    };
  };

  const addQuestion = (args: {
    type: string;
    title: string;
    description: string;
    context?: string;
    suggested_options?: string[];
  }) => {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, suggested_options, created_at, created_timestamp)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.title,
      args.description,
      args.context ?? null,
      args.suggested_options ? JSON.stringify(args.suggested_options) : null,
      created_at,
      created_timestamp
    );

    return {
      id,
      message: `Question added for CTO. ID: ${id}`,
    };
  };

  const getPendingRejectionCount = (): number => {
    const result = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
    ).get() as { count: number };
    return result.count;
  };

  const approveCommit = (rationale: string) => {
    const rejectionCount = getPendingRejectionCount();
    if (rejectionCount > 0) {
      return {
        approved: false,
        decision_id: '',
        message: `Cannot approve commit: ${rejectionCount} pending rejection(s) must be addressed first.`,
      };
    }

    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
      VALUES (?, 'approved', ?, ?, ?)
    `).run(id, rationale, created_at, created_timestamp);

    return {
      approved: true,
      decision_id: id,
      message: 'Commit approved. Pre-commit hook will allow the commit to proceed.',
    };
  };

  const rejectCommit = (args: { title: string; description: string }) => {
    const decisionId = randomUUID();
    const questionId = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    // Create commit decision
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'rejected', ?, ?, ?, ?)
    `).run(decisionId, args.description, questionId, created_at, created_timestamp);

    // Create question entry for CTO to address
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'rejection', 'pending', ?, ?, ?, ?)
    `).run(questionId, args.title, args.description, created_at, created_timestamp);

    return {
      rejected: true,
      decision_id: decisionId,
      question_id: questionId,
      message: `Commit rejected. Question created for CTO (ID: ${questionId}). Commits will be blocked until CTO addresses this.`,
    };
  };

  describe('G001 Fail-Closed: getAutonomousConfig()', () => {
    it('should return defaults when config file does not exist', () => {
      const config = getAutonomousConfig(configPath);

      expect(config.enabled).toBe(false);
      expect(config.planExecutorEnabled).toBe(true);
      expect(config.claudeMdRefactorEnabled).toBe(true);
      expect(config.lastModified).toBe(null);
      expect(config.modifiedBy).toBe(null);
    });

    it('should load valid config file', () => {
      const validConfig = {
        enabled: true,
        planExecutorEnabled: true,
        claudeMdRefactorEnabled: false,
        lastModified: '2026-01-20T10:00:00Z',
        modifiedBy: 'deputy-cto',
      };

      fs.writeFileSync(configPath, JSON.stringify(validConfig, null, 2));

      const config = getAutonomousConfig(configPath);

      expect(config.enabled).toBe(true);
      expect(config.planExecutorEnabled).toBe(true);
      expect(config.claudeMdRefactorEnabled).toBe(false);
      expect(config.lastModified).toBe('2026-01-20T10:00:00Z');
      expect(config.modifiedBy).toBe('deputy-cto');
    });

    it('should fail-closed (disabled) when config file is corrupted', () => {
      // Write invalid JSON
      fs.writeFileSync(configPath, '{ invalid json }');

      // Spy on console.error to verify error logging
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = getAutonomousConfig(configPath);

      // G001: MUST return fail-safe defaults (enabled: false)
      expect(config.enabled).toBe(false);
      expect(config.planExecutorEnabled).toBe(true);
      expect(config.claudeMdRefactorEnabled).toBe(true);
      expect(config.lastModified).toBe(null);
      expect(config.modifiedBy).toBe(null);

      // G001: MUST log error message
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[deputy-cto] Config file corrupted - autonomous mode DISABLED')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[deputy-cto] Fix: Delete or repair the config file')
      );

      consoleErrorSpy.mockRestore();
    });

    it('should fail-closed when config file is empty', () => {
      fs.writeFileSync(configPath, '');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = getAutonomousConfig(configPath);

      expect(config.enabled).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should fail-closed when config file contains non-JSON data', () => {
      fs.writeFileSync(configPath, 'This is not JSON at all!');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = getAutonomousConfig(configPath);

      expect(config.enabled).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should merge partial config with defaults', () => {
      // Config missing some fields
      const partialConfig = {
        enabled: true,
      };

      fs.writeFileSync(configPath, JSON.stringify(partialConfig));

      const config = getAutonomousConfig(configPath);

      expect(config.enabled).toBe(true);
      expect(config.planExecutorEnabled).toBe(true); // Default
      expect(config.claudeMdRefactorEnabled).toBe(true); // Default
    });
  });

  describe('G001 Fail-Closed: getNextRunMinutes()', () => {
    it('should return 0 when state file does not exist (first run)', () => {
      const nextRun = getNextRunMinutes(statePath);

      expect(nextRun).toBe(0);
    });

    it('should calculate minutes until next run when within cooldown', () => {
      const now = Date.now();
      const lastRun = now - (30 * 60 * 1000); // 30 minutes ago

      fs.writeFileSync(statePath, JSON.stringify({ lastRun }));

      const nextRun = getNextRunMinutes(statePath, 55);

      // Should be ~25 minutes (55 - 30)
      expect(nextRun).toBeGreaterThanOrEqual(24);
      expect(nextRun).toBeLessThanOrEqual(26);
      expect(typeof nextRun).toBe('number');
    });

    it('should return 0 when cooldown has expired', () => {
      const now = Date.now();
      const lastRun = now - (60 * 60 * 1000); // 60 minutes ago

      fs.writeFileSync(statePath, JSON.stringify({ lastRun }));

      const nextRun = getNextRunMinutes(statePath, 55);

      expect(nextRun).toBe(0);
    });

    it('should fail-closed (return null) when state file is corrupted', () => {
      // Write invalid JSON
      fs.writeFileSync(statePath, '{ corrupt: data');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const nextRun = getNextRunMinutes(statePath);

      // G001: MUST return null to indicate unknown state
      expect(nextRun).toBe(null);

      // G001: MUST log error message
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[deputy-cto] State file corrupted')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[deputy-cto] Fix: Delete the state file to reset.')
      );

      consoleErrorSpy.mockRestore();
    });

    it('should fail-closed when state file is empty', () => {
      fs.writeFileSync(statePath, '');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const nextRun = getNextRunMinutes(statePath);

      expect(nextRun).toBe(null);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should handle missing lastRun field gracefully', () => {
      // State file exists but missing lastRun
      fs.writeFileSync(statePath, JSON.stringify({ someOtherField: 'value' }));

      const nextRun = getNextRunMinutes(statePath);

      // Should use 0 as default for lastRun, making it ready to run
      expect(nextRun).toBe(0);
    });
  });

  describe('G001 Fail-Closed: getAutonomousModeStatus()', () => {
    it('should show "status unknown" when nextRunMinutes is null (state file corrupt)', () => {
      // Create valid config (enabled)
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, planExecutorEnabled: true, claudeMdRefactorEnabled: true })
      );

      // Create corrupt state file
      fs.writeFileSync(statePath, '{ invalid json');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.nextRunIn).toBe(null);
      expect(status.message).toBe(
        'Autonomous Deputy CTO Mode is ENABLED. Status unknown (state file error).'
      );

      consoleErrorSpy.mockRestore();
    });

    it('should show disabled message when config is disabled', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: false })
      );

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(false);
      expect(status.nextRunIn).toBe(null);
      expect(status.message).toBe('Autonomous Deputy CTO Mode is DISABLED.');
    });

    it('should show ready to run when nextRunIn is 0', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true })
      );
      // No state file means first run (nextRunIn = 0)

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.nextRunIn).toBe(0);
      expect(status.message).toBe(
        'Autonomous Deputy CTO Mode is ENABLED. Ready to run (waiting for service trigger).'
      );
    });

    it('should show minutes until next run', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true })
      );

      const now = Date.now();
      const lastRun = now - (30 * 60 * 1000); // 30 minutes ago
      fs.writeFileSync(statePath, JSON.stringify({ lastRun }));

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.nextRunIn).toBeGreaterThan(0);
      expect(status.message).toContain('Next run in ~');
      expect(status.message).toContain('minute(s)');
    });

    it('should fail-closed when config is corrupt (shows disabled)', () => {
      // Corrupt config file
      fs.writeFileSync(configPath, 'not json');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const status = getAutonomousModeStatus(configPath, statePath);

      // G001: Should fail-closed to disabled state
      expect(status.enabled).toBe(false);
      expect(status.message).toBe('Autonomous Deputy CTO Mode is DISABLED.');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Question Management', () => {
    it('should add a question to the database', () => {
      const result = addQuestion({
        type: 'decision',
        title: 'Should we proceed with this change?',
        description: 'This change affects multiple components.',
        context: 'PR #123',
        suggested_options: ['Proceed', 'Defer', 'Reject'],
      });

      expect(result.id).toBeDefined();
      expect(result.message).toContain('Question added for CTO');

      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.id) as QuestionRow | undefined;
      expect(question.type).toBe('decision');
      expect(question.status).toBe('pending');
      expect(question.title).toBe('Should we proceed with this change?');
    });

    it('should enforce valid question type constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
          VALUES (?, ?, 'pending', ?, ?, ?, ?)
        `).run(
          randomUUID(),
          'invalid-type',
          'Test',
          'Description',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }).toThrow();
    });

    it('should enforce valid status constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          'decision',
          'invalid-status',
          'Test',
          'Description',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }).toThrow();
    });
  });

  describe('Commit Approval/Rejection', () => {
    it('should approve commit when no pending rejections', () => {
      const result = approveCommit('Changes look good');

      expect(result.approved).toBe(true);
      expect(result.decision_id).toBeDefined();
      expect(result.message).toContain('Commit approved');
    });

    it('should block commit approval when pending rejections exist (G001)', () => {
      // Create a rejection
      rejectCommit({
        title: 'Security concern',
        description: 'Found potential SQL injection',
      });

      const result = approveCommit('Trying to approve anyway');

      // G001: MUST fail-closed - reject approval
      expect(result.approved).toBe(false);
      expect(result.decision_id).toBe('');
      expect(result.message).toContain('Cannot approve commit');
      expect(result.message).toContain('pending rejection(s) must be addressed first');
    });

    it('should create rejection decision and question', () => {
      const result = rejectCommit({
        title: 'Breaking change detected',
        description: 'This breaks API compatibility',
      });

      expect(result.rejected).toBe(true);
      expect(result.decision_id).toBeDefined();
      expect(result.question_id).toBeDefined();
      expect(result.message).toContain('Commit rejected');

      // Verify decision was created
      const decision = db
        .prepare('SELECT * FROM commit_decisions WHERE id = ?')
        .get(result.decision_id) as QuestionRow | undefined;
      expect(decision.decision).toBe('rejected');

      // Verify question was created
      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.question_id) as QuestionRow | undefined;
      expect(question.type).toBe('rejection');
      expect(question.status).toBe('pending');
      expect(question.title).toBe('Breaking change detected');
    });

    it('should count pending rejections correctly', () => {
      expect(getPendingRejectionCount()).toBe(0);

      rejectCommit({
        title: 'Issue 1',
        description: 'Problem 1',
      });

      expect(getPendingRejectionCount()).toBe(1);

      rejectCommit({
        title: 'Issue 2',
        description: 'Problem 2',
      });

      expect(getPendingRejectionCount()).toBe(2);
    });
  });

  describe('Database Indexes', () => {
    it('should have index on questions.status', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_questions_status'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on questions.type', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_questions_type'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on commit_decisions.created_timestamp', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_commit_decisions_created'"
        )
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on cleared_questions.cleared_timestamp', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cleared_questions_cleared'"
        )
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  describe('Data Cleanup Functions', () => {
    const cleanupOldRecords = () => {
      // Clean commit_decisions: keep only last 100
      const commitDecisionsResult = db.prepare(`
        DELETE FROM commit_decisions WHERE id NOT IN (
          SELECT id FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 100
        )
      `).run();

      // Clean cleared_questions: keep last 500 OR anything within 30 days
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
      const clearedQuestionsResult = db.prepare(`
        DELETE FROM cleared_questions
        WHERE cleared_timestamp < ?
        AND id NOT IN (
          SELECT id FROM cleared_questions ORDER BY cleared_timestamp DESC LIMIT 500
        )
      `).run(thirtyDaysAgo);

      const commitDeleted = commitDecisionsResult.changes;
      const clearedDeleted = clearedQuestionsResult.changes;
      const totalDeleted = commitDeleted + clearedDeleted;

      return {
        commit_decisions_deleted: commitDeleted,
        cleared_questions_deleted: clearedDeleted,
        message:
          totalDeleted === 0
            ? 'No old records found to clean up. Database is within retention limits.'
            : `Cleaned up ${totalDeleted} old record(s): ${commitDeleted} commit decision(s), ${clearedDeleted} cleared question(s).`,
      };
    };

    it('should not delete any records when database is within limits', () => {
      // Add only 10 commit decisions
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      // Add only 10 cleared questions
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(id, 'Test', 'Description', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      const result = cleanupOldRecords();

      expect(result.commit_decisions_deleted).toBe(0);
      expect(result.cleared_questions_deleted).toBe(0);
      expect(result.message).toContain('within retention limits');
    });

    it('should delete commit decisions beyond the 100 limit', () => {
      // Add 150 commit decisions
      const ids: string[] = [];
      for (let i = 0; i < 150; i++) {
        const id = randomUUID();
        ids.push(id);
        const now = Date.now() - i * 1000; // Stagger timestamps
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      const result = cleanupOldRecords();

      // Should delete 50 records (150 - 100)
      expect(result.commit_decisions_deleted).toBe(50);

      // Verify only 100 remain
      const count = db.prepare('SELECT COUNT(*) as count FROM commit_decisions').get() as {
        count: number;
      };
      expect(count.count).toBe(100);
    });

    it('should NOT delete old records if total count is under 500 (retention policy protects last 500)', () => {
      const now = Date.now();
      const fortyDaysAgo = now - 40 * 24 * 60 * 60 * 1000;

      // Add 10 old cleared questions (>30 days)
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(
          id,
          'Old Test',
          'Description',
          new Date(fortyDaysAgo).toISOString(),
          Math.floor(fortyDaysAgo / 1000)
        );
      }

      // Add 10 recent cleared questions
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(id, 'New Test', 'Description', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      const result = cleanupOldRecords();

      // With only 20 total records, ALL are within the "last 500" protection
      // So nothing should be deleted, even the old ones
      // Retention policy: keep last 500 OR anything within 30 days
      expect(result.cleared_questions_deleted).toBe(0);

      // Verify all 20 remain (retention policy protects them)
      const count = db.prepare('SELECT COUNT(*) as count FROM cleared_questions').get() as {
        count: number;
      };
      expect(count.count).toBe(20);
    });

    it('should keep last 500 cleared questions even if older than 30 days', () => {
      const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;

      // Add 550 old cleared questions (all >30 days)
      for (let i = 0; i < 550; i++) {
        const id = randomUUID();
        const timestamp = fortyDaysAgo - i * 1000; // Stagger timestamps
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(
          id,
          'Test',
          'Description',
          new Date(timestamp).toISOString(),
          Math.floor(timestamp / 1000)
        );
      }

      const result = cleanupOldRecords();

      // Should delete 50 records (550 - 500, even though all are >30 days)
      expect(result.cleared_questions_deleted).toBe(50);

      // Verify 500 remain
      const count = db.prepare('SELECT COUNT(*) as count FROM cleared_questions').get() as {
        count: number;
      };
      expect(count.count).toBe(500);
    });

    it('should be idempotent - running cleanup multiple times is safe', () => {
      // Add 150 commit decisions
      for (let i = 0; i < 150; i++) {
        const id = randomUUID();
        const now = Date.now() - i * 1000;
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      // First cleanup
      const result1 = cleanupOldRecords();
      expect(result1.commit_decisions_deleted).toBe(50);

      // Second cleanup should find nothing to clean
      const result2 = cleanupOldRecords();
      expect(result2.commit_decisions_deleted).toBe(0);
      expect(result2.message).toContain('within retention limits');

      // Third cleanup should still find nothing
      const result3 = cleanupOldRecords();
      expect(result3.commit_decisions_deleted).toBe(0);
    });

    it('should return appropriate message when records are cleaned', () => {
      // Add 150 commit decisions to trigger cleanup
      for (let i = 0; i < 150; i++) {
        const id = randomUUID();
        const now = Date.now() - i * 1000;
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', new Date(now).toISOString(), Math.floor(now / 1000));
      }

      const result = cleanupOldRecords();

      expect(result.message).toContain('Cleaned up');
      expect(result.message).toContain('50');
      expect(result.message).toContain('commit decision');
    });
  });
});
