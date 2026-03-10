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
import { randomUUID, createHmac } from 'crypto';

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
  recommendation?: string;
  created_at: string;
  created_timestamp: string;
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
    lastCtoBriefing: string | null;
  }

  const getAutonomousConfig = (filePath: string): AutonomousModeConfig => {
    const defaults: AutonomousModeConfig = {
      enabled: false,
      planExecutorEnabled: true,
      claudeMdRefactorEnabled: true,
      lastModified: null,
      modifiedBy: null,
      lastCtoBriefing: null,
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

    // Calculate CTO activity gate status
    let hoursSinceLastBriefing: number | null = null;
    let ctoGateOpen = false;
    if (config.lastCtoBriefing) {
      const briefingTime = new Date(config.lastCtoBriefing).getTime();
      if (!isNaN(briefingTime)) {
        hoursSinceLastBriefing = Math.floor((Date.now() - briefingTime) / (1000 * 60 * 60));
        ctoGateOpen = hoursSinceLastBriefing < 24;
      }
    }

    let message: string;
    if (!config.enabled) {
      message = 'Autonomous Deputy CTO Mode is DISABLED.';
    } else if (!ctoGateOpen) {
      const ageStr = hoursSinceLastBriefing !== null ? `${hoursSinceLastBriefing}h ago` : 'never';
      message = `Autonomous Deputy CTO Mode is ENABLED but CTO activity gate is CLOSED (last briefing: ${ageStr}). Run /deputy-cto to reactivate.`;
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
      lastCtoBriefing: config.lastCtoBriefing,
      ctoGateOpen,
      hoursSinceLastBriefing,
      message,
    };
  };

  const addQuestion = (args: {
    type: string;
    title: string;
    description: string;
    context?: string;
    suggested_options?: string[];
    recommendation?: string;
    investigation_task_id?: string;
  }) => {
    // Require recommendation for escalations (mirrors server validation)
    if (args.type === 'escalation' && !args.recommendation) {
      return { error: 'Escalations require a recommendation. Provide a concise statement of what you recommend and why.' };
    }

    // Block agents from creating bypass-request or protected-action-request via add_question
    if (args.type === 'bypass-request') {
      return { error: 'Cannot create bypass-request questions via add_question. Use request_bypass instead.' };
    }
    if (args.type === 'protected-action-request') {
      return { error: 'Cannot create protected-action-request questions via add_question. These are created by the protected-action hook.' };
    }

    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = now.toISOString();

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, suggested_options, recommendation, investigation_task_id, created_at, created_timestamp)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.title,
      args.description,
      args.context ?? null,
      args.suggested_options ? JSON.stringify(args.suggested_options) : null,
      args.recommendation ?? null,
      args.investigation_task_id ?? null,
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
    // Reject rationales starting with "EMERGENCY BYPASS" — only execute_bypass may use this prefix
    if (/^EMERGENCY\s+BYPASS/i.test(rationale)) {
      return {
        approved: false,
        decision_id: '',
        message: 'Cannot use "EMERGENCY BYPASS" prefix in approve_commit rationale. Use request_bypass for emergency bypass requests.',
      };
    }

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
    const created_timestamp = now.toISOString();

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
    const created_timestamp = now.toISOString();

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

  const answerQuestion = (args: { id: string; answer: string; decided_by?: string }) => {
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRow | undefined;

    if (!question) {
      return { error: `Question not found: ${args.id}` };
    }

    // Block answering bypass-request and protected-action-request questions via this tool
    if (question.type === 'bypass-request') {
      return { error: 'Cannot answer bypass-request questions via answer_question. The CTO must type "APPROVE BYPASS <code>" in chat.' };
    }
    if (question.type === 'protected-action-request') {
      return { error: 'Cannot answer protected-action-request questions via answer_question. Use approve_protected_action or deny_protected_action.' };
    }

    if (question.status === 'answered') {
      return {
        id: args.id,
        answered: true,
        message: `Question already answered at ${question.answered_at}`,
      };
    }

    const now = new Date().toISOString();
    const decidedBy = args.decided_by ?? 'cto';
    db.prepare(`
      UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, decided_by = ?
      WHERE id = ?
    `).run(args.answer, now, decidedBy, args.id);

    return {
      id: args.id,
      answered: true,
      message: `Answer recorded by ${decidedBy}. Use clear_question to remove from queue after implementing.`,
    };
  };

  const clearQuestion = (args: { id: string }) => {
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRow | undefined;

    if (!question) {
      return { error: `Question not found: ${args.id}` };
    }

    // Block clearing pending bypass-request and protected-action-request questions
    if (question.type === 'bypass-request' && question.status === 'pending') {
      return { error: 'Cannot clear a pending bypass-request. The CTO must type "APPROVE BYPASS <code>". Only answered bypass-requests can be cleared.' };
    }
    if (question.type === 'protected-action-request' && question.status === 'pending') {
      return { error: 'Cannot clear a pending protected-action-request. Use approve_protected_action or deny_protected_action.' };
    }

    const now = new Date();
    const cleared_at = now.toISOString();
    const cleared_timestamp = now.toISOString();

    db.prepare(`
      INSERT INTO cleared_questions (id, type, title, description, recommendation, answer, answered_at, decided_by, cleared_at, cleared_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      question.id,
      question.type,
      question.title,
      question.description,
      question.recommendation ?? null,
      question.answer ?? null,
      question.answered_at ?? null,
      null,
      cleared_at,
      cleared_timestamp
    );

    db.prepare('DELETE FROM questions WHERE id = ?').run(args.id);

    return {
      id: args.id,
      cleared: true,
      message: `Question cleared and archived.`,
    };
  };

  // Helper to directly insert a question of any type (bypassing addQuestion guards for test setup)
  const insertQuestionDirectly = (args: {
    type: string;
    title: string;
    description: string;
    status?: string;
    context?: string;
    created_timestamp?: string;
  }) => {
    const id = randomUUID();
    const created_timestamp = args.created_timestamp ?? new Date().toISOString();
    const created_at = created_timestamp;

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.status ?? 'pending',
      args.title,
      args.description,
      args.context ?? null,
      created_at,
      created_timestamp
    );

    return id;
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
    it('should show "status unknown" when nextRunMinutes is null (state file corrupt) and gate is open', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - 5 * 60 * 60 * 1000).toISOString(); // 5h ago

      // Create valid config (enabled) with recent briefing
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          planExecutorEnabled: true,
          claudeMdRefactorEnabled: true,
          lastCtoBriefing: recentBriefing,
        })
      );

      // Create corrupt state file
      fs.writeFileSync(statePath, '{ invalid json');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(true);
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

    it('should show ready to run when nextRunIn is 0 and gate is open', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago

      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: recentBriefing })
      );
      // No state file means first run (nextRunIn = 0)

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.nextRunIn).toBe(0);
      expect(status.ctoGateOpen).toBe(true);
      expect(status.message).toBe(
        'Autonomous Deputy CTO Mode is ENABLED. Ready to run (waiting for service trigger).'
      );
    });

    it('should show minutes until next run when gate is open', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - 5 * 60 * 60 * 1000).toISOString(); // 5h ago

      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: recentBriefing })
      );

      const lastRun = now - (30 * 60 * 1000); // 30 minutes ago
      fs.writeFileSync(statePath, JSON.stringify({ lastRun }));

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(true);
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

    it('should show CTO gate CLOSED when no briefing recorded (G001 fail-closed)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: null })
      );

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(false);
      expect(status.hoursSinceLastBriefing).toBe(null);
      expect(status.lastCtoBriefing).toBe(null);
      expect(status.message).toContain('CTO activity gate is CLOSED');
      expect(status.message).toContain('last briefing: never');
    });

    it('should show CTO gate OPEN when briefing is recent (<24h)', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - (12 * 60 * 60 * 1000)).toISOString(); // 12h ago

      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: recentBriefing })
      );

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(true);
      expect(status.hoursSinceLastBriefing).toBe(12);
      expect(status.lastCtoBriefing).toBe(recentBriefing);
      // When gate is open and nextRunIn is 0 (no state file), should say "Ready to run"
      expect(status.message).toContain('Autonomous Deputy CTO Mode is ENABLED');
    });

    it('should show CTO gate CLOSED when briefing is old (>=24h)', () => {
      const now = Date.now();
      const oldBriefing = new Date(now - (30 * 60 * 60 * 1000)).toISOString(); // 30h ago

      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: oldBriefing })
      );

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(false);
      expect(status.hoursSinceLastBriefing).toBe(30);
      expect(status.lastCtoBriefing).toBe(oldBriefing);
      expect(status.message).toContain('CTO activity gate is CLOSED');
      expect(status.message).toContain('last briefing: 30h ago');
    });

    it('should handle invalid briefing timestamp gracefully (G001 fail-closed)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: 'not-a-date' })
      );

      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.enabled).toBe(true);
      expect(status.ctoGateOpen).toBe(false);
      expect(status.hoursSinceLastBriefing).toBe(null);
      expect(status.message).toContain('CTO activity gate is CLOSED');
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

    it('should store recommendation when provided', () => {
      const result = addQuestion({
        type: 'decision',
        title: 'Caching strategy',
        description: 'Redis vs in-memory for sessions',
        recommendation: 'Use Redis for multi-instance support',
      });

      expect(result.id).toBeDefined();

      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.id) as QuestionRow | undefined;
      expect(question?.recommendation).toBe('Use Redis for multi-instance support');
    });

    it('should require recommendation for escalation type', () => {
      const result = addQuestion({
        type: 'escalation',
        title: 'G001 violations found',
        description: '3 modules failing open on errors',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Escalations require a recommendation');
    });

    it('should accept escalation with recommendation', () => {
      const result = addQuestion({
        type: 'escalation',
        title: 'G001 violations found',
        description: '3 modules failing open on errors',
        recommendation: 'Fix all 3 modules to fail-closed before next release',
      });

      expect(result.id).toBeDefined();

      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.id) as QuestionRow | undefined;
      expect(question?.type).toBe('escalation');
      expect(question?.recommendation).toBe('Fix all 3 modules to fail-closed before next release');
    });

    it('should allow null recommendation for non-escalation types', () => {
      const result = addQuestion({
        type: 'decision',
        title: 'API versioning approach',
        description: 'URL vs header based',
      });

      expect(result.id).toBeDefined();

      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.id) as QuestionRow | undefined;
      expect(question?.recommendation).toBeNull();
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
          new Date().toISOString()
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
          new Date().toISOString()
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

  // ============================================================================
  // G011 Idempotency Tests for spawn_implementation_task
  //
  // These tests validate that spawn_implementation_task is idempotent by
  // description for active ('spawned' status) tasks. The partial unique index
  // idx_spawned_tasks_description_active ON spawned_tasks(description)
  // WHERE status = 'spawned' and the SELECT-before-INSERT pattern ensure
  // duplicate calls return the existing PID rather than spawning a new process.
  //
  // All tests operate at the DATABASE level only — no real Claude processes
  // are spawned. We INSERT rows directly into spawned_tasks to simulate
  // previously spawned tasks, then call local helpers that mirror the
  // server-side dedup logic.
  // ============================================================================

  describe('G011: spawn_implementation_task idempotency', () => {
    // Mirrors the dedup portion of spawnImplementationTask() in server.ts.
    // Does NOT call spawn() — returns a simulated result based purely on DB state.
    const checkSpawnDedup = (description: string, fakePid: number = 12345): {
      spawned: boolean;
      pid: number | null;
      message: string;
    } => {
      // G011: Check for existing active task with same description before spawning.
      const existing = db.prepare(
        `SELECT id, pid, description, created_at FROM spawned_tasks WHERE description = ? AND status = 'spawned'`
      ).get(description) as { id: number; pid: number; description: string; created_at: string } | undefined;

      if (existing) {
        return {
          spawned: false,
          pid: existing.pid,
          message: `Task already active: ${existing.description} (PID: ${existing.pid}, created: ${existing.created_at}). Skipped duplicate spawn.`,
        };
      }

      // Simulate a successful spawn by inserting a tracking row with a fake PID.
      // In production, spawn() would be called here. We skip it in tests.
      const promptHash = 'testhash0123456';
      db.prepare(
        `INSERT INTO spawned_tasks (description, prompt_hash, pid, status) VALUES (?, ?, ?, 'spawned')`
      ).run(description, promptHash, fakePid);

      return {
        spawned: true,
        pid: fakePid,
        message: `Task spawned: ${description} (PID: ${fakePid})`,
      };
    };

    // Helper to insert a spawned_tasks row directly with a given status.
    const insertSpawnedTask = (description: string, pid: number, status: 'spawned' | 'completed') => {
      db.prepare(
        `INSERT INTO spawned_tasks (description, prompt_hash, pid, status) VALUES (?, ?, ?, ?)`
      ).run(description, 'deadbeef01234567', pid, status);
    };

    // Helper to insert a spawned_tasks row with a custom created_at timestamp
    // (SQLite datetime string) to simulate aged records for cleanup tests.
    const insertSpawnedTaskWithAge = (description: string, pid: number, status: 'spawned' | 'completed', createdAt: string) => {
      db.prepare(
        `INSERT INTO spawned_tasks (description, prompt_hash, pid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(description, 'deadbeef01234567', pid, status, createdAt, createdAt);
    };

    // Mirrors the spawned_tasks portion of cleanupOldRecordsInternal() in server.ts.
    const cleanupSpawnedTasks = () => {
      const result = db.prepare(
        `DELETE FROM spawned_tasks WHERE created_at < datetime('now', '-7 days')`
      ).run();
      return { spawned_tasks_deleted: result.changes };
    };

    it('should return spawned: false with existing PID when same description has active task (dedup: same description returns existing task)', () => {
      // Arrange: insert an active spawned_tasks row directly
      const existingPid = 99001;
      insertSpawnedTask('Test Task', existingPid, 'spawned');

      // Act: call dedup logic with the same description
      const result = checkSpawnDedup('Test Task', 99999 /* would-be new PID */);

      // Assert: duplicate is detected, existing PID returned, no new spawn
      expect(result.spawned).toBe(false);
      expect(result.pid).toBe(existingPid);
      expect(typeof result.pid).toBe('number');
      expect(result.message).toContain('already active');
      expect(result.message).toContain('Test Task');
      expect(result.message).toContain(String(existingPid));

      // Only one row should exist in the table
      const count = db.prepare('SELECT COUNT(*) as count FROM spawned_tasks').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should return spawned: true when description differs (different descriptions create separate records)', () => {
      // Arrange: insert an active task for description 'Task A'
      insertSpawnedTask('Task A', 88001, 'spawned');

      // Act: spawn with a different description 'Task B'
      const result = checkSpawnDedup('Task B', 88002);

      // Assert: no dedup — new task created
      expect(result.spawned).toBe(true);
      expect(result.pid).toBe(88002);
      expect(result.message).toContain('Task B');

      // Two rows should exist: one for Task A, one for Task B
      const count = db.prepare('SELECT COUNT(*) as count FROM spawned_tasks').get() as { count: number };
      expect(count.count).toBe(2);

      // Verify Task B was recorded
      const taskB = db.prepare(
        `SELECT * FROM spawned_tasks WHERE description = 'Task B'`
      ).get() as { description: string; pid: number; status: string } | undefined;
      expect(taskB).toBeDefined();
      expect(taskB?.pid).toBe(88002);
      expect(taskB?.status).toBe('spawned');
    });

    it('should return spawned: true when prior task with same description is completed (completed task allows re-spawn)', () => {
      // Arrange: insert a completed task with the same description
      insertSpawnedTask('Test Task', 77001, 'completed');

      // Act: spawn with the same description — completed tasks should not block
      const result = checkSpawnDedup('Test Task', 77002);

      // Assert: completed task is NOT treated as active, new spawn proceeds
      expect(result.spawned).toBe(true);
      expect(result.pid).toBe(77002);
      expect(result.message).not.toContain('already active');

      // Two rows should exist: the old completed one and the new spawned one
      const count = db.prepare('SELECT COUNT(*) as count FROM spawned_tasks').get() as { count: number };
      expect(count.count).toBe(2);

      // Verify a spawned row now exists alongside the completed row
      const activeCount = db.prepare(
        `SELECT COUNT(*) as count FROM spawned_tasks WHERE description = 'Test Task' AND status = 'spawned'`
      ).get() as { count: number };
      expect(activeCount.count).toBe(1);

      const completedCount = db.prepare(
        `SELECT COUNT(*) as count FROM spawned_tasks WHERE description = 'Test Task' AND status = 'completed'`
      ).get() as { count: number };
      expect(completedCount.count).toBe(1);
    });

    it('should delete spawned_tasks older than 7 days and preserve recent ones (cleanup removes old spawned_tasks)', () => {
      // Arrange: insert rows with old timestamps (>7 days) and recent timestamps
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];

      // Old rows that should be deleted
      insertSpawnedTaskWithAge('Old Task A', 1001, 'spawned', eightDaysAgo);
      insertSpawnedTaskWithAge('Old Task B', 1002, 'completed', tenDaysAgo);

      // Recent row that must be preserved
      insertSpawnedTaskWithAge('Recent Task C', 1003, 'spawned', oneDayAgo);

      // Act: run cleanup
      const result = cleanupSpawnedTasks();

      // Assert: 2 old rows deleted
      expect(result.spawned_tasks_deleted).toBe(2);
      expect(typeof result.spawned_tasks_deleted).toBe('number');

      // Only the recent row remains
      const remaining = db.prepare('SELECT COUNT(*) as count FROM spawned_tasks').get() as { count: number };
      expect(remaining.count).toBe(1);

      const recentTask = db.prepare(
        `SELECT description FROM spawned_tasks`
      ).get() as { description: string } | undefined;
      expect(recentTask).toBeDefined();
      expect(recentTask?.description).toBe('Recent Task C');
    });

    it('should have the correct unique partial index on spawned_tasks(description) where status = "spawned" (schema has correct index)', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_spawned_tasks_description_active'"
        )
        .all() as { name: string }[];

      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_spawned_tasks_description_active');
    });

    it('should enforce the unique constraint at the database level for concurrent spawns of the same description (UNIQUE constraint race condition fallback)', () => {
      // Arrange: pre-insert a spawned row for 'Race Task'
      insertSpawnedTask('Race Task', 55001, 'spawned');

      // Act: attempt to directly insert a second spawned row with the same description.
      // This simulates a race condition where two callers both passed the SELECT check
      // before either INSERT ran. The UNIQUE partial index must reject the second INSERT.
      expect(() => {
        db.prepare(
          `INSERT INTO spawned_tasks (description, prompt_hash, pid, status) VALUES (?, ?, ?, 'spawned')`
        ).run('Race Task', 'anotherhash1234', 55002);
      }).toThrow();

      // Only one spawned row should exist for 'Race Task'
      const count = db.prepare(
        `SELECT COUNT(*) as count FROM spawned_tasks WHERE description = 'Race Task' AND status = 'spawned'`
      ).get() as { count: number };
      expect(count.count).toBe(1);
    });
  });

  // ============================================================================
  // G011 Idempotency Tests for reject_commit
  //
  // These tests validate that rejectCommit() is idempotent by title for pending
  // rejection questions. The SELECT-first dedup pattern ensures duplicate calls
  // return the existing record rather than creating duplicate questions or
  // commit_decisions rows. Both INSERTs are wrapped in a transaction for
  // atomicity: either both records are created or neither is.
  // ============================================================================

  describe('G011 idempotency - reject_commit', () => {
    // Mirrors the G011-compliant rejectCommit() logic from server.ts.
    // Uses SELECT-first dedup on type='rejection' AND title AND status != 'answered',
    // then wraps the dual INSERT in a transaction.
    const rejectCommitIdempotent = (args: { title: string; description: string }): {
      rejected: boolean;
      decision_id: string;
      question_id: string;
      message: string;
    } => {
      // G011: Check for existing pending rejection question with the same title
      const existingQuestion = db.prepare(`
        SELECT id FROM questions WHERE type = 'rejection' AND title = ? AND status != 'answered' LIMIT 1
      `).get(args.title) as { id: string } | undefined;

      if (existingQuestion) {
        const existingDecision = db.prepare(`
          SELECT id FROM commit_decisions WHERE question_id = ? ORDER BY created_timestamp DESC LIMIT 1
        `).get(existingQuestion.id) as { id: string } | undefined;

        return {
          rejected: true,
          decision_id: existingDecision?.id ?? '',
          question_id: existingQuestion.id,
          message: `Commit rejection already recorded (deduplicated). Question ID: ${existingQuestion.id}. Commits will be blocked until CTO addresses this.`,
        };
      }

      const decisionId = randomUUID();
      const questionId = randomUUID();
      const now = new Date();
      const created_at = now.toISOString();
      const created_timestamp = now.toISOString();

      // Wrap both INSERTs in a transaction for atomicity
      const insertBoth = db.transaction(() => {
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
          VALUES (?, 'rejected', ?, ?, ?, ?)
        `).run(decisionId, args.description, questionId, created_at, created_timestamp);

        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
          VALUES (?, 'rejection', 'pending', ?, ?, ?, ?)
        `).run(questionId, args.title, args.description, created_at, created_timestamp);
      });

      insertBoth();

      return {
        rejected: true,
        decision_id: decisionId,
        question_id: questionId,
        message: `Commit rejected. Question created for CTO (ID: ${questionId}). Commits will be blocked until CTO addresses this.`,
      };
    };

    it('should return the same question_id on the second call with the same title (duplicate rejection returns existing record)', () => {
      const args = { title: 'Breaking API change', description: 'This breaks the v2 API contract' };

      const first = rejectCommitIdempotent(args);
      const second = rejectCommitIdempotent(args);

      // Both calls must report rejection
      expect(first.rejected).toBe(true);
      expect(second.rejected).toBe(true);

      // Same question_id must be returned — no new question created
      expect(second.question_id).toBe(first.question_id);
      expect(typeof second.question_id).toBe('string');
      expect(second.question_id.length).toBeGreaterThan(0);
    });

    it('should create only one question row after two calls with the same title (no duplicate DB rows)', () => {
      const args = { title: 'Security vulnerability found', description: 'SQL injection risk in user input handler' };

      rejectCommitIdempotent(args);
      rejectCommitIdempotent(args);

      const questionCount = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND title = ?"
      ).get(args.title) as { count: number };

      expect(questionCount.count).toBe(1);
    });

    it('should create only one commit_decision row after two calls with the same title (no duplicate commit_decisions)', () => {
      const args = { title: 'Missing test coverage', description: 'Auth module has no tests' };

      rejectCommitIdempotent(args);
      rejectCommitIdempotent(args);

      const decisionCount = db.prepare(
        "SELECT COUNT(*) as count FROM commit_decisions WHERE decision = 'rejected'"
      ).get() as { count: number };

      expect(decisionCount.count).toBe(1);
    });

    it('should preserve the original question_id in the second response (dedup returns the original record)', () => {
      const args = { title: 'Config drift detected', description: 'Production config differs from staging' };

      const first = rejectCommitIdempotent(args);
      // Second call uses different description — dedup must return the original record
      const second = rejectCommitIdempotent({ ...args, description: 'Different description on retry' });

      expect(second.question_id).toBe(first.question_id);

      // The stored description must be the ORIGINAL (first call's) description
      const row = db.prepare(
        'SELECT description FROM questions WHERE id = ?'
      ).get(first.question_id) as { description: string };
      expect(row.description).toBe('Production config differs from staging');
    });

    it('should create both commit_decision and question atomically — both records exist after a single call (transaction safety)', () => {
      const args = { title: 'Atomic transaction test', description: 'Verify both records are created together' };

      const result = rejectCommitIdempotent(args);

      // Both records must exist
      const question = db.prepare(
        'SELECT id, type, status FROM questions WHERE id = ?'
      ).get(result.question_id) as { id: string; type: string; status: string } | undefined;

      const decision = db.prepare(
        'SELECT id, decision, question_id FROM commit_decisions WHERE id = ?'
      ).get(result.decision_id) as { id: string; decision: string; question_id: string } | undefined;

      expect(question).toBeDefined();
      expect(question?.type).toBe('rejection');
      expect(question?.status).toBe('pending');

      expect(decision).toBeDefined();
      expect(decision?.decision).toBe('rejected');
      // The commit_decision must reference the question
      expect(decision?.question_id).toBe(result.question_id);
    });

    it('should include "deduplicated" in the message for the second call (message signals dedup occurred)', () => {
      const args = { title: 'Linting errors', description: 'ESLint found 15 errors' };

      rejectCommitIdempotent(args);
      const second = rejectCommitIdempotent(args);

      expect(second.message).toContain('deduplicated');
      expect(second.message).toContain(second.question_id);
    });

    it('should allow a new rejection with the same title after the prior question is answered (answered question allows re-rejection)', () => {
      const args = { title: 'Recurring policy violation', description: 'First occurrence' };

      const original = rejectCommitIdempotent(args);

      // Mark the question as answered (CTO addressed it)
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE questions SET status = 'answered', answer = 'Fixed', answered_at = ?, decided_by = 'cto' WHERE id = ?"
      ).run(now, original.question_id);

      // A new rejection with the same title must produce a new question
      const reissued = rejectCommitIdempotent({ ...args, description: 'Second occurrence' });

      expect(reissued.question_id).not.toBe(original.question_id);
      expect(reissued.rejected).toBe(true);

      // Two question rows should now exist: one answered + one pending
      const totalCount = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND title = ?"
      ).get(args.title) as { count: number };
      expect(totalCount.count).toBe(2);
    });

    it('should keep exactly one pending question even after duplicate calls — approve_commit must remain blocked (commit still blocked after dedup)', () => {
      const rejectArgs = { title: 'Blocking issue for approval test', description: 'Must be resolved before merging' };

      rejectCommitIdempotent(rejectArgs);
      // Duplicate call must not double-count pending questions
      rejectCommitIdempotent(rejectArgs);

      // Exactly one pending question should exist
      const pendingCount = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
      ).get() as { count: number };
      expect(pendingCount.count).toBe(1);

      // approveCommit must be blocked since the pending question still exists
      const approvalAttempt = approveCommit('Trying to sneak this through');
      expect(approvalAttempt.approved).toBe(false);
      expect(approvalAttempt.message).toContain('Cannot approve commit');
    });

    it('should return consistent response structure for both first and deduplicated calls (response shape parity)', () => {
      const args = { title: 'Shape parity test', description: 'Verifying response object structure' };

      const first = rejectCommitIdempotent(args);
      const second = rejectCommitIdempotent(args);

      // Both responses must have the same keys
      expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());

      // All fields must be the correct type
      expect(typeof second.rejected).toBe('boolean');
      expect(typeof second.decision_id).toBe('string');
      expect(typeof second.question_id).toBe('string');
      expect(typeof second.message).toBe('string');

      expect(second.rejected).toBe(true);
      expect(second.question_id.length).toBeGreaterThan(0);
      expect(second.message.length).toBeGreaterThan(0);
    });

    it('should enforce the UNIQUE partial index as a race-condition safety net for duplicate rejections (UNIQUE constraint rejects concurrent INSERT)', () => {
      const title = 'Race condition rejection test';
      const nowIso = new Date().toISOString();

      // First INSERT succeeds
      db.prepare(`
        INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
        VALUES (?, 'rejection', 'pending', ?, ?, ?, ?)
      `).run(randomUUID(), title, 'First rejection', nowIso, nowIso);

      // Second INSERT must be rejected by the UNIQUE partial index on (type, title) WHERE status != 'answered'
      expect(() => {
        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
          VALUES (?, 'rejection', 'pending', ?, ?, ?, ?)
        `).run(randomUUID(), title, 'Duplicate rejection', nowIso, nowIso);
      }).toThrow();

      // Only one row should exist
      const count = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND title = ?"
      ).get(title) as { count: number };
      expect(count.count).toBe(1);
    });
  });

  // ============================================================================
  // G011 Idempotency Tests for approve_commit
  //
  // These tests validate that approveCommit() is idempotent by rationale within
  // a 60-second dedup window. The SELECT-first pattern checks for an existing
  // approved decision with the same rationale and created_timestamp >= now - 60s
  // before inserting a new one. Duplicate calls within the window return the
  // existing decision_id without clearing and re-creating the approval token.
  // ============================================================================

  describe('G011 idempotency - approve_commit', () => {
    // Mirrors the G011-compliant approveCommit() dedup logic from server.ts.
    // Omits the file-system token write and G020 triage check (tested separately).
    const approveCommitIdempotent = (rationale: string): {
      approved: boolean;
      decision_id: string;
      message: string;
    } => {
      const pendingCount = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
      ).get() as { count: number };

      if (pendingCount.count > 0) {
        return {
          approved: false,
          decision_id: '',
          message: `Cannot approve commit: ${pendingCount.count} CTO question(s) must be addressed first.`,
        };
      }

      // G011: Check for existing recent approved decision with the same rationale (within 60s)
      const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const existingApproval = db.prepare(`
        SELECT id, created_at FROM commit_decisions
        WHERE decision = 'approved' AND rationale = ? AND created_timestamp >= ?
        ORDER BY created_timestamp DESC LIMIT 1
      `).get(rationale, sixtySecondsAgo) as { id: string; created_at: string } | undefined;

      if (existingApproval) {
        return {
          approved: true,
          decision_id: existingApproval.id,
          message: `Commit already approved (deduplicated). Decision ID: ${existingApproval.id}. Retry your commit within 5 minutes.`,
        };
      }

      const id = randomUUID();
      const now = new Date();
      const created_at = now.toISOString();
      const created_timestamp = now.toISOString();

      db.prepare(`
        INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
        VALUES (?, 'approved', ?, ?, ?)
      `).run(id, rationale, created_at, created_timestamp);

      return {
        approved: true,
        decision_id: id,
        message: `Commit approved. Token written - retry your commit within 5 minutes.`,
      };
    };

    it('should return the same decision_id on the second call with the same rationale (duplicate approval returns existing record)', () => {
      const rationale = 'All tests pass, no security concerns';

      const first = approveCommitIdempotent(rationale);
      const second = approveCommitIdempotent(rationale);

      expect(first.approved).toBe(true);
      expect(second.approved).toBe(true);

      // Same decision_id must be returned — no new record created
      expect(second.decision_id).toBe(first.decision_id);
      expect(typeof second.decision_id).toBe('string');
      expect(second.decision_id.length).toBeGreaterThan(0);
    });

    it('should create only one commit_decision row after two calls with the same rationale within 60 seconds (no duplicate rows)', () => {
      const rationale = 'Code reviewed, documentation updated';

      approveCommitIdempotent(rationale);
      approveCommitIdempotent(rationale);

      const count = db.prepare(
        "SELECT COUNT(*) as count FROM commit_decisions WHERE decision = 'approved' AND rationale = ?"
      ).get(rationale) as { count: number };

      expect(count.count).toBe(1);
    });

    it('should include "deduplicated" in the message for the second call (message signals dedup occurred)', () => {
      const rationale = 'Minor refactor, backward compatible';

      approveCommitIdempotent(rationale);
      const second = approveCommitIdempotent(rationale);

      expect(second.message).toContain('deduplicated');
      expect(second.message).toContain(second.decision_id);
    });

    it('should create a new approval when the rationale differs (different rationale creates a new record)', () => {
      const first = approveCommitIdempotent('First approval rationale');
      const second = approveCommitIdempotent('Second approval rationale - different');

      // Different rationale means different dedup key — different decision IDs expected
      expect(second.decision_id).not.toBe(first.decision_id);
      expect(second.approved).toBe(true);
    });

    it('should block approval when pending questions exist — even when same rationale is in the dedup window (G001 fail-closed takes priority)', () => {
      const rationale = 'Looks good to me';

      // First approval succeeds when the question queue is empty
      const first = approveCommitIdempotent(rationale);
      expect(first.approved).toBe(true);

      // Add a pending question after the approval
      const questionId = randomUUID();
      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
        VALUES (?, 'decision', 'pending', 'Urgent architecture question', 'Must answer before merging', ?, ?)
      `).run(questionId, nowIso, nowIso);

      // Approval must now be blocked even though the same rationale is within the 60-second window
      const blocked = approveCommitIdempotent(rationale);
      expect(blocked.approved).toBe(false);
      expect(blocked.message).toContain('Cannot approve commit');
    });

    it('should enforce the 60-second dedup window — old approval with same rationale gets a fresh record (time-bounded dedup)', () => {
      const rationale = 'Time-window dedup test rationale';

      // Insert an "old" approval (70 seconds ago — outside the 60-second dedup window)
      const oldId = randomUUID();
      const oldTimestamp = new Date(Date.now() - 70 * 1000).toISOString();
      db.prepare(`
        INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
        VALUES (?, 'approved', ?, ?, ?)
      `).run(oldId, rationale, oldTimestamp, oldTimestamp);

      // Calling approveCommitIdempotent must NOT deduplicate against the old record
      const result = approveCommitIdempotent(rationale);

      // A new record should be created with a different ID
      expect(result.decision_id).not.toBe(oldId);
      expect(result.approved).toBe(true);
      expect(result.message).not.toContain('deduplicated');
    });

    it('should return consistent response structure for both first and deduplicated calls (response shape parity)', () => {
      const rationale = 'All CI checks green, reviewed by deputy-cto';

      const first = approveCommitIdempotent(rationale);
      const second = approveCommitIdempotent(rationale);

      // Both responses must have the same keys
      expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());

      expect(typeof second.approved).toBe('boolean');
      expect(typeof second.decision_id).toBe('string');
      expect(typeof second.message).toBe('string');

      expect(second.approved).toBe(true);
      expect(second.decision_id.length).toBeGreaterThan(0);
      expect(second.message.length).toBeGreaterThan(0);
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

  // ============================================================================
  // G011 Idempotency Tests for request_bypass
  //
  // These tests validate that request_bypass is idempotent by reporting_agent:
  // the deterministic title `Bypass Request [${agent}]` combined with a
  // SELECT-before-INSERT dedup check ensures repeated calls from the same agent
  // return the same request_id and bypass_code without creating duplicate rows.
  //
  // The unique partial index idx_questions_type_title_dedup on
  // questions(type, title) WHERE status != 'answered' acts as a race-condition
  // safety net, and a try/catch UNIQUE fallback handles the window between
  // SELECT and INSERT.
  //
  // All tests operate at the DATABASE level — the helpers below mirror the
  // server-side requestBypass() logic without running the full MCP server.
  // ============================================================================

  describe('request_bypass idempotency (G011)', () => {
    // Mirrors generateBypassCode() from server.ts
    const generateBypassCode = (): string => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    };

    // Mirrors requestBypass() from server.ts, operating against the shared test db.
    const requestBypassIdempotent = (args: {
      reason: string;
      blocked_by: string;
      reporting_agent: string;
    }): { request_id: string; bypass_code: string; message: string; instructions: string } => {
      // G011: Deterministic title keyed by agent so duplicate calls are idempotent.
      const title = `Bypass Request [${args.reporting_agent}]`;

      const existingBypass = db.prepare(`
        SELECT id, context FROM questions
        WHERE type = 'bypass-request' AND title = ? AND status = 'pending' LIMIT 1
      `).get(title) as { id: string; context: string } | undefined;

      if (existingBypass) {
        const existingCode = existingBypass.context;
        return {
          request_id: existingBypass.id,
          bypass_code: existingCode,
          message: `Bypass request already pending (deduplicated). To approve, the CTO must type: APPROVE BYPASS ${existingCode}`,
          instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${existingCode}`,
        };
      }

      const id = randomUUID();
      const bypassCode = generateBypassCode();
      const now = new Date();
      const created_at = now.toISOString();
      const created_timestamp = now.toISOString();

      const description = `**Bypass requested by:** ${args.reporting_agent}\n\n**Reason:** ${args.reason}\n\n${args.blocked_by ? `**Blocked by:** ${args.blocked_by}` : ''}\n\n---\n\n**CTO Action Required:**\nTo approve this bypass, type exactly: **APPROVE BYPASS ${bypassCode}**`;

      try {
        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
          VALUES (?, 'bypass-request', 'pending', ?, ?, ?, ?, ?)
        `).run(id, title, description, bypassCode, created_at, created_timestamp);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          // Race condition: another call inserted between our SELECT and INSERT.
          const fallback = db.prepare(`
            SELECT id, context FROM questions
            WHERE type = 'bypass-request' AND title = ? AND status = 'pending' LIMIT 1
          `).get(title) as { id: string; context: string } | undefined;
          if (fallback) {
            const fallbackCode = fallback.context;
            return {
              request_id: fallback.id,
              bypass_code: fallbackCode,
              message: `Bypass request already pending (deduplicated). To approve, the CTO must type: APPROVE BYPASS ${fallbackCode}`,
              instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${fallbackCode}`,
            };
          }
        }
        throw err;
      }

      return {
        request_id: id,
        bypass_code: bypassCode,
        message: `Bypass request submitted. To approve, the CTO must type: APPROVE BYPASS ${bypassCode}`,
        instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${bypassCode}`,
      };
    };

    // Helper to mark a bypass-request question as answered, simulating CTO resolution.
    const answerBypassRequest = (questionId: string) => {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE questions SET status = 'answered', answer = 'Approved', answered_at = ?, decided_by = 'cto'
        WHERE id = ?
      `).run(now, questionId);
    };

    it('should create a bypass request and return request_id, bypass_code, message, and instructions (happy path)', () => {
      const result = requestBypassIdempotent({
        reason: 'Pre-commit hook blocking valid commit after 3 retries',
        blocked_by: 'deputy-cto pre-commit hook',
        reporting_agent: 'code-writer',
      });

      // Validate all required fields are present and are strings
      expect(typeof result.request_id).toBe('string');
      expect(result.request_id.length).toBeGreaterThan(0);

      expect(typeof result.bypass_code).toBe('string');
      expect(result.bypass_code.length).toBe(6);
      // Bypass code uses only unambiguous uppercase alphanumeric chars
      expect(result.bypass_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toContain('APPROVE BYPASS');
      expect(result.message).toContain(result.bypass_code);

      expect(typeof result.instructions).toBe('string');
      expect(result.instructions.length).toBeGreaterThan(0);
      expect(result.instructions).toContain('APPROVE BYPASS');
      expect(result.instructions).toContain(result.bypass_code);

      // Verify the row was persisted in the database
      const row = db.prepare(
        "SELECT id, type, status, title, context FROM questions WHERE id = ?"
      ).get(result.request_id) as { id: string; type: string; status: string; title: string; context: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.type).toBe('bypass-request');
      expect(row?.status).toBe('pending');
      expect(row?.title).toBe('Bypass Request [code-writer]');
      expect(row?.context).toBe(result.bypass_code);
    });

    it('should return the same request_id and bypass_code when the same agent calls twice (dedup on retry)', () => {
      const args = {
        reason: 'Hook blocking commit after auth fix',
        blocked_by: 'pre-commit hook',
        reporting_agent: 'test-agent',
      };

      const first = requestBypassIdempotent(args);
      const second = requestBypassIdempotent({ ...args, reason: 'Same agent, same call' });

      // Both calls must return the same identifiers
      expect(second.request_id).toBe(first.request_id);
      expect(second.bypass_code).toBe(first.bypass_code);

      // The returned IDs must be valid strings
      expect(typeof second.request_id).toBe('string');
      expect(second.request_id.length).toBeGreaterThan(0);
      expect(typeof second.bypass_code).toBe('string');
      expect(second.bypass_code.length).toBe(6);

      // Only one row should exist for this agent in the database
      const count = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND title = 'Bypass Request [test-agent]'"
      ).get() as { count: number };
      expect(count.count).toBe(1);

      // The second call message must indicate deduplication
      expect(second.message).toContain('deduplicated');
    });

    it('should return the same request_id regardless of reason text (dedup key is agent, not reason)', () => {
      const agent = 'reason-agnostic-agent';

      const first = requestBypassIdempotent({
        reason: 'First reason: hook timeout',
        blocked_by: 'pre-commit hook',
        reporting_agent: agent,
      });

      // Same agent, completely different reason text
      const second = requestBypassIdempotent({
        reason: 'Totally different reason: network error during review',
        blocked_by: 'deputy-cto review step',
        reporting_agent: agent,
      });

      // Dedup is by agent identity, not reason content
      expect(second.request_id).toBe(first.request_id);
      expect(second.bypass_code).toBe(first.bypass_code);

      // Verify only one row exists
      const count = db.prepare(
        `SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND title = 'Bypass Request [${agent}]'`
      ).get() as { count: number };
      expect(count.count).toBe(1);

      // Verify the stored description reflects the FIRST call's reason (not overwritten)
      const row = db.prepare(
        `SELECT description FROM questions WHERE id = ?`
      ).get(first.request_id) as { description: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.description).toContain('First reason: hook timeout');
      expect(row?.description).not.toContain('Totally different reason');
    });

    it('should create separate bypass requests for different agents (separate agents get separate requests)', () => {
      const firstResult = requestBypassIdempotent({
        reason: 'Blocked by hook after security patch',
        blocked_by: 'pre-commit hook',
        reporting_agent: 'agent-alpha',
      });

      const secondResult = requestBypassIdempotent({
        reason: 'Blocked by hook after refactor',
        blocked_by: 'pre-commit hook',
        reporting_agent: 'agent-beta',
      });

      // Different agents must get different request IDs and bypass codes
      expect(secondResult.request_id).not.toBe(firstResult.request_id);

      // Both IDs must be valid strings
      expect(typeof firstResult.request_id).toBe('string');
      expect(firstResult.request_id.length).toBeGreaterThan(0);
      expect(typeof secondResult.request_id).toBe('string');
      expect(secondResult.request_id.length).toBeGreaterThan(0);

      // Both bypass codes must be valid 6-char strings
      expect(firstResult.bypass_code.length).toBe(6);
      expect(secondResult.bypass_code.length).toBe(6);

      // Verify two separate rows exist in the database
      const totalCount = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request'"
      ).get() as { count: number };
      expect(totalCount.count).toBe(2);

      // Confirm each row has the correct title
      const alphaRow = db.prepare(
        "SELECT title FROM questions WHERE id = ?"
      ).get(firstResult.request_id) as { title: string } | undefined;
      expect(alphaRow?.title).toBe('Bypass Request [agent-alpha]');

      const betaRow = db.prepare(
        "SELECT title FROM questions WHERE id = ?"
      ).get(secondResult.request_id) as { title: string } | undefined;
      expect(betaRow?.title).toBe('Bypass Request [agent-beta]');
    });

    it('should create a fresh bypass request when the prior one is no longer pending (re-creation after terminal state)', () => {
      const agent = 'recurring-agent';
      const args = {
        reason: 'Original block reason',
        blocked_by: 'pre-commit hook',
        reporting_agent: agent,
      };

      // Create the original bypass request
      const original = requestBypassIdempotent(args);
      expect(typeof original.request_id).toBe('string');
      expect(original.message).not.toContain('deduplicated');

      // Verify it deduplicates while still pending
      const dupWhilePending = requestBypassIdempotent(args);
      expect(dupWhilePending.request_id).toBe(original.request_id);
      expect(dupWhilePending.message).toContain('deduplicated');

      // CTO answers (resolves) the bypass request
      answerBypassRequest(original.request_id);

      // Verify the question is now answered
      const answeredRow = db.prepare("SELECT status FROM questions WHERE id = ?").get(original.request_id) as { status: string };
      expect(answeredRow.status).toBe('answered');

      // After the original is answered, a new call from the same agent should create a fresh request
      const fresh = requestBypassIdempotent({
        reason: 'New block — different deployment',
        blocked_by: 'pre-commit hook',
        reporting_agent: agent,
      });

      // Must be a NEW request, not the answered one
      expect(fresh.request_id).not.toBe(original.request_id);
      expect(typeof fresh.request_id).toBe('string');
      expect(fresh.request_id.length).toBeGreaterThan(0);
      expect(fresh.message).not.toContain('deduplicated');

      // Both rows should coexist: original (answered) + fresh (pending)
      const allRows = db.prepare(
        `SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND title = 'Bypass Request [${agent}]'`
      ).get() as { count: number };
      expect(allRows.count).toBe(2);

      // Verify only the fresh one is pending
      const pendingCount = db.prepare(
        `SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND title = 'Bypass Request [${agent}]' AND status = 'pending'`
      ).get() as { count: number };
      expect(pendingCount.count).toBe(1);
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
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
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
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', nowIso, nowIso);
      }

      // Add only 10 cleared questions
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(id, 'Test', 'Description', nowIso, nowIso);
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
        const nowIso = new Date(Date.now() - i * 1000).toISOString(); // Stagger timestamps
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', nowIso, nowIso);
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
      const fortyDaysAgoIso = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date(now).toISOString();

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
          fortyDaysAgoIso,
          fortyDaysAgoIso
        );
      }

      // Add 10 recent cleared questions
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(id, 'New Test', 'Description', nowIso, nowIso);
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
        const timestampIso = new Date(fortyDaysAgo - i * 1000).toISOString(); // Stagger timestamps
        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, cleared_at, cleared_timestamp)
          VALUES (?, 'decision', ?, ?, ?, ?)
        `).run(
          id,
          'Test',
          'Description',
          timestampIso,
          timestampIso
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
        const nowIso = new Date(Date.now() - i * 1000).toISOString();
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', nowIso, nowIso);
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
        const nowIso = new Date(Date.now() - i * 1000).toISOString();
        db.prepare(`
          INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
          VALUES (?, 'approved', ?, ?, ?)
        `).run(id, 'test', nowIso, nowIso);
      }

      const result = cleanupOldRecords();

      expect(result.message).toContain('Cleaned up');
      expect(result.message).toContain('50');
      expect(result.message).toContain('commit decision');
    });
  });

  // ==========================================================================
  // Protected Action Management
  // ==========================================================================

  describe('Protected Action Management', () => {
    let PROTECTED_ACTIONS_PATH: string;
    let APPROVALS_PATH: string;

    beforeEach(() => {
      PROTECTED_ACTIONS_PATH = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      APPROVALS_PATH = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');
    });

    interface ProtectedActionsConfig {
      version: string;
      servers: Record<string, {
        protection: string;
        phrase: string;
        tools: string | string[];
        credentialKeys?: string[];
        description?: string;
      }>;
    }

    interface ApprovalRequest {
      code: string;
      server: string;
      tool: string;
      args: Record<string, any>;
      phrase: string;
      status: 'pending' | 'approved';
      created_at: string;
      created_timestamp: number;
      expires_at: string;
      expires_timestamp: number;
    }

    const listProtections = () => {
      try {
        if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
          return {
            protections: [],
            count: 0,
            message: 'No protected actions configured. Use setup.sh --protect-mcp to configure.',
          };
        }

        const config: ProtectedActionsConfig = JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));

        if (!config.servers || Object.keys(config.servers).length === 0) {
          return {
            protections: [],
            count: 0,
            message: 'No protected actions configured.',
          };
        }

        const protections = Object.entries(config.servers).map(([server, cfg]) => ({
          server,
          phrase: cfg.phrase,
          tools: cfg.tools,
          protection: cfg.protection,
          description: cfg.description,
        }));

        return {
          protections,
          count: protections.length,
          message: `Found ${protections.length} protected server(s).`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          protections: [],
          count: 0,
          message: `Error reading protected actions config: ${message}`,
        };
      }
    };

    const getProtectedActionRequest = (args: { code: string }) => {
      try {
        if (!fs.existsSync(APPROVALS_PATH)) {
          return {
            found: false,
            message: 'No pending approval requests.',
          };
        }

        const data = JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
        const approvals: Record<string, ApprovalRequest> = data.approvals || {};
        const code = args.code.toUpperCase();

        const request = approvals[code];
        if (!request) {
          return {
            found: false,
            message: `No request found with code: ${code}`,
          };
        }

        // Check if expired
        if (Date.now() > request.expires_timestamp) {
          return {
            found: false,
            message: `Request with code ${code} has expired.`,
          };
        }

        return {
          found: true,
          request: {
            code: request.code,
            server: request.server,
            tool: request.tool,
            args: request.args,
            phrase: request.phrase,
            status: request.status,
            created_at: request.created_at,
            expires_at: request.expires_at,
          },
          message: request.status === 'approved'
            ? `Request ${code} is approved and ready to execute.`
            : `Request ${code} is pending CTO approval. Type: ${request.phrase} ${code}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          found: false,
          message: `Error reading approval requests: ${message}`,
        };
      }
    };

    describe('list_protections', () => {
      it('should return empty list when no config file exists', () => {
        const result = listProtections();

        expect(result.protections).toHaveLength(0);
        expect(result.count).toBe(0);
        expect(result.message).toContain('No protected actions configured');
      });

      it('should return empty list when config has no servers', () => {
        const configDir = path.dirname(PROTECTED_ACTIONS_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        const config: ProtectedActionsConfig = {
          version: '1.0.0',
          servers: {},
        };

        fs.writeFileSync(PROTECTED_ACTIONS_PATH, JSON.stringify(config));

        const result = listProtections();

        expect(result.protections).toHaveLength(0);
        expect(result.count).toBe(0);
        expect(result.message).toContain('No protected actions configured');
      });

      it('should list all protected servers', () => {
        const configDir = path.dirname(PROTECTED_ACTIONS_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        const config: ProtectedActionsConfig = {
          version: '1.0.0',
          servers: {
            'supabase-prod': {
              protection: 'credential-isolated',
              phrase: 'APPROVE PROD',
              tools: '*',
              credentialKeys: ['SUPABASE_SERVICE_ROLE_KEY'],
              description: 'Production Supabase - all tools require approval',
            },
            'stripe': {
              protection: 'credential-isolated',
              phrase: 'APPROVE PAYMENT',
              tools: ['create_charge', 'create_refund', 'delete_customer'],
              credentialKeys: ['STRIPE_SECRET_KEY'],
              description: 'Stripe - only destructive/financial tools',
            },
            'sendgrid': {
              protection: 'approval-only',
              phrase: 'APPROVE EMAIL',
              tools: ['send_email', 'send_bulk'],
              description: 'SendGrid - approval required',
            },
          },
        };

        fs.writeFileSync(PROTECTED_ACTIONS_PATH, JSON.stringify(config));

        const result = listProtections();

        expect(result.count).toBe(3);
        expect(result.protections).toHaveLength(3);
        expect(result.message).toContain('Found 3 protected server(s)');

        // Verify structure
        const supabase = result.protections.find(p => p.server === 'supabase-prod');
        expect(supabase).toBeDefined();
        expect(supabase?.phrase).toBe('APPROVE PROD');
        expect(supabase?.tools).toBe('*');
        expect(supabase?.protection).toBe('credential-isolated');
        expect(supabase?.description).toContain('Production Supabase');

        const stripe = result.protections.find(p => p.server === 'stripe');
        expect(stripe).toBeDefined();
        expect(stripe?.phrase).toBe('APPROVE PAYMENT');
        expect(Array.isArray(stripe?.tools)).toBe(true);
        expect((stripe?.tools as string[]).length).toBe(3);
      });

      it('should handle wildcard tools protection', () => {
        const configDir = path.dirname(PROTECTED_ACTIONS_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        const config: ProtectedActionsConfig = {
          version: '1.0.0',
          servers: {
            'test-server': {
              protection: 'credential-isolated',
              phrase: 'APPROVE TEST',
              tools: '*',
            },
          },
        };

        fs.writeFileSync(PROTECTED_ACTIONS_PATH, JSON.stringify(config));

        const result = listProtections();

        expect(result.protections[0].tools).toBe('*');
      });

      it('should handle specific tools list protection', () => {
        const configDir = path.dirname(PROTECTED_ACTIONS_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        const config: ProtectedActionsConfig = {
          version: '1.0.0',
          servers: {
            'test-server': {
              protection: 'approval-only',
              phrase: 'APPROVE TEST',
              tools: ['create', 'delete', 'modify'],
            },
          },
        };

        fs.writeFileSync(PROTECTED_ACTIONS_PATH, JSON.stringify(config));

        const result = listProtections();

        expect(Array.isArray(result.protections[0].tools)).toBe(true);
        expect((result.protections[0].tools as string[]).length).toBe(3);
      });

      it('should handle corrupted config file gracefully (G001)', () => {
        const configDir = path.dirname(PROTECTED_ACTIONS_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        // Write invalid JSON
        fs.writeFileSync(PROTECTED_ACTIONS_PATH, '{ invalid json }');

        const result = listProtections();

        expect(result.protections).toHaveLength(0);
        expect(result.count).toBe(0);
        expect(result.message).toContain('Error reading protected actions config');
      });
    });

    describe('get_protected_action_request', () => {
      it('should return not found when no approvals file exists', () => {
        const result = getProtectedActionRequest({ code: 'ABC123' });

        expect(result.found).toBe(false);
        expect(result.message).toContain('No pending approval requests');
      });

      it('should return not found for non-existent code', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify({ approvals: {} }));

        const result = getProtectedActionRequest({ code: 'NOPE99' });

        expect(result.found).toBe(false);
        expect(result.message).toContain('No request found with code: NOPE99');
      });

      it('should return pending request details', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        const now = Date.now();
        const approvals = {
          approvals: {
            ABC123: {
              code: 'ABC123',
              server: 'test-server',
              tool: 'dangerous-operation',
              args: { database: 'production', action: 'truncate' },
              phrase: 'APPROVE PROD',
              status: 'pending',
              created_at: new Date(now).toISOString(),
              created_timestamp: now,
              expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
              expires_timestamp: now + 5 * 60 * 1000,
            },
          },
        };

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));

        const result = getProtectedActionRequest({ code: 'ABC123' });

        expect(result.found).toBe(true);
        expect(result.request).toBeDefined();
        expect(result.request?.code).toBe('ABC123');
        expect(result.request?.server).toBe('test-server');
        expect(result.request?.tool).toBe('dangerous-operation');
        expect(result.request?.status).toBe('pending');
        expect(result.message).toContain('pending CTO approval');
        expect(result.message).toContain('APPROVE PROD ABC123');
      });

      it('should return approved request details', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        const now = Date.now();
        const approvals = {
          approvals: {
            XYZ789: {
              code: 'XYZ789',
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              phrase: 'APPROVE TEST',
              status: 'approved',
              created_at: new Date(now).toISOString(),
              created_timestamp: now,
              expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
              expires_timestamp: now + 5 * 60 * 1000,
            },
          },
        };

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));

        const result = getProtectedActionRequest({ code: 'XYZ789' });

        expect(result.found).toBe(true);
        expect(result.request?.status).toBe('approved');
        expect(result.message).toContain('approved and ready to execute');
      });

      it('should return not found for expired request', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        const now = Date.now();
        const approvals = {
          approvals: {
            EXPIRE: {
              code: 'EXPIRE',
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              phrase: 'APPROVE TEST',
              status: 'pending',
              created_at: new Date(now - 10 * 60 * 1000).toISOString(),
              created_timestamp: now - 10 * 60 * 1000,
              expires_at: new Date(now - 1000).toISOString(),
              expires_timestamp: now - 1000, // Expired 1 second ago
            },
          },
        };

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));

        const result = getProtectedActionRequest({ code: 'EXPIRE' });

        expect(result.found).toBe(false);
        expect(result.message).toContain('expired');
      });

      it('should handle case-insensitive code lookup', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        const now = Date.now();
        const approvals = {
          approvals: {
            ABC123: {
              code: 'ABC123',
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              phrase: 'APPROVE TEST',
              status: 'pending',
              created_at: new Date(now).toISOString(),
              created_timestamp: now,
              expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
              expires_timestamp: now + 5 * 60 * 1000,
            },
          },
        };

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));

        // Try with lowercase
        const result = getProtectedActionRequest({ code: 'abc123' });

        expect(result.found).toBe(true);
        expect(result.request?.code).toBe('ABC123');
      });

      it('should include tool arguments in request', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        const now = Date.now();
        const toolArgs = {
          database: 'production',
          action: 'delete',
          table: 'users',
          where: 'id > 1000',
        };

        const approvals = {
          approvals: {
            ARGS12: {
              code: 'ARGS12',
              server: 'postgres-prod',
              tool: 'execute_query',
              args: toolArgs,
              phrase: 'APPROVE PROD',
              status: 'pending',
              created_at: new Date(now).toISOString(),
              created_timestamp: now,
              expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
              expires_timestamp: now + 5 * 60 * 1000,
            },
          },
        };

        fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));

        const result = getProtectedActionRequest({ code: 'ARGS12' });

        expect(result.found).toBe(true);
        expect(result.request?.args).toEqual(toolArgs);
      });

      it('should handle corrupted approvals file gracefully (G001)', () => {
        const approvalsDir = path.dirname(APPROVALS_PATH);
        if (!fs.existsSync(approvalsDir)) {
          fs.mkdirSync(approvalsDir, { recursive: true });
        }

        // Write invalid JSON
        fs.writeFileSync(APPROVALS_PATH, '{ invalid json }');

        const result = getProtectedActionRequest({ code: 'ABC123' });

        expect(result.found).toBe(false);
        expect(result.message).toContain('Error reading approval requests');
      });
    });
  });

  // ==========================================================================
  // CTO Briefing Recording (CTO Activity Gate)
  // ==========================================================================

  describe('CTO Briefing Recording', () => {
    const recordCtoBriefing = () => {
      const config = getAutonomousConfig(configPath);
      const now = new Date().toISOString();
      config.lastCtoBriefing = now;
      config.lastModified = now;
      config.modifiedBy = 'deputy-cto';

      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return {
          recorded: true,
          timestamp: now,
          message: `CTO briefing activity recorded at ${now}. Automation gate refreshed for 24 hours.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          recorded: false,
          timestamp: now,
          message: `Failed to record CTO briefing timestamp: ${message}`,
        };
      }
    };

    it('should record CTO briefing timestamp on first call', () => {
      // No config file exists yet
      expect(fs.existsSync(configPath)).toBe(false);

      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);
      expect(result.timestamp).toBeDefined();
      expect(result.message).toContain('CTO briefing activity recorded');
      expect(result.message).toContain('Automation gate refreshed for 24 hours');

      // Verify config file was created
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.lastCtoBriefing).toBe(result.timestamp);
      expect(config.lastModified).toBe(result.timestamp);
      expect(config.modifiedBy).toBe('deputy-cto');
    });

    it('should update existing briefing timestamp', () => {
      // Create initial config with old briefing
      const oldBriefing = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, lastCtoBriefing: oldBriefing })
      );

      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);

      // Verify timestamp was updated
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.lastCtoBriefing).not.toBe(oldBriefing);
      expect(config.lastCtoBriefing).toBe(result.timestamp);

      // Verify it's recent (within last minute)
      const briefingTime = new Date(config.lastCtoBriefing).getTime();
      const age = Date.now() - briefingTime;
      expect(age).toBeLessThan(60 * 1000); // Less than 1 minute old
    });

    it('should preserve other config fields when recording briefing', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          claudeMdRefactorEnabled: false,
          lastModified: '2026-01-15T10:00:00Z',
          modifiedBy: 'cto',
        })
      );

      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.enabled).toBe(true);
      expect(config.claudeMdRefactorEnabled).toBe(false);
      expect(config.lastCtoBriefing).toBe(result.timestamp);
      expect(config.modifiedBy).toBe('deputy-cto'); // Updated
    });

    it('should handle missing config file (creates with defaults)', () => {
      // Delete config file but leave directory
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      const result = recordCtoBriefing();

      // Should succeed - getAutonomousConfig returns defaults which then get written
      expect(result.recorded).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.lastCtoBriefing).toBe(result.timestamp);
    });

    it('should fail gracefully when config file cannot be written (G001)', () => {
      // Create config file as read-only
      fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
      fs.chmodSync(configPath, 0o444); // Read-only

      const result = recordCtoBriefing();

      // G001: Should fail-closed with error
      expect(result.recorded).toBe(false);
      expect(result.timestamp).toBeDefined();
      expect(result.message).toContain('Failed to record CTO briefing timestamp');

      // Restore permissions for cleanup
      fs.chmodSync(configPath, 0o644);
    });

    it('should record timestamp in ISO 8601 format', () => {
      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);

      // Verify ISO 8601 format
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(result.timestamp).toMatch(isoRegex);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.lastCtoBriefing).toMatch(isoRegex);

      // Verify timestamp is parseable
      const time = new Date(config.lastCtoBriefing).getTime();
      expect(isNaN(time)).toBe(false);
    });

    it('should set modifiedBy to "deputy-cto"', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ enabled: true, modifiedBy: 'cto' })
      );

      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.modifiedBy).toBe('deputy-cto');
    });

    it('should result in CTO gate opening after recording', () => {
      const result = recordCtoBriefing();

      expect(result.recorded).toBe(true);

      // Check status immediately after
      const status = getAutonomousModeStatus(configPath, statePath);

      expect(status.ctoGateOpen).toBe(true);
      expect(status.hoursSinceLastBriefing).toBe(0);
      expect(status.lastCtoBriefing).toBe(result.timestamp);
    });
  });

  // ==========================================================================
  // Bypass Security Guards
  // ==========================================================================

  describe('Bypass Security Guards', () => {
    describe('approveCommit() EMERGENCY BYPASS guard', () => {
      it('should reject rationale starting with "EMERGENCY BYPASS"', () => {
        const result = approveCommit('EMERGENCY BYPASS - skipping review');

        expect(result.approved).toBe(false);
        expect(result.decision_id).toBe('');
        expect(result.message).toContain('Cannot use "EMERGENCY BYPASS" prefix');
      });

      it('should reject case-insensitive "emergency bypass" prefix', () => {
        const result = approveCommit('emergency bypass - agent forced');

        expect(result.approved).toBe(false);
        expect(result.message).toContain('Cannot use "EMERGENCY BYPASS" prefix');
      });

      it('should reject with extra whitespace "EMERGENCY  BYPASS"', () => {
        const result = approveCommit('EMERGENCY  BYPASS - with extra space');

        expect(result.approved).toBe(false);
        expect(result.message).toContain('Cannot use "EMERGENCY BYPASS" prefix');
      });

      it('should allow normal rationales containing "bypass" not at start', () => {
        const result = approveCommit('Clean commit, no need to bypass any review');

        expect(result.approved).toBe(true);
        expect(result.decision_id).toBeDefined();
      });

      it('should allow rationale with "EMERGENCY" not followed by "BYPASS"', () => {
        const result = approveCommit('EMERGENCY fix for production bug');

        expect(result.approved).toBe(true);
        expect(result.decision_id).toBeDefined();
      });
    });

    describe('answerQuestion() type guards', () => {
      it('should reject answering bypass-request questions', () => {
        const questionId = insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Agent wants to bypass review',
        });

        const result = answerQuestion({ id: questionId, answer: 'Approved by agent' });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot answer bypass-request questions');
        expect((result as { error: string }).error).toContain('APPROVE BYPASS');
      });

      it('should reject answering protected-action-request questions', () => {
        const questionId = insertQuestionDirectly({
          type: 'protected-action-request',
          title: 'Protected action',
          description: 'Agent wants to run protected action',
        });

        const result = answerQuestion({ id: questionId, answer: 'Go ahead' });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot answer protected-action-request questions');
        expect((result as { error: string }).error).toContain('approve_protected_action');
      });

      it('should allow answering normal question types', () => {
        const questionId = insertQuestionDirectly({
          type: 'decision',
          title: 'Which approach?',
          description: 'Option A or B',
        });

        const result = answerQuestion({ id: questionId, answer: 'Option A' });

        expect(result).toHaveProperty('answered');
        expect((result as { answered: boolean }).answered).toBe(true);
      });
    });

    describe('clearQuestion() type guards', () => {
      it('should reject clearing pending bypass-request questions', () => {
        const questionId = insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Agent wants to bypass review',
          status: 'pending',
        });

        const result = clearQuestion({ id: questionId });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot clear a pending bypass-request');
        expect((result as { error: string }).error).toContain('APPROVE BYPASS');
      });

      it('should reject clearing pending protected-action-request questions', () => {
        const questionId = insertQuestionDirectly({
          type: 'protected-action-request',
          title: 'Protected action',
          description: 'Agent wants to run protected action',
          status: 'pending',
        });

        const result = clearQuestion({ id: questionId });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot clear a pending protected-action-request');
      });

      it('should allow clearing answered bypass-request questions', () => {
        const questionId = insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'CTO approved this bypass',
          status: 'answered',
        });

        const result = clearQuestion({ id: questionId });

        expect(result).toHaveProperty('cleared');
        expect((result as { cleared: boolean }).cleared).toBe(true);
      });
    });

    describe('addQuestion() type guards', () => {
      it('should reject creating bypass-request questions', () => {
        const result = addQuestion({
          type: 'bypass-request',
          title: 'Fake bypass request',
          description: 'Agent trying to forge a bypass-request',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot create bypass-request questions via add_question');
        expect((result as { error: string }).error).toContain('request_bypass');
      });

      it('should reject creating protected-action-request questions', () => {
        const result = addQuestion({
          type: 'protected-action-request',
          title: 'Fake protected action',
          description: 'Agent trying to forge a protected-action-request',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Cannot create protected-action-request questions via add_question');
        expect((result as { error: string }).error).toContain('protected-action hook');
      });
    });

    describe('executeBypass() HMAC verification', () => {
      // Helper to compute HMAC matching the server's computeHmac
      const computeHmac = (key: string, ...fields: string[]): string => {
        const keyBuffer = Buffer.from(key, 'base64');
        return createHmac('sha256', keyBuffer)
          .update(fields.join('|'))
          .digest('hex');
      };

      const protectionKey = Buffer.from('test-protection-key-32bytes!!!!').toString('base64');

      // Helper to simulate executeBypass with HMAC verification logic
      const executeBypassWithHmac = (
        bypassCode: string,
        tokenData: Record<string, unknown>,
        protKey: string | null,
      ) => {
        const code = bypassCode.toUpperCase();

        // Check bypass request exists
        const question = db.prepare(
          "SELECT id, title FROM questions WHERE type = 'bypass-request' AND status = 'pending' AND context = ?"
        ).get(code) as { id: string; title: string } | undefined;

        if (!question) {
          return { error: `No pending bypass request found with code: ${code}` };
        }

        // Simulate token file parsing
        const token = tokenData as {
          code: string;
          request_id: string;
          user_message: string;
          expires_timestamp: number;
          hmac?: string;
        };

        // Empty token check
        if (!token.code && !token.request_id && !token.expires_timestamp) {
          return { error: `No approval token found.` };
        }

        // HMAC verification
        if (!protKey) {
          return { error: 'Protection key missing. Cannot verify bypass approval token. Restore .claude/protection-key.' };
        }
        const expectedHmac = computeHmac(protKey, token.code, token.request_id, String(token.expires_timestamp), 'bypass-approved');
        if (token.hmac !== expectedHmac) {
          return { error: 'FORGERY DETECTED: Invalid bypass approval token signature. Token deleted.' };
        }

        // Code match
        if (token.code !== code) {
          return { error: `Approval token is for a different bypass code.` };
        }

        // Expiry
        if (Date.now() > token.expires_timestamp) {
          return { error: `Approval token has expired.` };
        }

        return { approved: true };
      };

      it('should reject forged token with invalid HMAC', () => {
        const code = 'ABC123';
        // Insert a bypass-request question
        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Test',
          status: 'pending',
        });
        // Set the context (bypass code) on the question
        db.prepare("UPDATE questions SET context = ? WHERE type = 'bypass-request'").run(code);

        const forgedToken = {
          code,
          request_id: randomUUID(),
          user_message: 'APPROVE BYPASS ABC123',
          expires_timestamp: Date.now() + 60000,
          hmac: 'forged-hmac-value',
        };

        const result = executeBypassWithHmac(code, forgedToken, protectionKey);
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('FORGERY DETECTED');
      });

      it('should reject token without HMAC when key exists', () => {
        const code = 'XYZ789';
        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Test',
          status: 'pending',
        });
        db.prepare("UPDATE questions SET context = ? WHERE type = 'bypass-request' AND context IS NULL").run(code);

        const tokenWithoutHmac = {
          code,
          request_id: randomUUID(),
          user_message: 'APPROVE BYPASS XYZ789',
          expires_timestamp: Date.now() + 60000,
          // no hmac field
        };

        const result = executeBypassWithHmac(code, tokenWithoutHmac, protectionKey);
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('FORGERY DETECTED');
      });

      it('should error when protection key is missing', () => {
        const code = 'KEY000';
        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Test',
          status: 'pending',
        });
        db.prepare("UPDATE questions SET context = ? WHERE type = 'bypass-request' AND context IS NULL").run(code);

        const token = {
          code,
          request_id: randomUUID(),
          user_message: 'APPROVE BYPASS KEY000',
          expires_timestamp: Date.now() + 60000,
          hmac: 'some-hmac',
        };

        const result = executeBypassWithHmac(code, token, null);
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Protection key missing');
      });

      it('should accept token with valid HMAC', () => {
        const code = 'VALID1';
        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass needed',
          description: 'Test',
          status: 'pending',
        });
        db.prepare("UPDATE questions SET context = ? WHERE type = 'bypass-request' AND context IS NULL").run(code);

        const requestId = randomUUID();
        const expiresTimestamp = Date.now() + 60000;
        const validHmac = computeHmac(protectionKey, code, requestId, String(expiresTimestamp), 'bypass-approved');

        const token = {
          code,
          request_id: requestId,
          user_message: 'APPROVE BYPASS VALID1',
          expires_timestamp: expiresTimestamp,
          hmac: validHmac,
        };

        const result = executeBypassWithHmac(code, token, protectionKey);
        expect(result).toHaveProperty('approved');
        expect((result as { approved: boolean }).approved).toBe(true);
      });
    });

    describe('getPendingCountTool() triage count', () => {
      // Helper mirroring getPendingCountTool logic.
      // Triage count is simulated (production reads from a separate reports DB).
      const getPendingCountTool = (pendingTriageCount: number = 0) => {
        const pendingCount = (db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
        ).get() as { count: number }).count;
        const rejectionCount = (db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
        ).get() as { count: number }).count;
        return {
          pending_count: pendingCount,
          rejection_count: rejectionCount,
          pending_triage_count: pendingTriageCount,
          commits_blocked: pendingCount > 0 || pendingTriageCount > 0,
        };
      };

      it('should return pending_triage_count in result', () => {
        const result = getPendingCountTool(3);

        expect(result).toHaveProperty('pending_triage_count');
        expect(result.pending_triage_count).toBe(3);
        expect(result.commits_blocked).toBe(true);
      });

      it('should not block commits when no pending items exist', () => {
        const result = getPendingCountTool(0);

        expect(result.pending_count).toBe(0);
        expect(result.pending_triage_count).toBe(0);
        expect(result.commits_blocked).toBe(false);
      });

      it('should block commits when only triage items are pending', () => {
        const result = getPendingCountTool(1);

        expect(result.pending_count).toBe(0);
        expect(result.pending_triage_count).toBe(1);
        expect(result.commits_blocked).toBe(true);
      });

      it('should block commits when pending questions exist', () => {
        insertQuestionDirectly({
          type: 'decision',
          title: 'Test question',
          description: 'Test',
          status: 'pending',
        });

        const result = getPendingCountTool();
        expect(result.pending_count).toBe(1);
        expect(result.commits_blocked).toBe(true);
      });
    });

    describe('Bypass Request TTL', () => {
      // TTL constant matching server.ts BYPASS_REQUEST_TTL_S
      const BYPASS_REQUEST_TTL_S = 3600;

      // Helper mirroring expireStaleBypassRequests logic
      const expireStaleBypassRequests = (): number => {
        const cutoff = new Date(Date.now() - BYPASS_REQUEST_TTL_S * 1000).toISOString();
        const result = db.prepare(`
          DELETE FROM questions
          WHERE type = 'bypass-request' AND status = 'pending'
          AND created_timestamp < ?
        `).run(cutoff);
        return result.changes;
      };

      // Helper mirroring cleanupOldRecords + bypass expiry
      const cleanupOldRecords = () => {
        const bypassExpired = expireStaleBypassRequests();

        const commitDecisionsResult = db.prepare(`
          DELETE FROM commit_decisions WHERE id NOT IN (
            SELECT id FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 100
          )
        `).run();

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const clearedQuestionsResult = db.prepare(`
          DELETE FROM cleared_questions
          WHERE cleared_timestamp < ?
          AND id NOT IN (
            SELECT id FROM cleared_questions ORDER BY cleared_timestamp DESC LIMIT 500
          )
        `).run(thirtyDaysAgo);

        return {
          commit_decisions_deleted: commitDecisionsResult.changes,
          cleared_questions_deleted: clearedQuestionsResult.changes,
          bypass_requests_expired: bypassExpired,
          message: '',
        };
      };

      // Helper mirroring getPendingCount with bypass expiry
      const getPendingCount = (): number => {
        expireStaleBypassRequests();
        const result = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
        ).get() as { count: number };
        return result.count;
      };

      it('should expire stale bypass-requests during cleanup', () => {
        const twoHoursAgo = new Date(Date.now() - 7200 * 1000).toISOString();

        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Stale bypass',
          description: 'From dead agent',
          status: 'pending',
          created_timestamp: twoHoursAgo,
        });

        const result = cleanupOldRecords();

        expect(result.bypass_requests_expired).toBe(1);

        // Verify the row was deleted
        const count = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request'"
        ).get() as { count: number };
        expect(count.count).toBe(0);
      });

      it('should preserve recent bypass-requests during cleanup', () => {
        const thirtyMinAgo = new Date(Date.now() - 1800 * 1000).toISOString();

        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Recent bypass',
          description: 'Still active agent',
          status: 'pending',
          created_timestamp: thirtyMinAgo,
        });

        const result = cleanupOldRecords();

        expect(result.bypass_requests_expired).toBe(0);

        // Verify the row still exists
        const count = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request'"
        ).get() as { count: number };
        expect(count.count).toBe(1);
      });

      it('should self-clean stale requests before rate-limit in requestBypass', () => {
        const twoHoursAgo = new Date(Date.now() - 7200 * 1000).toISOString();

        // Insert 3 stale bypass requests (would hit rate limit)
        for (let i = 0; i < 3; i++) {
          insertQuestionDirectly({
            type: 'bypass-request',
            title: `Stale bypass ${i}`,
            description: `From dead agent ${i}`,
            status: 'pending',
            created_timestamp: twoHoursAgo,
          });
        }

        // Verify they exist before cleanup
        const beforeCount = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND status = 'pending'"
        ).get() as { count: number };
        expect(beforeCount.count).toBe(3);

        // Expire them (simulating what requestBypass does before rate-limit check)
        expireStaleBypassRequests();

        // Verify they're gone
        const afterCount = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND status = 'pending'"
        ).get() as { count: number };
        expect(afterCount.count).toBe(0);
      });

      it('should exclude expired bypass-requests from getPendingCount', () => {
        const twoHoursAgo = new Date(Date.now() - 7200 * 1000).toISOString();

        // Insert one expired bypass-request
        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Expired bypass',
          description: 'From dead agent',
          status: 'pending',
          created_timestamp: twoHoursAgo,
        });

        // Insert one fresh decision question
        insertQuestionDirectly({
          type: 'decision',
          title: 'Fresh question',
          description: 'Still relevant',
          status: 'pending',
        });

        const count = getPendingCount();

        // Should only count the fresh decision, not the expired bypass-request
        expect(count).toBe(1);
      });

      it('should not expire answered bypass-requests', () => {
        const twoHoursAgo = new Date(Date.now() - 7200 * 1000).toISOString();

        insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Old but answered bypass',
          description: 'CTO handled this',
          status: 'answered',
          created_timestamp: twoHoursAgo,
        });

        const expired = expireStaleBypassRequests();

        expect(expired).toBe(0);

        // Verify it still exists
        const count = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request'"
        ).get() as { count: number };
        expect(count.count).toBe(1);
      });

      it('should not expire non-bypass-request questions', () => {
        const twoHoursAgo = new Date(Date.now() - 7200 * 1000).toISOString();

        insertQuestionDirectly({
          type: 'decision',
          title: 'Old decision',
          description: 'Still waiting for CTO',
          status: 'pending',
          created_timestamp: twoHoursAgo,
        });

        const expired = expireStaleBypassRequests();

        expect(expired).toBe(0);

        const count = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'decision'"
        ).get() as { count: number };
        expect(count.count).toBe(1);
      });
    });

    describe('requestBypass() rate limiting', () => {
      // Helper mirroring requestBypass logic with rate limit
      const requestBypass = (args: { reporting_agent: string; reason: string; blocked_by?: string }) => {
        // Rate limit check
        const pendingBypasses = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND status = 'pending'"
        ).get() as { count: number };
        if (pendingBypasses.count >= 3) {
          return {
            request_id: '',
            bypass_code: '',
            message: 'Too many pending bypass requests (max 3). Wait for existing requests to be addressed before submitting more.',
            instructions: 'Wait for the CTO to address existing bypass requests.',
          };
        }

        const id = randomUUID();
        const bypassCode = 'TEST01';
        const now = new Date();
        const created_at = now.toISOString();
        const created_timestamp = now.toISOString();

        db.prepare(`
          INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
          VALUES (?, 'bypass-request', 'pending', ?, ?, ?, ?, ?)
        `).run(id, `Bypass Request: ${args.reason.substring(0, 100)}`, args.reason, bypassCode, created_at, created_timestamp);

        return {
          request_id: id,
          bypass_code: bypassCode,
          message: `Bypass request submitted.`,
          instructions: `STOP attempting commits.`,
        };
      };

      it('should reject when 3 pending bypass requests exist', () => {
        // Insert 3 pending bypass-request questions
        for (let i = 0; i < 3; i++) {
          insertQuestionDirectly({
            type: 'bypass-request',
            title: `Bypass ${i}`,
            description: `Agent bypass request ${i}`,
            status: 'pending',
          });
        }

        const result = requestBypass({
          reporting_agent: 'test-agent',
          reason: 'Need to bypass',
        });

        expect(result.request_id).toBe('');
        expect(result.bypass_code).toBe('');
        expect(result.message).toContain('Too many pending bypass requests');
        expect(result.message).toContain('max 3');
      });

      it('should allow when fewer than 3 pending bypass requests exist', () => {
        // Insert 2 pending bypass-request questions
        for (let i = 0; i < 2; i++) {
          insertQuestionDirectly({
            type: 'bypass-request',
            title: `Bypass ${i}`,
            description: `Agent bypass request ${i}`,
            status: 'pending',
          });
        }

        const result = requestBypass({
          reporting_agent: 'test-agent',
          reason: 'Need to bypass',
        });

        expect(result.request_id).not.toBe('');
        expect(result.bypass_code).not.toBe('');
        expect(result.message).toContain('Bypass request submitted');
      });

      it('should not count answered bypass requests toward limit', () => {
        // Insert 3 bypass requests but mark them as answered
        for (let i = 0; i < 3; i++) {
          insertQuestionDirectly({
            type: 'bypass-request',
            title: `Bypass ${i}`,
            description: `Agent bypass request ${i}`,
            status: 'answered',
          });
        }

        const result = requestBypass({
          reporting_agent: 'test-agent',
          reason: 'Need to bypass',
        });

        expect(result.request_id).not.toBe('');
        expect(result.message).toContain('Bypass request submitted');
      });
    });
  });

  // ==========================================================================
  // Investigation Tools
  // ==========================================================================

  describe('Investigation Tools', () => {
    const MAX_CONTEXT_SIZE = 10 * 1024;

    const updateQuestion = (args: { id: string; append_context: string }) => {
      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRow | undefined;

      if (!question) {
        return { error: `Question not found: ${args.id}` };
      }

      if (question.status !== 'pending') {
        return { error: `Cannot update question ${args.id}: status is '${question.status}', expected 'pending'.` };
      }

      if (question.type === 'bypass-request' || question.type === 'protected-action-request') {
        return { error: `Cannot update ${question.type} questions via update_question.` };
      }

      const separator = `\n\n--- Investigation Update (${new Date().toISOString()}) ---\n`;
      const existingContext = question.context ?? '';
      const newContext = existingContext + separator + args.append_context;

      if (newContext.length > MAX_CONTEXT_SIZE) {
        return { error: `Context would exceed 10KB limit (current: ${existingContext.length} bytes, appending: ${args.append_context.length + separator.length} bytes).` };
      }

      db.prepare('UPDATE questions SET context = ? WHERE id = ?').run(newContext, args.id);

      return {
        id: args.id,
        updated: true,
        message: `Investigation findings appended to question ${args.id}. Context is now ${newContext.length} bytes.`,
      };
    };

    const resolveQuestion = (args: { id: string; resolution: string; resolution_detail: string }) => {
      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRow | undefined;

      if (!question) {
        return { error: `Question not found: ${args.id}` };
      }

      if (question.status === 'answered') {
        return { error: `Question ${args.id} is already answered. Cannot resolve an already-answered question.` };
      }

      if (question.type === 'bypass-request' || question.type === 'protected-action-request') {
        return { error: `Cannot resolve ${question.type} questions via resolve_question.` };
      }

      const now = new Date();
      const answered_at = now.toISOString();
      const cleared_timestamp = now.toISOString();
      const answer = `[Resolved by investigation: ${args.resolution}]\n${args.resolution_detail}`;

      const txn = db.transaction(() => {
        db.prepare(`
          UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, decided_by = 'deputy-cto'
          WHERE id = ?
        `).run(answer, answered_at, args.id);

        db.prepare(`
          INSERT INTO cleared_questions (id, type, title, description, recommendation, answer, answered_at, decided_by, cleared_at, cleared_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'deputy-cto', ?, ?)
        `).run(
          question.id,
          question.type,
          question.title,
          question.description,
          (question as QuestionRow & { recommendation?: string }).recommendation ?? null,
          answer,
          answered_at,
          answered_at,
          cleared_timestamp
        );

        db.prepare('DELETE FROM questions WHERE id = ?').run(args.id);
      });

      txn();

      const remaining = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
      ).get() as { count: number };

      return {
        id: args.id,
        resolved: true,
        resolution: args.resolution,
        remaining_pending_count: remaining.count,
        message: `Question ${args.id} resolved as '${args.resolution}' by investigation. ${remaining.count} pending question(s) remaining.`,
      };
    };

    describe('update_question', () => {
      it('should append context with timestamp separator', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'CI failure',
          description: 'CI has been failing for 3 days',
          context: 'Initial context from triage',
          recommendation: 'Investigate root cause',
        });

        const result = updateQuestion({
          id: q.id,
          append_context: 'Found: flaky test in auth module',
        });

        expect(result).not.toHaveProperty('error');
        expect((result as { updated: boolean }).updated).toBe(true);

        const updated = db.prepare('SELECT context FROM questions WHERE id = ?').get(q.id) as { context: string };
        expect(updated.context).toContain('Initial context from triage');
        expect(updated.context).toContain('--- Investigation Update (');
        expect(updated.context).toContain('Found: flaky test in auth module');
      });

      it('should accumulate multiple updates', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'Performance issue',
          description: 'Slow API responses',
          recommendation: 'Profile the endpoints',
        });

        updateQuestion({ id: q.id, append_context: 'Update 1: profiled /api/users - 2s avg' });
        updateQuestion({ id: q.id, append_context: 'Update 2: found N+1 query in user loader' });
        const result = updateQuestion({ id: q.id, append_context: 'Update 3: fix applied, testing' });

        expect(result).not.toHaveProperty('error');

        const updated = db.prepare('SELECT context FROM questions WHERE id = ?').get(q.id) as { context: string };
        expect(updated.context).toContain('Update 1:');
        expect(updated.context).toContain('Update 2:');
        expect(updated.context).toContain('Update 3:');

        // Should have 3 separator lines
        const separatorCount = (updated.context.match(/--- Investigation Update/g) || []).length;
        expect(separatorCount).toBe(3);
      });

      it('should reject when context would exceed 10KB', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'Large context test',
          description: 'Testing size limit',
          context: 'x'.repeat(9000), // Already close to limit
          recommendation: 'Test recommendation',
        });

        const result = updateQuestion({
          id: q.id,
          append_context: 'y'.repeat(2000), // This would push over 10KB
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('10KB limit');
      });

      it('should reject when question is not pending', () => {
        const q = addQuestion({
          type: 'decision',
          title: 'Test',
          description: 'Test desc',
        });

        // Answer the question
        answerQuestion({ id: q.id, answer: 'Done' });

        const result = updateQuestion({
          id: q.id,
          append_context: 'Late findings',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain("status is 'answered'");
      });

      it('should reject bypass-request type', () => {
        const id = insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass test',
          description: 'Testing',
        });

        const result = updateQuestion({
          id,
          append_context: 'Trying to update bypass',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('bypass-request');
      });

      it('should reject protected-action-request type', () => {
        const id = insertQuestionDirectly({
          type: 'protected-action-request',
          title: 'PAR test',
          description: 'Testing',
        });

        const result = updateQuestion({
          id,
          append_context: 'Trying to update PAR',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('protected-action-request');
      });

      it('should return error for non-existent question', () => {
        const result = updateQuestion({
          id: 'non-existent-uuid',
          append_context: 'Does not matter',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Question not found');
      });
    });

    describe('resolve_question', () => {
      it('should resolve and archive a pending escalation', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'CI failure',
          description: 'CI failing for 3 days',
          recommendation: 'Investigate',
        });

        const result = resolveQuestion({
          id: q.id,
          resolution: 'fixed',
          resolution_detail: 'Flaky test removed in commit abc123',
        });

        expect(result).not.toHaveProperty('error');
        expect((result as { resolved: boolean }).resolved).toBe(true);
        expect((result as { resolution: string }).resolution).toBe('fixed');

        // Should be removed from active questions
        const active = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
        expect(active).toBeUndefined();

        // Should be archived in cleared_questions
        const cleared = db.prepare('SELECT * FROM cleared_questions WHERE id = ?').get(q.id) as {
          answer: string;
          decided_by: string;
        };
        expect(cleared).toBeDefined();
        expect(cleared.answer).toContain('[Resolved by investigation: fixed]');
        expect(cleared.answer).toContain('Flaky test removed in commit abc123');
        expect(cleared.decided_by).toBe('deputy-cto');
      });

      it('should decrease pending count after resolution', () => {
        const q1 = addQuestion({
          type: 'escalation',
          title: 'Issue 1',
          description: 'Desc 1',
          recommendation: 'Rec 1',
        });
        addQuestion({
          type: 'decision',
          title: 'Issue 2',
          description: 'Desc 2',
        });

        const before = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
        ).get() as { count: number };
        expect(before.count).toBe(2);

        const result = resolveQuestion({
          id: q1.id,
          resolution: 'not_reproducible',
          resolution_detail: 'Could not reproduce after investigation',
        });

        expect((result as { remaining_pending_count: number }).remaining_pending_count).toBe(1);
      });

      it('should reject already-answered questions', () => {
        const q = addQuestion({
          type: 'decision',
          title: 'Already answered',
          description: 'This will be answered',
        });

        answerQuestion({ id: q.id, answer: 'CTO answered this' });

        const result = resolveQuestion({
          id: q.id,
          resolution: 'fixed',
          resolution_detail: 'Trying to resolve',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('already answered');
      });

      it('should reject bypass-request type', () => {
        const id = insertQuestionDirectly({
          type: 'bypass-request',
          title: 'Bypass test',
          description: 'Testing',
        });

        const result = resolveQuestion({
          id,
          resolution: 'fixed',
          resolution_detail: 'Trying to resolve bypass',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('bypass-request');
      });

      it('should reject protected-action-request type', () => {
        const id = insertQuestionDirectly({
          type: 'protected-action-request',
          title: 'PAR test',
          description: 'Testing',
        });

        const result = resolveQuestion({
          id,
          resolution: 'fixed',
          resolution_detail: 'Trying to resolve PAR',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('protected-action-request');
      });

      it('should return error for non-existent question', () => {
        const result = resolveQuestion({
          id: 'non-existent-uuid',
          resolution: 'fixed',
          resolution_detail: 'Does not matter',
        });

        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('Question not found');
      });

      it('should maintain transaction atomicity (all-or-nothing)', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'Atomicity test',
          description: 'Testing transaction',
          recommendation: 'Test',
        });

        // Resolve it
        resolveQuestion({
          id: q.id,
          resolution: 'duplicate',
          resolution_detail: 'Duplicate of earlier issue',
        });

        // Verify all three operations happened:
        // 1. No active question
        const active = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
        expect(active).toBeUndefined();

        // 2. Cleared question exists
        const cleared = db.prepare('SELECT * FROM cleared_questions WHERE id = ?').get(q.id) as {
          id: string;
          decided_by: string;
        } | undefined;
        expect(cleared).toBeDefined();
        expect(cleared!.decided_by).toBe('deputy-cto');
      });
    });

    describe('add_question with investigation_task_id', () => {
      it('should store investigation_task_id when provided', () => {
        const q = addQuestion({
          type: 'escalation',
          title: 'Linked escalation',
          description: 'Has an investigation task',
          recommendation: 'Investigate first',
          investigation_task_id: 'task-uuid-123',
        });

        const question = db.prepare('SELECT investigation_task_id FROM questions WHERE id = ?').get(q.id) as {
          investigation_task_id: string | null;
        };
        expect(question.investigation_task_id).toBe('task-uuid-123');
      });

      it('should default investigation_task_id to null when omitted', () => {
        const q = addQuestion({
          type: 'decision',
          title: 'No investigation',
          description: 'Standard question without investigation',
        });

        const question = db.prepare('SELECT investigation_task_id FROM questions WHERE id = ?').get(q.id) as {
          investigation_task_id: string | null;
        };
        expect(question.investigation_task_id).toBeNull();
      });
    });
  });
});
