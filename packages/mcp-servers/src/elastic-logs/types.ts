/**
 * Elastic Logs MCP Server Types
 *
 * Type definitions for querying logs from Elasticsearch.
 */

import { z } from 'zod';

// ============================================================================
// Tool Argument Schemas
// ============================================================================

/**
 * Arguments for querying logs
 *
 * Uses Lucene query syntax for powerful log filtering.
 */
export const QueryLogsArgsSchema = z.object({
  query: z.string().describe('Lucene query string (e.g., "level:error AND service:my-backend")'),
  from: z.string().optional().describe('Start time (ISO8601 or relative like "now-1h", default: "now-1h")'),
  to: z.string().optional().describe('End time (ISO8601 or "now", default: "now")'),
  size: z.coerce.number().optional().describe('Maximum number of results (default: 100, max: 1000)'),
  sort: z.enum(['asc', 'desc']).optional().describe('Sort order by timestamp (default: "desc")'),
});

export type QueryLogsArgs = z.infer<typeof QueryLogsArgsSchema>;

/**
 * Arguments for getting log statistics
 */
export const GetLogStatsArgsSchema = z.object({
  query: z.string().optional().describe('Lucene query string to filter logs (default: "*")'),
  from: z.string().optional().describe('Start time (default: "now-24h")'),
  to: z.string().optional().describe('End time (default: "now")'),
  groupBy: z.enum(['level', 'service', 'module']).optional().describe('Field to group by (default: "level")'),
});

export type GetLogStatsArgs = z.infer<typeof GetLogStatsArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

/**
 * Log entry returned from Elasticsearch
 */
export interface LogEntry {
  '@timestamp': string;
  timestamp?: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  message: string;
  requestId?: string;
  userId?: string;
  customerId?: string;
  vendorId?: string;
  module?: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Result from query_logs tool
 */
export interface QueryLogsResult {
  logs: LogEntry[];
  total: number;
  took: number; // Query execution time in ms
  from: string;
  to: string;
}

/**
 * Statistics for a group
 */
export interface LogStatGroup {
  key: string;
  count: number;
}

/**
 * Result from get_log_stats tool
 */
export interface GetLogStatsResult {
  total: number;
  groups: LogStatGroup[];
  from: string;
  to: string;
  groupBy: string;
}

/**
 * Error result
 */
export interface ErrorResult {
  error: string;
  hint?: string;
}
