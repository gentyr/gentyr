/**
 * Types for the Programmatic Feedback MCP Server
 *
 * Provides CLI, API, and SDK interaction tools that let AI feedback agents
 * test applications programmatically from a real user's perspective.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const FEEDBACK_MODES = ['cli', 'api', 'sdk', 'all'] as const;
export type FeedbackMode = (typeof FEEDBACK_MODES)[number];

// ============================================================================
// CLI Tool Schemas (G003 Compliance)
// ============================================================================

export const CliRunArgsSchema = z.object({
  args: z.array(z.string()).describe('Command-line arguments to pass to the CLI'),
  timeout: z.coerce.number().min(1000).max(300000).optional().default(30000)
    .describe('Timeout in milliseconds (default: 30000ms, max: 300000ms)'),
});

export const CliRunInteractiveArgsSchema = z.object({
  args: z.array(z.string()).describe('Command-line arguments to pass to the CLI'),
  input_lines: z.array(z.string()).max(100)
    .describe('Lines of input to send to stdin (for interactive CLI sessions)'),
  timeout: z.coerce.number().min(1000).max(300000).optional().default(30000)
    .describe('Timeout in milliseconds (default: 30000ms, max: 300000ms)'),
});

// ============================================================================
// API Tool Schemas
// ============================================================================

/**
 * Preprocess values that may arrive as JSON strings (e.g. from Sonnet)
 * into parsed objects before Zod validation.
 */
const jsonStringToObject = (val: unknown) => {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
};

export const ApiRequestArgsSchema = z.object({
  method: z.enum(HTTP_METHODS).describe('HTTP method'),
  path: z.string().max(2000)
    .describe('Request path (prepended with FEEDBACK_API_BASE_URL, must stay within base URL)'),
  body: z.preprocess(jsonStringToObject, z.record(z.unknown()).optional())
    .describe('Request body (JSON object or JSON string)'),
  headers: z.preprocess(jsonStringToObject, z.record(z.string()).optional())
    .describe('Additional request headers (object or JSON string)'),
  timeout: z.coerce.number().min(1000).max(300000).optional().default(30000)
    .describe('Timeout in milliseconds (default: 30000ms, max: 300000ms)'),
});

export const ApiGraphqlArgsSchema = z.object({
  query: z.string().max(50000)
    .describe('GraphQL query or mutation'),
  variables: z.preprocess(jsonStringToObject, z.record(z.unknown()).optional())
    .describe('GraphQL variables (object or JSON string)'),
  headers: z.preprocess(jsonStringToObject, z.record(z.string()).optional())
    .describe('Additional request headers (object or JSON string)'),
  timeout: z.coerce.number().min(1000).max(300000).optional().default(30000)
    .describe('Timeout in milliseconds (default: 30000ms, max: 300000ms)'),
});

// ============================================================================
// SDK Tool Schemas
// ============================================================================

export const SdkEvalArgsSchema = z.object({
  code: z.string().max(100000)
    .describe('JavaScript/TypeScript code snippet to execute in sandboxed environment'),
  timeout: z.coerce.number().min(1000).max(60000).optional().default(10000)
    .describe('Timeout in milliseconds (default: 10000ms, max: 60000ms)'),
});

export const SdkListExportsArgsSchema = z.object({
  package_name: z.string().max(200).optional()
    .describe('Package name to list exports from (defaults to first configured SDK package)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type CliRunArgs = z.infer<typeof CliRunArgsSchema>;
export type CliRunInteractiveArgs = z.infer<typeof CliRunInteractiveArgsSchema>;
export type ApiRequestArgs = z.infer<typeof ApiRequestArgsSchema>;
export type ApiGraphqlArgs = z.infer<typeof ApiGraphqlArgsSchema>;
export type SdkEvalArgs = z.infer<typeof SdkEvalArgsSchema>;
export type SdkListExportsArgs = z.infer<typeof SdkListExportsArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface CliRunInteractiveResult {
  output: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface ApiRequestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timedOut?: boolean;
}

export interface ApiGraphqlResult {
  data: unknown;
  errors?: unknown[];
  timedOut?: boolean;
}

export interface SdkEvalResult {
  result: string;
  logs: string[];
  timedOut?: boolean;
}

export interface SdkListExportsResult {
  package_name: string;
  exports: string[];
}
