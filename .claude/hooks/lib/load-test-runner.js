/**
 * Load Test Runner
 *
 * Lightweight load testing using autocannon. Reads route configuration
 * from services.json and returns structured performance results.
 *
 * autocannon must be installed in the target project — this module
 * checks for its presence and throws a clear error if missing.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Read load test configuration from services.json.
 *
 * @param {string} projectDir - Project root directory
 * @returns {{ enabled: boolean, duration: number, connections: number, routes: string[] }}
 */
export function getLoadTestConfig(projectDir = PROJECT_DIR) {
  try {
    const configPath = path.join(projectDir, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) {
      return { enabled: false, duration: 30, connections: 50, routes: ['/api/health'] };
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const lt = config.loadTest;
    if (!lt) {
      return { enabled: false, duration: 30, connections: 50, routes: ['/api/health'] };
    }
    return {
      enabled: lt.enabled === true,
      duration: typeof lt.duration === 'number' ? lt.duration : 30,
      connections: typeof lt.connections === 'number' ? lt.connections : 50,
      routes: Array.isArray(lt.routes) ? lt.routes : ['/api/health'],
    };
  } catch {
    return { enabled: false, duration: 30, connections: 50, routes: ['/api/health'] };
  }
}

/**
 * Check if autocannon is available in the target project.
 *
 * @param {string} projectDir - Project root directory
 * @returns {boolean}
 */
export function isAutocannonAvailable(projectDir = PROJECT_DIR) {
  try {
    execSync('npx autocannon --version', {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a load test against a single route using autocannon.
 *
 * @param {string} baseUrl - Base URL (e.g., "http://localhost:3000")
 * @param {string} route - Route path (e.g., "/api/health")
 * @param {{ duration: number, connections: number }} options
 * @param {string} projectDir - Project root directory
 * @returns {{ route: string, p95ms: number|null, avgMs: number|null, errorRate: number, requestsPerSec: number|null }} | null
 */
export function runRouteLoadTest(baseUrl, route, options, projectDir = PROJECT_DIR) {
  if (!baseUrl) {
    throw new Error('runRouteLoadTest requires baseUrl');
  }
  if (!route) {
    throw new Error('runRouteLoadTest requires route');
  }

  const url = `${baseUrl.replace(/\/$/, '')}${route}`;
  const duration = options?.duration ?? 30;
  const connections = options?.connections ?? 50;

  try {
    const output = execSync(
      `npx autocannon -d ${duration} -c ${connections} -j "${url}"`,
      {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: (duration + 30) * 1000, // buffer beyond test duration
        stdio: 'pipe',
      }
    );

    const result = JSON.parse(output);

    // autocannon JSON output shape:
    // { latency: { p50, p95, p99, avg, min, max }, requests: { total, average, ... }, errors, ... }
    const totalRequests = result.requests?.total ?? 0;
    const totalErrors = result.errors ?? 0;
    const errorRate = totalRequests > 0
      ? Math.round((totalErrors / totalRequests) * 10000) / 100
      : 0;

    return {
      route,
      p95ms: result.latency?.p95 ?? null,
      avgMs: result.latency?.average ?? null,
      errorRate,
      requestsPerSec: result.requests?.average ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Run load tests against all configured routes.
 *
 * @param {string} projectDir - Project root directory
 * @param {{ enabled?: boolean, duration?: number, connections?: number, routes?: string[], baseUrl?: string }} [configOverride]
 * @returns {{ results: Array<{ route: string, p95ms: number|null, avgMs: number|null, errorRate: number, requestsPerSec: number|null }>, passed: boolean, error?: string }}
 */
export function runLoadTest(projectDir = PROJECT_DIR, configOverride = null) {
  if (!projectDir) {
    throw new Error('runLoadTest requires projectDir');
  }

  // Merge config from services.json with any overrides
  const fileConfig = getLoadTestConfig(projectDir);
  const config = configOverride
    ? { ...fileConfig, ...configOverride }
    : fileConfig;

  if (!config.enabled && !configOverride) {
    return { results: [], passed: true, error: 'Load testing is disabled in services.json. Set loadTest.enabled: true to enable.' };
  }

  // Check autocannon availability
  if (!isAutocannonAvailable(projectDir)) {
    return {
      results: [],
      passed: false,
      error: 'autocannon is not installed. Install it in the target project: pnpm add -D autocannon',
    };
  }

  // Determine base URL — from config override, environment variable, or default
  const baseUrl = config.baseUrl
    || process.env.PLAYWRIGHT_BASE_URL
    || 'http://localhost:3000';

  const results = [];
  let allPassed = true;

  const routes = config.routes || ['/api/health'];
  const duration = config.duration || 30;
  const connections = config.connections || 50;

  // Default thresholds: p95 < 500ms, error rate < 1%
  const p95Threshold = 500;
  const errorRateThreshold = 1;

  for (const route of routes) {
    const result = runRouteLoadTest(baseUrl, route, { duration, connections }, projectDir);
    if (result === null) {
      results.push({
        route,
        p95ms: null,
        avgMs: null,
        errorRate: 100,
        requestsPerSec: null,
      });
      allPassed = false;
      continue;
    }

    results.push(result);

    // Check thresholds
    if (result.p95ms !== null && result.p95ms > p95Threshold) {
      allPassed = false;
    }
    if (result.errorRate > errorRateThreshold) {
      allPassed = false;
    }
  }

  return { results, passed: allPassed };
}

/**
 * Format load test results for display.
 *
 * @param {{ results: Array, passed: boolean, error?: string }} testResult
 * @returns {string}
 */
export function formatLoadTestResults(testResult) {
  if (!testResult) return 'Load test: unavailable';
  if (testResult.error) return `Load test: ${testResult.error}`;
  if (testResult.results.length === 0) return 'Load test: no routes tested';

  const lines = [`Load test: ${testResult.passed ? 'PASSED' : 'FAILED'}`];
  for (const r of testResult.results) {
    const p95 = r.p95ms !== null ? `p95=${r.p95ms}ms` : 'p95=N/A';
    const avg = r.avgMs !== null ? `avg=${r.avgMs}ms` : 'avg=N/A';
    const rps = r.requestsPerSec !== null ? `${r.requestsPerSec} req/s` : 'N/A req/s';
    const err = `err=${r.errorRate}%`;
    lines.push(`  ${r.route}: ${p95}, ${avg}, ${rps}, ${err}`);
  }
  return lines.join('\n');
}
