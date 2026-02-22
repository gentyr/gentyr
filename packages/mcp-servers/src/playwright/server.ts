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
import * as os from 'os';
import * as http from 'http';
import { spawn, execFileSync } from 'child_process';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  LaunchUiModeArgsSchema,
  RunTestsArgsSchema,
  SeedDataArgsSchema,
  CleanupDataArgsSchema,
  GetReportArgsSchema,
  GetCoverageStatusArgsSchema,
  PreflightCheckArgsSchema,
  type LaunchUiModeArgs,
  type RunTestsArgs,
  type GetReportArgs,
  type PreflightCheckArgs,
  type LaunchUiModeResult,
  type RunTestsResult,
  type SeedDataResult,
  type CleanupDataResult,
  type GetReportResult,
  type GetCoverageStatusResult,
  type CoverageEntry,
  type PreflightCheckEntry,
  type PreflightCheckResult,
} from './types.js';
import { parseTestOutput, truncateOutput } from './helpers.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');
const RUN_TIMEOUT = 300_000; // 5 minutes for test runs

// Map standard env names to NEXT_PUBLIC_ variants for Next.js webServer.
// Credentials are injected by mcp-launcher.js from 1Password at runtime.
if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (process.env.SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
}

/**
 * Kill any processes listening on the dev server port (default 3000).
 * Prevents zombie servers from previous runs causing port conflicts.
 */
