/**
 * Unit tests for data reader utilities
 *
 * Tests data aggregation from multiple sources including:
 * - Token usage from session files
 * - Autonomous mode status
 * - Session metrics (task vs user triggered)
 * - Pending items from databases
 * - Task metrics
 * - Hook executions (including skipped tracking)
 *
 * Uses in-memory databases and mock file systems for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

describe('Data Reader - Token Usage', () => {
  let tempDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `data-reader-test-${randomUUID()}`);
    sessionDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createSessionFile = (sessionId: string, entries: unknown[]) => {
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    const content = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const getTokenUsage = (hours: number) => {
    const since = Date.now() - (hours * 60 * 60 * 1000);
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

    try {
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(sessionDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtime.getTime() < since) continue;

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as {
                timestamp?: string;
                message?: {
                  usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              };

              if (entry.timestamp) {
                const entryTime = new Date(entry.timestamp).getTime();
                if (entryTime < since) continue;
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
        } catch {
          // Skip unreadable files
        }
      }

      totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
    } catch {
      // Ignore errors
    }

    return totals;
  };

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

    const result = getTokenUsage(24);

    expect(result.input).toBe(300);
    expect(result.output).toBe(150);
    expect(result.cache_read).toBe(50);
    expect(result.cache_creation).toBe(25);
    expect(result.total).toBe(525);
  });

  it('should return zero usage for non-existent session directory', () => {
    fs.rmSync(sessionDir, { recursive: true, force: true });

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
        timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
        message: { usage: { input_tokens: 1000, output_tokens: 500 } },
      },
    ];

    createSessionFile(sessionId, entries);

    const result = getTokenUsage(24);

    expect(result.input).toBe(100);
    expect(result.output).toBe(50);
  });

  it('should handle malformed JSON lines gracefully', () => {
    const sessionId = randomUUID();
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    const content = [
      JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 100 } } }),
      'invalid json line',
      JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { output_tokens: 50 } } }),
    ].join('\n');

    fs.writeFileSync(filePath, content);

    const result = getTokenUsage(24);

    expect(result.input).toBe(100);
    expect(result.output).toBe(50);
    expect(result.total).toBe(150);
  });

  it('should validate structure of returned token usage', () => {
    const result = getTokenUsage(24);

    expect(result).toHaveProperty('input');
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('cache_read');
    expect(result).toHaveProperty('cache_creation');
    expect(result).toHaveProperty('total');

    expect(typeof result.input).toBe('number');
    expect(typeof result.output).toBe('number');
    expect(typeof result.cache_read).toBe('number');
    expect(typeof result.cache_creation).toBe('number');
    expect(typeof result.total).toBe('number');
  });
});

describe('Data Reader - Autonomous Mode', () => {
  let tempDir: string;
  let autonomousConfigPath: string;
  let automationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `autonomous-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    autonomousConfigPath = path.join(tempDir, 'autonomous-mode.json');
    automationStatePath = path.join(tempDir, 'hourly-automation-state.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const getAutonomousModeStatus = () => {
    let enabled = false;

    if (fs.existsSync(autonomousConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(autonomousConfigPath, 'utf8')) as { enabled?: boolean };
        enabled = config.enabled === true;
      } catch {
        // Config parse error
      }
    }

    let next_run_minutes: number | null = null;
    const COOLDOWN_MINUTES = 55;

    if (enabled && fs.existsSync(automationStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(automationStatePath, 'utf8')) as { lastRun?: number };
        const lastRun = state.lastRun || 0;
        const now = Date.now();
        const timeSinceLastRun = now - lastRun;
        const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

        if (timeSinceLastRun >= cooldownMs) {
          next_run_minutes = 0;
        } else {
          next_run_minutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
        }
      } catch {
        // State file error
      }
    } else if (enabled) {
      next_run_minutes = 0;
    }

    return { enabled, next_run_minutes };
  };

  it('should return disabled status when config does not exist', () => {
    const result = getAutonomousModeStatus();

    expect(result.enabled).toBe(false);
    expect(result.next_run_minutes).toBe(null);
  });

  it('should return enabled status from config', () => {
    fs.writeFileSync(autonomousConfigPath, JSON.stringify({ enabled: true }));

    const result = getAutonomousModeStatus();

    expect(result.enabled).toBe(true);
    expect(result.next_run_minutes).toBe(0);
  });

  it('should calculate next run time from automation state', () => {
    fs.writeFileSync(autonomousConfigPath, JSON.stringify({ enabled: true }));
    const lastRun = Date.now() - (30 * 60 * 1000); // 30 minutes ago
    fs.writeFileSync(automationStatePath, JSON.stringify({ lastRun }));

    const result = getAutonomousModeStatus();

    expect(result.enabled).toBe(true);
    expect(result.next_run_minutes).toBeGreaterThan(0);
    expect(result.next_run_minutes).toBeLessThanOrEqual(25);
  });

  it('should return 0 next_run_minutes when cooldown expired', () => {
    fs.writeFileSync(autonomousConfigPath, JSON.stringify({ enabled: true }));
    const lastRun = Date.now() - (60 * 60 * 1000); // 60 minutes ago
    fs.writeFileSync(automationStatePath, JSON.stringify({ lastRun }));

    const result = getAutonomousModeStatus();

    expect(result.enabled).toBe(true);
    expect(result.next_run_minutes).toBe(0);
  });

  it('should validate structure of returned status', () => {
    const result = getAutonomousModeStatus();

    expect(result).toHaveProperty('enabled');
    expect(result).toHaveProperty('next_run_minutes');
    expect(typeof result.enabled).toBe('boolean');
    expect(result.next_run_minutes === null || typeof result.next_run_minutes === 'number').toBe(true);
  });
});

describe('Data Reader - Session Metrics', () => {
  let tempDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `session-metrics-test-${randomUUID()}`);
    sessionDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createSessionFile = (sessionId: string, entries: unknown[]) => {
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    const content = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const parseTaskType = (messageContent: string): string | null => {
    if (!messageContent.startsWith('[Task]')) return null;
    const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
    if (typeMatch && typeMatch[1]) return typeMatch[1];
    return 'unknown';
  };

  const getSessionMetrics = (hours: number) => {
    const since = Date.now() - (hours * 60 * 60 * 1000);
    const metrics = {
      task_triggered: 0,
      user_triggered: 0,
      task_by_type: {} as Record<string, number>,
    };

    if (!fs.existsSync(sessionDir)) return metrics;

    try {
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(sessionDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtime.getTime() < since) continue;

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());

          let taskType: string | null = null;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as {
                type?: string;
                message?: { content?: string };
                content?: string;
              };

              if (entry.type === 'human' || entry.type === 'user') {
                const messageContent = typeof entry.message?.content === 'string'
                  ? entry.message.content
                  : entry.content;

                if (messageContent) {
                  taskType = parseTaskType(messageContent);
                }
                break;
              }
            } catch {
              // Skip malformed lines
            }
          }

          if (taskType !== null) {
            metrics.task_triggered++;
            metrics.task_by_type[taskType] = (metrics.task_by_type[taskType] || 0) + 1;
          } else {
            metrics.user_triggered++;
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Ignore errors
    }

    return metrics;
  };

  it('should count task-triggered sessions with types', () => {
    createSessionFile(randomUUID(), [
      { type: 'human', content: '[Task][lint-fixer] Fix lint errors' },
    ]);
    createSessionFile(randomUUID(), [
      { type: 'user', message: { content: '[Task][deputy-cto-review] Review' } },
    ]);
    createSessionFile(randomUUID(), [
      { type: 'human', content: '[Task] Legacy task' },
    ]);

    const result = getSessionMetrics(24);

    expect(result.task_triggered).toBe(3);
    expect(result.user_triggered).toBe(0);
    expect(result.task_by_type['lint-fixer']).toBe(1);
    expect(result.task_by_type['deputy-cto-review']).toBe(1);
    expect(result.task_by_type['unknown']).toBe(1);
  });

  it('should count user-triggered sessions', () => {
    createSessionFile(randomUUID(), [
      { type: 'human', content: 'Help me debug' },
    ]);
    createSessionFile(randomUUID(), [
      { type: 'user', message: { content: 'Explain this code' } },
    ]);

    const result = getSessionMetrics(24);

    expect(result.task_triggered).toBe(0);
    expect(result.user_triggered).toBe(2);
    expect(Object.keys(result.task_by_type).length).toBe(0);
  });

  it('should validate structure of returned metrics', () => {
    const result = getSessionMetrics(24);

    expect(result).toHaveProperty('task_triggered');
    expect(result).toHaveProperty('user_triggered');
    expect(result).toHaveProperty('task_by_type');

    expect(typeof result.task_triggered).toBe('number');
    expect(typeof result.user_triggered).toBe('number');
    expect(typeof result.task_by_type).toBe('object');
  });
});

describe('Data Reader - Pending Items', () => {
  let tempDir: string;
  let deputyCTOPath: string;
  let ctoReportsPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `pending-items-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    deputyCTOPath = path.join(tempDir, 'deputy-cto.db');
    ctoReportsPath = path.join(tempDir, 'cto-reports.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const getPendingItems = () => {
    const items = {
      cto_questions: 0,
      commit_rejections: 0,
      pending_triage: 0,
      commits_blocked: false,
    };

    if (fs.existsSync(deputyCTOPath)) {
      try {
        const db = new Database(deputyCTOPath, { readonly: true });
        const pending = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
        ).get() as { count: number } | undefined;
        const rejections = db.prepare(
          "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
        ).get() as { count: number } | undefined;
        db.close();

        items.cto_questions = pending?.count || 0;
        items.commit_rejections = rejections?.count || 0;
      } catch {
        // Database error
      }
    }

    if (fs.existsSync(ctoReportsPath)) {
      try {
        const db = new Database(ctoReportsPath, { readonly: true });
        const pending = db.prepare(
          "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
        ).get() as { count: number } | undefined;
        items.pending_triage = pending?.count || 0;
        db.close();
      } catch {
        // Database error
      }
    }

    items.commits_blocked = items.cto_questions > 0 || items.pending_triage > 0;
    return items;
  };

  it('should count pending CTO questions', () => {
    const db = new Database(deputyCTOPath);
    db.exec(`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        question TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO questions VALUES (?, ?, ?, ?, ?)").run('1', 'decision', 'pending', 'Q1', new Date().toISOString());
    db.prepare("INSERT INTO questions VALUES (?, ?, ?, ?, ?)").run('2', 'clarification', 'pending', 'Q2', new Date().toISOString());
    db.prepare("INSERT INTO questions VALUES (?, ?, ?, ?, ?)").run('3', 'decision', 'answered', 'Q3', new Date().toISOString());
    db.close();

    const result = getPendingItems();

    expect(result.cto_questions).toBe(2);
    expect(result.commits_blocked).toBe(true);
  });

  it('should return zero counts when databases do not exist', () => {
    const result = getPendingItems();

    expect(result.cto_questions).toBe(0);
    expect(result.commit_rejections).toBe(0);
    expect(result.pending_triage).toBe(0);
    expect(result.commits_blocked).toBe(false);
  });

  it('should validate structure of returned items', () => {
    const result = getPendingItems();

    expect(result).toHaveProperty('cto_questions');
    expect(result).toHaveProperty('commit_rejections');
    expect(result).toHaveProperty('pending_triage');
    expect(result).toHaveProperty('commits_blocked');

    expect(typeof result.cto_questions).toBe('number');
    expect(typeof result.commit_rejections).toBe('number');
    expect(typeof result.pending_triage).toBe('number');
    expect(typeof result.commits_blocked).toBe('boolean');
  });
});

describe('Data Reader - Hook Executions', () => {
  let tempDir: string;
  let agentTrackerPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `hook-exec-test-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, 'state'), { recursive: true });
    agentTrackerPath = path.join(tempDir, 'state', 'agent-tracker-history.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  interface HookExecutionEntry {
    hookType: string;
    status: 'success' | 'failure' | 'skipped';
    timestamp: string;
    metadata?: { error?: string };
  }

  interface HookHistory {
    hookExecutions: HookExecutionEntry[];
  }

  interface HookStats {
    total: number;
    success: number;
    failure: number;
    skipped: number;
  }

  interface HookExecutions {
    total_24h: number;
    skipped_24h: number;
    success_rate: number;
    by_hook: Record<string, HookStats>;
    recent_failures: Array<{ hook: string; error: string; timestamp: string }>;
  }

  const getHookExecutions = (): HookExecutions => {
    const result: HookExecutions = {
      total_24h: 0,
      skipped_24h: 0,
      success_rate: 100,
      by_hook: {},
      recent_failures: [],
    };

    if (!fs.existsSync(agentTrackerPath)) return result;

    try {
      const content = fs.readFileSync(agentTrackerPath, 'utf8');
      const history = JSON.parse(content) as HookHistory;

      const now = Date.now();
      const cutoff24h = now - 24 * 60 * 60 * 1000;
      let successCount = 0;
      let skippedCount = 0;

      for (const exec of history.hookExecutions || []) {
        const execTime = new Date(exec.timestamp).getTime();
        if (execTime < cutoff24h) continue;

        result.total_24h++;
        if (exec.status === 'success') successCount++;
        else if (exec.status === 'skipped') skippedCount++;

        if (!result.by_hook[exec.hookType]) {
          result.by_hook[exec.hookType] = { total: 0, success: 0, failure: 0, skipped: 0 };
        }
        const stats = result.by_hook[exec.hookType];
        stats.total++;
        if (exec.status === 'success') stats.success++;
        else if (exec.status === 'failure') stats.failure++;
        else if (exec.status === 'skipped') stats.skipped++;

        if (exec.status === 'failure' && result.recent_failures.length < 5) {
          result.recent_failures.push({
            hook: exec.hookType,
            error: exec.metadata?.error || 'Unknown error',
            timestamp: exec.timestamp,
          });
        }
      }

      result.skipped_24h = skippedCount;
      // Calculate success rate excluding skipped executions
      const relevantTotal = result.total_24h - skippedCount;
      if (relevantTotal > 0) {
        result.success_rate = Math.round((successCount / relevantTotal) * 100);
      }
    } catch {
      // Ignore errors
    }

    return result;
  };

  it('should return empty results when agent tracker does not exist', () => {
    const result = getHookExecutions();

    expect(result.total_24h).toBe(0);
    expect(result.skipped_24h).toBe(0);
    expect(result.success_rate).toBe(100);
    expect(Object.keys(result.by_hook).length).toBe(0);
    expect(result.recent_failures.length).toBe(0);
  });

  it('should count hook executions by status', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 1000).toISOString() },
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 2000).toISOString() },
        { hookType: 'PreCommit', status: 'failure', timestamp: new Date(now - 3000).toISOString(), metadata: { error: 'Failed' } },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 4000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.total_24h).toBe(4);
    expect(result.skipped_24h).toBe(1);
    expect(result.by_hook['PreCommit']).toEqual({
      total: 4,
      success: 2,
      failure: 1,
      skipped: 1,
    });
  });

  it('should calculate success rate excluding skipped executions', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 1000).toISOString() },
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 2000).toISOString() },
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 3000).toISOString() },
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 4000).toISOString() },
        { hookType: 'PreCommit', status: 'failure', timestamp: new Date(now - 5000).toISOString(), metadata: { error: 'Test' } },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 6000).toISOString() },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 7000).toISOString() },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 8000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.total_24h).toBe(8);
    expect(result.skipped_24h).toBe(3);
    // Success rate should be 4/(8-3) = 4/5 = 80%
    expect(result.success_rate).toBe(80);
  });

  it('should maintain 100% success rate when all non-skipped executions succeed', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 1000).toISOString() },
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 2000).toISOString() },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 3000).toISOString() },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 4000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.total_24h).toBe(4);
    expect(result.skipped_24h).toBe(2);
    // Success rate should be 2/(4-2) = 2/2 = 100%
    expect(result.success_rate).toBe(100);
  });

  it('should maintain 100% success rate when only skipped executions exist', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 1000).toISOString() },
        { hookType: 'PreCommit', status: 'skipped', timestamp: new Date(now - 2000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.total_24h).toBe(2);
    expect(result.skipped_24h).toBe(2);
    // When all executions are skipped, success_rate should remain 100
    expect(result.success_rate).toBe(100);
  });

  it('should track recent failures with error messages', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'failure', timestamp: new Date(now - 1000).toISOString(), metadata: { error: 'Error 1' } },
        { hookType: 'PreCommit', status: 'failure', timestamp: new Date(now - 2000).toISOString(), metadata: { error: 'Error 2' } },
        { hookType: 'Compliance', status: 'failure', timestamp: new Date(now - 3000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.recent_failures.length).toBe(3);
    expect(result.recent_failures[0].hook).toBe('PreCommit');
    expect(result.recent_failures[0].error).toBe('Error 1');
    expect(result.recent_failures[2].error).toBe('Unknown error'); // Missing error metadata
  });

  it('should limit recent failures to 5 entries', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: Array.from({ length: 10 }, (_, i) => ({
        hookType: 'PreCommit',
        status: 'failure' as const,
        timestamp: new Date(now - i * 1000).toISOString(),
        metadata: { error: `Error ${i}` },
      })),
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.recent_failures.length).toBe(5);
  });

  it('should filter by 24-hour time window', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString() }, // 1h ago
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 12 * 60 * 60 * 1000).toISOString() }, // 12h ago
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, // 25h ago (excluded)
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.total_24h).toBe(2);
  });

  it('should aggregate stats by hook type', () => {
    const now = Date.now();
    const history: HookHistory = {
      hookExecutions: [
        { hookType: 'PreCommit', status: 'success', timestamp: new Date(now - 1000).toISOString() },
        { hookType: 'PreCommit', status: 'failure', timestamp: new Date(now - 2000).toISOString(), metadata: { error: 'Err' } },
        { hookType: 'Compliance', status: 'success', timestamp: new Date(now - 3000).toISOString() },
        { hookType: 'Compliance', status: 'skipped', timestamp: new Date(now - 4000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getHookExecutions();

    expect(result.by_hook['PreCommit']).toEqual({
      total: 2,
      success: 1,
      failure: 1,
      skipped: 0,
    });
    expect(result.by_hook['Compliance']).toEqual({
      total: 2,
      success: 1,
      failure: 0,
      skipped: 1,
    });
  });

  it('should validate structure of returned hook executions', () => {
    const result = getHookExecutions();

    expect(result).toHaveProperty('total_24h');
    expect(result).toHaveProperty('skipped_24h');
    expect(result).toHaveProperty('success_rate');
    expect(result).toHaveProperty('by_hook');
    expect(result).toHaveProperty('recent_failures');

    expect(typeof result.total_24h).toBe('number');
    expect(typeof result.skipped_24h).toBe('number');
    expect(typeof result.success_rate).toBe('number');
    expect(typeof result.by_hook).toBe('object');
    expect(Array.isArray(result.recent_failures)).toBe(true);

    // Validate success rate is a percentage
    expect(result.success_rate).toBeGreaterThanOrEqual(0);
    expect(result.success_rate).toBeLessThanOrEqual(100);
    expect(Number.isNaN(result.success_rate)).toBe(false);
  });

  it('should handle malformed agent tracker file gracefully', () => {
    fs.writeFileSync(agentTrackerPath, 'invalid json');

    const result = getHookExecutions();

    // Should return default empty state on parse error
    expect(result.total_24h).toBe(0);
    expect(result.success_rate).toBe(100);
  });
});

describe('Data Reader - Key Rotation Metrics', () => {
  let tempDir: string;
  let keyRotationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `key-rotation-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    keyRotationStatePath = path.join(tempDir, 'api-key-rotation.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  interface KeyData {
    accessToken?: string;
    subscriptionType: string;
    last_usage: {
      five_hour: number;
      seven_day: number;
    } | null;
    status: 'active' | 'exhausted' | 'invalid' | 'expired';
    account_uuid?: string | null;
  }

  interface KeyRotationState {
    version: number;
    active_key_id: string | null;
    keys: Record<string, KeyData>;
    rotation_log: Array<{ timestamp: number; event: string }>;
  }

  const getKeyRotationMetrics = (hours: number, stateFilePath: string) => {
    if (!fs.existsSync(stateFilePath)) return null;

    const content = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(content) as KeyRotationState;

    if (!state || state.version !== 1 || typeof state.keys !== 'object') {
      return null;
    }

    const now = Date.now();
    const since = now - (hours * 60 * 60 * 1000);

    const keys = [];

    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'active') continue;
      const isCurrent = keyId === state.active_key_id;

      keys.push({
        key_id: `${keyId.slice(0, 8)}...`,
        subscription_type: keyData.subscriptionType || 'unknown',
        five_hour_pct: keyData.last_usage?.five_hour ?? null,
        seven_day_pct: keyData.last_usage?.seven_day ?? null,
        is_current: isCurrent,
      });
    }

    // Deduplicate by account_uuid for aggregate calculation
    const accountMap = new Map<string, { fiveHour: number; sevenDay: number }>();
    for (const [, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'active') continue;
      if (!keyData.last_usage) continue;
      const dedupeKey = keyData.account_uuid || `fp:${keyData.last_usage.seven_day}`;
      if (!accountMap.has(dedupeKey)) {
        accountMap.set(dedupeKey, {
          fiveHour: keyData.last_usage.five_hour ?? 0,
          sevenDay: keyData.last_usage.seven_day ?? 0,
        });
      }
    }
    const accounts = Array.from(accountMap.values());

    const rotationEvents24h = state.rotation_log.filter(
      entry => entry.timestamp >= since && entry.event === 'key_switched'
    ).length;

    const aggregate = accounts.length > 0 ? {
      active_keys: accounts.length,
      five_hour_pct: Math.round(accounts.reduce((s, a) => s + a.fiveHour, 0) / accounts.length),
      seven_day_pct: Math.round(accounts.reduce((s, a) => s + a.sevenDay, 0) / accounts.length),
    } : null;

    return {
      current_key_id: state.active_key_id ? `${state.active_key_id.slice(0, 8)}...` : null,
      active_keys: keys.length,
      keys,
      rotation_events_24h: rotationEvents24h,
      aggregate,
    };
  };

  it('should return null when rotation state file does not exist', () => {
    const result = getKeyRotationMetrics(24, keyRotationStatePath);
    expect(result).toBe(null);
  });

  it('should return null for invalid rotation state version', () => {
    const state = { version: 2, keys: {} };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);
    expect(result).toBe(null);
  });

  it('should list all active keys with their metrics', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-abc123',
      keys: {
        'key-abc123': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 45, seven_day: 30 },
          status: 'active',
          account_uuid: 'acct-uuid-1',
        },
        'key-def456': {
          subscriptionType: 'team',
          last_usage: { five_hour: 60, seven_day: 50 },
          status: 'active',
          account_uuid: 'acct-uuid-2',
        },
        'key-invalid': {
          subscriptionType: 'pro',
          last_usage: null,
          status: 'invalid',
          account_uuid: 'acct-uuid-3',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result!.active_keys).toBe(2); // Only active keys
    expect(result!.keys).toHaveLength(2);
    expect(result!.keys[0].subscription_type).toBe('pro');
    expect(result!.keys[0].is_current).toBe(true);
    expect(result!.keys[1].subscription_type).toBe('team');
    expect(result!.keys[1].is_current).toBe(false);
  });

  it('should deduplicate keys from same account in aggregate calculation', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 10, seven_day: 20 },
          status: 'active',
          account_uuid: 'acct-uuid-same',
        },
        'key-2': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 15, seven_day: 25 },
          status: 'active',
          account_uuid: 'acct-uuid-same', // Same account
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    // Both keys listed individually
    expect(result!.keys).toHaveLength(2);
    // But aggregate should only count 1 account
    expect(result!.aggregate).not.toBe(null);
    expect(result!.aggregate!.active_keys).toBe(1);
    // Should use the first occurrence (key-1)
    expect(result!.aggregate!.five_hour_pct).toBe(10);
    expect(result!.aggregate!.seven_day_pct).toBe(20);
  });

  it('should count different accounts separately in aggregate', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 10, seven_day: 20 },
          status: 'active',
          account_uuid: 'acct-uuid-1',
        },
        'key-2': {
          subscriptionType: 'team',
          last_usage: { five_hour: 30, seven_day: 40 },
          status: 'active',
          account_uuid: 'acct-uuid-2', // Different account
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result!.keys).toHaveLength(2);
    expect(result!.aggregate).not.toBe(null);
    expect(result!.aggregate!.active_keys).toBe(2);
    // Average: (10+30)/2 = 20, (20+40)/2 = 30
    expect(result!.aggregate!.five_hour_pct).toBe(20);
    expect(result!.aggregate!.seven_day_pct).toBe(30);
  });

  it('should fall back to usage fingerprint when account_uuid is missing', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 10, seven_day: 20 },
          status: 'active',
          account_uuid: null,
        },
        'key-2': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 15, seven_day: 20 }, // Same seven_day fingerprint
          status: 'active',
          account_uuid: null,
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result!.keys).toHaveLength(2);
    // Should deduplicate by fingerprint (same seven_day value)
    expect(result!.aggregate).not.toBe(null);
    expect(result!.aggregate!.active_keys).toBe(1);
  });

  it('should count rotation events within time window', () => {
    const now = Date.now();
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 10, seven_day: 20 },
          status: 'active',
          account_uuid: 'acct-uuid-1',
        },
      },
      rotation_log: [
        { timestamp: now - 1 * 60 * 60 * 1000, event: 'key_switched' }, // 1h ago
        { timestamp: now - 12 * 60 * 60 * 1000, event: 'key_switched' }, // 12h ago
        { timestamp: now - 25 * 60 * 60 * 1000, event: 'key_switched' }, // 25h ago (outside 24h window)
        { timestamp: now - 2 * 60 * 60 * 1000, event: 'key_added' }, // Not a switch event
      ],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result!.rotation_events_24h).toBe(2); // Only key_switched events within 24h
  });

  it('should handle keys without usage data', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: null, // No usage data yet
          status: 'active',
          account_uuid: 'acct-uuid-1',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result!.keys).toHaveLength(1);
    expect(result!.keys[0].five_hour_pct).toBe(null);
    expect(result!.keys[0].seven_day_pct).toBe(null);
    // No accounts with usage data
    expect(result!.aggregate).toBe(null);
  });

  it('should validate structure of returned metrics', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          subscriptionType: 'pro',
          last_usage: { five_hour: 10, seven_day: 20 },
          status: 'active',
          account_uuid: 'acct-uuid-1',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(keyRotationStatePath, JSON.stringify(state));

    const result = getKeyRotationMetrics(24, keyRotationStatePath);

    expect(result).not.toBe(null);
    expect(result).toHaveProperty('current_key_id');
    expect(result).toHaveProperty('active_keys');
    expect(result).toHaveProperty('keys');
    expect(result).toHaveProperty('rotation_events_24h');
    expect(result).toHaveProperty('aggregate');

    expect(typeof result!.current_key_id).toBe('string');
    expect(typeof result!.active_keys).toBe('number');
    expect(Array.isArray(result!.keys)).toBe(true);
    expect(typeof result!.rotation_events_24h).toBe('number');

    if (result!.aggregate) {
      expect(result!.aggregate).toHaveProperty('active_keys');
      expect(result!.aggregate).toHaveProperty('five_hour_pct');
      expect(result!.aggregate).toHaveProperty('seven_day_pct');
      expect(typeof result!.aggregate.active_keys).toBe('number');
      expect(typeof result!.aggregate.five_hour_pct).toBe('number');
      expect(typeof result!.aggregate.seven_day_pct).toBe('number');
    }

    // Validate key structure
    for (const key of result!.keys) {
      expect(key).toHaveProperty('key_id');
      expect(key).toHaveProperty('subscription_type');
      expect(key).toHaveProperty('five_hour_pct');
      expect(key).toHaveProperty('seven_day_pct');
      expect(key).toHaveProperty('is_current');
      expect(typeof key.key_id).toBe('string');
      expect(typeof key.subscription_type).toBe('string');
      expect(typeof key.is_current).toBe('boolean');
    }
  });

  it('should handle malformed rotation state file gracefully', () => {
    fs.writeFileSync(keyRotationStatePath, 'invalid json');

    expect(() => {
      getKeyRotationMetrics(24, keyRotationStatePath);
    }).toThrow();
  });
});
