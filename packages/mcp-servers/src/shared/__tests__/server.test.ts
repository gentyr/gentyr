/**
 * Unit tests for Base MCP Server
 *
 * Tests JSON-RPC 2.0 protocol handling, MCP methods, error handling,
 * input validation (G003), and Zod schema conversion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { McpServer, type AnyToolHandler, type ToolHandler } from '../server.js';
import { JSON_RPC_ERRORS } from '../types.js';

interface TestServer {
  handleRequest: (request: unknown) => Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

describe('McpServer', () => {
  // Mock stdout.write to capture responses
  let mockOutput: string[] = [];
  let mockStdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockOutput = [];
    mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      mockOutput.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    mockStdoutWrite.mockRestore();
  });

  const createTestServer = (tools: AnyToolHandler[] = []) => {
    return new McpServer({
      name: 'test-server',
      version: '1.0.0',
      tools,
    });
  };

  const sendRequest = async (server: McpServer, request: unknown) => {
    // Access private method via type assertion
    const serverAny = server as unknown as TestServer;
    const parsed = JSON.parse(JSON.stringify(request)) as unknown;
    await serverAny.handleRequest(parsed);
  };

  const getLastResponse = (): JsonRpcResponse => {
    const lastOutput = mockOutput[mockOutput.length - 1];
    return JSON.parse(lastOutput) as JsonRpcResponse;
  };

  describe('Initialization', () => {
    it('should create server with name and version', () => {
      const server = createTestServer();
      expect(server).toBeDefined();
    });

    it('should register tools correctly', () => {
      const testTool: ToolHandler = {
        name: 'test_tool',
        description: 'A test tool',
        schema: z.object({ value: z.string() }),
        handler: async (args) => ({ result: args.value }),
      };

      const server = createTestServer([testTool]);
      expect(server).toBeDefined();
    });
  });

  describe('MCP Protocol - initialize', () => {
    it('should respond to initialize request', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });

      const response = getLastResponse();
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.0.0' },
      });
    });

    it('should include protocol version in initialize response', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
      });

      const response = getLastResponse();
      expect(response.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('MCP Protocol - tools/list', () => {
    it('should return empty tools list when no tools registered', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const response = getLastResponse();
      expect(response.result).toEqual({ tools: [] });
    });

    it('should return all registered tools', async () => {
      const tool1: ToolHandler = {
        name: 'tool_one',
        description: 'First tool',
        schema: z.object({ a: z.string() }),
        handler: async () => ({}),
      };

      const tool2: ToolHandler = {
        name: 'tool_two',
        description: 'Second tool',
        schema: z.object({ b: z.number() }),
        handler: async () => ({}),
      };

      const server = createTestServer([tool1, tool2]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });

      const response = getLastResponse();
      expect(response.result.tools).toHaveLength(2);
      expect(response.result.tools[0].name).toBe('tool_one');
      expect(response.result.tools[1].name).toBe('tool_two');
    });

    it('should convert Zod schemas to JSON Schema format', async () => {
      const tool: ToolHandler = {
        name: 'test_schema',
        description: 'Schema conversion test',
        schema: z.object({
          stringField: z.string(),
          numberField: z.number(),
          boolField: z.boolean(),
          optionalField: z.string().optional(),
        }),
        handler: async () => ({}),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
      });

      const response = getLastResponse();
      const {inputSchema} = response.result.tools[0];

      expect(inputSchema.type).toBe('object');
      expect(inputSchema.properties.stringField).toEqual({ type: 'string' });
      expect(inputSchema.properties.numberField).toEqual({ type: 'number' });
      expect(inputSchema.properties.boolField).toEqual({ type: 'boolean' });
      expect(inputSchema.required).toContain('stringField');
      expect(inputSchema.required).not.toContain('optionalField');
    });

    it('should handle array schemas', async () => {
      const tool: ToolHandler = {
        name: 'array_test',
        description: 'Array schema test',
        schema: z.object({
          items: z.array(z.string()),
        }),
        handler: async () => ({}),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
      });

      const response = getLastResponse();
      const itemsSchema = response.result.tools[0].inputSchema.properties.items;

      expect(itemsSchema.type).toBe('array');
      expect(itemsSchema.items).toEqual({ type: 'string' });
    });

    it('should handle enum schemas', async () => {
      const tool: ToolHandler = {
        name: 'enum_test',
        description: 'Enum schema test',
        schema: z.object({
          status: z.enum(['pending', 'active', 'completed']),
        }),
        handler: async () => ({}),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/list',
      });

      const response = getLastResponse();
      const statusSchema = response.result.tools[0].inputSchema.properties.status;

      expect(statusSchema.type).toBe('string');
      expect(statusSchema.enum).toEqual(['pending', 'active', 'completed']);
    });

    it('should handle default values', async () => {
      const tool: ToolHandler = {
        name: 'default_test',
        description: 'Default value test',
        schema: z.object({
          limit: z.number().default(50),
        }),
        handler: async () => ({}),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
      });

      const response = getLastResponse();
      const limitSchema = response.result.tools[0].inputSchema.properties.limit;

      expect(limitSchema.default).toBe(50);
    });
  });

  describe('MCP Protocol - tools/call', () => {
    it('should execute tool with valid arguments', async () => {
      const handler = vi.fn(async (args) => ({ result: args.value.toUpperCase() }));
      const tool: ToolHandler = {
        name: 'transform',
        description: 'Transform value',
        schema: z.object({ value: z.string() }),
        handler,
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'transform',
          arguments: { value: 'hello' },
        },
      });

      expect(handler).toHaveBeenCalledWith({ value: 'hello' });

      const response = getLastResponse();
      expect(response.result.content).toHaveLength(1);
      expect(response.result.content[0].type).toBe('text');
      const result = JSON.parse(response.result.content[0].text);
      expect(result.result).toBe('HELLO');
    });

    it('should validate tool arguments with Zod (G003)', async () => {
      const tool: ToolHandler = {
        name: 'validate_test',
        description: 'Validation test',
        schema: z.object({
          requiredField: z.string(),
          numberField: z.number(),
        }),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'validate_test',
          arguments: { requiredField: 'test' }, // Missing numberField
        },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toContain('Invalid arguments');
    });

    it('should return error for unknown tool', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'unknown_tool',
          arguments: {},
        },
      });

      const response = getLastResponse();
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      expect(response.error.message).toContain('Unknown tool');
    });

    it('should handle tool errors gracefully', async () => {
      const tool: ToolHandler = {
        name: 'failing_tool',
        description: 'A tool that fails',
        schema: z.object({}),
        handler: async () => {
          throw new Error('Tool execution failed');
        },
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'failing_tool',
          arguments: {},
        },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toBe('Tool execution failed');
    });

    it('should validate tool call params structure (G003)', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { invalid: 'structure' }, // Missing 'name' field
      });

      const response = getLastResponse();
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      expect(response.error.message).toContain('Invalid tool call params');
    });

    it('should handle missing arguments as empty object', async () => {
      const handler = vi.fn(async (args) => ({ args }));
      const tool: ToolHandler = {
        name: 'optional_args',
        description: 'Tool with optional args',
        schema: z.object({ value: z.string().optional() }),
        handler,
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'optional_args' }, // No arguments field
      });

      expect(handler).toHaveBeenCalledWith({});
    });
  });

  describe('MCP Protocol - notifications', () => {
    it('should handle notifications/initialized without response', async () => {
      const server = createTestServer();
      mockOutput = [];

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: null,
        method: 'notifications/initialized',
      });

      // Notifications should not produce a response
      expect(mockOutput).toHaveLength(0);
    });
  });

  describe('JSON-RPC Error Handling', () => {
    it('should return error for unknown method', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 14,
        method: 'unknown/method',
      });

      const response = getLastResponse();
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      expect(response.error.message).toContain('Unknown method');
    });

    it('should handle internal errors', async () => {
      const tool: ToolHandler = {
        name: 'error_tool',
        description: 'Tool that throws',
        schema: z.object({}),
        handler: async () => {
          throw new Error('Internal error');
        },
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'error_tool', arguments: {} },
      });

      const response = getLastResponse();
      // Tool errors should be returned in result.content, not as JSON-RPC errors
      expect(response.result).toBeDefined();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toBe('Internal error');
    });
  });

  describe('Input Validation (G003 Compliance)', () => {
    it('should validate all string fields', async () => {
      const tool: ToolHandler = {
        name: 'string_validation',
        description: 'String validation test',
        schema: z.object({
          email: z.string().email(),
          url: z.string().url(),
        }),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'string_validation',
          arguments: {
            email: 'invalid-email',
            url: 'not-a-url',
          },
        },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toContain('Invalid arguments');
    });

    it('should validate number constraints', async () => {
      const tool: ToolHandler = {
        name: 'number_validation',
        description: 'Number validation test',
        schema: z.object({
          age: z.number().min(0).max(150),
        }),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'number_validation',
          arguments: { age: 200 },
        },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toContain('Invalid arguments');
    });

    it('should reject type mismatches', async () => {
      const tool: ToolHandler = {
        name: 'type_check',
        description: 'Type checking test',
        schema: z.object({
          count: z.number(),
        }),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: 'type_check',
          arguments: { count: 'not-a-number' },
        },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result.error).toContain('Invalid arguments');
    });
  });

  describe('Response Format', () => {
    it('should format successful tool results correctly', async () => {
      const tool: ToolHandler = {
        name: 'format_test',
        description: 'Format test',
        schema: z.object({}),
        handler: async () => ({ data: 'test', status: 'ok' }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 19,
        method: 'tools/call',
        params: { name: 'format_test', arguments: {} },
      });

      const response = getLastResponse();
      expect(response.result.content).toHaveLength(1);
      expect(response.result.content[0].type).toBe('text');

      const result = JSON.parse(response.result.content[0].text);
      expect(result).toEqual({ data: 'test', status: 'ok' });
    });

    it('should format tool result as JSON with pretty printing', async () => {
      const tool: ToolHandler = {
        name: 'pretty_test',
        description: 'Pretty print test',
        schema: z.object({}),
        handler: async () => ({
          nested: { object: { value: 123 } },
        }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'pretty_test', arguments: {} },
      });

      const response = getLastResponse();
      const {text} = response.result.content[0];

      // Should be formatted with 2-space indentation
      expect(text).toContain('\n');
      expect(text).toContain('  ');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null id in requests', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: null,
        method: 'initialize',
      });

      const response = getLastResponse();
      expect(response.id).toBe(null);
    });

    it('should handle numeric id', async () => {
      const server = createTestServer();

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 12345,
        method: 'initialize',
      });

      const response = getLastResponse();
      expect(response.id).toBe(12345);
    });

    it('should handle tool returning null', async () => {
      const tool: ToolHandler = {
        name: 'null_return',
        description: 'Returns null',
        schema: z.object({}),
        handler: async () => null,
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'null_return', arguments: {} },
      });

      const response = getLastResponse();
      const result = JSON.parse(response.result.content[0].text);
      expect(result).toBe(null);
    });

    it('should handle tool returning undefined', async () => {
      const tool: ToolHandler = {
        name: 'undefined_return',
        description: 'Returns undefined',
        schema: z.object({}),
        handler: async () => undefined,
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'undefined_return', arguments: {} },
      });

      const response = getLastResponse();
      // JSON.stringify(undefined) returns undefined (not a string)
      // The server may handle this differently
      expect(response.result).toBeDefined();
      expect(response.result.content).toBeDefined();
    });

    it('should handle empty schema object', async () => {
      const tool: ToolHandler = {
        name: 'empty_schema',
        description: 'Empty schema test',
        schema: z.object({}),
        handler: async () => ({ success: true }),
      };

      const server = createTestServer([tool]);

      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/list',
      });

      const response = getLastResponse();
      const {inputSchema} = response.result.tools[0];
      expect(inputSchema.type).toBe('object');
      expect(inputSchema.properties).toEqual({});
    });
  });
});
