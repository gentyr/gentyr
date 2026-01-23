/**
 * Shared types for MCP servers
 *
 * These types define the JSON-RPC 2.0 and MCP protocol interfaces
 * used by all MCP servers in this package.
 */

import { z } from 'zod';

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC error codes
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000, // For application-specific errors
} as const;

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

// ============================================================================
// Zod Schemas for Request Validation (G003 Compliance)
// ============================================================================

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export const McpToolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

// ============================================================================
// Server Configuration
// ============================================================================

export interface ServerConfig {
  name: string;
  version: string;
  tools: McpToolDefinition[];
}

// ============================================================================
// Common Result Types
// ============================================================================

export interface SuccessResult<T> {
  success: true;
  data: T;
}

export interface ErrorResult {
  success: false;
  error: string;
  code?: string;
}

export type Result<T> = SuccessResult<T> | ErrorResult;

export function success<T>(data: T): SuccessResult<T> {
  return { success: true, data };
}

export function error(message: string, code?: string): ErrorResult {
  return { success: false, error: message, code };
}
