/**
 * Elastic Logger — dual-output wrapper around createLogger.
 *
 * Writes each log entry to both stdout/stderr AND Elasticsearch.
 * Silent no-op when ELASTIC_CLOUD_ID/ELASTIC_API_KEY env vars are missing.
 *
 * Drop-in replacement for createLogger:
 *   import { createElasticLogger } from '@my-project/logger';
 *   const logger = createElasticLogger({ service: 'my-api', module: 'billing' });
 */

import { createLogger, type LoggerConfig, type Logger, type LogEntry } from './logger.js';

type ElasticClient = { index: (args: { index: string; document: unknown }) => Promise<unknown> };

let _client: ElasticClient | null = null;
let _clientInitPromise: Promise<ElasticClient | null> | null = null;

async function getClient(): Promise<ElasticClient | null> {
  if (_client) return _client;
  if (_clientInitPromise) return _clientInitPromise;

  const apiKey = process.env.ELASTIC_API_KEY;
  const cloudId = process.env.ELASTIC_CLOUD_ID;
  const endpoint = process.env.ELASTIC_ENDPOINT;

  if (!apiKey || (!cloudId && !endpoint)) return null;

  _clientInitPromise = (async () => {
    try {
      const { Client } = await import('@elastic/elasticsearch');
      _client = new Client({
        ...(cloudId ? { cloud: { id: cloudId } } : { node: endpoint }),
        auth: { apiKey },
      });
      return _client;
    } catch {
      return null;
    }
  })();

  return _clientInitPromise;
}

let lastShipErrorAt = 0;

function getIndexName(service: string): string {
  const prefix = process.env.ELASTIC_INDEX_PREFIX || 'logs';
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix}-${service}-${date}`;
}

export function createElasticLogger(config: LoggerConfig & { service: string }): Logger {
  return createLogger({
    ...config,
    output: (entry: LogEntry) => {
      // 1. Always write to stdout/stderr
      const json = JSON.stringify(entry);
      if (entry.level === 'error' || entry.level === 'warn') {
        process.stderr.write(json + '\n');
      } else {
        process.stdout.write(json + '\n');
      }

      // 2. Ship to Elastic (non-blocking, best-effort, rate-limited errors)
      getClient().then(client => {
        if (!client) return;

        const doc: Record<string, unknown> = {
          '@timestamp': entry['@timestamp'],
          level: entry.level,
          message: entry.message,
          service: config.service,
        };
        if (entry.module) doc.module = entry.module;
        if (entry.requestId) doc.requestId = entry.requestId;
        if (entry.userId) doc.userId = entry.userId;
        if (entry.data) Object.assign(doc, entry.data);
        if (entry.error) doc.error = entry.error;
        if (process.env.DEMO_RUN_ID) doc['demo.run_id'] = process.env.DEMO_RUN_ID;

        client.index({ index: getIndexName(config.service), document: doc }).catch((err: unknown) => {
          // Rate-limit error reporting: max 1 error per 60s to prevent stderr flood
          const now = Date.now();
          if (now - lastShipErrorAt > 60_000) {
            lastShipErrorAt = now;
            process.stderr.write(`[elastic-logger] Ship error (suppressing repeats for 60s): ${err instanceof Error ? err.message : String(err)}\n`);
          }
        });
      }).catch(() => {});
    },
  });
}
