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
   * Send a JSON-RPC response to stdout
   */
  private sendResponse(response: JsonRpcResponse): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  /**
   * Send a success response
   */
  private sendSuccess(id: string | number | null, result: unknown): void {
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Send an error response
   */
  private sendError(id: string | number | null, code: number, message: string): void {
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  /**
   * Handle a JSON-RPC request
   */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          this.sendSuccess(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          });
          break;

        case 'notifications/initialized':
          // No response needed for notifications
          break;

        case 'tools/list':
          this.sendSuccess(id, { tools: this.toolDefinitions });
          break;

        case 'tools/call':
          await this.handleToolCall(id, params);
          break;

        default:
          this.sendError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle a tool call
   */
  protected async handleToolCall(id: string | number | null, params: unknown): Promise<void> {
    // Validate tool call params (G003)
    const parseResult = McpToolCallParamsSchema.safeParse(params);
    if (!parseResult.success) {
      this.sendError(id, JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid tool call params: ${parseResult.error.message}`);
      return;
    }

    const { name, arguments: args } = parseResult.data;
    const tool = this.tools.get(name);

    if (!tool) {
      this.sendError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      return;
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
      this.sendSuccess(id, result);
      return;
    }

    try {
      const toolResult = await tool.handler(argsParseResult.data);
      const result: McpToolCallResult = {
        content: [{
          type: 'text',
          text: JSON.stringify(toolResult, null, 2),
        }],
      };
      this.sendSuccess(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: McpToolCallResult = {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: message }, null, 2),
        }],
      };
      this.sendSuccess(id, result);
    }
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
        this.sendError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error');
        return;
      }

      // Validate JSON-RPC request (G003)
      const parseResult = JsonRpcRequestSchema.safeParse(parsed);

      if (!parseResult.success) {
        // Try to extract ID for error response
        const partial = parsed as { id?: unknown };
        if (partial && typeof partial.id !== 'undefined') {
          this.sendError(
            partial.id as string | number | null,
            JSON_RPC_ERRORS.PARSE_ERROR,
            `Invalid request: ${parseResult.error.message}`
          );
          return;
        }
        this.sendError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Invalid request');
        return;
      }

      await this.handleRequest(parseResult.data);
    });

    rl.on('close', () => {
      process.exit(0);
    });

    // Handle process signals
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
}
