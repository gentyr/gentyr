#!/usr/bin/env node
/**
 * Playwright E2E MCP Server
 *
 * Provides MCP tools for interacting with the Playwright E2E test
 * infrastructure: launching UI mode for demos, running tests headlessly,
 * seeding/cleaning test data, and checking coverage status.
 *
 * @see specs/global/G028-playwright-e2e-testing.md
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  LaunchUiModeArgsSchema,
  RunTestsArgsSchema,
  SeedDataArgsSchema,
  CleanupDataArgsSchema,
  GetReportArgsSchema,
  GetCoverageStatusArgsSchema,
  type LaunchUiModeArgs,
  type RunTestsArgs,
  type GetReportArgs,
  type LaunchUiModeResult,
  type RunTestsResult,
  type SeedDataResult,
  type CleanupDataResult,
  type GetReportResult,
  type GetCoverageStatusResult,
  type CoverageEntry,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');
const RUN_TIMEOUT = 300_000; // 5 minutes for test runs

/** Persona descriptions for coverage reporting */
const PERSONA_MAP: Record<string, string> = {
  'vendor-owner': 'SaaS Vendor (Owner)',
  'vendor-admin': 'SaaS Vendor (Admin)',
  'vendor-dev': 'SaaS Vendor (Developer)',
  'vendor-viewer': 'SaaS Vendor (Viewer)',
  'cross-persona': 'Cross-Persona Workflows',
  'auth-flows': 'Auth Flows (No Pre-auth)',
  'manual': 'Manual QA Scaffolds',
};

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Launch Playwright in interactive UI mode.
 * Spawns a detached process so the MCP server doesn't block.
 */
function launchUiMode(args: LaunchUiModeArgs): LaunchUiModeResult {
  const { project, base_url } = args;

  const cmdArgs = ['playwright', 'test', '--project', project, '--ui'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (base_url) {
    env.PLAYWRIGHT_BASE_URL = base_url;
  }

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env,
    });

    child.unref();

    return {
      success: true,
      project,
      message: `Playwright UI mode launched for project "${project}". The browser window should open shortly.`,
      pid: child.pid,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      project,
      message: `Failed to launch Playwright UI: ${message}`,
    };
  }
}

/**
 * Run E2E tests headlessly and return results.
 */
function runTests(args: RunTestsArgs): RunTestsResult {
  const cmdArgs = ['playwright', 'test'];

  if (args.project) {
    cmdArgs.push('--project', args.project);
  }
  if (args.grep) {
    cmdArgs.push('--grep', args.grep);
  }
  if (args.retries !== undefined) {
    cmdArgs.push('--retries', String(args.retries));
  }
  if (args.workers !== undefined) {
    cmdArgs.push('--workers', String(args.workers));
  }

  // Use list reporter for parseable output
  cmdArgs.push('--reporter', 'list');

  const projectLabel = args.project || 'default (vendor-owner + cross-persona)';

  try {
    const output = execFileSync('npx', cmdArgs, {
      cwd: PROJECT_DIR,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const { passed, failed, skipped, duration } = parseTestOutput(output);

    return {
      success: failed === 0,
      project: projectLabel,
      passed,
      failed,
      skipped,
      duration,
      output: truncateOutput(output),
    };
  } catch (err) {
    // execSync throws on non-zero exit code (test failures)
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');
    const { passed, failed, skipped, duration } = parseTestOutput(output);

    return {
      success: false,
      project: projectLabel,
      passed,
      failed: failed || 1, // At least 1 failure if we're in the catch
      skipped,
      duration,
      output: truncateOutput(output),
    };
  }
}

/**
 * Seed the E2E test database.
 */
function seedData(): SeedDataResult {
  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      success: true,
      message: 'Test database seeded successfully.',
      output: truncateOutput(output),
    };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');

    return {
      success: false,
      message: `Seeding failed: ${execErr.message || 'Unknown error'}`,
      output: truncateOutput(output),
    };
  }
}

/**
 * Clean up E2E test data.
 */
function cleanupData(): CleanupDataResult {
  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, E2E_CLEANUP: 'true' },
    });

    return {
      success: true,
      message: 'Test data cleaned up successfully.',
      output: truncateOutput(output),
    };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');

    return {
      success: false,
      message: `Cleanup failed: ${execErr.message || 'Unknown error'}`,
      output: truncateOutput(output),
    };
  }
}

/**
 * Get the last Playwright test report.
 */
function getReport(args: GetReportArgs): GetReportResult {
  const reportIndex = path.join(REPORT_DIR, 'index.html');
  const exists = fs.existsSync(reportIndex);

  if (!exists) {
    return {
      success: true,
      reportPath: REPORT_DIR,
      exists: false,
      message: 'No test report found. Run tests first with run_tests.',
    };
  }

  const stats = fs.statSync(reportIndex);
  const lastModified = stats.mtime.toISOString();

  let browserOpened = false;
  let browserError: string | null = null;

  if (args.open_browser) {
    try {
      spawn('npx', ['playwright', 'show-report'], {
        detached: true,
        stdio: 'ignore',
        cwd: PROJECT_DIR,
      }).unref();
      browserOpened = true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      browserError = `Failed to open report in browser: ${errMsg}`;
      process.stderr.write(`[playwright] ${browserError}\n`);
    }
  }

  const statusMsg = args.open_browser
    ? (browserOpened
        ? `Report opened in browser. Last generated: ${lastModified}`
        : `Report exists but browser failed to open: ${browserError}. Last generated: ${lastModified}`)
    : `Report available at ${REPORT_DIR}. Last generated: ${lastModified}. Use open_browser: true to view.`;

  return {
    success: true,
    reportPath: REPORT_DIR,
    exists: true,
    lastModified,
    message: statusMsg,
  };
}

