/**
 * Logging Data Reader
 *
 * Queries Elasticsearch for comprehensive log metrics:
 * volume timeseries, level/service breakdowns, top errors/warnings,
 * storage estimates, and source coverage assessment.
 */

import { resolveCredential, resolveElasticEndpoint, fetchWithTimeout } from './credentials.js';

// ============================================================================
// Types
// ============================================================================

export interface LoggingData {
  hasData: boolean;

  // Volume metrics
  totalLogs1h: number;
  totalLogs24h: number;

  // Timeseries for line graph (24 data points, 1 per hour)
  volumeTimeseries: number[];

  // By log level
  byLevel: Array<{ level: string; count: number }>;

  // By service
  byService: Array<{ service: string; count: number }>;

  // By source/module
  bySource: Array<{ source: string; count: number }>;

  // Top errors (last 24h)
  topErrors: Array<{ message: string; service: string; count: number }>;

  // Top warnings (last 24h)
  topWarnings: Array<{ message: string; service: string; count: number }>;

  // Storage estimate
  storage: {
    estimatedDailyGB: number;
    estimatedMonthlyCost: number;
    indexCount: number;
  };

  // Source coverage assessment
  sourceCoverage: Array<{
    source: string;
    status: 'active' | 'missing' | 'low-volume';
    description: string;
  }>;
}

// ============================================================================
// Expected sources for coverage assessment
// ============================================================================

const EXPECTED_SOURCES = [
  { source: 'api', description: 'Application API server logs' },
  { source: 'worker', description: 'Background job/worker logs' },
  { source: 'deployment', description: 'Deploy event logs from Render/Vercel' },
  { source: 'ci-cd', description: 'CI/CD pipeline logs (GitHub Actions)' },
  { source: 'testing', description: 'Test execution logs (Vitest/Playwright)' },
  { source: 'database', description: 'Supabase/Postgres query logs' },
  { source: 'cdn', description: 'Cloudflare access/WAF logs' },
  { source: 'auth', description: 'Authentication event logs' },
  { source: 'cron', description: 'Scheduled job execution logs' },
];

const LOW_VOLUME_THRESHOLD = 10; // <10 logs/24h = low-volume

// ============================================================================
// Elasticsearch Queries
// ============================================================================

interface ElasticSearchResponse {
  hits?: { total?: { value?: number } };
  aggregations?: Record<string, {
    buckets?: Array<{
      key: string;
      key_as_string?: string;
      doc_count: number;
      top_services?: { buckets?: Array<{ key: string; doc_count: number }> };
    }>;
  }>;
}

interface ElasticCatIndex {
  index: string;
  'store.size': string;
  'docs.count': string;
}

