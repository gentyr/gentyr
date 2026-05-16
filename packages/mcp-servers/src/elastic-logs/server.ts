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
import { loadServicesConfig } from '../shared/op-secrets.js';
import {
  QueryLogsArgsSchema,
  GetLogStatsArgsSchema,
  VerifyLoggingConfigArgsSchema,
  type QueryLogsArgs,
  type GetLogStatsArgs,
  type QueryLogsResult,
  type GetLogStatsResult,
  type ErrorResult,
  type LogEntry,
  type VerifyLoggingConfigResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

// Lazy-initialized Elasticsearch client (deferred so server starts without credentials)
let _client: Client | null = null;

/**
 * Get the Elasticsearch client, initializing on first use.
 * G001: Fail-closed on missing credentials (checked at invocation time for tool discoverability).
 */
function getClient(): Client {
  if (_client) return _client;

  const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;
  const ELASTIC_CLOUD_ID = process.env.ELASTIC_CLOUD_ID;
  const ELASTIC_ENDPOINT = process.env.ELASTIC_ENDPOINT;

  if (!ELASTIC_API_KEY) {
    throw new Error(
      'Missing ELASTIC_API_KEY. Required for Elasticsearch authentication. Ensure 1Password credentials are configured.'
    );
  }

  if (!ELASTIC_CLOUD_ID && !ELASTIC_ENDPOINT) {
    throw new Error(
      'Missing Elasticsearch connection. Required: ELASTIC_CLOUD_ID (hosted) or ELASTIC_ENDPOINT (Serverless). Ensure 1Password credentials are configured.'
    );
  }

  _client = new Client({
    ...(ELASTIC_CLOUD_ID
      ? { cloud: { id: ELASTIC_CLOUD_ID } }
      : { node: ELASTIC_ENDPOINT }),
    auth: {
      apiKey: ELASTIC_API_KEY,
    },
  });

  return _client;
}

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
    const result = await getClient().search({
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
    const result = await getClient().search({
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
// Logging Config Verification
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function hasKey(obj: Record<string, unknown> | undefined, key: string): boolean {
  // Only checks key presence — never accesses secret values
  return !!obj && typeof obj === 'object' && key in obj;
}

async function verifyLoggingConfig(): Promise<VerifyLoggingConfigResult | ErrorResult> {
  let config;
  try {
    config = loadServicesConfig(PROJECT_DIR);
  } catch (err) {
    return { error: `Failed to read services.json: ${err instanceof Error ? err.message : String(err)}`, hint: 'Ensure .claude/config/services.json exists and is valid JSON' };
  }

  const recommendations: string[] = [];

  // Check elastic section (Zod-validated by loadServicesConfig)
  const elastic = config.elastic;
  const elasticConfigured = !!elastic;
  const elasticEnabled = elastic?.enabled !== false;
  const indexPrefix = elastic?.indexPrefix || 'logs';

  if (!elasticConfigured) {
    recommendations.push('Add elastic section to services.json: mcp__secret-sync__update_services_config({ updates: { elastic: { apiKey: "op://Production/Elastic/api-key", cloudId: "op://Production/Elastic/cloud-id", enabled: true } } })');
  }

  // Check secrets.local (key presence only — values are op:// refs, not raw secrets)
  const localSecrets = config.secrets?.local;
  const hasLocalApiKey = hasKey(localSecrets, 'ELASTIC_API_KEY');
  const hasLocalCloudId = hasKey(localSecrets, 'ELASTIC_CLOUD_ID') || hasKey(localSecrets, 'ELASTIC_ENDPOINT');

  if (!hasLocalApiKey || !hasLocalCloudId) {
    recommendations.push('Add Elastic credentials to secrets.local: mcp__secret-sync__populate_secrets_local({ entries: { ELASTIC_API_KEY: "op://...", ELASTIC_CLOUD_ID: "op://..." } })');
  }

  // Check deployment secret sections (key presence only)
  const hasRenderProd = hasKey(config.secrets?.renderProduction, 'ELASTIC_API_KEY') && (hasKey(config.secrets?.renderProduction, 'ELASTIC_CLOUD_ID') || hasKey(config.secrets?.renderProduction, 'ELASTIC_ENDPOINT'));
  const hasRenderStag = hasKey(config.secrets?.renderStaging, 'ELASTIC_API_KEY') && (hasKey(config.secrets?.renderStaging, 'ELASTIC_CLOUD_ID') || hasKey(config.secrets?.renderStaging, 'ELASTIC_ENDPOINT'));
  const hasVercel = hasKey(config.secrets?.vercel as Record<string, unknown> | undefined, 'ELASTIC_API_KEY') && (hasKey(config.secrets?.vercel as Record<string, unknown> | undefined, 'ELASTIC_CLOUD_ID') || hasKey(config.secrets?.vercel as Record<string, unknown> | undefined, 'ELASTIC_ENDPOINT'));

  if (!hasRenderProd) {
    recommendations.push('Add ELASTIC_API_KEY + ELASTIC_CLOUD_ID to secrets.renderProduction for production backend logging');
  }
  if (!hasRenderStag) {
    recommendations.push('Add ELASTIC_API_KEY + ELASTIC_CLOUD_ID to secrets.renderStaging for staging backend logging');
  }
  if (!hasVercel) {
    recommendations.push('Add ELASTIC_API_KEY + ELASTIC_CLOUD_ID to secrets.vercel for frontend SSR logging');
  }

  // Check cluster connectivity.
  //
  // We deliberately do NOT call `cluster.health()` here:
  //   * On Elastic Cloud Serverless the `_cluster/health` endpoint does not
  //     exist and the call returns a 404.
  //   * On Elastic Cloud Standard, read/data API keys typically lack
  //     `monitor` cluster privileges, so the call returns 403 even when
  //     `query_logs` works.
  //
  // Both produce a false `cluster_reachable: false` even though the same
  // credentials can search just fine. Probe with `ping()` first (lightest
  // available call), then fall back to a `size: 0` match-all search against
  // the configured index pattern — this matches exactly the permissions
  // `query_logs` uses, so it is the most accurate "can we observe logs"
  // signal we can produce.
  let clusterReachable = false;
  const clusterStatus: string | undefined = undefined;

  try {
    const client = getClient();
    try {
      await (client as { ping: (opts?: unknown) => Promise<unknown> }).ping({ requestTimeout: 3000 });
      clusterReachable = true;
    } catch {
      try {
        await (client as { search: (opts: unknown) => Promise<unknown> }).search({
          index: `${indexPrefix}-*`,
          size: 0,
          query: { match_all: {} },
          requestTimeout: 3000,
        });
        clusterReachable = true;
      } catch {
        // both probes failed — leave clusterReachable false
      }
    }
  } catch {
    // Client init failed — credentials likely missing
  }

  if (!clusterReachable && hasLocalApiKey && hasLocalCloudId) {
    recommendations.push('Elastic cluster unreachable via ping or search probe — verify credentials are correct and cluster is running');
  }

  if (recommendations.length === 0) {
    recommendations.push('Logging configuration is complete across all environments');
  }

  return {
    elastic_configured: elasticConfigured,
    elastic_enabled: elasticEnabled,
    index_prefix: indexPrefix,
    credentials: {
      local: hasLocalApiKey && hasLocalCloudId,
      render_production: hasRenderProd,
      render_staging: hasRenderStag,
      vercel: hasVercel,
    },
    cluster_reachable: clusterReachable,
    cluster_status: clusterStatus,
    recommendations,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

export const tools: AnyToolHandler[] = [
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
  {
    name: 'verify_logging_config',
    description: `Verify logging configuration across all environments.

Checks:
- Elastic section presence in services.json
- Credential coverage: secrets.local (local dev/demos), renderProduction, renderStaging, vercel
- Cluster connectivity (attempts health check with configured credentials)
- Returns actionable recommendations for missing configuration

Use this after setting up Elastic credentials to verify end-to-end readiness.
Returns a structured health report with per-environment credential status and cluster health.`,
    schema: VerifyLoggingConfigArgsSchema,
    handler: verifyLoggingConfig,
  },
];

export const server = new McpServer({
  name: 'elastic-logs',
  version: '1.0.0',
  tools,
});

if (!process.env.MCP_SHARED_DAEMON) { server.start(); }
