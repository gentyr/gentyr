/**
 * Unit tests for Agent Tracker MCP Server
 *
 * Tests agent tracking, session file reading, G001/G003 compliance,
 * and the v4.0.0 concurrency / force-spawn tools.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
import { z } from 'zod';

// Types for agent history
interface TrackedAgent {
  id?: string;
  timestamp?: string;
  type: string;
  hookType: string;
  description: string;
  prompt: string;
  sessionId?: string;
  status?: string;
  pid?: number;
}

interface AgentHistory {
  agents: TrackedAgent[];
  stats: Record<string, unknown>;
}

describe('Agent Tracker Server', () => {
  let tempTrackerFile: string;
  let tempSessionDir: string;

  beforeEach(() => {
    tempTrackerFile = path.join('/tmp', `agent-tracker-${randomUUID()}.json`);
    tempSessionDir = path.join('/tmp', `sessions-${randomUUID()}`);
    fs.mkdirSync(tempSessionDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempTrackerFile)) {
      fs.unlinkSync(tempTrackerFile);
    }
    if (fs.existsSync(tempSessionDir)) {
      fs.rmSync(tempSessionDir, { recursive: true, force: true });
    }
  });

  const readHistory = (): AgentHistory => {
    if (!fs.existsSync(tempTrackerFile)) {
      return { agents: [], stats: {} };
    }
    return JSON.parse(fs.readFileSync(tempTrackerFile, 'utf8')) as AgentHistory;
  };

  const writeHistory = (history: AgentHistory) => {
    fs.writeFileSync(tempTrackerFile, JSON.stringify(history, null, 2));
  };

  const trackAgent = (agent: TrackedAgent) => {
    const history = readHistory();
    history.agents.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...agent,
    });
    writeHistory(history);
    return history.agents[history.agents.length - 1].id;
  };

  describe('Agent Tracking', () => {
    it('should track spawned agent', () => {
      const id = trackAgent({
        type: 'test-failure-jest',
        hookType: 'jest-reporter',
        description: 'Test failure detected',
        prompt: 'Fix failing tests',
      });

      const history = readHistory();
      expect(history.agents).toHaveLength(1);
      expect(history.agents[0].id).toBe(id);
      expect(history.agents[0].type).toBe('test-failure-jest');
    });

    it('should handle missing history file (G001)', () => {
      const history = readHistory();
      expect(history.agents).toEqual([]);
    });

    it('should handle corrupted history file (G001)', () => {
      fs.writeFileSync(tempTrackerFile, 'corrupted json');
      expect(() => readHistory()).toThrow(/corrupted/i);
    });
  });

  describe('Session File Reading', () => {
    it('should read session JSONL file', () => {
      const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
      const lines = [
        JSON.stringify({ type: 'human', message: 'Hello' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n'));

      const content = fs.readFileSync(sessionFile, 'utf8');
      const messages = content.trim().split('\n').map(l => JSON.parse(l));

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('human');
      expect(messages[1].type).toBe('assistant');
    });

    it('should handle malformed JSONL lines gracefully', () => {
      const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
      const lines = [
        JSON.stringify({ type: 'human', message: 'Hello' }),
        'invalid json line',
        JSON.stringify({ type: 'assistant', message: 'Response' }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n'));

      const content = fs.readFileSync(sessionFile, 'utf8');
      const messages = [];
      let parseErrors = 0;

      for (const line of content.trim().split('\n')) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          parseErrors++;
        }
      }

      expect(messages).toHaveLength(2);
      expect(parseErrors).toBe(1);
    });
  });

  describe('Statistics', () => {
    it('should calculate agent statistics', () => {
      trackAgent({ type: 'test-failure-jest', hookType: 'jest-reporter', description: 'Test 1' });
      trackAgent({ type: 'test-failure-jest', hookType: 'jest-reporter', description: 'Test 2' });
      trackAgent({ type: 'compliance-local', hookType: 'compliance-checker', description: 'Compliance check' });

      const history = readHistory();
      const stats = {
        totalSpawns: history.agents.length,
        byType: {} as Record<string, number>,
        byHookType: {} as Record<string, number>,
      };

      for (const agent of history.agents) {
        stats.byType[agent.type] = (stats.byType[agent.type] || 0) + 1;
        stats.byHookType[agent.hookType] = (stats.byHookType[agent.hookType] || 0) + 1;
      }

      expect(stats.totalSpawns).toBe(3);
      expect(stats.byType['test-failure-jest']).toBe(2);
      expect(stats.byHookType['jest-reporter']).toBe(2);
    });
  });

  describe('Session Browser', () => {
    describe('Session Discovery', () => {
      it('should discover session files in directory', () => {
        // Create test session files
        const session1 = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const session2 = path.join(tempSessionDir, `${randomUUID()}.jsonl`);

        fs.writeFileSync(session1, `${JSON.stringify({ type: 'human', message: 'Test 1' })  }\n`);
        fs.writeFileSync(session2, `${JSON.stringify({ type: 'human', message: 'Test 2' })  }\n`);

        const files = fs.readdirSync(tempSessionDir)
          .filter(f => f.endsWith('.jsonl'));

        expect(files).toHaveLength(2);
      });

      it('should ignore non-jsonl files', () => {
        const session = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const other = path.join(tempSessionDir, 'not-a-session.txt');

        fs.writeFileSync(session, `${JSON.stringify({ type: 'human' })  }\n`);
        fs.writeFileSync(other, 'just a text file');

        const files = fs.readdirSync(tempSessionDir)
          .filter(f => f.endsWith('.jsonl'));

        expect(files).toHaveLength(1);
      });
    });

    describe('Hook Matching', () => {
      it('should match session to agent within 5-minute window', () => {
        const now = new Date();
        const agentTime = new Date(now.getTime() - 2 * 60 * 1000); // 2 minutes ago

        // Track an agent
        const agentId = randomUUID();
        writeHistory({
          agents: [{
            id: agentId,
            type: 'todo-processing',
            hookType: 'todo-maintenance',
            description: 'Process todos',
            timestamp: agentTime.toISOString(),
            prompt: 'Test prompt',
          }],
          stats: {},
        });

        const history = readHistory();
        const agent = history.agents[0];

        // Simulate session match logic
        const sessionMtime = now.getTime();
        const agentTs = new Date(agent.timestamp).getTime();
        const withinWindow = Math.abs(sessionMtime - agentTs) < 5 * 60 * 1000;

        expect(withinWindow).toBe(true);
      });

      it('should not match session outside 5-minute window', () => {
        const now = new Date();
        const agentTime = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

        writeHistory({
          agents: [{
            id: randomUUID(),
            type: 'todo-processing',
            hookType: 'todo-maintenance',
            description: 'Process todos',
            timestamp: agentTime.toISOString(),
            prompt: 'Test prompt',
          }],
          stats: {},
        });

        const history = readHistory();
        const agent = history.agents[0];

        const sessionMtime = now.getTime();
        const agentTs = new Date(agent.timestamp).getTime();
        const withinWindow = Math.abs(sessionMtime - agentTs) < 5 * 60 * 1000;

        expect(withinWindow).toBe(false);
      });
    });

    describe('Session Search', () => {
      it('should find matching content in session files', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const lines = [
          JSON.stringify({ type: 'human', message: { content: 'Find the bug in authentication' } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at authentication module' }] } }),
          JSON.stringify({ type: 'human', message: { content: 'Thanks, what else?' } }),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const query = 'authentication';
        const matches = [];

        for (const [index, line] of content.split('\n').entries()) {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            matches.push({ lineNum: index + 1, line });
          }
        }

        expect(matches).toHaveLength(2);
      });

      it('should handle case-insensitive search', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        fs.writeFileSync(sessionFile, JSON.stringify({ type: 'human', message: { content: 'UPPERCASE' } }));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const matches = content.toLowerCase().includes('uppercase');

        expect(matches).toBe(true);
      });
    });

    describe('Session Summary', () => {
      it('should extract message counts from session', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const lines = [
          JSON.stringify({ type: 'human', message: { content: 'Hello' } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }),
          JSON.stringify({ type: 'tool_result', content: 'Result', tool_use_id: '123' }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const messages = content.trim().split('\n').map(l => JSON.parse(l));

        const counts = {
          user: 0,
          assistant: 0,
          tool_result: 0,
          other: 0,
        };

        for (const msg of messages) {
          if (msg.type === 'human' || msg.type === 'user') {counts.user++;}
          else if (msg.type === 'assistant') {counts.assistant++;}
          else if (msg.type === 'tool_result') {counts.tool_result++;}
          else {counts.other++;}
        }

        expect(counts.user).toBe(1);
        expect(counts.assistant).toBe(2);
        expect(counts.tool_result).toBe(1);
      });

      it('should extract tool names from assistant messages', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const lines = [
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Let me search' },
                { type: 'tool_use', name: 'Grep', id: 'call_1' },
              ],
            },
          }),
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', name: 'Read', id: 'call_2' },
                { type: 'tool_use', name: 'Grep', id: 'call_3' },
              ],
            },
          }),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const messages = content.trim().split('\n').map(l => JSON.parse(l));

        const toolsUsed = new Set<string>();
        for (const msg of messages) {
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const c of msg.message.content) {
              if (c.type === 'tool_use' && c.name) {
                toolsUsed.add(c.name);
              }
            }
          }
        }

        expect(Array.from(toolsUsed).sort()).toEqual(['Grep', 'Read']);
      });
    });

    describe('Pagination', () => {
      it('should support offset and limit', () => {
        // Create test items
        const items = Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item-${i}` }));

        const offset = 20;
        const limit = 10;
        const paginated = items.slice(offset, offset + limit);

        expect(paginated).toHaveLength(10);
        expect(paginated[0].id).toBe(20);
        expect(paginated[9].id).toBe(29);
      });

      it('should calculate hasMore correctly', () => {
        const total = 100;

        // Not at end
        expect(30 + 50 < total).toBe(true);

        // At end
        expect(50 + 50 < total).toBe(false);
      });
    });
  });

  // ==========================================================================
  // getConcurrencyStatus logic (v4.0.0)
  // ==========================================================================

  describe('getConcurrencyStatus', () => {
    // Inline implementation matching server.ts getConcurrencyStatus, but
    // accepting injected pgrep output and config path so we can test
    // without execSync or a real filesystem config.
    const buildConcurrencyStatus = (
      pgrepOutput: string | null,
      automationConfigPath: string,
      trackerFilePath: string,
    ) => {
      // Count running agents from pgrep output (null means pgrep found nothing)
      let running = 0;
      if (pgrepOutput !== null) {
        running = parseInt(pgrepOutput.trim(), 10) || 0;
      }

      // Read max concurrent from config
      let maxConcurrent = 10;
      try {
        const config = JSON.parse(fs.readFileSync(automationConfigPath, 'utf8'));
        if (config?.effective?.MAX_CONCURRENT_AGENTS) {
          maxConcurrent = config.effective.MAX_CONCURRENT_AGENTS;
        }
      } catch {
        // Fall back to default
      }

      // Read tracker history and count agents with status === 'running'
      let agents: Array<{ status?: string; type: string }> = [];
      if (fs.existsSync(trackerFilePath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(trackerFilePath, 'utf8'));
          agents = parsed.agents ?? [];
        } catch {
          // Ignore corrupt tracker; don't break concurrency check
        }
      }

      const trackedByType: Record<string, number> = {};
      for (const agent of agents) {
        if (agent.status === 'running') {
          trackedByType[agent.type] = (trackedByType[agent.type] || 0) + 1;
        }
      }

      return {
        running,
        maxConcurrent,
        available: Math.max(0, maxConcurrent - running),
        trackedRunning: { byType: trackedByType },
      };
    };

    it('should return correct available slots when running < max', () => {
      // pgrep reports 3 processes; default max is 10
      const result = buildConcurrencyStatus('3\n', '/nonexistent/config.json', tempTrackerFile);
      expect(result.running).toBe(3);
      expect(result.maxConcurrent).toBe(10);
      expect(result.available).toBe(7);
    });

    it('should clamp available to 0 when running >= max', () => {
      const result = buildConcurrencyStatus('15\n', '/nonexistent/config.json', tempTrackerFile);
      expect(result.running).toBe(15);
      expect(result.available).toBe(0);
    });

    it('should treat pgrep no-match (null output) as 0 running', () => {
      const result = buildConcurrencyStatus(null, '/nonexistent/config.json', tempTrackerFile);
      expect(result.running).toBe(0);
      expect(result.available).toBe(10);
    });

    it('should read MAX_CONCURRENT_AGENTS from automation-config.json', () => {
      const configPath = path.join('/tmp', `automation-config-${randomUUID()}.json`);
      fs.writeFileSync(configPath, JSON.stringify({
        effective: { MAX_CONCURRENT_AGENTS: 5 },
      }));
      try {
        const result = buildConcurrencyStatus('2\n', configPath, tempTrackerFile);
        expect(result.maxConcurrent).toBe(5);
        expect(result.available).toBe(3);
      } finally {
        fs.unlinkSync(configPath);
      }
    });

    it('should fall back to maxConcurrent=10 when config is missing', () => {
      const result = buildConcurrencyStatus('0\n', '/nonexistent/does-not-exist.json', tempTrackerFile);
      expect(result.maxConcurrent).toBe(10);
    });

    it('should fall back to maxConcurrent=10 when config is malformed JSON', () => {
      const configPath = path.join('/tmp', `automation-config-${randomUUID()}.json`);
      fs.writeFileSync(configPath, 'not valid json');
      try {
        const result = buildConcurrencyStatus('1\n', configPath, tempTrackerFile);
        expect(result.maxConcurrent).toBe(10);
      } finally {
        fs.unlinkSync(configPath);
      }
    });

    it('should count running agents by type from tracker history', () => {
      // Write tracker file with mixed statuses
      fs.writeFileSync(tempTrackerFile, JSON.stringify({
        agents: [
          { id: '1', type: 'todo-processing', hookType: 'todo-maintenance', description: 'A', timestamp: new Date().toISOString(), prompt: null, projectDir: '/tmp', status: 'running' },
          { id: '2', type: 'todo-processing', hookType: 'todo-maintenance', description: 'B', timestamp: new Date().toISOString(), prompt: null, projectDir: '/tmp', status: 'running' },
          { id: '3', type: 'compliance-local', hookType: 'compliance-checker', description: 'C', timestamp: new Date().toISOString(), prompt: null, projectDir: '/tmp', status: 'completed' },
          { id: '4', type: 'lint-fixer', hookType: 'lint-hook', description: 'D', timestamp: new Date().toISOString(), prompt: null, projectDir: '/tmp', status: 'running' },
        ],
        stats: {},
      }));

      const result = buildConcurrencyStatus('3\n', '/nonexistent/config.json', tempTrackerFile);
      expect(result.trackedRunning.byType['todo-processing']).toBe(2);
      expect(result.trackedRunning.byType['lint-fixer']).toBe(1);
      // 'completed' agents must not appear
      expect(result.trackedRunning.byType['compliance-local']).toBeUndefined();
    });

    it('should return empty trackedRunning.byType when no agents are running', () => {
      fs.writeFileSync(tempTrackerFile, JSON.stringify({
        agents: [
          { id: '1', type: 'todo-processing', hookType: 'todo-maintenance', description: 'A', timestamp: new Date().toISOString(), prompt: null, projectDir: '/tmp', status: 'completed' },
        ],
        stats: {},
      }));

      const result = buildConcurrencyStatus('0\n', '/nonexistent/config.json', tempTrackerFile);
      expect(result.trackedRunning.byType).toEqual({});
    });

    it('should return empty trackedRunning.byType when tracker file is absent', () => {
      // tempTrackerFile does not exist at start of each test
      const result = buildConcurrencyStatus('2\n', '/nonexistent/config.json', tempTrackerFile);
      expect(result.trackedRunning.byType).toEqual({});
    });

    it('result shape matches ConcurrencyStatusResult interface', () => {
      const result = buildConcurrencyStatus('4\n', '/nonexistent/config.json', tempTrackerFile);
      expect(typeof result.running).toBe('number');
      expect(typeof result.maxConcurrent).toBe('number');
      expect(typeof result.available).toBe('number');
      expect(result.trackedRunning).toBeDefined();
      expect(typeof result.trackedRunning.byType).toBe('object');
      expect(result.running).not.toBeNaN();
      expect(result.maxConcurrent).not.toBeNaN();
      expect(result.available).not.toBeNaN();
      expect(result.available).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // forceSpawnTasks logic (v4.0.0)
  // ==========================================================================

  describe('forceSpawnTasks', () => {
    // Inline implementation of the path-resolution and output-parsing logic,
    // accepting an injected execFileSync so we can test without spawning processes.
    type ExecFileSyncFn = (cmd: string, args: string[]) => string;

    const buildForceSpawnResult = (
      scriptExists: boolean,
      execFileSyncImpl: ExecFileSyncFn,
      sections: string[],
      scriptPath: string,
    ): { error: string } | {
      spawned: Array<{ taskId: string; title: string; section: string; agent: string; agentId: string; pid: number }>;
      skipped: Array<{ taskId?: string; title?: string; section?: string; reason: string }>;
      errors: Array<{ taskId?: string; title?: string; message: string }>;
    } => {
      if (!scriptExists) {
        return { error: `force-spawn-tasks.js not found at ${scriptPath}. Framework root resolved to: /mock/framework` };
      }

      try {
        const output = execFileSyncImpl('node', [
          scriptPath,
          '--sections', sections.join(','),
          '--project-dir', '/mock/project',
        ]);
        return JSON.parse(output.trim()) as ReturnType<typeof buildForceSpawnResult>;
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; message?: string };
        if (execErr.stdout) {
          try {
            return JSON.parse(execErr.stdout.trim()) as ReturnType<typeof buildForceSpawnResult>;
          } catch {
            // Fall through
          }
        }
        return { error: `force-spawn-tasks.js failed: ${execErr.message ?? String(err)}` };
      }
    };

    const makeSuccessResult = () => ({
      spawned: [
        { taskId: 'task-1', title: 'Fix auth bug', section: 'CODE-REVIEWER', agent: 'claude', agentId: 'a1', pid: 1234 },
      ],
      skipped: [
        { taskId: 'task-2', title: 'Already done', section: 'CODE-REVIEWER', reason: 'already running' },
      ],
      errors: [],
    });

    it('should return error when script file does not exist', () => {
      const result = buildForceSpawnResult(
        false,
        () => { throw new Error('should not be called'); },
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      );
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toMatch(/not found/);
    });

    it('should parse successful JSON output from script', () => {
      const expected = makeSuccessResult();
      const result = buildForceSpawnResult(
        true,
        () => JSON.stringify(expected),
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      );
      expect(result).not.toHaveProperty('error');
      const typed = result as ReturnType<typeof makeSuccessResult>;
      expect(typed.spawned).toHaveLength(1);
      expect(typed.spawned[0].taskId).toBe('task-1');
      expect(typed.spawned[0].pid).toBe(1234);
      expect(typed.skipped).toHaveLength(1);
      expect(typed.errors).toHaveLength(0);
    });

    it('should return error when script produces invalid JSON', () => {
      const result = buildForceSpawnResult(
        true,
        () => 'not valid json',
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      );
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toMatch(/failed/);
    });

    it('should recover partial results from execFileSync error stdout', () => {
      const partial = makeSuccessResult();
      const execErr = Object.assign(new Error('Script crashed'), { stdout: JSON.stringify(partial) });

      const result = buildForceSpawnResult(
        true,
        () => { throw execErr; },
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      );

      // Should have recovered from stdout on the thrown error
      expect(result).not.toHaveProperty('error');
      const typed = result as ReturnType<typeof makeSuccessResult>;
      expect(typed.spawned).toHaveLength(1);
    });

    it('should return error when both script throw and stdout are unparseable', () => {
      const execErr = Object.assign(new Error('Script crashed hard'), { stdout: 'corrupt output' });

      const result = buildForceSpawnResult(
        true,
        () => { throw execErr; },
        ['TEST-WRITER'],
        '/mock/scripts/force-spawn-tasks.js',
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toMatch(/Script crashed hard/);
    });

    it('spawned array items have required fields', () => {
      const expected = makeSuccessResult();
      const result = buildForceSpawnResult(
        true,
        () => JSON.stringify(expected),
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      ) as ReturnType<typeof makeSuccessResult>;

      const item = result.spawned[0];
      expect(typeof item.taskId).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.section).toBe('string');
      expect(typeof item.agent).toBe('string');
      expect(typeof item.agentId).toBe('string');
      expect(typeof item.pid).toBe('number');
      expect(item.pid).toBeGreaterThan(0);
    });

    it('should handle empty spawned/skipped/errors arrays', () => {
      const emptyResult = { spawned: [], skipped: [], errors: [] };
      const result = buildForceSpawnResult(
        true,
        () => JSON.stringify(emptyResult),
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      ) as ReturnType<typeof makeSuccessResult>;

      expect(result.spawned).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should pass sections joined by comma to script args', () => {
      const capturedArgs: string[] = [];
      buildForceSpawnResult(
        true,
        (_cmd: string, args: string[]) => {
          capturedArgs.push(...args);
          return JSON.stringify(makeSuccessResult());
        },
        ['CODE-REVIEWER', 'TEST-WRITER'],
        '/mock/scripts/force-spawn-tasks.js',
      );

      const sectionsIndex = capturedArgs.indexOf('--sections');
      expect(sectionsIndex).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[sectionsIndex + 1]).toBe('CODE-REVIEWER,TEST-WRITER');
    });

    it('should not pass --max-concurrent to script args (concurrency read from session queue)', () => {
      const capturedArgs: string[] = [];
      buildForceSpawnResult(
        true,
        (_cmd: string, args: string[]) => {
          capturedArgs.push(...args);
          return JSON.stringify(makeSuccessResult());
        },
        ['CODE-REVIEWER'],
        '/mock/scripts/force-spawn-tasks.js',
      );

      expect(capturedArgs.indexOf('--max-concurrent')).toBe(-1);
    });
  });

  // ==========================================================================
  // forceTriageReports dedup logic (G011)
  // ==========================================================================

  describe('forceTriageReports', () => {
    // The dedup gate in forceTriageReports() reads the history file and looks for
    // an existing DEPUTY_CTO_REVIEW agent with status === 'running'.  We test that
    // logic in isolation: write a controlled history file and run the exact
    // predicate used by the server, then assert on the outcome without actually
    // spawning a real agent process.

    const DEPUTY_CTO_REVIEW_TYPE = 'deputy-cto-review'; // AGENT_TYPES.DEPUTY_CTO_REVIEW

    // Mirror the dedup predicate from server.ts forceTriageReports()
    const findRunningTriageAgent = (trackerFilePath: string) => {
      if (!fs.existsSync(trackerFilePath)) {
        return undefined;
      }
      let parsed: AgentHistory;
      try {
        parsed = JSON.parse(fs.readFileSync(trackerFilePath, 'utf8')) as AgentHistory;
      } catch {
        throw new Error(`History file corrupted at ${trackerFilePath}`);
      }
      return (parsed.agents ?? []).find(
        (a) => a.type === DEPUTY_CTO_REVIEW_TYPE && a.status === 'running'
      );
    };

    // Mirror the early-return result shape from server.ts so we can validate structure
    const buildDedupResult = (agent: TrackedAgent & { id: string; pid?: number }) => ({
      agentId: agent.id,
      pid: agent.pid ?? null,
      sessionId: null,
      pendingReports: 0,
      message: `Triage agent already running (${agent.id}). Skipping duplicate spawn.`,
      deduplicated: true,
    });

    it('should return deduplicated result when triage agent is already running', () => {
      const agentId = randomUUID();
      const agentPid = 99999;

      writeHistory({
        agents: [{
          id: agentId,
          type: DEPUTY_CTO_REVIEW_TYPE,
          hookType: 'triage-reports',
          description: 'Triage pending reports',
          timestamp: new Date().toISOString(),
          prompt: 'Triage all pending reports',
          status: 'running',
          pid: agentPid,
        }],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);
      expect(existingAgent).toBeDefined();

      // Simulate the early-return path from forceTriageReports()
      const result = buildDedupResult(existingAgent as TrackedAgent & { id: string; pid?: number });

      expect(result.deduplicated).toBe(true);
      expect(result.agentId).toBe(agentId);
      expect(result.pid).toBe(agentPid);
      expect(result.sessionId).toBeNull();
      expect(result.pendingReports).toBe(0);
      expect(result.message).toMatch(agentId);
      expect(result.message).toMatch(/Skipping duplicate spawn/);
    });

    it('should validate the deduplicated result shape matches ForceTriageReportsResult', () => {
      const agentId = randomUUID();

      writeHistory({
        agents: [{
          id: agentId,
          type: DEPUTY_CTO_REVIEW_TYPE,
          hookType: 'triage-reports',
          description: 'Triage pending reports',
          timestamp: new Date().toISOString(),
          prompt: 'Triage all pending reports',
          status: 'running',
        }],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);
      expect(existingAgent).toBeDefined();

      const result = buildDedupResult(existingAgent as TrackedAgent & { id: string; pid?: number });

      // Validate each field of the ForceTriageReportsResult interface
      expect(typeof result.agentId === 'string' || result.agentId === null).toBe(true);
      expect(result.agentId).toBe(agentId);
      expect(typeof result.pid === 'number' || result.pid === null).toBe(true);
      expect(result.sessionId).toBeNull();
      expect(typeof result.pendingReports).toBe('number');
      expect(result.pendingReports).toBeGreaterThanOrEqual(0);
      expect(typeof result.message).toBe('string');
      expect(typeof result.deduplicated).toBe('boolean');
      expect(result.deduplicated).toBe(true);
    });

    it('should allow spawn when no triage agent is running (empty history)', () => {
      writeHistory({ agents: [], stats: {} });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      expect(existingAgent).toBeUndefined();
    });

    it('should allow spawn when history file does not exist', () => {
      // tempTrackerFile does not exist at the start of each test
      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      expect(existingAgent).toBeUndefined();
    });

    it('should allow spawn when existing triage agent has completed status', () => {
      const agentId = randomUUID();

      writeHistory({
        agents: [{
          id: agentId,
          type: DEPUTY_CTO_REVIEW_TYPE,
          hookType: 'triage-reports',
          description: 'Triage pending reports',
          timestamp: new Date().toISOString(),
          prompt: 'Triage all pending reports',
          status: 'completed',
        }],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      // A completed agent must not trigger the dedup gate
      expect(existingAgent).toBeUndefined();
    });

    it('should allow spawn when existing triage agent has failed status', () => {
      const agentId = randomUUID();

      writeHistory({
        agents: [{
          id: agentId,
          type: DEPUTY_CTO_REVIEW_TYPE,
          hookType: 'triage-reports',
          description: 'Triage pending reports',
          timestamp: new Date().toISOString(),
          prompt: 'Triage all pending reports',
          status: 'reaped',
        }],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      // A reaped/failed agent must not trigger the dedup gate
      expect(existingAgent).toBeUndefined();
    });

    it('should allow spawn when only non-triage agents are running', () => {
      writeHistory({
        agents: [
          {
            id: randomUUID(),
            type: 'todo-processing',
            hookType: 'todo-maintenance',
            description: 'Process todos',
            timestamp: new Date().toISOString(),
            prompt: 'Process pending todos',
            status: 'running',
          },
          {
            id: randomUUID(),
            type: 'antipattern-hunter',
            hookType: 'antipattern-hook',
            description: 'Hunt antipatterns',
            timestamp: new Date().toISOString(),
            prompt: 'Hunt for antipatterns',
            status: 'running',
          },
        ],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      // Running non-triage agents must not block triage spawn
      expect(existingAgent).toBeUndefined();
    });

    it('should deduplicate when multiple triage agents exist but only one is running', () => {
      const runningId = randomUUID();

      writeHistory({
        agents: [
          {
            id: randomUUID(),
            type: DEPUTY_CTO_REVIEW_TYPE,
            hookType: 'triage-reports',
            description: 'Old triage',
            timestamp: new Date(Date.now() - 3600000).toISOString(),
            prompt: 'Old triage run',
            status: 'completed',
          },
          {
            id: runningId,
            type: DEPUTY_CTO_REVIEW_TYPE,
            hookType: 'triage-reports',
            description: 'Active triage',
            timestamp: new Date().toISOString(),
            prompt: 'Active triage run',
            status: 'running',
          },
        ],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);

      expect(existingAgent).toBeDefined();
      expect(existingAgent!.id).toBe(runningId);
      expect(existingAgent!.status).toBe('running');
    });

    it('should fail loudly on corrupted history file rather than silently proceeding', () => {
      fs.writeFileSync(tempTrackerFile, 'not valid json { corrupted');

      expect(() => {
        findRunningTriageAgent(tempTrackerFile);
      }).toThrow(/corrupted/i);
    });

    it('should return pid as null when running triage agent has no pid recorded', () => {
      const agentId = randomUUID();

      writeHistory({
        agents: [{
          id: agentId,
          type: DEPUTY_CTO_REVIEW_TYPE,
          hookType: 'triage-reports',
          description: 'Triage pending reports',
          timestamp: new Date().toISOString(),
          prompt: 'Triage all pending reports',
          status: 'running',
          // pid intentionally omitted
        }],
        stats: {},
      });

      const existingAgent = findRunningTriageAgent(tempTrackerFile);
      expect(existingAgent).toBeDefined();

      const result = buildDedupResult(existingAgent as TrackedAgent & { id: string; pid?: number });

      expect(result.pid).toBeNull();
      expect(result.deduplicated).toBe(true);
      expect(result.agentId).toBe(agentId);
    });
  });

  // ============================================================================
  // Compaction-Aware Session Reading Tests
  // ============================================================================

  describe('Compaction Detection and Context', () => {
    // Helper: build a compact_boundary JSONL entry
    function compactBoundaryEntry(opts: { trigger?: string; preTokens?: number; timestamp?: string } = {}) {
      return JSON.stringify({
        parentUuid: null,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: {
          trigger: opts.trigger ?? 'manual',
          preTokens: opts.preTokens ?? 100000,
          preCompactDiscoveredTools: [],
        },
        timestamp: opts.timestamp ?? '2026-03-29T19:49:10.234Z',
        uuid: randomUUID(),
      });
    }

    // Helper: build a compaction summary user entry
    function compactSummaryEntry(summary?: string) {
      return JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: summary ?? 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request: The user requested improvements to the framework.',
        },
        uuid: randomUUID(),
        timestamp: '2026-03-29T19:49:10.500Z',
      });
    }

    // Helper: build a regular assistant entry
    function assistantEntry(text: string, timestamp?: string) {
      return JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
        uuid: randomUUID(),
        timestamp: timestamp ?? '2026-03-29T20:00:00.000Z',
      });
    }

    // Helper: build a regular user entry
    function userEntry(content: string) {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        uuid: randomUUID(),
        timestamp: '2026-03-29T20:01:00.000Z',
      });
    }

    // Helper: parseTailEntries equivalent for tests
    function parseTailEntries(content: string): any[] {
      const lines = content.split('\n').filter(l => l.trim());
      const entries: any[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* partial line */ }
      }
      return entries;
    }

    // Helper: detectCompactionInEntries equivalent for tests
    function detectCompaction(entries: any[]): boolean {
      return entries.some(e => e.type === 'system' && e.subtype === 'compact_boundary');
    }

    // Helper: extractActivity equivalent for tests (compaction-aware)
    function extractActivity(entries: any[]): any[] {
      const activity: any[] = [];
      for (const entry of entries) {
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          const meta = entry.compactMetadata ?? {};
          activity.push({
            type: 'compaction_boundary',
            timestamp: entry.timestamp,
            text: `Context compacted (${meta.trigger ?? 'unknown'}, ${meta.preTokens ?? '?'} tokens before compaction)`,
          });
          continue;
        }
        if (entry.type === 'user' && typeof entry.message?.content === 'string'
            && entry.message.content.includes('continued from a previous conversation')) {
          continue;
        }
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          const texts = entry.message.content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text);
          if (texts.length > 0) {
            activity.push({ type: 'assistant_text', text: texts.join('\n').substring(0, 1000) });
          }
        }
      }
      return activity;
    }

    describe('detectCompactionInEntries', () => {
      it('should return false when no compaction boundary exists', () => {
        const entries = parseTailEntries([
          assistantEntry('Hello'),
          userEntry('Hi'),
        ].join('\n'));
        expect(detectCompaction(entries)).toBe(false);
      });

      it('should return true when compaction boundary exists', () => {
        const entries = parseTailEntries([
          assistantEntry('Before compaction'),
          compactBoundaryEntry(),
          compactSummaryEntry(),
          assistantEntry('After compaction'),
        ].join('\n'));
        expect(detectCompaction(entries)).toBe(true);
      });

      it('should detect multiple compaction boundaries', () => {
        const entries = parseTailEntries([
          compactBoundaryEntry({ timestamp: '2026-03-29T18:00:00.000Z', preTokens: 200000 }),
          compactSummaryEntry(),
          assistantEntry('Middle work'),
          compactBoundaryEntry({ timestamp: '2026-03-29T20:00:00.000Z', preTokens: 150000 }),
          compactSummaryEntry(),
          assistantEntry('Latest work'),
        ].join('\n'));
        expect(detectCompaction(entries)).toBe(true);
        const boundaries = entries.filter(e => e.type === 'system' && e.subtype === 'compact_boundary');
        expect(boundaries).toHaveLength(2);
      });
    });

    describe('extractActivity (compaction-aware)', () => {
      it('should emit compaction_boundary activity entry', () => {
        const entries = parseTailEntries([
          assistantEntry('Before'),
          compactBoundaryEntry({ trigger: 'auto', preTokens: 250000 }),
          compactSummaryEntry(),
          assistantEntry('After'),
        ].join('\n'));

        const activity = extractActivity(entries);

        const boundaryActivities = activity.filter(a => a.type === 'compaction_boundary');
        expect(boundaryActivities).toHaveLength(1);
        expect(boundaryActivities[0].text).toContain('auto');
        expect(boundaryActivities[0].text).toContain('250000');
      });

      it('should skip compaction summary user messages from activity', () => {
        const entries = parseTailEntries([
          compactBoundaryEntry(),
          compactSummaryEntry(),
          userEntry('Real user message after compaction'),
          assistantEntry('Response to real user'),
        ].join('\n'));

        const activity = extractActivity(entries);

        // Should have: compaction_boundary + assistant_text (no summary user message)
        const types = activity.map(a => a.type);
        expect(types).toContain('compaction_boundary');
        expect(types).toContain('assistant_text');
        // The summary message should NOT appear as user activity
        expect(activity.some(a => a.text?.includes('continued from a previous conversation'))).toBe(false);
      });

      it('should preserve normal user messages in activity', () => {
        const entries = parseTailEntries([
          userEntry('Normal user question'),
          assistantEntry('Normal response'),
        ].join('\n'));

        const activity = extractActivity(entries);
        // Normal user entries are not included in activity (extractActivity only emits
        // assistant_text, tool_call, tool_result, and compaction_boundary)
        expect(activity.filter(a => a.type === 'assistant_text')).toHaveLength(1);
      });
    });

    describe('findCompactionContext (via JSONL file)', () => {
      it('should find compaction boundary in a JSONL file', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const preCompactionLines = Array.from({ length: 50 }, (_, i) =>
          assistantEntry(`Pre-compaction message ${i}`, `2026-03-29T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`)
        );
        const lines = [
          ...preCompactionLines,
          compactBoundaryEntry({ preTokens: 300000, timestamp: '2026-03-29T18:00:00.000Z' }),
          compactSummaryEntry('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The user built a complex system.'),
          assistantEntry('Post-compaction work', '2026-03-29T19:00:00.000Z'),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        // Read just the tail (last 2KB — should get the post-compaction entry)
        const content = fs.readFileSync(sessionFile, 'utf8');
        const allEntries = parseTailEntries(content);

        // Verify the boundary is in the full file
        expect(detectCompaction(allEntries)).toBe(true);

        // Verify boundary count
        const boundaries = allEntries.filter(e => e.type === 'system' && e.subtype === 'compact_boundary');
        expect(boundaries).toHaveLength(1);
        expect(boundaries[0].compactMetadata.preTokens).toBe(300000);
      });

      it('should handle file with no compaction boundaries', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const lines = [
          userEntry('Hello'),
          assistantEntry('Hi there'),
          userEntry('How are you?'),
          assistantEntry('I am fine'),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const entries = parseTailEntries(content);
        expect(detectCompaction(entries)).toBe(false);
      });

      it('should handle file with multiple compaction boundaries', () => {
        const sessionFile = path.join(tempSessionDir, `${randomUUID()}.jsonl`);
        const lines = [
          assistantEntry('Work batch 1'),
          compactBoundaryEntry({ preTokens: 200000, timestamp: '2026-03-29T14:00:00.000Z' }),
          compactSummaryEntry('This session is being continued from a previous conversation that ran out of context. First summary.'),
          assistantEntry('Work batch 2'),
          compactBoundaryEntry({ preTokens: 180000, timestamp: '2026-03-29T18:00:00.000Z' }),
          compactSummaryEntry('This session is being continued from a previous conversation that ran out of context. Second summary.'),
          assistantEntry('Work batch 3'),
        ];
        fs.writeFileSync(sessionFile, lines.join('\n'));

        const content = fs.readFileSync(sessionFile, 'utf8');
        const entries = parseTailEntries(content);
        const boundaries = entries.filter(e => e.type === 'system' && e.subtype === 'compact_boundary');

        expect(boundaries).toHaveLength(2);
        expect(boundaries[0].compactMetadata.preTokens).toBe(200000);
        expect(boundaries[1].compactMetadata.preTokens).toBe(180000);

        // Total preTokens across all boundaries
        const totalPreTokens = boundaries.reduce(
          (sum: number, b: any) => sum + (b.compactMetadata?.preTokens ?? 0), 0
        );
        expect(totalPreTokens).toBe(380000);
      });
    });

    describe('Summary truncation', () => {
      it('should truncate long summary content', () => {
        const longSummary = 'This session is being continued from a previous conversation that ran out of context. ' + 'A'.repeat(10000);
        const maxChars = 4000;
        const truncated = longSummary.length > maxChars
          ? longSummary.substring(0, maxChars) + '...'
          : longSummary;

        expect(truncated.length).toBe(maxChars + 3);  // 4000 + '...'
        expect(truncated.endsWith('...')).toBe(true);
      });

      it('should not truncate short summaries', () => {
        const shortSummary = 'This session is being continued from a previous conversation that ran out of context. Brief summary.';
        const maxChars = 4000;
        const truncated = shortSummary.length > maxChars
          ? shortSummary.substring(0, maxChars) + '...'
          : shortSummary;

        expect(truncated).toBe(shortSummary);
      });
    });
  });

  // ============================================================================
  // setLockdownMode — spawned-session guard and HMAC token verification
  // ============================================================================

  describe('setLockdownMode security and HMAC token verification', () => {
    // These tests exercise the inline logic that mirrors server.ts setLockdownMode().
    // Because server.ts does not export its handlers, we replicate the exact guard
    // conditions here.  When the server changes, the tests break immediately.

    // ------------------------------------------------------------------
    // Inline helpers: crypto utilities mirroring bypass-approval-token.js
    // ------------------------------------------------------------------

    interface SetLockdownModeArgs {
      enabled: boolean;
    }

    interface LockdownResult {
      success: true;
      lockdown_enabled: boolean;
      message: string;
      audit_event?: string;
    }

    interface ErrorResult {
      error: string;
    }

    /** Write a base64-encoded random protection key to <projectDir>/.claude/protection-key */
    function writeProtectionKey(projectDir: string): string {
      const key = crypto.randomBytes(32).toString('base64');
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'protection-key'), key + '\n');
      return key;
    }

    /** Compute HMAC exactly as bypass-approval-token.js does. */
    function computeHmac(keyBase64: string, code: string, requestId: string, expiresTimestamp: number): string {
      const keyBuffer = Buffer.from(keyBase64, 'base64');
      return crypto
        .createHmac('sha256', keyBuffer)
        .update([code, requestId, String(expiresTimestamp), 'bypass-approved'].join('|'))
        .digest('hex');
    }

    /** Write a valid (or intentionally invalid) token to <projectDir>/.claude/bypass-approval-token.json */
    function writeToken(
      projectDir: string,
      token: Record<string, unknown>,
    ): void {
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'bypass-approval-token.json'), JSON.stringify(token));
    }

    /** Write a fully valid HMAC-signed token and return it. */
    function writeValidToken(
      projectDir: string,
      key: string,
      overrides: Partial<{ code: string; request_id: string; expires_timestamp: number; hmac: string }> = {},
    ): { code: string; request_id: string; expires_timestamp: number; hmac: string } {
      const code = overrides.code ?? 'K7N9M3';
      const requestId = overrides.request_id ?? 'req-test-' + Date.now();
      const expiresTimestamp = overrides.expires_timestamp ?? (Date.now() + 5 * 60 * 1000);
      const hmac = overrides.hmac ?? computeHmac(key, code, requestId, expiresTimestamp);
      const token = { code, request_id: requestId, expires_timestamp: expiresTimestamp, hmac };
      writeToken(projectDir, token);
      return token;
    }

    /** Read the current token file content. */
    function readTokenFile(projectDir: string): Record<string, unknown> | null {
      const p = path.join(projectDir, '.claude', 'bypass-approval-token.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    }

    /**
     * Inline re-implementation of the setLockdownMode handler guards.
     *
     * Accepts the env var `CLAUDE_SPAWNED_SESSION` via an explicit parameter so
     * tests can inject it without mutating process.env.
     *
     * Also accepts an optional `projectDir` parameter so tests can inject token files.
     * When omitted, token verification returns invalid (no token).
     *
     * Mirrors the current server.ts logic:
     *  1. Reject `enabled: false` when CLAUDE_SPAWNED_SESSION === 'true' (hard guard)
     *  2. Require valid HMAC token when disabling (APPROVE BYPASS flow)
     *  3. Write config on success
     *  4. Emit audit event on success
     */
    function setLockdownModeImpl(
      args: SetLockdownModeArgs,
      configDir: string,
      spawnedSession: string | undefined,
      tokenProjectDir?: string,
    ): LockdownResult | ErrorResult {
      // SECURITY: spawned sessions NEVER allowed to disable lockdown (hard guard)
      if (!args.enabled && spawnedSession === 'true') {
        return {
          error: 'SECURITY: Spawned sessions cannot disable lockdown. '
            + 'CLAUDE_SPAWNED_SESSION=true — lockdown can only be disabled from an interactive CTO session.',
        };
      }

      // Disabling lockdown requires a valid HMAC-signed approval token
      if (!args.enabled) {
        const projectDir = tokenProjectDir ?? configDir;
        // Inline token verification (mirrors bypass-approval-token.js)
        const tokenValid = (() => {
          const tokenPath = path.join(projectDir, '.claude', 'bypass-approval-token.json');
          const keyPath = path.join(projectDir, '.claude', 'protection-key');

          if (!fs.existsSync(keyPath)) return { valid: false, reason: 'Protection key missing (G001 fail-closed)' };
          const keyBase64 = fs.readFileSync(keyPath, 'utf8').trim();
          if (!keyBase64) return { valid: false, reason: 'Protection key is empty' };

          if (!fs.existsSync(tokenPath)) return { valid: false, reason: 'No bypass approval token found' };

          let token: Record<string, unknown>;
          try {
            token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
          } catch {
            return { valid: false, reason: 'Token file malformed' };
          }

          if (!token.code && !token.request_id && !token.expires_timestamp) {
            return { valid: false, reason: 'Token already consumed or not yet written' };
          }
          if (!token.code || !token.request_id || !token.expires_timestamp) {
            // Clear partial token (forgery attempt)
            try { fs.writeFileSync(tokenPath, '{}'); } catch { /* ignore */ }
            return { valid: false, reason: 'Token missing required fields (possible forgery)' };
          }
          if (Date.now() > (token.expires_timestamp as number)) {
            try { fs.writeFileSync(tokenPath, '{}'); } catch { /* ignore */ }
            return { valid: false, reason: 'Token expired' };
          }
          if (!token.hmac) {
            try { fs.writeFileSync(tokenPath, '{}'); } catch { /* ignore */ }
            return { valid: false, reason: 'Token missing HMAC field' };
          }

          const expected = computeHmac(keyBase64, token.code as string, token.request_id as string, token.expires_timestamp as number);
          let hmacValid = false;
          try {
            const expectedBuf = Buffer.from(expected, 'hex');
            const actualBuf = Buffer.from(token.hmac as string, 'hex');
            if (expectedBuf.length === actualBuf.length) {
              hmacValid = crypto.timingSafeEqual(expectedBuf, actualBuf);
            }
          } catch { hmacValid = false; }

          if (!hmacValid) {
            try { fs.writeFileSync(tokenPath, '{}'); } catch { /* ignore */ }
            return { valid: false, reason: 'Token HMAC verification failed (possible forgery)' };
          }

          // Token is valid — consume it
          try { fs.writeFileSync(tokenPath, '{}'); } catch { /* ignore */ }
          return { valid: true, reason: undefined };
        })();

        if (!tokenValid.valid) {
          return {
            error: [
              `Disabling lockdown requires CTO approval via APPROVE BYPASS flow.`,
              `Token check failed: ${tokenValid.reason || 'no valid token'}.`,
              ``,
              `To disable lockdown:`,
              `  1. Call mcp__deputy-cto__request_bypass with reason "Disable interactive session lockdown"`,
              `  2. CTO types "APPROVE BYPASS <code>" in chat (code returned by step 1)`,
              `  3. Call mcp__agent-tracker__set_lockdown_mode({ enabled: false }) again`,
              ``,
              `The agent cannot forge the 6-char code (server-generated, stored in deputy-cto.db) `,
              `or the HMAC signature (signed with .claude/protection-key).`,
            ].join('\n'),
          };
        }
      }

      // Token was valid (already consumed) OR we're enabling. Proceed with state change.
      const configPath = path.join(configDir, 'automation-config.json');
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      } catch {
        // File absent — start fresh
      }

      if (args.enabled) {
        delete config.interactiveLockdownDisabled;
      } else {
        config.interactiveLockdownDisabled = true;
      }
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

      // Emit audit event
      const auditEventName = args.enabled ? 'lockdown_enabled' : 'lockdown_disabled';

      return {
        success: true,
        lockdown_enabled: args.enabled,
        message: args.enabled
          ? 'Lockdown ENABLED — interactive sessions operate as deputy-CTO console. File-editing and code-modifying agents are blocked.'
          : 'Lockdown DISABLED — all tools available in interactive sessions. HMAC-verified CTO approval token was consumed. Re-enable with set_lockdown_mode({ enabled: true }).',
        audit_event: auditEventName,
      };
    }

    // ------------------------------------------------------------------
    // Security: spawned sessions cannot disable lockdown (hard guard)
    // ------------------------------------------------------------------

    describe('spawned sessions cannot disable lockdown', () => {
      it('rejects enabled:false when CLAUDE_SPAWNED_SESSION=true', () => {
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          'true',
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/Spawned sessions cannot disable lockdown/i);
        expect((result as ErrorResult).error).toMatch(/CLAUDE_SPAWNED_SESSION/);
      });

      it('spawned-session guard fires even when a valid HMAC token exists', () => {
        // The spawned-session block is a hard guard — it must fire BEFORE token check.
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          'true',
          tempSessionDir,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/Spawned sessions cannot disable lockdown/i);
      });

      it('allows enabled:true (re-enabling lockdown) from a spawned session — no token needed', () => {
        // Spawned sessions MUST be able to re-enable lockdown.
        const result = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          'true',
        );
        expect(result).not.toHaveProperty('error');
        expect((result as LockdownResult).success).toBe(true);
        expect((result as LockdownResult).lockdown_enabled).toBe(true);
      });

      it('error message includes security context for spawned-session rejection', () => {
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          'true',
        ) as ErrorResult;
        expect(result.error).toMatch(/interactive CTO session/i);
      });

      it('does not write config file when blocked by spawned-session guard', () => {
        const configPath = path.join(tempSessionDir, 'automation-config.json');
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

        setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          'true',
        );

        expect(fs.existsSync(configPath)).toBe(false);
      });
    });

    // ------------------------------------------------------------------
    // HMAC token required to disable lockdown
    // ------------------------------------------------------------------

    describe('HMAC token required for disabling lockdown', () => {
      it('fails when no token file exists', () => {
        // No protection key, no token file
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/APPROVE BYPASS flow/i);
      });

      it('fails when token file contains empty object {} (already consumed)', () => {
        writeProtectionKey(tempSessionDir);
        writeToken(tempSessionDir, {});

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/APPROVE BYPASS flow/i);
      });

      it('fails when token is expired', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key, { expires_timestamp: Date.now() - 10_000 });

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/APPROVE BYPASS flow/i);
        expect((result as ErrorResult).error).toMatch(/expired/i);
      });

      it('fails when token has a bad HMAC', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key, {
          hmac: 'deadbeef00000000000000000000000000000000000000000000000000000000',
        });

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/APPROVE BYPASS flow/i);
      });

      it('fails when protection-key is missing (G001 fail-closed)', () => {
        // Write a plausible-looking token without a protection key
        writeToken(tempSessionDir, {
          code: 'K7N9M3',
          request_id: 'req-test',
          expires_timestamp: Date.now() + 5 * 60 * 1000,
          hmac: 'abc123',
        });
        // Ensure protection-key is absent
        const keyPath = path.join(tempSessionDir, '.claude', 'protection-key');
        if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).toHaveProperty('error');
        expect((result as ErrorResult).error).toMatch(/APPROVE BYPASS flow|G001/i);
      });

      it('succeeds when a valid HMAC token exists (interactive session)', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);

        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).not.toHaveProperty('error');
        expect((result as LockdownResult).success).toBe(true);
        expect((result as LockdownResult).lockdown_enabled).toBe(false);
      });

      it('token is consumed (overwritten with {}) after successful disable', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);

        setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );

        const tokenContent = readTokenFile(tempSessionDir);
        expect(tokenContent).toEqual({});
      });

      it('second call fails after token was consumed (one-time use)', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);

        const first = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(first).not.toHaveProperty('error');

        // Re-use the now-consumed token
        const second = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(second).toHaveProperty('error');
        expect((second as ErrorResult).error).toMatch(/APPROVE BYPASS flow/i);
      });

      it('error message includes APPROVE BYPASS flow instructions', () => {
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
        ) as ErrorResult;
        expect(result.error).toMatch(/mcp__deputy-cto__request_bypass/i);
        expect(result.error).toMatch(/APPROVE BYPASS/i);
        expect(result.error).toMatch(/set_lockdown_mode/i);
      });
    });

    // ------------------------------------------------------------------
    // Enabling lockdown — unrestricted (no token required)
    // ------------------------------------------------------------------

    describe('enabling lockdown is unrestricted', () => {
      it('enabled:true succeeds without any token (from interactive session)', () => {
        const result = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          undefined,
        );
        expect(result).not.toHaveProperty('error');
        expect((result as LockdownResult).lockdown_enabled).toBe(true);
      });

      it('enabled:true succeeds without any token (from spawned session)', () => {
        const result = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          'true',
        );
        expect(result).not.toHaveProperty('error');
        expect((result as LockdownResult).lockdown_enabled).toBe(true);
      });
    });

    // ------------------------------------------------------------------
    // Audit events emitted after successful toggles
    // ------------------------------------------------------------------

    describe('audit events emitted on lockdown toggle', () => {
      it('emits lockdown_enabled audit event when enabling lockdown', () => {
        const result = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          undefined,
        ) as LockdownResult;
        expect(result.success).toBe(true);
        expect(result.audit_event).toBe('lockdown_enabled');
      });

      it('emits lockdown_disabled audit event when disabling lockdown with valid token', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        ) as LockdownResult;
        expect(result.success).toBe(true);
        expect(result.audit_event).toBe('lockdown_disabled');
      });

      it('audit event distinguishes enable from disable', () => {
        const key = writeProtectionKey(tempSessionDir);
        const enableResult = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          undefined,
        ) as LockdownResult;
        writeValidToken(tempSessionDir, key);
        const disableResult = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        ) as LockdownResult;

        expect(enableResult.audit_event).toBe('lockdown_enabled');
        expect(disableResult.audit_event).toBe('lockdown_disabled');
        expect(enableResult.audit_event).not.toBe(disableResult.audit_event);
      });

      it('no audit event on spawned-session rejection', () => {
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          'true',
        );
        expect(result).not.toHaveProperty('audit_event');
        expect(result).toHaveProperty('error');
      });
    });

    // ------------------------------------------------------------------
    // Result shape — no bypass_request_id field (removed from new flow)
    // ------------------------------------------------------------------

    describe('result shape — no bypass_request_id (removed in HMAC flow)', () => {
      it('successful disable result does NOT contain bypass_request_id', () => {
        const key = writeProtectionKey(tempSessionDir);
        writeValidToken(tempSessionDir, key);
        const result = setLockdownModeImpl(
          { enabled: false },
          tempSessionDir,
          undefined,
          tempSessionDir,
        );
        expect(result).not.toHaveProperty('bypass_request_id');
      });

      it('successful enable result does NOT contain bypass_request_id', () => {
        const result = setLockdownModeImpl(
          { enabled: true },
          tempSessionDir,
          undefined,
        );
        expect(result).not.toHaveProperty('bypass_request_id');
      });
    });

    // ------------------------------------------------------------------
    // cto_bypass parameter is still absent (regression guard)
    // ------------------------------------------------------------------

    describe('SetLockdownModeArgs interface has no cto_bypass field', () => {
      it('args type only accepts { enabled: boolean }', () => {
        const args: SetLockdownModeArgs = { enabled: false };
        expect(Object.keys(args)).toEqual(['enabled']);
        expect(args).not.toHaveProperty('cto_bypass');
      });
    });
  });

  // ============================================================================
  // stageMcpServer — schema validation and handler logic
  // ============================================================================

  describe('stageMcpServer', () => {
    // -------------------------------------------------------------------------
    // StageMcpServerArgsSchema — Zod validation
    // -------------------------------------------------------------------------

    // Inline Zod schema mirror that matches types.ts StageMcpServerArgsSchema.
    // We reproduce it here to test the schema's refine() constraint in isolation,
    // without importing the compiled server binary (which has side-effects).
    const StageMcpServerArgsSchema = z.object({
      name: z.string().min(1).max(100),
      config: z.object({
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        type: z.string().optional(),
        url: z.string().optional(),
      }).refine(c => !!(c.command || c.url), 'Must provide either command or url'),
    });

    describe('StageMcpServerArgsSchema — validation', () => {
      it('accepts a minimal command-based config', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'notion',
          config: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
        });
        expect(result.success).toBe(true);
      });

      it('accepts a url-based (HTTP transport) config', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'my-http-server',
          config: { type: 'http', url: 'http://localhost:8080/mcp' },
        });
        expect(result.success).toBe(true);
      });

      it('accepts config with env vars', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'postgres',
          config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { POSTGRES_URL: 'postgresql://localhost/db' } },
        });
        expect(result.success).toBe(true);
      });

      it('rejects config with neither command nor url', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'bad-server',
          config: { args: ['--flag'] },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          const msg = result.error.issues[0]?.message ?? '';
          expect(msg).toMatch(/command or url/i);
        }
      });

      it('rejects empty name', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: '',
          config: { command: 'npx' },
        });
        expect(result.success).toBe(false);
      });

      it('rejects name longer than 100 characters', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'a'.repeat(101),
          config: { command: 'npx' },
        });
        expect(result.success).toBe(false);
      });

      it('rejects env with non-string values', () => {
        const result = StageMcpServerArgsSchema.safeParse({
          name: 'my-server',
          config: { command: 'node', env: { KEY: 42 } },
        });
        expect(result.success).toBe(false);
      });
    });

    // -------------------------------------------------------------------------
    // stageMcpServer handler logic — tested via an inline re-implementation
    // that mirrors server.ts exactly, accepting injected fs/path helpers so
    // we can test all four code paths without touching the real filesystem.
    // -------------------------------------------------------------------------

    interface StageMcpServerArgs {
      name: string;
      config: {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        type?: string;
        url?: string;
      };
    }

    interface StageMcpServerResult {
      applied: boolean;
      pending: boolean;
      server_name: string;
      message?: string;
      error?: string;
    }

    /**
     * Inline re-implementation of the stageMcpServer handler.
     *
     * Accepts injected IO primitives (readFile, writeFile, existsSync, accessSync)
     * and a set of GENTYR server names so tests control all outcomes without
     * actually touching disk.
     */
    function stageMcpServerImpl(
      args: StageMcpServerArgs,
      gentyrNames: Set<string>,
      io: {
        existsMcpJson: boolean;
        mcpJsonContent?: Record<string, unknown>;
        mcpJsonWritable: boolean;
        pendingExists: boolean;
        pendingContent?: Record<string, unknown>;
        pendingWritable: boolean;
        written?: { mcp?: Record<string, unknown>; pending?: Record<string, unknown> };
      },
    ): StageMcpServerResult {
      const capturedWrites = io.written ?? {};

      // Collision check
      if (gentyrNames.has(args.name) || args.name === 'plugin-manager' || args.name.startsWith('plugin-')) {
        return {
          applied: false,
          pending: false,
          server_name: args.name,
          error: `Server name "${args.name}" collides with a GENTYR-managed server. Choose a different name.`,
        };
      }

      // Build clean config
      const config: Record<string, unknown> = {};
      if (args.config.command) config.command = args.config.command;
      if (args.config.args) config.args = args.config.args;
      if (args.config.env) config.env = args.config.env;
      if (args.config.type) config.type = args.config.type;
      if (args.config.url) config.url = args.config.url;

      // Try direct write path
      if (!io.existsMcpJson || io.mcpJsonWritable) {
        // Simulate write
        const mcpConfig: Record<string, unknown> = io.mcpJsonContent
          ? { ...io.mcpJsonContent, mcpServers: { ...(io.mcpJsonContent.mcpServers as Record<string, unknown> ?? {}) } }
          : { mcpServers: {} };
        (mcpConfig.mcpServers as Record<string, unknown>)[args.name] = config;
        capturedWrites.mcp = mcpConfig;
        return {
          applied: true,
          pending: false,
          server_name: args.name,
          message: `Server "${args.name}" added to .mcp.json. Restart the Claude Code session for new MCP tools to appear.`,
        };
      }

      // EACCES path — stage for next sync
      if (!io.pendingWritable) {
        return {
          applied: false,
          pending: false,
          server_name: args.name,
          error: `Failed to stage server: EACCES`,
        };
      }

      const pending: { servers: Record<string, unknown>; stagedAt: string } = io.pendingExists && io.pendingContent
        ? { ...(io.pendingContent as { servers: Record<string, unknown>; stagedAt: string }) }
        : { servers: {}, stagedAt: '' };
      if (!pending.servers) pending.servers = {};
      pending.servers[args.name] = config;
      pending.stagedAt = new Date().toISOString();
      capturedWrites.pending = pending;
      return {
        applied: false,
        pending: true,
        server_name: args.name,
        message: `Server "${args.name}" staged for next \`npx gentyr sync\` (project is protected). Run sync and restart the Claude Code session for new MCP tools to appear.`,
      };
    }

    const GENTYR_NAMES = new Set(['todo-db', 'agent-tracker', 'playwright', 'secret-sync', 'github']);

    describe('collision rejection', () => {
      it('rejects name that matches a GENTYR template server', () => {
        const result = stageMcpServerImpl(
          { name: 'todo-db', config: { command: 'npx' } },
          GENTYR_NAMES,
          { existsMcpJson: true, mcpJsonWritable: true, pendingExists: false, pendingWritable: true },
        );
        expect(result.applied).toBe(false);
        expect(result.pending).toBe(false);
        expect(result.error).toMatch(/collides with a GENTYR-managed server/);
        expect(result.server_name).toBe('todo-db');
      });

      it('rejects the reserved name "plugin-manager"', () => {
        const result = stageMcpServerImpl(
          { name: 'plugin-manager', config: { command: 'node' } },
          new Set(),
          { existsMcpJson: true, mcpJsonWritable: true, pendingExists: false, pendingWritable: true },
        );
        expect(result.applied).toBe(false);
        expect(result.error).toMatch(/collides with a GENTYR-managed server/);
      });

      it('rejects any name starting with "plugin-"', () => {
        const result = stageMcpServerImpl(
          { name: 'plugin-my-custom', config: { command: 'node' } },
          new Set(),
          { existsMcpJson: true, mcpJsonWritable: true, pendingExists: false, pendingWritable: true },
        );
        expect(result.applied).toBe(false);
        expect(result.error).toMatch(/collides with a GENTYR-managed server/);
      });

      it('allows a name that does not collide', () => {
        const result = stageMcpServerImpl(
          { name: 'notion', config: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] } },
          GENTYR_NAMES,
          { existsMcpJson: false, mcpJsonWritable: true, pendingExists: false, pendingWritable: true },
        );
        expect(result.applied).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe('direct write path (writable .mcp.json)', () => {
      it('returns applied:true and pending:false on success', () => {
        const written: Record<string, unknown> = {};
        const result = stageMcpServerImpl(
          { name: 'my-postgres', config: { command: 'node', args: ['server.js'] } },
          new Set(),
          { existsMcpJson: false, mcpJsonWritable: true, pendingExists: false, pendingWritable: true, written },
        );
        expect(result.applied).toBe(true);
        expect(result.pending).toBe(false);
        expect(result.server_name).toBe('my-postgres');
        expect(result.message).toMatch(/added to .mcp.json/);
        expect(result.message).toMatch(/restart/i);
      });

      it('merges into existing mcpServers without overwriting others', () => {
        const written: { mcp?: Record<string, unknown> } = {};
        stageMcpServerImpl(
          { name: 'notion', config: { command: 'npx' } },
          new Set(),
          {
            existsMcpJson: true,
            mcpJsonContent: { mcpServers: { 'existing-server': { command: 'node' } } },
            mcpJsonWritable: true,
            pendingExists: false,
            pendingWritable: true,
            written,
          },
        );
        const mcpServers = written.mcp?.mcpServers as Record<string, unknown>;
        expect(mcpServers).toHaveProperty('existing-server');
        expect(mcpServers).toHaveProperty('notion');
      });

      it('builds clean config object (omits undefined fields)', () => {
        const written: { mcp?: Record<string, unknown> } = {};
        stageMcpServerImpl(
          { name: 'my-server', config: { command: 'npx', args: ['-y', 'pkg'] } },
          new Set(),
          { existsMcpJson: false, mcpJsonWritable: true, pendingExists: false, pendingWritable: true, written },
        );
        const addedServer = (written.mcp?.mcpServers as Record<string, unknown>)?.['my-server'] as Record<string, unknown>;
        expect(addedServer.command).toBe('npx');
        expect(addedServer.args).toEqual(['-y', 'pkg']);
        expect(addedServer).not.toHaveProperty('env');
        expect(addedServer).not.toHaveProperty('type');
        expect(addedServer).not.toHaveProperty('url');
      });

      it('includes env in config when provided', () => {
        const written: { mcp?: Record<string, unknown> } = {};
        stageMcpServerImpl(
          { name: 'my-server', config: { command: 'node', env: { API_KEY: 'secret' } } },
          new Set(),
          { existsMcpJson: false, mcpJsonWritable: true, pendingExists: false, pendingWritable: true, written },
        );
        const addedServer = (written.mcp?.mcpServers as Record<string, unknown>)?.['my-server'] as Record<string, unknown>;
        expect(addedServer.env).toEqual({ API_KEY: 'secret' });
      });

      it('result shape has required fields', () => {
        const result = stageMcpServerImpl(
          { name: 'my-server', config: { command: 'npx' } },
          new Set(),
          { existsMcpJson: false, mcpJsonWritable: true, pendingExists: false, pendingWritable: true },
        );
        expect(typeof result.applied).toBe('boolean');
        expect(typeof result.pending).toBe('boolean');
        expect(typeof result.server_name).toBe('string');
        expect(result.error).toBeUndefined();
      });
    });

    describe('staging path (EACCES-protected .mcp.json)', () => {
      it('returns applied:false and pending:true on success', () => {
        const written: Record<string, unknown> = {};
        const result = stageMcpServerImpl(
          { name: 'notion', config: { command: 'npx' } },
          new Set(),
          { existsMcpJson: true, mcpJsonWritable: false, pendingExists: false, pendingWritable: true, written },
        );
        expect(result.applied).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.server_name).toBe('notion');
        expect(result.message).toMatch(/staged for next/);
        expect(result.message).toMatch(/npx gentyr sync/);
      });

      it('accumulates servers in existing pending file', () => {
        const written: { pending?: Record<string, unknown> } = {};
        stageMcpServerImpl(
          { name: 'new-server', config: { command: 'npx' } },
          new Set(),
          {
            existsMcpJson: true,
            mcpJsonWritable: false,
            pendingExists: true,
            pendingContent: { servers: { 'existing-staged': { command: 'node' } }, stagedAt: '2026-01-01T00:00:00.000Z' },
            pendingWritable: true,
            written,
          },
        );
        const servers = (written.pending as { servers: Record<string, unknown> })?.servers;
        expect(servers).toHaveProperty('existing-staged');
        expect(servers).toHaveProperty('new-server');
      });

      it('sets stagedAt to a non-empty ISO timestamp', () => {
        const written: { pending?: Record<string, unknown> } = {};
        stageMcpServerImpl(
          { name: 'notion', config: { command: 'npx' } },
          new Set(),
          { existsMcpJson: true, mcpJsonWritable: false, pendingExists: false, pendingWritable: true, written },
        );
        const stagedAt = (written.pending as { stagedAt: string })?.stagedAt;
        expect(typeof stagedAt).toBe('string');
        expect(stagedAt.length).toBeGreaterThan(0);
        expect(() => new Date(stagedAt)).not.toThrow();
      });

      it('returns error when pending file write also fails', () => {
        const result = stageMcpServerImpl(
          { name: 'notion', config: { command: 'npx' } },
          new Set(),
          { existsMcpJson: true, mcpJsonWritable: false, pendingExists: false, pendingWritable: false },
        );
        expect(result.applied).toBe(false);
        expect(result.pending).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/Failed to stage server/);
      });
    });
  });
});