async function queryVolumeAndBreakdowns(endpoint: string, apiKey: string): Promise<{
  totalLogs24h: number;
  totalLogs1h: number;
  volumeTimeseries: number[];
  byLevel: LoggingData['byLevel'];
  byService: LoggingData['byService'];
  bySource: LoggingData['bySource'];
}> {
  const headers = {
    Authorization: `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Query 1: 24h volume with timeseries, level, service, and source breakdowns
  const body24h = JSON.stringify({
    size: 0,
    query: { range: { '@timestamp': { gte: 'now-24h' } } },
    aggs: {
      volume_over_time: {
        date_histogram: { field: '@timestamp', fixed_interval: '1h' },
      },
      by_level: { terms: { field: 'level.keyword', size: 10 } },
      by_service: { terms: { field: 'service.keyword', size: 15 } },
      by_source: { terms: { field: 'module.keyword', size: 15 } },
    },
  });

  // Query 2: 1h volume (separate for accurate count)
  const body1h = JSON.stringify({
    size: 0,
    query: { range: { '@timestamp': { gte: 'now-1h' } } },
  });

  const [result24h, result1h] = await Promise.allSettled([
    fetchWithTimeout(`${endpoint}/logs-*/_search`, { method: 'POST', headers, body: body24h }),
    fetchWithTimeout(`${endpoint}/logs-*/_search`, { method: 'POST', headers, body: body1h }),
  ]);

  let totalLogs24h = 0;
  let volumeTimeseries: number[] = [];
  let byLevel: LoggingData['byLevel'] = [];
  let byService: LoggingData['byService'] = [];
  let bySource: LoggingData['bySource'] = [];

  if (result24h.status === 'fulfilled' && result24h.value.ok) {
    const data = await result24h.value.json() as ElasticSearchResponse;
    totalLogs24h = data.hits?.total?.value || 0;

    const timeBuckets = data.aggregations?.['volume_over_time']?.buckets || [];
    volumeTimeseries = timeBuckets.map(b => b.doc_count);
    // Ensure we have 24 data points (pad with 0s at start if needed)
    while (volumeTimeseries.length < 24) {
      volumeTimeseries.unshift(0);
    }
    volumeTimeseries = volumeTimeseries.slice(-24);

    byLevel = (data.aggregations?.['by_level']?.buckets || []).map(b => ({
      level: b.key,
      count: b.doc_count,
    }));

    byService = (data.aggregations?.['by_service']?.buckets || []).map(b => ({
      service: b.key,
      count: b.doc_count,
    }));

    bySource = (data.aggregations?.['by_source']?.buckets || []).map(b => ({
      source: b.key,
      count: b.doc_count,
    }));
  }

  let totalLogs1h = 0;
  if (result1h.status === 'fulfilled' && result1h.value.ok) {
    const data = await result1h.value.json() as ElasticSearchResponse;
    totalLogs1h = data.hits?.total?.value || 0;
  }

  return { totalLogs24h, totalLogs1h, volumeTimeseries, byLevel, byService, bySource };
}

async function queryTopMessages(endpoint: string, apiKey: string): Promise<{
  topErrors: LoggingData['topErrors'];
  topWarnings: LoggingData['topWarnings'];
}> {
  const headers = {
    Authorization: `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Top errors (24h)
  const errorsBody = JSON.stringify({
    size: 0,
    query: {
      bool: {
        must: [
          { range: { '@timestamp': { gte: 'now-24h' } } },
          { term: { 'level.keyword': 'error' } },
        ],
      },
    },
    aggs: {
      top_messages: {
        terms: { field: 'message.keyword', size: 5 },
        aggs: { top_services: { terms: { field: 'service.keyword', size: 1 } } },
      },
    },
  });

  // Top warnings (24h)
  const warningsBody = JSON.stringify({
    size: 0,
    query: {
      bool: {
        must: [
          { range: { '@timestamp': { gte: 'now-24h' } } },
        ],
        should: [
          { term: { 'level.keyword': 'warn' } },
          { term: { 'level.keyword': 'warning' } },
        ],
        minimum_should_match: 1,
      },
    },
    aggs: {
      top_messages: {
        terms: { field: 'message.keyword', size: 5 },
        aggs: { top_services: { terms: { field: 'service.keyword', size: 1 } } },
      },
    },
  });

  const [errorsResult, warningsResult] = await Promise.allSettled([
    fetchWithTimeout(`${endpoint}/logs-*/_search`, { method: 'POST', headers, body: errorsBody }),
    fetchWithTimeout(`${endpoint}/logs-*/_search`, { method: 'POST', headers, body: warningsBody }),
  ]);

  let topErrors: LoggingData['topErrors'] = [];
  if (errorsResult.status === 'fulfilled' && errorsResult.value.ok) {
    const data = await errorsResult.value.json() as ElasticSearchResponse;
    topErrors = (data.aggregations?.['top_messages']?.buckets || []).map(b => ({
      message: b.key,
      service: b.top_services?.buckets?.[0]?.key || 'unknown',
      count: b.doc_count,
    }));
  }

  let topWarnings: LoggingData['topWarnings'] = [];
  if (warningsResult.status === 'fulfilled' && warningsResult.value.ok) {
    const data = await warningsResult.value.json() as ElasticSearchResponse;
    topWarnings = (data.aggregations?.['top_messages']?.buckets || []).map(b => ({
      message: b.key,
      service: b.top_services?.buckets?.[0]?.key || 'unknown',
      count: b.doc_count,
    }));
  }

  return { topErrors, topWarnings };
}

async function queryStorage(endpoint: string, apiKey: string, totalDocs24h: number): Promise<LoggingData['storage']> {
  const headers = {
    Authorization: `ApiKey ${apiKey}`,
    Accept: 'application/json',
  };

  // Try _cat/indices first (needs monitor privilege)
  try {
    const resp = await fetchWithTimeout(
      `${endpoint}/_cat/indices/logs-*?format=json&h=index,store.size,docs.count`,
      { headers },
    );
    if (resp.ok) {
      const indices = await resp.json() as ElasticCatIndex[];
      const indexCount = indices.length;

      let totalBytes = 0;
      for (const idx of indices) {
        const sizeStr = idx['store.size'] || '0b';
        totalBytes += parseSizeToBytes(sizeStr);
      }

      const totalGB = totalBytes / (1024 * 1024 * 1024);
      const estimatedDailyGB = totalGB / 7;
      const estimatedMonthlyCost = estimatedDailyGB * 30 * 0.25;

      return { estimatedDailyGB, estimatedMonthlyCost, indexCount };
    }
  } catch {
    // Fall through to estimation
  }

  // Fallback: estimate from document count (~500 bytes per structured log doc)
  if (totalDocs24h > 0) {
    const avgDocBytes = 500;
    const estimatedDailyGB = (totalDocs24h * avgDocBytes) / (1024 * 1024 * 1024);
    const estimatedMonthlyCost = estimatedDailyGB * 30 * 0.25;
    return { estimatedDailyGB, estimatedMonthlyCost, indexCount: 1 };
  }

  return { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 };
}

function parseSizeToBytes(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)(b|kb|mb|gb|tb)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };
  return value * (multipliers[unit] || 1);
}

