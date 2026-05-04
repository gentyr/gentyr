#!/usr/bin/env node
/**
 * Synthetic Monitoring Daemon
 *
 * Probes health endpoints for staging and production environments.
 * - Production: every 60 seconds
 * - Staging: every 5 minutes
 *
 * Stores results in .claude/state/synthetic-metrics.db (SQLite, WAL mode).
 * Writes alerts to .claude/state/synthetic-alerts.json for hourly-automation
 * to pick up and feed into the auto-rollback pipeline.
 *
 * Runs as a launchd KeepAlive service alongside other GENTYR daemons.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Enforce CWD — launchd WorkingDirectory is unreliable (macOS launchctl load/unload bug)
try { process.chdir(PROJECT_DIR); } catch { /* non-fatal */ }

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const DB_PATH = path.join(STATE_DIR, 'synthetic-metrics.db');
const ALERTS_PATH = path.join(STATE_DIR, 'synthetic-alerts.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'synthetic-monitor.log');
const SERVICES_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');

const PROD_INTERVAL_MS = 60 * 1000;        // 60 seconds
const STAGING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_SLEEP_MS = 5000;                 // 5-second main loop tick
const PROBE_TIMEOUT_MS = 10000;             // 10-second HTTP timeout per probe
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly cleanup
const PROBE_RETENTION_DAYS = 7;
const SUMMARY_RETENTION_DAYS = 90;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const LATENCY_SPIKE_MULTIPLIER = 2;

// Lazy-loaded better-sqlite3
let Database;

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* best-effort */ }
}

// ============================================================================
// Database Initialization
// ============================================================================

