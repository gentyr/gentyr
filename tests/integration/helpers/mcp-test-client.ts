/**
 * MCP Test Client
 *
 * Convenience wrapper around McpServer.processRequest() for integration tests.
 * Provides a clean API to call MCP tools programmatically without stdin/stdout.
 */

import type { McpServer } from '../../../packages/mcp-servers/src/shared/server.js';
import type { JsonRpcResponse, JsonRpcErrorResponse } from '../../../packages/mcp-servers/src/shared/types.js';

let _nextId = 1;

function nextId(): number {
  return _nextId++;
}

/** Thrown when an MCP tool call returns a JSON-RPC error */
export class McpToolError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

function isErrorResponse(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return 'error' in response;
}

/**
 * Wraps an McpServer instance for convenient programmatic tool calls.
 *
 * Usage:
 * ```ts
 * const server = createUserFeedbackServer({ db: testDb, projectDir: '/tmp/test' });
 * const client = new McpTestClient(server);
 * const persona = await client.callTool('create_persona', { name: 'tester', ... });
 * ```
 */
export class McpTestClient {
  constructor(private server: McpServer) {}

  /**
   * Call an MCP tool by name with arguments.
   * Returns the parsed tool result.
   * Throws McpToolError on JSON-RPC errors.
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await this.server.processRequest({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });

    if (!response) {
      throw new McpToolError(-1, `No response received for tool call: ${name}`);
    }

    if (isErrorResponse(response)) {
      throw new McpToolError(response.error.code, response.error.message);
    }

    // Extract the tool result from the MCP response envelope
    const result = response.result as { content: Array<{ type: string; text: string }> };
    if (!result?.content?.[0]?.text) {
      throw new McpToolError(-1, `Empty response from tool: ${name}`);
    }

    return JSON.parse(result.content[0].text) as T;
  }

  /**
   * Send an initialize request and return the server info.
   */
  async initialize(): Promise<unknown> {
    const response = await this.server.processRequest({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {},
    });

    if (!response || isErrorResponse(response)) {
      throw new McpToolError(-1, 'Initialize failed');
    }

    return response.result;
  }

  /**
   * List available tools on the server.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const response = await this.server.processRequest({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
      params: {},
    });

    if (!response || isErrorResponse(response)) {
      throw new McpToolError(-1, 'List tools failed');
    }

    const result = response.result as { tools: Array<{ name: string; description: string }> };
    return result.tools;
  }
}
