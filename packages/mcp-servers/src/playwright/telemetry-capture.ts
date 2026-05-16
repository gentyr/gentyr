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
  /**
   * Optional byte offsets per filename. When supplied, only bytes appended
   * AFTER each offset are read and shipped — used at demo completion to
   * avoid re-shipping lines that were already streamed via
   * `shipTelemetryDelta` during the run. Mutated in place so the caller can
   * persist the final position.
   */
  priorOffsets?: Record<string, number>;
}): Promise<void> {
  const client = getElasticClient() as { bulk?: (args: { operations: unknown[] }) => Promise<{ errors?: boolean }> } | null;
  if (!client || !client.bulk) return;

  const { runId, scenarioId, telemetryDir, status, durationMs, executionTarget, priorOffsets } = opts;

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
      let content: string;
      const startOffset = priorOffsets ? (priorOffsets[filename] ?? 0) : 0;
      if (startOffset > 0) {
        const stat = fs.statSync(filePath);
        if (stat.size <= startOffset) {
          // Already shipped through end of file.
          continue;
        }
        const fd = fs.openSync(filePath, 'r');
        try {
          const len = stat.size - startOffset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, startOffset);
          content = buf.toString('utf8');
        } finally {
          try { fs.closeSync(fd); } catch { /* */ }
        }
        if (priorOffsets) priorOffsets[filename] = stat.size;
      } else {
        content = fs.readFileSync(filePath, 'utf8');
        if (priorOffsets) {
          try { priorOffsets[filename] = fs.statSync(filePath).size; } catch { /* */ }
        }
      }
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

// ============================================================================
// Incremental telemetry shipping
// ============================================================================

const TELEMETRY_FILE_MAP: Record<string, string> = {
  'console-logs.jsonl': 'console',
  'network-log.jsonl': 'network',
  'js-errors.jsonl': 'js_error',
  'performance-metrics.jsonl': 'performance',
  'system-metrics.jsonl': 'system_metrics',
};

/**
 * Ship NEW telemetry lines (since last sync) to Elastic for a still-running demo.
 *
 * Uses byte-offset tracking per filename so each call only ships bytes that
 * appeared since the previous call. Designed to be called periodically during
 * a long-running demo (e.g. from check_demo_result polling) so telemetry from
 * a hung machine still reaches Elastic before the machine is destroyed.
 *
 * Mutates `offsets` in place. Lines are tagged with `status: 'running'` and
 * `demo_phase: 'incremental'` so they can be distinguished from the
 * post-completion final ship.
 *
 * Silent no-op when ELASTIC_CLOUD_ID / ELASTIC_API_KEY are not set, when the
 * telemetry directory does not exist, or when no new bytes are present.
 *
 * @returns The number of lines shipped this pass (best-effort count).
 */