/**
 * Check E2E test coverage by persona and page.
 * Reads the filesystem to determine which projects have tests.
 */
function getCoverageStatus(): GetCoverageStatusResult {
  const personas: CoverageEntry[] = [];
  let totalTests = 0;
  let activeProjects = 0;
  let deferredProjects = 0;

  // Active test directories
  const activeDirs: Record<string, string> = {
    'vendor-owner': 'e2e/vendor',
    'vendor-admin': 'e2e/vendor-roles',
    'vendor-dev': 'e2e/vendor-roles',
    'vendor-viewer': 'e2e/vendor-roles',
    'cross-persona': 'e2e/cross-persona',
    'auth-flows': 'e2e/auth',
    'manual': 'e2e/manual',
  };

  for (const [project, testDir] of Object.entries(activeDirs)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    const testCount = countTestFiles(fullDir, project);

    const entry: CoverageEntry = {
      project,
      persona: PERSONA_MAP[project] || project,
      testDir,
      testCount,
      status: testCount > 0 ? 'active' : 'no-tests',
    };

    if (testCount > 0) {
      activeProjects++;
      totalTests += testCount;
    }

    personas.push(entry);
  }

  // Deferred test directories
  const deferredDirs: Record<string, string> = {
    'extension': 'e2e/_deferred/extension',
    'operator': 'e2e/_deferred/operator',
  };

  for (const [name, testDir] of Object.entries(deferredDirs)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    const testCount = countTestFiles(fullDir);

    const personaLabel = name === 'extension' ? 'End Customer (Extension)' : 'Platform Operator';

    personas.push({
      project: `deferred-${name}`,
      persona: personaLabel,
      testDir,
      testCount,
      status: 'deferred',
    });

    if (testCount > 0) {
      deferredProjects++;
    }
  }

  return {
    personas,
    totalTests,
    activeProjects,
    deferredProjects,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Count test files (*.spec.ts) in a directory.
 */
function countTestFiles(dir: string, projectFilter?: string): number {
  if (!fs.existsSync(dir)) return 0;

  try {
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    return files.filter(f => {
      const filename = String(f);
      if (!filename.endsWith('.spec.ts')) return false;

      // For role-specific projects, filter by matching spec file
      if (projectFilter === 'vendor-admin') return filename.includes('admin');
      if (projectFilter === 'vendor-dev') return filename.includes('developer');
      if (projectFilter === 'vendor-viewer') return filename.includes('viewer');

      return true;
    }).length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[playwright] Failed to read test directory ${dir}: ${message}\n`);
    return 0;
  }
}

/**
 * Parse Playwright test output for pass/fail/skip counts.
 */
function parseTestOutput(output: string): {
  passed: number;
  failed: number;
  skipped: number;
  duration: string;
} {
  // Playwright outputs lines like: "  10 passed (5.2s)"
  const passedMatch = output.match(/(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  const skippedMatch = output.match(/(\d+)\s+skipped/);
  const durationMatch = output.match(/\((\d+\.?\d*s)\)/);

  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
    duration: durationMatch ? durationMatch[1] : 'unknown',
  };
}

/**
 * Truncate output to prevent huge MCP responses.
 */
function truncateOutput(output: string, maxLength = 4000): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + '\n... (output truncated)';
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'launch_ui_mode',
    description:
      'Launch Playwright in interactive UI mode for manual testing and demos. ' +
      'Opens a browser with the Playwright test runner UI. ' +
      'Use project "manual" for demos (page.pause() for human interaction), ' +
      'or a vendor role project to test as a specific persona.',
    schema: LaunchUiModeArgsSchema,
    handler: launchUiMode,
  },
  {
    name: 'run_tests',
    description:
      'Run Playwright E2E tests headlessly and return pass/fail results. ' +
      'Filter by project (persona) or test name pattern. ' +
      'Runs seed + auth-setup automatically as dependencies.',
    schema: RunTestsArgsSchema,
    handler: runTests,
  },
  {
    name: 'seed_data',
    description:
      'Seed the E2E test database with deterministic test data. ' +
      'Creates vendor accounts, customers, integrations, webhooks, API keys, and audit entries. ' +
      'Idempotent — safe to run multiple times.',
    schema: SeedDataArgsSchema,
    handler: seedData,
  },
  {
    name: 'cleanup_data',
    description:
      'Clean up E2E test data from the database. ' +
      'Removes all e2e-* prefixed test records. ' +
      'Set E2E_CLEANUP=true internally.',
    schema: CleanupDataArgsSchema,
    handler: cleanupData,
  },
  {
    name: 'get_report',
    description:
      'Get the last Playwright HTML test report. ' +
      'Shows report path, last modified time, and optionally opens in browser.',
    schema: GetReportArgsSchema,
    handler: getReport,
  },
  {
    name: 'get_coverage_status',
    description:
      'Check E2E test coverage by persona and page. ' +
      'Returns a matrix of all Playwright projects with test counts, ' +
      'persona labels, and active/deferred status.',
    schema: GetCoverageStatusArgsSchema,
    handler: getCoverageStatus,
  },
];

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