function initDb() {
  if (!Database) {
    throw new Error('better-sqlite3 not available — cannot initialize synthetic metrics DB');
  }

  // Ensure state directory exists
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS health_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      status_code INTEGER,
      response_time_ms INTEGER,
      healthy INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment TEXT NOT NULL,
      hour TEXT NOT NULL,
      uptime_pct REAL,
      p95_latency_ms INTEGER,
      probe_count INTEGER,
      failure_count INTEGER,
      UNIQUE(environment, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_probes_env_ts
      ON health_probes(environment, timestamp);
    CREATE INDEX IF NOT EXISTS idx_probes_env_endpoint_ts
      ON health_probes(environment, endpoint, timestamp);
    CREATE INDEX IF NOT EXISTS idx_summary_env_hour
      ON metrics_summary(environment, hour);
  `);

  return db;
}

// ============================================================================
// Services.json Configuration Reader
// ============================================================================

/**
 * Read health endpoints from services.json environments config.
 * Returns { production: [{url, label}], staging: [{url, label}] }
 */
function getHealthEndpoints() {
  const result = { production: [], staging: [] };

  try {
    if (!fs.existsSync(SERVICES_CONFIG_PATH)) {
      return result;
    }

    const raw = fs.readFileSync(SERVICES_CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    const environments = config.environments;

    if (!environments || typeof environments !== 'object') {
      return result;
    }

    for (const [envName, envConfig] of Object.entries(environments)) {
      if (!envConfig || !envConfig.baseUrl) continue;

      const healthEndpoint = envConfig.healthEndpoint || '/api/health';
      const url = `${envConfig.baseUrl}${healthEndpoint}`;
      const label = envConfig.label || envName;

      // Classify into production or staging based on environment name
      const lowerName = envName.toLowerCase();
      if (lowerName === 'production' || lowerName === 'prod') {
        result.production.push({ url, label, envName });
      } else {
        // Everything else (staging, preview, etc.) is staging-tier
        result.staging.push({ url, label, envName });
      }
    }
  } catch (err) {
    log(`Failed to read services.json: ${err.message}`);
  }

  return result;
}

// ============================================================================
// Health Probing
// ============================================================================

/**
 * Probe a single health endpoint via HTTP GET.
 * Returns { status_code, response_time_ms, healthy, error }
 */
async function probeEndpoint(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': 'GENTYR-Synthetic-Monitor/1.0' },
    });
    const responseTimeMs = Date.now() - start;
    return {
      status_code: response.status,
      response_time_ms: responseTimeMs,
      healthy: response.ok ? 1 : 0,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      status_code: 0,
      response_time_ms: Date.now() - start,
      healthy: 0,
      error: err.name === 'TimeoutError' ? `Timeout after ${PROBE_TIMEOUT_MS}ms` : err.message,
    };
  }
}

// ============================================================================
// Alert Detection
// ============================================================================

/**
 * Check for N consecutive failures on an endpoint.
 * @returns {boolean} true if N consecutive failures detected
 */
function checkConsecutiveFailures(db, environment, endpoint) {
  const recent = db.prepare(`
    SELECT healthy FROM health_probes
    WHERE environment = ? AND endpoint = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(environment, endpoint, CONSECUTIVE_FAILURE_THRESHOLD);

  if (recent.length < CONSECUTIVE_FAILURE_THRESHOLD) return false;
  return recent.every(r => r.healthy === 0);
}

/**
 * Check for latency spike (>2x the 5-minute rolling baseline).
 * @returns {{ spiked: boolean, currentMs: number, baselineMs: number }}
 */
function checkLatencySpike(db, environment, endpoint, currentLatency) {
  const baseline = db.prepare(`
    SELECT AVG(response_time_ms) as avg_ms FROM health_probes
    WHERE environment = ? AND endpoint = ? AND healthy = 1
    AND timestamp > datetime('now', '-5 minutes')
  `).get(environment, endpoint);

  if (!baseline || baseline.avg_ms == null || baseline.avg_ms === 0) {
    return { spiked: false, currentMs: currentLatency, baselineMs: 0 };
  }

  const spiked = currentLatency > baseline.avg_ms * LATENCY_SPIKE_MULTIPLIER;
  return { spiked, currentMs: currentLatency, baselineMs: Math.round(baseline.avg_ms) };
}

// ============================================================================
// Alert File Management
// ============================================================================

/**
 * Write an alert to the synthetic-alerts.json file.
 * The hourly-automation auto_rollback_check reads this file.
 */
function writeAlert(alert) {
  try {
    let alerts = [];
    if (fs.existsSync(ALERTS_PATH)) {
      try {
        const raw = fs.readFileSync(ALERTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          alerts = parsed;
        }
      } catch {
        // Corrupt file — start fresh
        alerts = [];
      }
    }

    alerts.push({
      ...alert,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 100 alerts
    if (alerts.length > 100) {
      alerts = alerts.slice(-100);
    }

    // Atomic write: tmp + rename
    const tmpPath = ALERTS_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(alerts, null, 2), 'utf8');
    fs.renameSync(tmpPath, ALERTS_PATH);
  } catch (err) {
    log(`Failed to write alert: ${err.message}`);
  }
}

// ============================================================================
// Hourly Summary Aggregation
// ============================================================================

/**
 * Compute and insert hourly summary for the previous hour.
 */
function computeHourlySummary(db, environment) {
  const currentHour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const previousHour = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 13);

  // Check if summary already exists for previous hour
  const existing = db.prepare(`
    SELECT id FROM metrics_summary WHERE environment = ? AND hour = ?
  `).get(environment, previousHour);
  if (existing) return;

  // Aggregate probes from the previous hour
  const stats = db.prepare(`
    SELECT
      COUNT(*) as probe_count,
      SUM(CASE WHEN healthy = 0 THEN 1 ELSE 0 END) as failure_count,
      ROUND(100.0 * SUM(healthy) / COUNT(*), 2) as uptime_pct
    FROM health_probes
    WHERE environment = ?
    AND timestamp >= datetime(?, 'utc')
    AND timestamp < datetime(?, 'utc')
  `).get(environment, previousHour + ':00:00', currentHour + ':00:00');

  if (!stats || stats.probe_count === 0) return;

  // P95 latency — approximate via sorted query
  const p95Row = db.prepare(`
    SELECT response_time_ms FROM health_probes
    WHERE environment = ? AND healthy = 1
    AND timestamp >= datetime(?, 'utc')
    AND timestamp < datetime(?, 'utc')
    ORDER BY response_time_ms ASC
    LIMIT 1 OFFSET CAST(0.95 * (
      SELECT COUNT(*) FROM health_probes
      WHERE environment = ? AND healthy = 1
      AND timestamp >= datetime(?, 'utc')
      AND timestamp < datetime(?, 'utc')
    ) AS INTEGER)
  `).get(
    environment, previousHour + ':00:00', currentHour + ':00:00',
    environment, previousHour + ':00:00', currentHour + ':00:00',
  );

  const insertSummary = db.prepare(`
    INSERT OR REPLACE INTO metrics_summary (environment, hour, uptime_pct, p95_latency_ms, probe_count, failure_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertSummary.run(
    environment,
    previousHour,
    stats.uptime_pct,
    p95Row ? p95Row.response_time_ms : null,
    stats.probe_count,
    stats.failure_count,
  );
}

// ============================================================================
// Data Cleanup
// ============================================================================

function cleanupOldData(db) {
  try {
    const deletedProbes = db.prepare(
      `DELETE FROM health_probes WHERE timestamp < datetime('now', '-${PROBE_RETENTION_DAYS} days')`
    ).run();
    const deletedSummaries = db.prepare(
      `DELETE FROM metrics_summary WHERE hour < datetime('now', '-${SUMMARY_RETENTION_DAYS} days')`
    ).run();

    if (deletedProbes.changes > 0 || deletedSummaries.changes > 0) {
      log(`Cleanup: removed ${deletedProbes.changes} probes, ${deletedSummaries.changes} summaries`);
    }
  } catch (err) {
    log(`Cleanup error (non-fatal): ${err.message}`);
  }
}

// ============================================================================
// Probe Execution
// ============================================================================

/**
 * Run probes for a set of endpoints in an environment tier.
 *
 * @param {object} db - SQLite database handle
 * @param {string} tier - 'production' or 'staging'
 * @param {Array<{url: string, label: string, envName: string}>} endpoints
 */
async function probeEnvironment(db, tier, endpoints) {
  const insertProbe = db.prepare(`
    INSERT INTO health_probes (environment, endpoint, status_code, response_time_ms, healthy, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const { url, label, envName } of endpoints) {
    const result = await probeEndpoint(url);

    insertProbe.run(
      envName,
      url,
      result.status_code,
      result.response_time_ms,
      result.healthy,
      result.error,
    );

    // Check for consecutive failures
    if (checkConsecutiveFailures(db, envName, url)) {
      const alertMsg = `${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures for ${label} (${envName}) at ${url}`;
      log(`ALERT: ${alertMsg}`);
      writeAlert({
        type: 'consecutive_failures',
        environment: envName,
        tier,
        endpoint: url,
        label,
        consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
        message: alertMsg,
      });
    }

    // Check for latency spike (only on healthy responses)
    if (result.healthy) {
      const spike = checkLatencySpike(db, envName, url, result.response_time_ms);
      if (spike.spiked) {
        const alertMsg = `Latency spike on ${label} (${envName}): ${spike.currentMs}ms vs ${spike.baselineMs}ms baseline`;
        log(`WARNING: ${alertMsg}`);
        writeAlert({
          type: 'latency_spike',
          environment: envName,
          tier,
          endpoint: url,
          label,
          currentLatencyMs: spike.currentMs,
          baselineLatencyMs: spike.baselineMs,
          message: alertMsg,
        });
      }
    }

    // Compute hourly summary opportunistically
    computeHourlySummary(db, envName);
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  // Lazy-load better-sqlite3
  try {
    const mod = await import('better-sqlite3');
    Database = mod.default;
  } catch (err) {
    log(`FATAL: better-sqlite3 not available: ${err.message}`);
    process.exit(1);
  }

  let db;
  try {
    db = initDb();
  } catch (err) {
    log(`FATAL: Failed to initialize DB: ${err.message}`);
    process.exit(1);
  }

  log('Starting synthetic monitor daemon...');

  let lastProdProbe = 0;
  let lastStagingProbe = 0;
  let lastCleanup = 0;

  // Graceful shutdown
  let running = true;
  const shutdown = () => {
    log('Shutting down...');
    running = false;
    try { db.close(); } catch { /* cleanup */ }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (running) {
    const now = Date.now();

    // Read endpoints fresh each cycle (config may change)
    let endpoints;
    try {
      endpoints = getHealthEndpoints();
    } catch (err) {
      log(`Failed to read endpoints: ${err.message}`);
      await new Promise(r => setTimeout(r, POLL_SLEEP_MS));
      continue;
    }

    const hasProd = endpoints.production.length > 0;
    const hasStaging = endpoints.staging.length > 0;

    if (!hasProd && !hasStaging) {
      // No endpoints configured — sleep longer
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    // Probe production endpoints
    if (hasProd && (now - lastProdProbe >= PROD_INTERVAL_MS)) {
      try {
        await probeEnvironment(db, 'production', endpoints.production);
      } catch (err) {
        log(`Production probe error: ${err.message}`);
      }
      lastProdProbe = now;
    }

    // Probe staging endpoints
    if (hasStaging && (now - lastStagingProbe >= STAGING_INTERVAL_MS)) {
      try {
        await probeEnvironment(db, 'staging', endpoints.staging);
      } catch (err) {
        log(`Staging probe error: ${err.message}`);
      }
      lastStagingProbe = now;
    }

    // Periodic cleanup
    if (now - lastCleanup >= CLEANUP_INTERVAL_MS) {
      cleanupOldData(db);
      lastCleanup = now;
    }

    await new Promise(r => setTimeout(r, POLL_SLEEP_MS));
  }
}

main().catch(err => {
  log(`FATAL: Unhandled error: ${err.message}`);
  process.exit(1);
});