// ============================================================================
// Source Coverage Assessment
// ============================================================================

function assessSourceCoverage(
  byService: LoggingData['byService'],
  bySource: LoggingData['bySource'],
): LoggingData['sourceCoverage'] {
  // Build a set of known active sources from service and module names
  const activeNames = new Set<string>();
  for (const s of byService) {
    activeNames.add(s.service.toLowerCase());
  }
  for (const s of bySource) {
    activeNames.add(s.source.toLowerCase());
  }

  // Build a map for count lookups
  const countByName = new Map<string, number>();
  for (const s of byService) {
    countByName.set(s.service.toLowerCase(), s.count);
  }
  for (const s of bySource) {
    const existing = countByName.get(s.source.toLowerCase()) || 0;
    countByName.set(s.source.toLowerCase(), Math.max(existing, s.count));
  }

  return EXPECTED_SOURCES.map(expected => {
    // Check if any active name contains or matches the expected source keyword
    const matchingName = [...activeNames].find(name =>
      name.includes(expected.source) || expected.source.includes(name),
    );

    if (!matchingName) {
      return { source: expected.source, status: 'missing' as const, description: expected.description };
    }

    const count = countByName.get(matchingName) || 0;
    if (count < LOW_VOLUME_THRESHOLD) {
      return { source: expected.source, status: 'low-volume' as const, description: expected.description };
    }

    return { source: expected.source, status: 'active' as const, description: expected.description };
  });
}

// ============================================================================
// Main
// ============================================================================

export async function getLoggingData(): Promise<LoggingData> {
  const empty: LoggingData = {
    hasData: false,
    totalLogs1h: 0,
    totalLogs24h: 0,
    volumeTimeseries: [],
    byLevel: [],
    byService: [],
    bySource: [],
    topErrors: [],
    topWarnings: [],
    storage: { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 },
    sourceCoverage: [],
  };

  const endpoint = resolveElasticEndpoint();
  const apiKey = resolveCredential('ELASTIC_API_KEY');
  if (!endpoint || !apiKey) return empty;

  // Volume and messages in parallel first (storage depends on doc count for fallback)
  const [volumeResult, messagesResult] = await Promise.allSettled([
    queryVolumeAndBreakdowns(endpoint, apiKey),
    queryTopMessages(endpoint, apiKey),
  ]);

  const volume = volumeResult.status === 'fulfilled'
    ? volumeResult.value
    : { totalLogs24h: 0, totalLogs1h: 0, volumeTimeseries: [] as number[], byLevel: [], byService: [], bySource: [] };

  const messages = messagesResult.status === 'fulfilled'
    ? messagesResult.value
    : { topErrors: [], topWarnings: [] };

  // Storage estimation (uses doc count fallback if _cat/indices is unauthorized)
  let storage: LoggingData['storage'];
  try {
    storage = await queryStorage(endpoint, apiKey, volume.totalLogs24h);
  } catch {
    storage = { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 };
  }

  const hasData = volume.totalLogs24h > 0 || volume.totalLogs1h > 0;

  return {
    hasData,
    totalLogs1h: volume.totalLogs1h,
    totalLogs24h: volume.totalLogs24h,
    volumeTimeseries: volume.volumeTimeseries,
    byLevel: volume.byLevel,
    byService: volume.byService,
    bySource: volume.bySource,
    topErrors: messages.topErrors,
    topWarnings: messages.topWarnings,
    storage,
    sourceCoverage: assessSourceCoverage(volume.byService, volume.bySource),
  };
}
