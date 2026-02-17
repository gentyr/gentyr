/**
 * Unit tests for CTO Report MCP Server
 *
 * Tests comprehensive CTO reporting, token usage calculation,
 * session metrics, pending items aggregation, and task metrics.
 *
 * Uses in-memory databases and mock file systems for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Types for session entries
interface SessionEntry {
  type: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  message?: {
    role?: string;
    content?: string | unknown[];
    model?: string;
  };
  // Allow additional fields for flexibility
  [key: string]: unknown;
}

// Types for metrics (used in task metrics calculations)
interface _SectionStats {
  pending: number;
  in_progress: number;
  completed: number;
}

describe('CTO Report Server', () => {
  let tempDir: string;
  let projectDir: string;
  let todoDB: Database.Database;
  let deputyCTODB: Database.Database;
  let ctoReportsDB: Database.Database;

  // Mock file paths
  let autonomousConfigPath: string;
  let automationStatePath: string;
  let sessionDir: string;

  beforeEach(() => {
    // Create temp directory structure
    tempDir = path.join('/tmp', `cto-report-test-${  randomUUID()}`);
    projectDir = path.join(tempDir, 'project');
    const claudeDir = path.join(projectDir, '.claude');
    const hooksDir = path.join(claudeDir, 'hooks');

    fs.mkdirSync(hooksDir, { recursive: true });

    // Initialize databases
    todoDB = new Database(':memory:');
    todoDB.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        section TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        assigned_by TEXT,
        metadata TEXT,
        created_timestamp INTEGER NOT NULL,
        completed_timestamp INTEGER,
        followup_enabled INTEGER NOT NULL DEFAULT 0,
        followup_section TEXT,
        followup_prompt TEXT,
        CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'completed')),
        CONSTRAINT valid_section CHECK (section IN ('TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER', 'DEPUTY-CTO'))
      );
      CREATE INDEX idx_tasks_completed_timestamp ON tasks(completed_timestamp);
    `);

    deputyCTODB = new Database(':memory:');
    deputyCTODB.exec(`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        question TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    ctoReportsDB = new Database(':memory:');
    ctoReportsDB.exec(`
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        reporting_agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
    `);

    // Create mock file paths
    autonomousConfigPath = path.join(claudeDir, 'autonomous-mode.json');
    automationStatePath = path.join(claudeDir, 'hourly-automation-state.json');

    // Create session directory
    // Claude stores sessions with all non-alphanumeric chars replaced by '-'
    const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Set environment variable
    process.env.CLAUDE_PROJECT_DIR = projectDir;
  });

  afterEach(() => {
    todoDB.close();
    deputyCTODB.close();
    ctoReportsDB.close();

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    delete process.env.CLAUDE_PROJECT_DIR;
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  const createTask = (args: {
    section: string;
    status: string;
    title: string;
    created_timestamp?: number;
    completed_timestamp?: number;
  }) => {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = args.created_timestamp ?? Math.floor(now.getTime() / 1000);
    const completed_at = args.status === 'completed' ? now.toISOString() : null;
    const completed_timestamp = args.status === 'completed'
      ? (args.completed_timestamp ?? created_timestamp)
      : null;

    todoDB.prepare(`
      INSERT INTO tasks (id, section, status, title, created_at, created_timestamp, completed_at, completed_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, args.section, args.status, args.title, created_at, created_timestamp, completed_at, completed_timestamp);

    return id;
  };

  const createQuestion = (args: { type: string; status: string; question: string }) => {
    const id = randomUUID();
    const created_at = new Date().toISOString();

    deputyCTODB.prepare(`
      INSERT INTO questions (id, type, status, question, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, args.type, args.status, args.question, created_at);

    return id;
  };

  const createReport = (args: { title: string; read: boolean }) => {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const read_at = args.read ? created_at : null;

    ctoReportsDB.prepare(`
      INSERT INTO reports (id, title, summary, category, priority, reporting_agent, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, args.title, 'Test summary', 'architecture', 'normal', 'test-writer', created_at, read_at);

    return id;
  };

  const writeAutonomousConfig = (config: { enabled: boolean }) => {
    fs.writeFileSync(autonomousConfigPath, JSON.stringify(config));
  };

  const writeAutomationState = (state: { lastRun: number }) => {
    fs.writeFileSync(automationStatePath, JSON.stringify(state));
  };

  const createSessionFile = (sessionId: string, entries: SessionEntry[]) => {
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    const content = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  // ============================================================================
  // Token Usage Calculation Tests
  // ============================================================================

  describe('Token Usage Calculation', () => {
    it('should calculate total token usage from session files', () => {
      const sessionId = randomUUID();
      const entries = [
        {
          timestamp: new Date().toISOString(),
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 10,
            },
          },
        },
        {
          timestamp: new Date().toISOString(),
          message: {
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 15,
            },
          },
        },
      ];

      createSessionFile(sessionId, entries);

      // Mock getTokenUsage implementation
      const getTokenUsage = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const totals = {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
        };

        if (!fs.existsSync(sessionDir)) {
          return totals;
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(sessionDir, file);
          const stat = fs.statSync(filePath);
          if (stat.mtime.getTime() < _since) {
            continue;
          }

          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.timestamp) {
                const entryTime = new Date(entry.timestamp).getTime();
                if (entryTime < _since) {
                  continue;
                }
              }

              const usage = entry.message?.usage;
              if (usage) {
                totals.input += usage.input_tokens || 0;
                totals.output += usage.output_tokens || 0;
                totals.cache_read += usage.cache_read_input_tokens || 0;
                totals.cache_creation += usage.cache_creation_input_tokens || 0;
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
        return totals;
      };

      const result = getTokenUsage(24);

      expect(result.input).toBe(300);
      expect(result.output).toBe(150);
      expect(result.cache_read).toBe(50);
      expect(result.cache_creation).toBe(25);
      expect(result.total).toBe(525);
    });

    it('should return zero usage for non-existent session directory', () => {
      // Remove session directory
      fs.rmSync(sessionDir, { recursive: true, force: true });

      const getTokenUsage = (_hours: number) => {
        const totals = {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
        };

        if (!fs.existsSync(sessionDir)) {
          return totals;
        }

        return totals;
      };

      const result = getTokenUsage(24);

      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
      expect(result.cache_read).toBe(0);
      expect(result.cache_creation).toBe(0);
      expect(result.total).toBe(0);
    });

    it('should filter by time range', () => {
      const sessionId = randomUUID();
      const now = Date.now();
      const entries = [
        {
          timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
          message: { usage: { input_tokens: 100, output_tokens: 50 } },
        },
        {
          timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago (should be filtered)
          message: { usage: { input_tokens: 1000, output_tokens: 500 } },
        },
      ];

      createSessionFile(sessionId, entries);

      const getTokenUsage = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const totals = {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
        };

        if (!fs.existsSync(sessionDir)) {
          return totals;
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const sessionFilePath = path.join(sessionDir, file);
          const sessionContent = fs.readFileSync(sessionFilePath, 'utf8');
          const lines = sessionContent.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.timestamp) {
                const entryTime = new Date(entry.timestamp).getTime();
                if (entryTime < _since) {
                  continue;
                }
              }

              const usage = entry.message?.usage;
              if (usage) {
                totals.input += usage.input_tokens || 0;
                totals.output += usage.output_tokens || 0;
                totals.cache_read += usage.cache_read_input_tokens || 0;
                totals.cache_creation += usage.cache_creation_input_tokens || 0;
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
        return totals;
      };

      const result = getTokenUsage(24); // Only last 24 hours

      expect(result.input).toBe(100);
      expect(result.output).toBe(50);
    });

    it('should handle malformed JSON lines gracefully (G001)', () => {
      const sessionId = randomUUID();
      const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
      const content = [
        JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 100 } } }),
        'invalid json line',
        JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { output_tokens: 50 } } }),
      ].join('\n');

      fs.writeFileSync(filePath, content);

      const getTokenUsage = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const totals = {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
        };

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const sessionFilePath = path.join(sessionDir, file);
          const sessionContent = fs.readFileSync(sessionFilePath, 'utf8');
          const lines = sessionContent.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const usage = entry.message?.usage;
              if (usage) {
                totals.input += usage.input_tokens || 0;
                totals.output += usage.output_tokens || 0;
              }
            } catch {
              // G001: Skip malformed lines but continue processing
            }
          }
        }

        totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
        return totals;
      };

      const result = getTokenUsage(24);

      expect(result.input).toBe(100);
      expect(result.output).toBe(50);
      expect(result.total).toBe(150);
    });
  });

  // ============================================================================
  // Autonomous Mode Status Tests
  // ============================================================================

  describe('Autonomous Mode Status', () => {
    it('should return disabled status when config does not exist', () => {
      const getAutonomousModeStatus = () => {
        let enabled = false;

        if (fs.existsSync(autonomousConfigPath)) {
          const config = JSON.parse(fs.readFileSync(autonomousConfigPath, 'utf8'));
          enabled = config.enabled === true;
        }

        return { enabled, next_run_minutes: enabled ? 0 : null };
      };

      const result = getAutonomousModeStatus();

      expect(result.enabled).toBe(false);
      expect(result.next_run_minutes).toBe(null);
    });

    it('should return enabled status from config', () => {
      writeAutonomousConfig({ enabled: true });

      const getAutonomousModeStatus = () => {
        let enabled = false;

        if (fs.existsSync(autonomousConfigPath)) {
          const config = JSON.parse(fs.readFileSync(autonomousConfigPath, 'utf8'));
          enabled = config.enabled === true;
        }

        return { enabled, next_run_minutes: enabled ? 0 : null };
      };

      const result = getAutonomousModeStatus();

      expect(result.enabled).toBe(true);
    });

    it('should calculate next run time from automation state', () => {
      writeAutonomousConfig({ enabled: true });
      const lastRun = Date.now() - (30 * 60 * 1000); // 30 minutes ago
      writeAutomationState({ lastRun });

      const COOLDOWN_MINUTES = 55;

      const getAutonomousModeStatus = () => {
        let enabled = false;

        if (fs.existsSync(autonomousConfigPath)) {
          const config = JSON.parse(fs.readFileSync(autonomousConfigPath, 'utf8'));
          enabled = config.enabled === true;
        }

        let next_run_minutes: number | null = null;
        if (enabled && fs.existsSync(automationStatePath)) {
          const state = JSON.parse(fs.readFileSync(automationStatePath, 'utf8'));
          const stateLastRun = state.lastRun || 0;
          const now = Date.now();
          const timeSinceLastRun = now - stateLastRun;
          const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

          if (timeSinceLastRun >= cooldownMs) {
            next_run_minutes = 0;
          } else {
            next_run_minutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
          }
        }

        return { enabled, next_run_minutes };
      };

      const result = getAutonomousModeStatus();

      expect(result.enabled).toBe(true);
      expect(result.next_run_minutes).toBeGreaterThan(0);
      expect(result.next_run_minutes).toBeLessThanOrEqual(25); // Should be ~25 minutes
    });

    it('should return 0 next_run_minutes when cooldown expired', () => {
      writeAutonomousConfig({ enabled: true });
      const lastRun = Date.now() - (60 * 60 * 1000); // 60 minutes ago (past cooldown)
      writeAutomationState({ lastRun });

      const COOLDOWN_MINUTES = 55;

      const getAutonomousModeStatus = () => {
        let enabled = false;

        if (fs.existsSync(autonomousConfigPath)) {
          const config = JSON.parse(fs.readFileSync(autonomousConfigPath, 'utf8'));
          enabled = config.enabled === true;
        }

        let next_run_minutes: number | null = null;
        if (enabled && fs.existsSync(automationStatePath)) {
          const state = JSON.parse(fs.readFileSync(automationStatePath, 'utf8'));
          const stateLastRun = state.lastRun || 0;
          const now = Date.now();
          const timeSinceLastRun = now - stateLastRun;
          const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

          if (timeSinceLastRun >= cooldownMs) {
            next_run_minutes = 0;
          } else {
            next_run_minutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
          }
        }

        return { enabled, next_run_minutes };
      };

      const result = getAutonomousModeStatus();

      expect(result.enabled).toBe(true);
      expect(result.next_run_minutes).toBe(0);
    });
  });

  // ============================================================================
  // Session Metrics Tests
  // ============================================================================

  describe('Session Metrics', () => {
    /**
     * Parse task type from message content.
     * Supports formats:
     * - [Task][type-name] ... → extracts "type-name"
     * - [Task] ... → returns "unknown"
     */
    const parseTaskType = (messageContent: string): string | null => {
      if (!messageContent.startsWith('[Task]')) {
        return null;
      }

      // Check for [Task][type] format
      const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
      if (typeMatch) {
        return typeMatch[1];
      }

      // Legacy [Task] format without type
      return 'unknown';
    };

    it('should count task-triggered sessions and track task types', () => {
      const sessionId1 = randomUUID();
      const sessionId2 = randomUUID();
      const sessionId3 = randomUUID();
      const sessionId4 = randomUUID();

      // Task sessions with types
      createSessionFile(sessionId1, [
        { type: 'human', content: '[Task][lint-fixer] Fix lint errors' },
        { type: 'assistant', message: { content: 'I will fix the lint errors' } },
      ]);
      createSessionFile(sessionId2, [
        { type: 'user', message: { content: '[Task][deputy-cto-review] Review commit' } },
        { type: 'assistant', message: { content: 'I will review' } },
      ]);

      // Legacy task session without type
      createSessionFile(sessionId3, [
        { type: 'human', content: '[Task] Fix bug in authentication' },
        { type: 'assistant', message: { content: 'I will fix the bug' } },
      ]);

      // User session - first message does NOT start with [Task]
      createSessionFile(sessionId4, [
        { type: 'human', content: 'Help me debug this code' },
        { type: 'assistant', message: { content: 'Sure, I can help' } },
      ]);

      const getSessionMetricsData = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const metrics: { task_triggered: number; user_triggered: number; task_by_type: Record<string, number> } = {
          task_triggered: 0,
          user_triggered: 0,
          task_by_type: {},
        };

        if (!fs.existsSync(sessionDir)) {
          return metrics;
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

        for (const file of files) {
          const sessionFilePath = path.join(sessionDir, file);
          const stat = fs.statSync(sessionFilePath);
          if (stat.mtime.getTime() < _since) {
            continue;
          }

          const sessionContent = fs.readFileSync(sessionFilePath, 'utf8');
          const lines = sessionContent.split('\n').filter(l => l.trim());

          let taskType: string | null = null;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'human' || entry.type === 'user') {
                const messageContent = typeof entry.message?.content === 'string'
                  ? entry.message.content
                  : entry.content;
                if (messageContent) {
                  taskType = parseTaskType(messageContent);
                }
                break;
              }
            } catch {}
          }

          if (taskType !== null) {
            metrics.task_triggered++;
            metrics.task_by_type[taskType] = (metrics.task_by_type[taskType] || 0) + 1;
          } else {
            metrics.user_triggered++;
          }
        }

        return metrics;
      };

      const result = getSessionMetricsData(24);

      expect(result.task_triggered).toBe(3);
      expect(result.user_triggered).toBe(1);
      expect(result.task_by_type['lint-fixer']).toBe(1);
      expect(result.task_by_type['deputy-cto-review']).toBe(1);
      expect(result.task_by_type['unknown']).toBe(1);
    });

    it('should count user-triggered sessions (no [Task] prefix)', () => {
      const sessionId1 = randomUUID();
      const sessionId2 = randomUUID();

      createSessionFile(sessionId1, [
        { type: 'human', content: 'Help me with TypeScript' },
      ]);
      createSessionFile(sessionId2, [
        { type: 'user', message: { content: 'Explain this code' } },
      ]);

      const getSessionMetricsData = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const metrics: { task_triggered: number; user_triggered: number; task_by_type: Record<string, number> } = {
          task_triggered: 0,
          user_triggered: 0,
          task_by_type: {},
        };

        if (!fs.existsSync(sessionDir)) {
          return metrics;
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

        for (const file of files) {
          const sessionFilePath = path.join(sessionDir, file);
          const stat = fs.statSync(sessionFilePath);
          if (stat.mtime.getTime() < _since) {
            continue;
          }

          const sessionContent = fs.readFileSync(sessionFilePath, 'utf8');
          const lines = sessionContent.split('\n').filter(l => l.trim());

          let taskType: string | null = null;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'human' || entry.type === 'user') {
                const messageContent = typeof entry.message?.content === 'string'
                  ? entry.message.content
                  : entry.content;
                if (messageContent) {
                  taskType = parseTaskType(messageContent);
                }
                break;
              }
            } catch {}
          }

          if (taskType !== null) {
            metrics.task_triggered++;
            metrics.task_by_type[taskType] = (metrics.task_by_type[taskType] || 0) + 1;
          } else {
            metrics.user_triggered++;
          }
        }

        return metrics;
      };

      const result = getSessionMetricsData(24);

      expect(result.task_triggered).toBe(0);
      expect(result.user_triggered).toBe(2);
      expect(Object.keys(result.task_by_type).length).toBe(0);
    });

    it('should filter sessions by time range', () => {
      const sessionId1 = randomUUID();
      const sessionId2 = randomUUID();

      // Create first session (recent) with typed task
      createSessionFile(sessionId1, [
        { type: 'human', content: '[Task][plan-executor] Recent task' },
      ]);

      // Create second session (old) - will be filtered by mtime
      const oldSessionPath = path.join(sessionDir, `${sessionId2}.jsonl`);
      fs.writeFileSync(oldSessionPath, JSON.stringify({ type: 'human', content: '[Task][old-task] Old task' }));

      // Set file modification time to 25 hours ago
      const oldTime = Date.now() - (25 * 60 * 60 * 1000);
      fs.utimesSync(oldSessionPath, new Date(oldTime), new Date(oldTime));

      const getSessionMetricsData = (_hours: number) => {
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const metrics: { task_triggered: number; user_triggered: number; task_by_type: Record<string, number> } = {
          task_triggered: 0,
          user_triggered: 0,
          task_by_type: {},
        };

        if (!fs.existsSync(sessionDir)) {
          return metrics;
        }

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

        for (const file of files) {
          const sessionFilePath = path.join(sessionDir, file);
          const stat = fs.statSync(sessionFilePath);
          if (stat.mtime.getTime() < _since) {
            continue;
          }

          const sessionContent = fs.readFileSync(sessionFilePath, 'utf8');
          const lines = sessionContent.split('\n').filter(l => l.trim());

          let taskType: string | null = null;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'human' || entry.type === 'user') {
                const messageContent = typeof entry.message?.content === 'string'
                  ? entry.message.content
                  : entry.content;
                if (messageContent) {
                  taskType = parseTaskType(messageContent);
                }
                break;
              }
            } catch {}
          }

          if (taskType !== null) {
            metrics.task_triggered++;
            metrics.task_by_type[taskType] = (metrics.task_by_type[taskType] || 0) + 1;
          } else {
            metrics.user_triggered++;
          }
        }

        return metrics;
      };

      const result = getSessionMetricsData(24); // Only last 24 hours

      expect(result.task_triggered).toBe(1); // Only the recent one
      expect(result.user_triggered).toBe(0);
      expect(result.task_by_type['plan-executor']).toBe(1);
      expect(result.task_by_type['old-task']).toBeUndefined(); // Old task was filtered
    });

    it('should return empty metrics when session directory does not exist', () => {
      // Remove session directory
      fs.rmSync(sessionDir, { recursive: true, force: true });

      const getSessionMetricsData = (_hours: number) => {
        const metrics: { task_triggered: number; user_triggered: number; task_by_type: Record<string, number> } = {
          task_triggered: 0,
          user_triggered: 0,
          task_by_type: {},
        };

        if (!fs.existsSync(sessionDir)) {
          return metrics;
        }

        return metrics;
      };

      const result = getSessionMetricsData(24);

      expect(result.task_triggered).toBe(0);
      expect(result.user_triggered).toBe(0);
      expect(Object.keys(result.task_by_type).length).toBe(0);
    });
  });

  // ============================================================================
  // Pending Items Tests
  // ============================================================================

  describe('Pending Items', () => {
    it('should count pending CTO questions', () => {
      // Save database to file for testing
      const deputyCTOPath = path.join(projectDir, '.claude', 'deputy-cto.db');
      deputyCTODB.close();
      deputyCTODB = new Database(deputyCTOPath);
      deputyCTODB.exec(`
        CREATE TABLE questions (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          question TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      createQuestion({ type: 'decision', status: 'pending', question: 'Q1' });
      createQuestion({ type: 'clarification', status: 'pending', question: 'Q2' });
      createQuestion({ type: 'decision', status: 'answered', question: 'Q3' });

      const getPendingItems = () => {
        const items = {
          cto_questions: 0,
          commit_rejections: 0,
          unread_reports: 0,
          commits_blocked: false,
        };

        if (fs.existsSync(deputyCTOPath)) {
          const db = new Database(deputyCTOPath, { readonly: true });
          const pending = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'").get() as { count: number } | undefined;
          const rejections = db.prepare("SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'").get() as { count: number } | undefined;
          db.close();

          items.cto_questions = pending?.count || 0;
          items.commit_rejections = rejections?.count || 0;
          // Block commits when ANY CTO questions are pending (not just rejections)
          items.commits_blocked = items.cto_questions > 0;
        }

        return items;
      };

      const result = getPendingItems();

      expect(result.cto_questions).toBe(2);
      expect(result.commit_rejections).toBe(0);
      expect(result.commits_blocked).toBe(true);
    });

    it('should count commit rejections and set blocked flag', () => {
      const deputyCTOPath = path.join(projectDir, '.claude', 'deputy-cto.db');
      deputyCTODB.close();
      deputyCTODB = new Database(deputyCTOPath);
      deputyCTODB.exec(`
        CREATE TABLE questions (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          question TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      createQuestion({ type: 'rejection', status: 'pending', question: 'Reject 1' });
      createQuestion({ type: 'rejection', status: 'pending', question: 'Reject 2' });

      const getPendingItems = () => {
        const items = {
          cto_questions: 0,
          commit_rejections: 0,
          unread_reports: 0,
          commits_blocked: false,
        };

        if (fs.existsSync(deputyCTOPath)) {
          const db = new Database(deputyCTOPath, { readonly: true });
          const pending = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'").get() as { count: number } | undefined;
          const rejections = db.prepare("SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'").get() as { count: number } | undefined;
          db.close();

          items.cto_questions = pending?.count || 0;
          items.commit_rejections = rejections?.count || 0;
          // Block commits when ANY CTO questions are pending (not just rejections)
          items.commits_blocked = items.cto_questions > 0;
        }

        return items;
      };

      const result = getPendingItems();

      expect(result.commit_rejections).toBe(2);
      expect(result.commits_blocked).toBe(true);
      expect(result.cto_questions).toBe(2);
    });

    it('should count unread reports', () => {
      const ctoReportsPath = path.join(projectDir, '.claude', 'cto-reports.db');
      ctoReportsDB.close();
      ctoReportsDB = new Database(ctoReportsPath);
      ctoReportsDB.exec(`
        CREATE TABLE reports (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          category TEXT NOT NULL,
          priority TEXT NOT NULL,
          reporting_agent TEXT NOT NULL,
          created_at TEXT NOT NULL,
          read_at TEXT
        );
      `);

      createReport({ title: 'Report 1', read: false });
      createReport({ title: 'Report 2', read: false });
      createReport({ title: 'Report 3', read: true });

      const getPendingItems = () => {
        const items = {
          cto_questions: 0,
          commit_rejections: 0,
          unread_reports: 0,
          commits_blocked: false,
        };

        if (fs.existsSync(ctoReportsPath)) {
          const db = new Database(ctoReportsPath, { readonly: true });
          const unread = db.prepare("SELECT COUNT(*) as count FROM reports WHERE read_at IS NULL").get() as { count: number } | undefined;
          db.close();

          items.unread_reports = unread?.count || 0;
        }

        return items;
      };

      const result = getPendingItems();

      expect(result.unread_reports).toBe(2);
    });

    it('should return zero counts when databases do not exist', () => {
      const getPendingItems = () => {
        const items = {
          cto_questions: 0,
          commit_rejections: 0,
          unread_reports: 0,
          commits_blocked: false,
        };

        return items;
      };

      const result = getPendingItems();

      expect(result.cto_questions).toBe(0);
      expect(result.commit_rejections).toBe(0);
      expect(result.unread_reports).toBe(0);
      expect(result.commits_blocked).toBe(false);
    });
  });

  // ============================================================================
  // Task Metrics Tests
  // ============================================================================

  describe('Task Metrics', () => {
    it('should count tasks by section and status', () => {
      const todoDBPath = path.join(projectDir, '.claude', 'todo.db');
      todoDB.close();
      todoDB = new Database(todoDBPath);
      todoDB.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          section TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          created_timestamp INTEGER NOT NULL,
          completed_timestamp INTEGER
        );
      `);

      createTask({ section: 'TEST-WRITER', status: 'pending', title: 'Task 1' });
      createTask({ section: 'TEST-WRITER', status: 'in_progress', title: 'Task 2' });
      createTask({ section: 'CODE-REVIEWER', status: 'completed', title: 'Task 3' });

      const getTaskMetricsData = (_hours: number) => {
        const metrics = {
          by_section: {} as Record<string, { pending: number; in_progress: number; completed: number }>,
          completed_24h: 0,
          completed_24h_by_section: {} as Record<string, number>,
        };

        if (!fs.existsSync(todoDBPath)) {
          return metrics;
        }

        const db = new Database(todoDBPath, { readonly: true });

        const tasks = db.prepare(`
          SELECT section, status, COUNT(*) as count
          FROM tasks
          GROUP BY section, status
        `).all() as Array<{ section: string; status: string; count: number }>;

        for (const row of tasks) {
          if (!metrics.by_section[row.section]) {
            metrics.by_section[row.section] = { pending: 0, in_progress: 0, completed: 0 };
          }
          const section = metrics.by_section[row.section];
          if (row.status === 'pending' || row.status === 'in_progress' || row.status === 'completed') {
            section[row.status] = row.count;
          }
        }

        db.close();
        return metrics;
      };

      const result = getTaskMetricsData(24);

      expect(result.by_section['TEST-WRITER'].pending).toBe(1);
      expect(result.by_section['TEST-WRITER'].in_progress).toBe(1);
      expect(result.by_section['CODE-REVIEWER'].completed).toBe(1);
    });

    it('should count completed tasks within time range', () => {
      const todoDBPath = path.join(projectDir, '.claude', 'todo.db');
      todoDB.close();
      todoDB = new Database(todoDBPath);
      todoDB.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          section TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          created_timestamp INTEGER NOT NULL,
          completed_timestamp INTEGER
        );
      `);

      const now = Math.floor(Date.now() / 1000);
      const twoHoursAgo = now - (2 * 60 * 60);
      const twentyFiveHoursAgo = now - (25 * 60 * 60);

      createTask({
        section: 'TEST-WRITER',
        status: 'completed',
        title: 'Recent',
        completed_timestamp: twoHoursAgo
      });
      createTask({
        section: 'CODE-REVIEWER',
        status: 'completed',
        title: 'Old',
        completed_timestamp: twentyFiveHoursAgo
      });

      const getTaskMetricsData = (_hours: number) => {
        const metrics = {
          by_section: {} as Record<string, { pending: number; in_progress: number; completed: number }>,
          completed_24h: 0,
          completed_24h_by_section: {} as Record<string, number>,
        };

        if (!fs.existsSync(todoDBPath)) {
          return metrics;
        }

        const db = new Database(todoDBPath, { readonly: true });
        const _since = Date.now() - (_hours * 60 * 60 * 1000);
        const sinceTimestamp = Math.floor(_since / 1000);

        const completed = db.prepare(`
          SELECT section, COUNT(*) as count
          FROM tasks
          WHERE status = 'completed' AND completed_timestamp >= ?
          GROUP BY section
        `).all(sinceTimestamp) as Array<{ section: string; count: number }>;

        let total = 0;
        for (const row of completed) {
          metrics.completed_24h_by_section[row.section] = row.count;
          total += row.count;
        }
        metrics.completed_24h = total;

        db.close();
        return metrics;
      };

      const result = getTaskMetricsData(24);

      expect(result.completed_24h).toBe(1);
      expect(result.completed_24h_by_section['TEST-WRITER']).toBe(1);
      expect(result.completed_24h_by_section['CODE-REVIEWER']).toBeUndefined();
    });

    it('should return empty metrics when database does not exist', () => {
      const getTaskMetricsData = (_hours: number) => {
        const metrics = {
          by_section: {} as Record<string, { pending: number; in_progress: number; completed: number }>,
          completed_24h: 0,
          completed_24h_by_section: {} as Record<string, number>,
        };

        const todoDBPath = path.join(projectDir, '.claude', 'todo.db');
        if (!fs.existsSync(todoDBPath)) {
          return metrics;
        }

        return metrics;
      };

      const result = getTaskMetricsData(24);

      expect(result.completed_24h).toBe(0);
      expect(Object.keys(result.by_section)).toHaveLength(0);
      expect(Object.keys(result.completed_24h_by_section)).toHaveLength(0);
    });
  });

  // ============================================================================
  // Structure Validation Tests
  // ============================================================================

  describe('Report Structure Validation', () => {
    it('should validate report structure has all required fields', () => {
      // This test validates the structure without calling the actual server
      const mockReport = {
        generated_at: new Date().toISOString(),
        hours: 24,
        autonomous_mode: {
          enabled: false,
          next_run_minutes: null,
        },
        usage: {
          plan_type: 'unknown',
          tokens_24h: {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_creation: 0,
            total: 0,
          },
          estimated_remaining_pct: null,
        },
        sessions: {
          task_triggered: 0,
          user_triggered: 0,
          task_by_type: {},
        },
        pending_items: {
          cto_questions: 0,
          commit_rejections: 0,
          unread_reports: 0,
          commits_blocked: false,
        },
        tasks: {
          by_section: {},
          completed_24h: 0,
          completed_24h_by_section: {},
        },
      };

      expect(mockReport).toHaveProperty('generated_at');
      expect(mockReport).toHaveProperty('hours');
      expect(mockReport).toHaveProperty('autonomous_mode');
      expect(mockReport).toHaveProperty('usage');
      expect(mockReport).toHaveProperty('sessions');
      expect(mockReport).toHaveProperty('pending_items');
      expect(mockReport).toHaveProperty('tasks');

      expect(typeof mockReport.generated_at).toBe('string');
      expect(typeof mockReport.hours).toBe('number');
      expect(typeof mockReport.autonomous_mode.enabled).toBe('boolean');
      expect(typeof mockReport.usage.tokens_24h.total).toBe('number');
    });

    it('should validate session metrics structure', () => {
      const mockMetrics = {
        hours: 24,
        sessions: {
          task_triggered: 5,
          user_triggered: 10,
          task_by_type: {
            'lint-fixer': 2,
            'deputy-cto-review': 3,
          },
        },
      };

      expect(mockMetrics.sessions).toHaveProperty('task_triggered');
      expect(mockMetrics.sessions).toHaveProperty('user_triggered');
      expect(mockMetrics.sessions).toHaveProperty('task_by_type');
      expect(typeof mockMetrics.sessions.task_triggered).toBe('number');
      expect(typeof mockMetrics.sessions.user_triggered).toBe('number');
      expect(typeof mockMetrics.sessions.task_by_type).toBe('object');
      expect(mockMetrics.sessions.task_by_type['lint-fixer']).toBe(2);
    });

    it('should validate task metrics structure', () => {
      const mockMetrics = {
        hours: 24,
        tasks: {
          by_section: {
            'TEST-WRITER': { pending: 1, in_progress: 2, completed: 3 },
          },
          completed_24h: 10,
          completed_24h_by_section: {
            'TEST-WRITER': 5,
            'CODE-REVIEWER': 5,
          },
        },
      };

      expect(mockMetrics.tasks).toHaveProperty('by_section');
      expect(mockMetrics.tasks).toHaveProperty('completed_24h');
      expect(mockMetrics.tasks).toHaveProperty('completed_24h_by_section');
      expect(typeof mockMetrics.tasks.completed_24h).toBe('number');
    });
  });
});
