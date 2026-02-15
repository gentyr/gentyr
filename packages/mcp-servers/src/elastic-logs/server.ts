#!/usr/bin/env node
/**
 * Elastic Logs MCP Server
 *
 * Provides Claude Code with programmatic access to Elasticsearch logs.
 * Enables powerful log querying using Lucene query syntax.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Security:
 * - Uses read-only Elasticsearch API key (stored in 1Password)
 * - No write, delete, or admin permissions
 * - Rate limits handled by Elasticsearch (capacity-based)
 *
 * @version 1.0.0
 */

import { Client } from '@elastic/elasticsearch';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  QueryLogsArgsSchema,
  GetLogStatsArgsSchema,
  type QueryLogsArgs,
  type GetLogStatsArgs,
  type QueryLogsResult,
  type GetLogStatsResult,
  type ErrorResult,
  type LogEntry,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const {ELASTIC_CLOUD_ID} = process.env;
const {ELASTIC_ENDPOINT} = process.env; // Direct endpoint URL (Serverless projects)
const {ELASTIC_API_KEY} = process.env; // Read-only key

if (!ELASTIC_API_KEY) {
  throw new Error(
    'Missing ELASTIC_API_KEY. Required for Elasticsearch authentication.'
  );
}

if (!ELASTIC_CLOUD_ID && !ELASTIC_ENDPOINT) {
  throw new Error(
    'Missing Elasticsearch connection. Required: ELASTIC_CLOUD_ID (hosted) or ELASTIC_ENDPOINT (Serverless)'
  );
}

// Initialize Elasticsearch client — supports both hosted (Cloud ID) and Serverless (endpoint URL)
const client = new Client({
  ...(ELASTIC_CLOUD_ID
    ? { cloud: { id: ELASTIC_CLOUD_ID } }
    : { node: ELASTIC_ENDPOINT }),
  auth: {
    apiKey: ELASTIC_API_KEY,
  },
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize time string to Elasticsearch format
 *
 * Supports:
 * - ISO8601: "2026-02-08T10:00:00.000Z"
 * - Relative: "now-1h", "now-24h", "now-7d"
 * - "now" (current time)
 */
function normalizeTime(time: string | undefined, defaultValue: string): string {
  if (!time) {
    return defaultValue;
  }

  // If it starts with "now", return as-is (Elasticsearch understands it)
  if (time.startsWith('now')) {
    return time;
  }

  // If it's ISO8601, validate and return
  const date = new Date(time);
  if (!isNaN(date.getTime())) {
    return date.toISOString();
  }

  // Fallback to default
  return defaultValue;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Query logs from Elasticsearch
 *
 * Examples:
 * - query: "level:error" - All errors
 * - query: "level:error AND service:my-backend" - Backend API errors only
 * - query: "status:500" - All 500 errors
 * - query: "userId:usr_123" - Logs for specific user
 * - query: "duration:>1000" - Slow requests (>1s)
 */
async function queryLogs(args: QueryLogsArgs): Promise<QueryLogsResult | ErrorResult> {
  try {
    const {
      query,
      from = 'now-1h',
      to = 'now',
      size = 100,
      sort = 'desc',
    } = args;

    // Limit size to prevent excessive memory usage
    const maxSize = Math.min(size, 1000);

    // Normalize time range
    const fromTime = normalizeTime(from, 'now-1h');
    const toTime = normalizeTime(to, 'now');

    // Execute search
    const result = await client.search({
      index: 'logs-*',
      body: {
        query: {
          bool: {
            must: [
              {
                query_string: {
                  query: query || '*',
                },
              },
              {
                range: {
                  '@timestamp': {
                    gte: fromTime,
                    lte: toTime,
                  },
                },
              },
            ],
          },
        },
        size: maxSize,
        sort: [
          {
            '@timestamp': {
              order: sort,
            },
          },
        ],
      },
    });

    // Extract log entries
    const logs: LogEntry[] = result.hits.hits.map((hit) => hit._source as LogEntry);

    return {
      logs,
      total: typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0,
      took: result.took,
      from: fromTime,
      to: toTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `Failed to query logs: ${message}`,
      hint: 'Check Elasticsearch connection and query syntax',
    };
  }
}

/**
 * Get log statistics (aggregated counts)
 *
 * Examples:
 * - groupBy: "level" - Count by log level (debug, info, warn, error)
 * - groupBy: "service" - Count by service (e.g., my-backend, my-frontend)
 * - groupBy: "module" - Count by module
 */
async function getLogStats(args: GetLogStatsArgs): Promise<GetLogStatsResult | ErrorResult> {
  try {
    const {
      query = '*',
      from = 'now-24h',
      to = 'now',
      groupBy = 'level',
    } = args;

    // Normalize time range
    const fromTime = normalizeTime(from, 'now-24h');
    const toTime = normalizeTime(to, 'now');

    // Execute aggregation query
    const result = await client.search({
      index: 'logs-*',
      body: {
        query: {
          bool: {
            must: [
              {
                query_string: {
                  query,
                },
              },
              {
                range: {
                  '@timestamp': {
                    gte: fromTime,
                    lte: toTime,
                  },
                },
              },
            ],
          },
        },
        size: 0, // Don't return documents, just aggregations
        aggs: {
          by_group: {
            terms: {
              field: `${groupBy}.keyword`, // Use .keyword for exact match
              size: 100,
            },
          },
        },
      },
    });

    // Extract aggregation results
    const buckets = (result.aggregations?.by_group as { buckets?: Array<{ key: string; doc_count: number }> })?.buckets || [];
    const groups = buckets.map((bucket) => ({
      key: bucket.key,
      count: bucket.doc_count,
    }));

    return {
      total: typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0,
      groups,
      from: fromTime,
      to: toTime,
      groupBy,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `Failed to get log stats: ${message}`,
      hint: 'Check Elasticsearch connection and query syntax',
    };
  }
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'query_logs',
    description: `Query logs from Elasticsearch using Lucene query syntax.

Examples:
- "level:error" - All error logs
- "level:error AND service:my-backend" - Backend API errors only
- "status:500 AND path:/api/customers" - 500 errors on customer endpoint
- "userId:usr_123" - Logs for specific user
- "duration:>1000" - Slow requests (>1 second)
- "requestId:abc-123" - All logs for a specific request

Time ranges:
- from: "now-1h" (last hour), "now-24h" (last day), "now-7d" (last week)
- to: "now" (current time), "2026-02-08T10:00:00.000Z" (specific time)

Returns up to 1000 logs, sorted by timestamp (newest first by default).`,
    schema: QueryLogsArgsSchema,
    handler: queryLogs,
  },
  {
    name: 'get_log_stats',
    description: `Get aggregated log statistics.

Groups logs by:
- "level" - Count by log level (debug, info, warn, error)
- "service" - Count by service (e.g., my-backend, my-frontend)
- "module" - Count by module/component

Useful for:
- Understanding error patterns
- Identifying noisy components
- Monitoring service health

Example: Find which service has the most errors in the last 24 hours.`,
    schema: GetLogStatsArgsSchema,
    handler: getLogStats,
  },
];

const server = new McpServer({
  name: 'elastic-logs',
  version: '1.0.0',
  tools,
});

server.start();
