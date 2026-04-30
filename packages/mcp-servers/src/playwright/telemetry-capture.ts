/**
 * Demo Telemetry Capture — System metrics poller and Elastic shipping
 *
 * Provides system-level metrics capture (CPU, memory, load) as a sidecar
 * alongside Playwright demo execution. Browser-level telemetry (console,
 * network, errors, performance) is captured by playwright-telemetry-setup.mjs
 * via the --import mechanism.
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// System Metrics Poller
// ============================================================================

interface CpuSnapshot {
  idle: number;
  total: number;
}

function getCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercent(prev: CpuSnapshot, curr: CpuSnapshot): number {
  const idleDiff = curr.idle - prev.idle;
  const totalDiff = curr.total - prev.total;
  if (totalDiff === 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 1000) / 10; // 1 decimal
}

async function getProcessStats(pid: number): Promise<{ rss_mb: number; cpu_percent: number } | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 3000 });
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 2) {
        return {
          rss_mb: Math.round(parseInt(parts[0], 10) / 1024),
          cpu_percent: parseFloat(parts[1]) || 0,
        };
      }
    } else {
      // Linux — read /proc/{pid}/stat
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.split(' ');
      const rssPages = parseInt(fields[23], 10) || 0;
      const pageSize = 4096; // typical
      return {
        rss_mb: Math.round((rssPages * pageSize) / (1024 * 1024)),
        cpu_percent: 0, // /proc/stat requires delta calculation — skip for simplicity
      };
    }
  } catch {
    // Process may have exited
  }
  return null;
}

export interface MetricsPollerHandle {
  stop: () => void;
}

/**
 * Start a background system metrics poller that writes JSONL to the given path.
 *
 * Captures: system CPU%, memory usage, load averages, and (optionally) Playwright
 * child process RSS/CPU.
 */
export function startSystemMetricsPoller(opts: {
  outputPath: string;
  intervalMs?: number;
  playwrightPid?: number;
  runId?: string;
}): MetricsPollerHandle {
  const { outputPath, intervalMs = 2000, playwrightPid, runId } = opts;

  // Ensure parent directory exists
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const stream = fs.createWriteStream(outputPath, { flags: 'a' });
  let prevCpu = getCpuSnapshot();

  const intervalHandle = setInterval(async () => {
    try {
      const currCpu = getCpuSnapshot();
      const systemCpuPct = cpuPercent(prevCpu, currCpu);
      prevCpu = currCpu;

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const loadAvg = os.loadavg();

      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        type: 'system_metrics',
        ...(runId ? { run_id: runId } : {}),
        system: {
          cpu_percent: systemCpuPct,
          mem_used_mb: Math.round((totalMem - freeMem) / (1024 * 1024)),
          mem_total_mb: Math.round(totalMem / (1024 * 1024)),
          mem_free_mb: Math.round(freeMem / (1024 * 1024)),
          load_avg: loadAvg.map(v => Math.round(v * 100) / 100),
        },
      };

      if (playwrightPid) {
        const procStats = await getProcessStats(playwrightPid);
        if (procStats) {
          entry.process = {
            pid: playwrightPid,
            ...procStats,
          };
        }
      }

      stream.write(JSON.stringify(entry) + '\n');
    } catch {
      // Non-fatal — skip this sample
    }
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(intervalHandle);
      stream.end();
    },
  };
}

// ============================================================================
// Telemetry Directory Management
// ============================================================================

/**
 * Create the telemetry directory for a demo scenario.
 * Returns the absolute path to the directory.
 */
export function ensureTelemetryDir(scenarioId: string, projectDir: string): string {
  const telemetryDir = path.join(projectDir, '.claude', 'recordings', 'demos', scenarioId, 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  return telemetryDir;
}

/**
 * Read telemetry JSONL file line counts for a quick summary.
 */
export function readTelemetrySummary(telemetryDir: string): {
  console_count: number;
  network_count: number;
  error_count: number;
  perf_entries: number;
  metric_samples: number;
} | undefined {
  try {
    if (!fs.existsSync(telemetryDir)) return undefined;
    const countLines = (file: string): number => {
      try {
        const p = path.join(telemetryDir, file);
        if (!fs.existsSync(p)) return 0;
        const content = fs.readFileSync(p, 'utf8');
        return content.split('\n').filter(l => l.trim()).length;
      } catch { return 0; }
    };
    return {
      console_count: countLines('console-logs.jsonl'),
      network_count: countLines('network-log.jsonl'),
      error_count: countLines('js-errors.jsonl'),
      perf_entries: countLines('performance-metrics.jsonl'),
      metric_samples: countLines('system-metrics.jsonl'),
    };
  } catch { return undefined; }
}

// ============================================================================
// Elastic Shipping (fire-and-forget, silent no-op when credentials missing)
// ============================================================================

let _elasticClient: unknown = null;

function getElasticClient(): unknown {
  if (_elasticClient) return _elasticClient;

  const apiKey = process.env.ELASTIC_API_KEY;
  const cloudId = process.env.ELASTIC_CLOUD_ID;
  const endpoint = process.env.ELASTIC_ENDPOINT;

  if (!apiKey || (!cloudId && !endpoint)) return null;

  try {
    // Dynamic import to avoid hard dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('@elastic/elasticsearch');
    _elasticClient = new Client({
      ...(cloudId ? { cloud: { id: cloudId } } : { node: endpoint }),
      auth: { apiKey },
    });
    return _elasticClient;
  } catch {
    return null;
  }
}

/**
 * Ship telemetry JSONL files to Elastic Cloud.
 *
 * Reads all JSONL files in the telemetry directory, enriches each line with
 * demo.run_id and telemetry_type, and bulk-ships to Elastic.
 *
 * Silent no-op when ELASTIC_CLOUD_ID / ELASTIC_API_KEY are not set.
 */
export async function shipTelemetryToElastic(opts: {
  runId: string;
  scenarioId: string;
  telemetryDir: string;
  status: string;
  durationMs: number;
  executionTarget?: string;
}): Promise<void> {
  const client = getElasticClient() as { bulk?: (args: { operations: unknown[] }) => Promise<{ errors?: boolean }> } | null;
  if (!client || !client.bulk) return;

  const { runId, scenarioId, telemetryDir, status, durationMs, executionTarget } = opts;

  const fileMap: Record<string, string> = {
    'console-logs.jsonl': 'console',
    'network-log.jsonl': 'network',
    'js-errors.jsonl': 'js_error',
    'performance-metrics.jsonl': 'performance',
    'system-metrics.jsonl': 'system_metrics',
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const indexName = `logs-demo-telemetry-${dateStr}`;
  const BATCH_SIZE = 500;

  for (const [filename, telemetryType] of Object.entries(fileMap)) {
    const filePath = path.join(telemetryDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (let i = 0; i < lines.length; i += BATCH_SIZE) {
        const batch = lines.slice(i, i + BATCH_SIZE);
        const operations: unknown[] = [];

        for (const line of batch) {
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(line); } catch { continue; }

          const doc = {
            '@timestamp': parsed.timestamp || new Date().toISOString(),
            ...parsed,
            telemetry_type: telemetryType,
            demo: {
              run_id: runId,
              scenario_id: scenarioId,
              status,
              duration_ms: durationMs,
              execution_target: executionTarget || 'local',
            },
          };

          operations.push({ index: { _index: indexName } });
          operations.push(doc);
        }

        if (operations.length > 0) {
          try {
            await client.bulk({ operations });
          } catch {
            // Non-fatal — shipping is best-effort
          }
        }
      }
    } catch {
      // Non-fatal — skip this file
    }
  }
}