export async function shipTelemetryDelta(opts: {
  runId: string;
  scenarioId: string;
  telemetryDir: string;
  offsets: Record<string, number>;
  executionTarget?: string;
  status?: string;
}): Promise<{ shipped: number; perFile: Record<string, number> }> {
  const result = { shipped: 0, perFile: {} as Record<string, number> };

  const client = getElasticClient() as { bulk?: (args: { operations: unknown[] }) => Promise<{ errors?: boolean }> } | null;
  if (!client || !client.bulk) return result;

  const { runId, scenarioId, telemetryDir, offsets, executionTarget, status } = opts;
  if (!fs.existsSync(telemetryDir)) return result;

  const dateStr = new Date().toISOString().slice(0, 10);
  const indexName = `logs-demo-telemetry-${dateStr}`;
  const BATCH_SIZE = 500;

  for (const [filename, telemetryType] of Object.entries(TELEMETRY_FILE_MAP)) {
    const filePath = path.join(telemetryDir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // file doesn't exist yet
    }
    const prevOffset = offsets[filename] ?? 0;
    if (stat.size <= prevOffset) {
      // No new bytes (or file was truncated/rotated — leave offset, skip).
      continue;
    }

    let delta: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const len = stat.size - prevOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, prevOffset);
        delta = buf.toString('utf8');
      } finally {
        try { fs.closeSync(fd); } catch { /* */ }
      }
    } catch {
      continue;
    }

    // Be careful with a partial trailing line: only consume up to the last
    // newline; remember the offset of the last complete line for the next pass.
    const lastNewline = delta.lastIndexOf('\n');
    let consumeUpTo: number;
    if (lastNewline === -1) {
      // No complete line yet — leave offset, try again next pass.
      continue;
    }
    consumeUpTo = lastNewline + 1; // include the newline
    const consumedText = delta.slice(0, consumeUpTo);
    const lines = consumedText.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      offsets[filename] = prevOffset + consumeUpTo;
      continue;
    }

    let shippedForFile = 0;
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
            status: status || 'running',
            execution_target: executionTarget || 'fly',
            demo_phase: 'incremental',
          },
        };

        operations.push({ index: { _index: indexName } });
        operations.push(doc);
      }

      if (operations.length > 0) {
        try {
          await client.bulk({ operations });
          shippedForFile += operations.length / 2;
        } catch {
          // Non-fatal — shipping is best-effort. Do NOT advance offset on
          // failure so the next pass retries the same bytes.
          continue;
        }
      }
    }

    // Advance offset only for the bytes we successfully consumed.
    offsets[filename] = prevOffset + consumeUpTo;
    result.shipped += shippedForFile;
    result.perFile[filename] = shippedForFile;
  }

  return result;
}

// ============================================================================
// Fly-side incremental telemetry pull
// ============================================================================

/**
 * Pull only the bytes appended to in-machine telemetry JSONL files since the
 * last sync (using per-file byte offsets) and write the deltas to the local
 * telemetry directory.
 *
 * Mutates `offsets` in place — the same map can be reused across shipping.
 *
 * The remote tar is created on a per-file basis using `tail -c +N` so we never
 * pull the entire telemetry tree more than once. Each tail is piped through
 * base64 because the Fly exec API returns stdout as UTF-8 text (NOT base64),
 * so binary-safe transport requires encoding remote-side.
 *
 * @returns A map of filename -> bytes appended locally this call.
 */
export async function pullFlyTelemetryDelta(opts: {
  exec: (cmd: string[], timeoutMs?: number) => Promise<Buffer>;
  remoteDir: string;
  localDir: string;
  offsets: Record<string, number>;
}): Promise<Record<string, number>> {
  const { exec, remoteDir, localDir, offsets } = opts;
  const result: Record<string, number> = {};

  await fs.promises.mkdir(localDir, { recursive: true });

  for (const filename of Object.keys(TELEMETRY_FILE_MAP)) {
    const remotePath = `${remoteDir}/${filename}`;
    const prevOffset = offsets[filename] ?? 0;
    // `tail -c +N` is 1-indexed: +1 means "from byte 1" (the whole file).
    const startByte = prevOffset + 1;
    const shellLine = `if [ -f ${shQuote(remotePath)} ]; then ` +
      `SZ=$(stat -c%s ${shQuote(remotePath)} 2>/dev/null || stat -f%z ${shQuote(remotePath)} 2>/dev/null || echo 0); ` +
      `if [ "$SZ" -ge ${prevOffset} ]; then ` +
      `tail -c +${startByte} ${shQuote(remotePath)} 2>/dev/null | base64; ` +
      `else echo ""; fi; else echo ""; fi`;

    let b64: string;
    try {
      const buf = await exec(['sh', '-c', shellLine], 10_000);
      b64 = buf.toString('utf8').replace(/\s/g, '');
    } catch {
      continue;
    }
    if (!b64) continue;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (bytes.length === 0) continue;

    const localPath = path.join(localDir, filename);
    try {
      await fs.promises.appendFile(localPath, bytes);
      offsets[filename] = prevOffset + bytes.length;
      result[filename] = bytes.length;
    } catch {
      // ignore; will retry next pass with same offset
    }
  }

  return result;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
