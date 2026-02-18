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
      maxConcurrent: number,
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
          '--max-concurrent', String(maxConcurrent),
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
        10,
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
        10,
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
        10,
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
        10,
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
        5,
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
        10,
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
        10,
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
        5,
        '/mock/scripts/force-spawn-tasks.js',
      );

      const sectionsIndex = capturedArgs.indexOf('--sections');
      expect(sectionsIndex).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[sectionsIndex + 1]).toBe('CODE-REVIEWER,TEST-WRITER');
    });

    it('should pass maxConcurrent as string to script args', () => {
      const capturedArgs: string[] = [];
      buildForceSpawnResult(
        true,
        (_cmd: string, args: string[]) => {
          capturedArgs.push(...args);
          return JSON.stringify(makeSuccessResult());
        },
        ['CODE-REVIEWER'],
        7,
        '/mock/scripts/force-spawn-tasks.js',
      );

      const maxIndex = capturedArgs.indexOf('--max-concurrent');
      expect(maxIndex).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[maxIndex + 1]).toBe('7');
    });
  });
});
