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
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, suggested_options, recommendation, created_at, created_timestamp)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.title,
      args.description,
      args.context ?? null,
      args.suggested_options ? JSON.stringify(args.suggested_options) : null,
      args.recommendation ?? null,
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
    const cleared_timestamp = Math.floor(now.getTime() / 1000);

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
  }) => {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.status ?? 'pending',
      args.title,
      args.description,
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
        const created_timestamp = Math.floor(now.getTime() / 1000);

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
});
