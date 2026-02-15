/**
 * Unit tests for AuditedMcpServer
 *
 * Tests audit logging functionality for MCP tool calls.
 * Verifies that tool calls are logged to session-events.db and that
 * construction fails when no session ID is provided (auditing is mandatory).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { AuditedMcpServer, type AuditedMcpServerOptions } from '../audited-server.js';
import type { ToolHandler } from '../server.js';

interface TestServer {
  handleRequest: (request: unknown) => Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface AuditEntry {
  id: string;
  session_id: string;
  agent_id: string | null;
  integration_id: string | null;
  event_type: string;
  event_category: string;
  input: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  page_url: string | null;
  page_title: string | null;
  element_selector: string | null;
  timestamp: string;
  metadata: string;
}

describe('AuditedMcpServer', () => {
  // Mock stdout.write to capture responses
  let mockOutput: string[] = [];
  let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
  let mockStderrWrite: ReturnType<typeof vi.spyOn>;
  let stderrOutput: string[] = [];

  // Temp file tracking for cleanup
  let tempFiles: string[] = [];

  beforeEach(() => {
    mockOutput = [];
    stderrOutput = [];
    tempFiles = [];

    mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      mockOutput.push(chunk.toString());
      return true;
    });

    mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    mockStdoutWrite.mockRestore();
    mockStderrWrite.mockRestore();

    // Clean up temp files
    tempFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });

  const createTempDbPath = (): string => {
    const dbPath = path.join(tmpdir(), `audit-test-${randomUUID()}.db`);
    tempFiles.push(dbPath);
    return dbPath;
  };

  const createTestServer = (options: Partial<AuditedMcpServerOptions> = {}) => {
    const defaultOptions: AuditedMcpServerOptions = {
      name: 'test-server',
      version: '1.0.0',
      tools: [],
      ...options,
    };
    return new AuditedMcpServer(defaultOptions);
  };

  const sendRequest = async (server: AuditedMcpServer, request: unknown) => {
    const serverAny = server as unknown as TestServer;
    const parsed = JSON.parse(JSON.stringify(request)) as unknown;
    await serverAny.handleRequest(parsed);
  };

  const getLastResponse = (): JsonRpcResponse => {
    const lastOutput = mockOutput[mockOutput.length - 1];
    return JSON.parse(lastOutput) as JsonRpcResponse;
  };

  const parseResponse = (): JsonRpcResponse => getLastResponse();

  const getAuditEntries = (dbPath: string): AuditEntry[] => {
    const db = new Database(dbPath);
    const entries = db.prepare('SELECT * FROM session_events ORDER BY timestamp ASC').all() as AuditEntry[];
    db.close();
    return entries;
  };

  describe('No session ID (mandatory audit)', () => {
    it('should throw when no session ID is provided', () => {
      const tool: ToolHandler = {
        name: 'transform',
        description: 'Transform value',
        schema: z.object({ value: z.string() }),
        handler: async (args) => ({ result: args.value.toUpperCase() }),
      };

      expect(() => createTestServer({ tools: [tool] })).toThrow(
        /requires a session ID/,
      );
    });

    it('should include server name in error message', () => {
      expect(() =>
        createTestServer({
          name: 'my-feedback-server',
          tools: [],
        }),
      ).toThrow(/my-feedback-server/);
    });
  });

  describe('With session ID (audit enabled)', () => {
    it('should create audit database and log tool calls', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();
      const personaName = 'test-agent';

      const tool: ToolHandler = {
        name: 'test_tool',
        description: 'Test tool',
        schema: z.object({ input: z.string() }),
        handler: async (args) => ({ output: args.input }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
        auditPersonaName: personaName,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_tool',
          arguments: { input: 'test-value' },
        },
      });

      // Verify DB was created
      expect(fs.existsSync(dbPath)).toBe(true);

      // Verify audit entry
      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.session_id).toBe(sessionId);
      expect(entry.agent_id).toBe(personaName);
      expect(entry.event_type).toBe('mcp_tool_call');
      expect(entry.event_category).toBe('mcp');

      const input = JSON.parse(entry.input);
      expect(input.tool).toBe('test_tool');
      expect(input.args).toEqual({ input: 'test-value' });

      const output = JSON.parse(entry.output!);
      expect(output.output).toBe('test-value');

      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);

      const metadata = JSON.parse(entry.metadata);
      expect(metadata.mcp_server).toBe('test-server');
    });

    it('should still return tool results normally when auditing is enabled', async () => {
      const dbPath = createTempDbPath();
      const handler = vi.fn(async (args) => ({ result: args.value.toUpperCase() }));

      const tool: ToolHandler = {
        name: 'transform',
        description: 'Transform value',
        schema: z.object({ value: z.string() }),
        handler,
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: randomUUID(),
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'transform',
          arguments: { value: 'hello' },
        },
      });

      expect(handler).toHaveBeenCalledWith({ value: 'hello' });

      const response = parseResponse();
      expect(response.result?.content).toHaveLength(1);
      const result = JSON.parse(response.result!.content![0].text);
      expect(result.result).toBe('HELLO');
    });

    it('should include correct duration_ms in audit entry', async () => {
      const dbPath = createTempDbPath();

      const tool: ToolHandler = {
        name: 'slow_tool',
        description: 'A slow tool',
        schema: z.object({}),
        handler: async () => {
          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { done: true };
        },
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: randomUUID(),
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow_tool', arguments: {} },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      // Duration should be at least 50ms but not more than a few seconds
      expect(entries[0].duration_ms).toBeGreaterThanOrEqual(40); // Allow some variance
      expect(entries[0].duration_ms).toBeLessThan(5000);
    });

    it('should handle null persona name', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const tool: ToolHandler = {
        name: 'test_tool',
        description: 'Test tool',
        schema: z.object({}),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
        // No auditPersonaName provided
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: {} },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].agent_id).toBeNull();
    });
  });

  describe('Error logging', () => {
    it('should log errors with event_type mcp_tool_error', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const tool: ToolHandler = {
        name: 'failing_tool',
        description: 'A tool that fails',
        schema: z.object({ value: z.string() }),
        handler: async () => {
          throw new Error('Tool execution failed');
        },
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'failing_tool',
          arguments: { value: 'test' },
        },
      });

      // Tool should still throw the error to the caller
      const response = parseResponse();
      const result = JSON.parse(response.result!.content![0].text);
      expect(result.error).toBe('Tool execution failed');

      // Verify error was logged
      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.session_id).toBe(sessionId);
      expect(entry.event_type).toBe('mcp_tool_error');
      expect(entry.event_category).toBe('mcp');

      const input = JSON.parse(entry.input);
      expect(input.tool).toBe('failing_tool');
      expect(input.args).toEqual({ value: 'test' });

      const error = JSON.parse(entry.error!);
      expect(error.message).toBe('Tool execution failed');
      expect(error.tool).toBe('failing_tool');

      expect(entry.output).toBeNull();
      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should handle non-Error thrown values', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const tool: ToolHandler = {
        name: 'string_throw_tool',
        description: 'Throws a string',
        schema: z.object({}),
        handler: async () => {
          throw 'String error message';
        },
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'string_throw_tool', arguments: {} },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.event_type).toBe('mcp_tool_error');

      const error = JSON.parse(entry.error!);
      expect(error.message).toBe('String error message');
    });

    it('should record duration even when tool fails', async () => {
      const dbPath = createTempDbPath();

      const tool: ToolHandler = {
        name: 'slow_fail_tool',
        description: 'Slow failing tool',
        schema: z.object({}),
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('Failed after delay');
        },
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: randomUUID(),
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow_fail_tool', arguments: {} },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      expect(entries[0].event_type).toBe('mcp_tool_error');
      expect(entries[0].duration_ms).toBeGreaterThanOrEqual(40);
    });
  });

  describe('Multiple tools', () => {
    it('should create separate audit entries for multiple tool calls', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const tool1: ToolHandler = {
        name: 'tool_one',
        description: 'First tool',
        schema: z.object({ a: z.string() }),
        handler: async (args) => ({ result: `one-${args.a}` }),
      };

      const tool2: ToolHandler = {
        name: 'tool_two',
        description: 'Second tool',
        schema: z.object({ b: z.number() }),
        handler: async (args) => ({ result: `two-${args.b}` }),
      };

      const server = createTestServer({
        tools: [tool1, tool2],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'tool_one',
          arguments: { a: 'test' },
        },
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'tool_two',
          arguments: { b: 42 },
        },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(2);

      // Verify first entry
      const entry1 = entries[0];
      expect(entry1.session_id).toBe(sessionId);
      expect(entry1.event_type).toBe('mcp_tool_call');

      const input1 = JSON.parse(entry1.input);
      expect(input1.tool).toBe('tool_one');
      expect(input1.args).toEqual({ a: 'test' });

      const output1 = JSON.parse(entry1.output!);
      expect(output1.result).toBe('one-test');

      // Verify second entry
      const entry2 = entries[1];
      expect(entry2.session_id).toBe(sessionId);
      expect(entry2.event_type).toBe('mcp_tool_call');

      const input2 = JSON.parse(entry2.input);
      expect(input2.tool).toBe('tool_two');
      expect(input2.args).toEqual({ b: 42 });

      const output2 = JSON.parse(entry2.output!);
      expect(output2.result).toBe('two-42');
    });

    it('should handle mix of successful and failed tool calls', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const successTool: ToolHandler = {
        name: 'success_tool',
        description: 'Success tool',
        schema: z.object({}),
        handler: async () => ({ success: true }),
      };

      const failTool: ToolHandler = {
        name: 'fail_tool',
        description: 'Fail tool',
        schema: z.object({}),
        handler: async () => {
          throw new Error('Intentional failure');
        },
      };

      const server = createTestServer({
        tools: [successTool, failTool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'success_tool', arguments: {} },
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fail_tool', arguments: {} },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(2);

      expect(entries[0].event_type).toBe('mcp_tool_call');
      expect(entries[0].output).not.toBeNull();
      expect(entries[0].error).toBeNull();

      expect(entries[1].event_type).toBe('mcp_tool_error');
      expect(entries[1].output).toBeNull();
      expect(entries[1].error).not.toBeNull();
    });
  });

  describe('Audit failure is non-fatal', () => {
    it('should continue returning tool results even if audit write fails', async () => {
      // Create a read-only DB path by using a non-existent directory that can't be created
      const readonlyPath = '/nonexistent-readonly-path/audit.db';

      const tool: ToolHandler = {
        name: 'test_tool',
        description: 'Test tool',
        schema: z.object({ value: z.string() }),
        handler: async (args) => ({ result: args.value }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: readonlyPath,
        auditSessionId: randomUUID(),
      });

      // Tool should still work despite audit failure
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_tool',
          arguments: { value: 'test-value' },
        },
      });

      const response = parseResponse();
      expect(response.result?.content).toHaveLength(1);
      const result = JSON.parse(response.result!.content![0].text);
      expect(result.result).toBe('test-value');

      // Should have logged the audit failure to stderr
      const stderrLog = stderrOutput.join('');
      expect(stderrLog).toContain('[audit] Failed to record tool call');
    });

    it('should log audit errors to stderr without throwing', async () => {
      const invalidPath = '/invalid/path/to/db.db';

      const tool: ToolHandler = {
        name: 'test_tool',
        description: 'Test tool',
        schema: z.object({}),
        handler: async () => {
          throw new Error('Tool error');
        },
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: invalidPath,
        auditSessionId: randomUUID(),
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: {} },
      });

      // Tool should have returned the error
      const response = parseResponse();
      const result = JSON.parse(response.result!.content![0].text);
      expect(result.error).toBe('Tool error');

      // Should have logged the audit failure to stderr
      const stderrLog = stderrOutput.join('');
      expect(stderrLog).toContain('[audit] Failed to record tool error');
    });
  });

  describe('Audit record format', () => {
    it('should include all required fields in audit entry', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();
      const personaName = 'test-persona';

      const tool: ToolHandler = {
        name: 'format_test',
        description: 'Format test',
        schema: z.object({ field: z.string() }),
        handler: async (args) => ({ processed: args.field }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
        auditPersonaName: personaName,
      });

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'format_test',
          arguments: { field: 'value' },
        },
      });

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(1);

      const entry = entries[0];

      // Verify all required fields are present
      expect(entry.id).toBeDefined();
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(entry.session_id).toBe(sessionId);
      expect(entry.agent_id).toBe(personaName);
      expect(entry.event_type).toBe('mcp_tool_call');
      expect(entry.event_category).toBe('mcp');
      expect(entry.input).toBeDefined();
      expect(entry.output).toBeDefined();
      expect(entry.error).toBeNull();
      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
      expect(entry.timestamp).toBeDefined();
      expect(entry.metadata).toBeDefined();

      // Verify JSON fields are valid
      expect(() => JSON.parse(entry.input)).not.toThrow();
      expect(() => JSON.parse(entry.output!)).not.toThrow();
      expect(() => JSON.parse(entry.metadata)).not.toThrow();

      // Verify metadata contains mcp_server
      const metadata = JSON.parse(entry.metadata);
      expect(metadata.mcp_server).toBe('test-server');
    });

    it('should use unique IDs for each audit entry', async () => {
      const dbPath = createTempDbPath();
      const sessionId = randomUUID();

      const tool: ToolHandler = {
        name: 'test_tool',
        description: 'Test tool',
        schema: z.object({}),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: sessionId,
      });

      // Call the same tool multiple times
      for (let i = 0; i < 5; i++) {
        await sendRequest(server, {
          jsonrpc: '2.0',
          id: i + 1,
          method: 'tools/call',
          params: { name: 'test_tool', arguments: {} },
        });
      }

      const entries = getAuditEntries(dbPath);
      expect(entries).toHaveLength(5);

      // Verify all IDs are unique
      const ids = entries.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });

    it('should include tool name and args in input JSON', async () => {
      const dbPath = createTempDbPath();

      const tool: ToolHandler = {
        name: 'complex_tool',
        description: 'Complex tool',
        schema: z.object({
          str: z.string(),
          num: z.number(),
          bool: z.boolean(),
          arr: z.array(z.string()),
          obj: z.object({ nested: z.string() }),
        }),
        handler: async () => ({ done: true }),
      };

      const server = createTestServer({
        tools: [tool],
        auditDbPath: dbPath,
        auditSessionId: randomUUID(),
      });

      const complexArgs = {
        str: 'test',
        num: 42,
        bool: true,
        arr: ['a', 'b', 'c'],
        obj: { nested: 'value' },
      };

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'complex_tool',
          arguments: complexArgs,
        },
      });

      const entries = getAuditEntries(dbPath);
      const input = JSON.parse(entries[0].input);

      expect(input.tool).toBe('complex_tool');
      expect(input.args).toEqual(complexArgs);
    });
  });
});
