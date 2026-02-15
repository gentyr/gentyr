/**
 * Base MCP Server implementation
 *
 * Provides a reusable foundation for all MCP servers with:
 * - JSON-RPC 2.0 protocol handling
 * - MCP protocol methods (initialize, tools/list, tools/call)
 * - Error handling and logging
 * - Input validation with Zod (G003 compliance)
 */

import * as readline from 'readline';
import { z, type ZodSchema } from 'zod';
import {
  JsonRpcRequestSchema,
  McpToolCallParamsSchema,
  JSON_RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDefinition,
  type McpToolCallResult,
} from './types.js';

export interface ToolHandler<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  schema: ZodSchema<TArgs>;
  handler: (args: TArgs) => TResult | Promise<TResult>;
}

/**
 * Type alias for heterogeneous tool arrays.
 *
 * We use `any` here (not `unknown`) because each tool in the array has different
 * concrete types for TArgs and TResult. Using `unknown` breaks type inference
 * and causes compilation errors when assigning typed handlers to the array.
 *
 * This is a legitimate use of `any` for generic collection types where we need
 * to preserve type information at runtime but accept heterogeneous compile-time types.
 *
 * @see https://github.com/microsoft/TypeScript/issues/14520
 */
export type AnyToolHandler = ToolHandler<any, any>;

export interface McpServerOptions {
  name: string;
  version: string;
  tools: AnyToolHandler[];
}

/**
 * Convert a single Zod type to JSON Schema representation
 */
function zodTypeToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  // Handle optional wrapper
  if (schema instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(schema.unwrap());
  }

  // Handle common types
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: 'boolean' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  }

  if (schema instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodTypeToJsonSchema(schema.element),
      description: schema.description,
    };
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: schema.options,
      description: schema.description,
    };
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }

  // Fallback
  return { type: 'string', description: schema.description };
}

/**
 * Convert Zod schema to JSON Schema for MCP tool definitions.
 * Exported for use by MCP servers that don't extend McpServer.
 */
export function zodToJsonSchema(schema: ZodSchema): McpToolDefinition['inputSchema'] {
  // For object schemas, extract properties
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodSchema>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToJsonSchema(value);

      // Check if field is required (not optional)
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  // Fallback for non-object schemas
  return {
    type: 'object',
    properties: {},
  };
}

export class McpServer {
  private readonly name: string;
  private readonly version: string;
  private readonly tools: Map<string, AnyToolHandler>;
  private readonly toolDefinitions: McpToolDefinition[];

  constructor(options: McpServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.tools = new Map();
    this.toolDefinitions = [];

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
      this.toolDefinitions.push({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.schema),
      });
    }
  }

  /**
   * Create a success JSON-RPC response object
   */
  private createSuccessResponse(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * Create an error JSON-RPC response object
   */
  private createErrorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  /**
   * Write a JSON-RPC response to stdout (used by start() only)
   */
  private writeResponse(response: JsonRpcResponse): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  /**
   * Handle a JSON-RPC request and return the response.
   * Returns null for notification methods that don't produce a response.
   */
  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          return this.createSuccessResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          });

        case 'notifications/initialized':
          // No response needed for notifications
          return null;

        case 'tools/list':
          return this.createSuccessResponse(id, { tools: this.toolDefinitions });

        case 'tools/call':
          return await this.handleToolCall(id, params);

        default:
          return this.createErrorResponse(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.createErrorResponse(id, JSON_RPC_ERRORS.INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle a tool call and return the response
   */
  protected async handleToolCall(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    // Validate tool call params (G003)
    const parseResult = McpToolCallParamsSchema.safeParse(params);
    if (!parseResult.success) {
      return this.createErrorResponse(id, JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid tool call params: ${parseResult.error.message}`);
    }

    const { name, arguments: args } = parseResult.data;
    const tool = this.tools.get(name);

    if (!tool) {
      return this.createErrorResponse(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    }

    // Validate tool arguments with Zod (G003)
    const argsParseResult = tool.schema.safeParse(args ?? {});
    if (!argsParseResult.success) {
      const result: McpToolCallResult = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Invalid arguments: ${argsParseResult.error.message}`,
          }, null, 2),
        }],
      };
      return this.createSuccessResponse(id, result);
    }

    try {
      const toolResult = await tool.handler(argsParseResult.data);
      const result: McpToolCallResult = {
        content: [{
          type: 'text',
          text: JSON.stringify(toolResult, null, 2),
        }],
      };
      return this.createSuccessResponse(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: McpToolCallResult = {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: message }, null, 2),
        }],
      };
      return this.createSuccessResponse(id, result);
    }
  }

  /**
   * Process a JSON-RPC request programmatically and return the response.
   *
   * Unlike `start()` which reads from stdin and writes to stdout, this method
   * accepts a request object and returns the response directly. Used for testing
   * MCP servers without stdio.
   *
   * Thread-safe: no instance-level mutable state is used during request processing.
   *
   * Returns null for notification methods (e.g., notifications/initialized)
   * that don't produce a response.
   */
  public async processRequest(request: unknown): Promise<JsonRpcResponse | null> {
    // Validate JSON-RPC request
    const parseResult = JsonRpcRequestSchema.safeParse(request);
    if (!parseResult.success) {
      const partial = request as { id?: unknown };
      const id = (partial && typeof partial.id !== 'undefined')
        ? (partial.id as string | number | null)
        : null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: `Invalid request: ${parseResult.error.message}` },
      };
    }

    return this.handleRequest(parseResult.data);
  }

  /**
   * Start the server and listen for JSON-RPC requests on stdin
   */
  public start(): void {
    process.stderr.write(`${this.name} MCP Server v${this.version} running\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', async (line) => {
      // Skip empty lines
      if (!line.trim()) { return; }

      // Parse JSON first
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (jsonErr) {
        // G001: Log parse errors
        const message = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
        process.stderr.write(`[mcp-server] JSON parse error: ${message}\n`);
        this.writeResponse(this.createErrorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error'));
        return;
      }

      // Validate JSON-RPC request (G003)
      const parseResult = JsonRpcRequestSchema.safeParse(parsed);

      if (!parseResult.success) {
        // Try to extract ID for error response
        const partial = parsed as { id?: unknown };
        if (partial && typeof partial.id !== 'undefined') {
          this.writeResponse(this.createErrorResponse(
            partial.id as string | number | null,
            JSON_RPC_ERRORS.PARSE_ERROR,
            `Invalid request: ${parseResult.error.message}`
          ));
          return;
        }
        this.writeResponse(this.createErrorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Invalid request'));
        return;
      }

      const response = await this.handleRequest(parseResult.data);
      if (response) {
        this.writeResponse(response);
      }
    });

    rl.on('close', () => {
      process.exit(0);
    });

    // Handle process signals
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
}