function cleanupDevServerPort(port = 3000): void {
  try {
    const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (lsofOutput) {
      const pids = lsofOutput.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // No processes on port — nothing to clean up
  }
}

// ============================================================================
// Pre-flight Validation
// ============================================================================

interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate that required environment variables are set and resolved.
 * Catches broken 1Password injection (op:// references still present)
 * and missing Supabase credentials before spawning Playwright.
 */
function validatePrerequisites(): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

  for (const name of required) {
    const value = process.env[name];
    if (!value) {
      errors.push(`${name} is not set`);
    } else if (value.startsWith('op://')) {
      errors.push(`${name} contains unresolved 1Password reference (op:// prefix detected)`);
    }
  }

  const optional = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

  for (const name of optional) {
    const value = process.env[name];
    if (!value) {
      warnings.push(`${name} is not set (will be derived from SUPABASE_* if available)`);
    } else if (value.startsWith('op://')) {
      errors.push(`${name} contains unresolved 1Password reference (op:// prefix detected)`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Persona descriptions for coverage reporting */
const PERSONA_MAP: Record<string, string> = {
  'vendor-owner': 'SaaS Vendor (Owner)',
  'vendor-admin': 'SaaS Vendor (Admin)',
  'vendor-dev': 'SaaS Vendor (Developer)',
  'vendor-viewer': 'SaaS Vendor (Viewer)',
  'cross-persona': 'Cross-Persona Workflows',
  'auth-flows': 'Auth Flows (No Pre-auth)',
  'manual': 'Manual QA Scaffolds',
  'extension': 'End Customer (Extension)',
  'extension-manual': 'Extension Manual QA',
  'demo': 'Unified Demo (Dashboard + Extension)',
};

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Launch Playwright in interactive UI mode.
 * Validates prerequisites, spawns a detached process, and monitors for early crashes.
 */
async function launchUiMode(args: LaunchUiModeArgs): Promise<LaunchUiModeResult> {
  const { project, base_url } = args;

  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      project,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  const cmdArgs = ['playwright', 'test', '--project', project, '--ui'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (base_url) {
    env.PLAYWRIGHT_BASE_URL = base_url;
  }

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: PROJECT_DIR,
      env,
    });

    // Collect stderr for crash diagnostics
    let stderrChunks: Buffer[] = [];
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
    }

    // Wait up to 3s for early crash detection
    const earlyExit = await new Promise<{ code: number | null; signal: string | null } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);

        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: 1, signal: err.message });
        });
      }
    );

    if (earlyExit) {
      // Process died within 3s — report the failure
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
      return {
        success: false,
        project,
        message: `Playwright process crashed within 3s (exit code: ${earlyExit.code}, signal: ${earlyExit.signal})${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    // Still running after 3s — detach and return success
    if (child.stderr) {
      child.stderr.destroy();
    }
    child.unref();

    const warningText = preflight.warnings.length > 0
      ? `\nWarnings:\n${preflight.warnings.map(w => `  - ${w}`).join('\n')}`
      : '';

    return {
      success: true,
      project,
      message: `Playwright UI mode launched for project "${project}". The browser window should open shortly.${warningText}`,
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
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    const projectLabel = args.project || 'default (vendor-owner + cross-persona)';
    return {
      success: false,
      project: projectLabel,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: '0s',
      output: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

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

    // Guard: zero tests executed is not a success
    if (passed === 0 && failed === 0 && skipped === 0) {
      return {
        success: false,
        project: projectLabel,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration,
        output: truncateOutput(output),
        error: 'No tests were executed. Check project filter, test file paths, or Playwright configuration.',
      };
    }

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
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
      output: '',
    };
  }

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

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
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
      output: '',
    };
  }

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

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
    'extension': 'e2e/extension',
    'extension-manual': 'e2e/extension/manual',
    'demo': 'e2e/demo',
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
    'operator': 'e2e/_deferred/operator',
  };

  for (const [name, testDir] of Object.entries(deferredDirs)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    const testCount = countTestFiles(fullDir);

    const personaLabel = 'Platform Operator';

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
 * Count test files in a directory.
 * Matches *.spec.ts for automated tests, *.manual.ts for manual scaffolds.
 */
function countTestFiles(dir: string, projectFilter?: string): number {
  if (!fs.existsSync(dir)) return 0;

  const files = fs.readdirSync(dir, { recursive: true }) as string[];
  return files.filter(f => {
    const filename = String(f);
    const isSpec = filename.endsWith('.spec.ts');
    const isManual = filename.endsWith('.manual.ts');
    if (!isSpec && !isManual) return false;

    // Exclude manual/ subdirectory for the extension project (counted separately as extension-manual)
    if (projectFilter === 'extension' && filename.includes('manual/')) return false;

    // For role-specific projects, filter by matching spec file
    if (projectFilter === 'vendor-admin') return filename.includes('admin');
    if (projectFilter === 'vendor-dev') return filename.includes('developer');
    if (projectFilter === 'vendor-viewer') return filename.includes('viewer');

    return true;
  }).length;
}

// parseTestOutput and truncateOutput imported from ./helpers.js

// ============================================================================
// Preflight Check
// ============================================================================

/**
 * Run a single preflight check and return a structured entry.
 */
function runCheck(
  name: string,
  fn: () => { status: 'pass' | 'fail' | 'warn' | 'skip'; message: string }
): PreflightCheckEntry {
  const start = Date.now();
  try {
    const result = fn();
    return { name, ...result, duration_ms: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `Unexpected error: ${message}`, duration_ms: Date.now() - start };
  }
}

/**
 * Comprehensive pre-flight validation before launching Playwright.
 * Checks config, deps, browsers, test files, credentials, compilation, and dev server.
 */
async function preflightCheck(args: PreflightCheckArgs): Promise<PreflightCheckResult> {
  const startTime = Date.now();
  const checks: PreflightCheckEntry[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const recoverySteps: string[] = [];

  // 1. Config exists
  checks.push(runCheck('config_exists', () => {
    const tsConfig = path.join(PROJECT_DIR, 'playwright.config.ts');
    const jsConfig = path.join(PROJECT_DIR, 'playwright.config.js');
    if (fs.existsSync(tsConfig)) {
      return { status: 'pass', message: `Found playwright.config.ts` };
    }
    if (fs.existsSync(jsConfig)) {
      return { status: 'pass', message: `Found playwright.config.js` };
    }
    return { status: 'fail', message: 'No playwright.config.ts or playwright.config.js found' };
  }));

  // 2. Dependencies installed
  checks.push(runCheck('dependencies_installed', () => {
    const pwTestDir = path.join(PROJECT_DIR, 'node_modules', '@playwright', 'test');
    if (fs.existsSync(pwTestDir)) {
      return { status: 'pass', message: '@playwright/test is installed' };
    }
    return { status: 'fail', message: '@playwright/test not found in node_modules' };
  }));

  // 3. Browsers installed
  checks.push(runCheck('browsers_installed', () => {
    const homedir = os.homedir();
    const cacheLocations = [
      path.join(homedir, 'Library', 'Caches', 'ms-playwright'),
      path.join(homedir, '.cache', 'ms-playwright'),
    ];

    for (const cacheDir of cacheLocations) {
      if (!fs.existsSync(cacheDir)) continue;
      try {
        const entries = fs.readdirSync(cacheDir);
        const chromium = entries.find(e => e.startsWith('chromium-'));
        if (chromium) {
          return { status: 'pass', message: `Chromium found in ${cacheDir}` };
        }
      } catch {
        continue;
      }
    }
    return { status: 'fail', message: 'No Chromium browser found in Playwright cache' };
  }));

  // 4. Test files exist (when project specified)
  if (args.project) {
    checks.push(runCheck('test_files_exist', () => {
      const activeDirs: Record<string, string> = {
        'vendor-owner': 'e2e/vendor',
        'vendor-admin': 'e2e/vendor-roles',
        'vendor-dev': 'e2e/vendor-roles',
        'vendor-viewer': 'e2e/vendor-roles',
        'cross-persona': 'e2e/cross-persona',
        'auth-flows': 'e2e/auth',
        'manual': 'e2e/manual',
        'extension': 'e2e/extension',
        'extension-manual': 'e2e/extension/manual',
        'demo': 'e2e/demo',
      };

      const testDir = activeDirs[args.project!];
      if (!testDir) {
        return { status: 'warn', message: `No known test directory for project "${args.project}"` };
      }

      const fullDir = path.join(PROJECT_DIR, testDir);
      const count = countTestFiles(fullDir, args.project);
      if (count > 0) {
        return { status: 'pass', message: `${count} test file(s) found in ${testDir}` };
      }
      return { status: 'fail', message: `No test files found in ${testDir} for project "${args.project}"` };
    }));
  } else {
    checks.push({ name: 'test_files_exist', status: 'skip', message: 'No project specified — skipping test file check', duration_ms: 0 });
  }

  // 5. Credentials valid
  checks.push(runCheck('credentials_valid', () => {
    const preflight = validatePrerequisites();
    if (preflight.ok) {
      const warnMsg = preflight.warnings.length > 0
        ? ` (${preflight.warnings.length} warning(s))`
        : '';
      return { status: 'pass', message: `All required credentials are set${warnMsg}` };
    }
    return { status: 'fail', message: preflight.errors.join('; ') };
  }));

  // 6. Compilation succeeds (unless skipped)
  if (!args.skip_compilation && args.project) {
    checks.push(runCheck('compilation', () => {
      try {
        const listArgs = ['playwright', 'test', '--list', '--project', args.project!];
        const output = execFileSync('npx', listArgs, {
          cwd: PROJECT_DIR,
          timeout: 30_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env as Record<string, string>,
        });

        // Check if any tests were listed
        const lines = output.trim().split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) {
          return { status: 'fail', message: 'Compilation succeeded but no tests were listed' };
        }
        return { status: 'pass', message: `${lines.length} test(s) listed successfully` };
      } catch (err) {
        const execErr = err as { stderr?: string; message?: string };
        const stderr = (execErr.stderr || '').trim();
        const snippet = stderr.length > 300 ? stderr.slice(0, 300) + '...' : stderr;
        return { status: 'fail', message: `Compilation/list failed: ${snippet || execErr.message || 'unknown error'}` };
      }
    }));
  } else {
    const reason = args.skip_compilation ? 'skip_compilation=true' : 'no project specified';
    checks.push({ name: 'compilation', status: 'skip', message: `Skipped (${reason})`, duration_ms: 0 });
  }

  // 7. Dev server reachable (warning only)
  const baseUrl = args.base_url || 'http://localhost:3000';
  const devServerCheck = await new Promise<PreflightCheckEntry>((resolve) => {
    const start = Date.now();
    const url = new URL(baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'HEAD',
        timeout: 5000,
      },
      (res) => {
        resolve({
          name: 'dev_server',
          status: 'pass',
          message: `Dev server at ${baseUrl} responded with ${res.statusCode}`,
          duration_ms: Date.now() - start,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        name: 'dev_server',
        status: 'warn',
        message: `Dev server at ${baseUrl} did not respond within 5s (may auto-start via playwright.config.ts webServer)`,
        duration_ms: Date.now() - start,
      });
    });
    req.on('error', () => {
      resolve({
        name: 'dev_server',
        status: 'warn',
        message: `Dev server at ${baseUrl} is not reachable (may auto-start via playwright.config.ts webServer)`,
        duration_ms: Date.now() - start,
      });
    });
    req.end();
  });
  checks.push(devServerCheck);

  // Aggregate results
  for (const check of checks) {
    if (check.status === 'fail') {
      failures.push(`${check.name}: ${check.message}`);
    } else if (check.status === 'warn') {
      warnings.push(`${check.name}: ${check.message}`);
    }
  }

  // Generate recovery steps for failures
  for (const check of checks) {
    if (check.status !== 'fail') continue;
    switch (check.name) {
      case 'config_exists':
        recoverySteps.push('Create playwright.config.ts in the project root (see Playwright docs)');
        break;
      case 'dependencies_installed':
        recoverySteps.push('Run: pnpm add -D @playwright/test');
        break;
      case 'browsers_installed':
        recoverySteps.push('Run: npx playwright install chromium');
        break;
      case 'test_files_exist':
        recoverySteps.push(`Create test files in the expected directory for project "${args.project}"`);
        break;
      case 'credentials_valid':
        recoverySteps.push('Check 1Password credential injection — ensure MCP server has SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
        break;
      case 'compilation':
        recoverySteps.push('Fix TypeScript compilation errors — run: npx playwright test --list to see details');
        break;
    }
  }

  return {
    ready: failures.length === 0,
    project: args.project || null,
    checks,
    failures,
    warnings,
    recovery_steps: recoverySteps,
    total_duration_ms: Date.now() - startTime,
  };
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
      'Use project "demo" for full product demos (dashboard + extension in one session), ' +
      '"manual" for vendor dashboard demos, "extension-manual" for extension demos, ' +
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
  {
    name: 'preflight_check',
    description:
      'Run comprehensive pre-flight validation before launching Playwright. ' +
      'Checks config file, dependencies, browsers, test files, credentials, ' +
      'compilation, and dev server. ALWAYS run before launch_ui_mode or run_tests. ' +
      'Returns structured result with pass/fail per check and recovery steps.',
    schema: PreflightCheckArgsSchema,
    handler: preflightCheck,
  },
];

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
