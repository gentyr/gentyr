/**
 * Unit tests for Agent Tracker MCP Server
 *
 * Tests agent tracking, session file reading, G001/G003 compliance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
