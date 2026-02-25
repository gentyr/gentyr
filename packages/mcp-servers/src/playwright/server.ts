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
import * as net from 'net';
import * as crypto from 'crypto';
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
  ListExtensionTabsArgsSchema,
  ScreenshotExtensionTabArgsSchema,
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
  type ListExtensionTabsArgs,
  type ScreenshotExtensionTabArgs,
  type ListExtensionTabsResult,
  type ScreenshotExtensionTabResult,
  type ExtensionTab,
  RunAuthSetupArgsSchema,
  type RunAuthSetupArgs,
  type RunAuthSetupResult,
  RunDemoArgsSchema,
  type RunDemoArgs,
  type RunDemoResult,
} from './types.js';
import { parseTestOutput, truncateOutput } from './helpers.js';
import { discoverPlaywrightConfig } from './config-discovery.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const pwConfig = discoverPlaywrightConfig(PROJECT_DIR);
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');
const RUN_TIMEOUT = 300_000; // 5 minutes for test runs

// Convenience mapping for Next.js projects using Supabase — no-op when these vars are absent.
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
 * Two checks:
 *   1. Unresolved op:// references → credential injection failed
 *   2. When the project uses auth (storageState in config), at least one
 *      credential env var must be present — catches completely missing credentials
 *
 * Project-agnostic: no hardcoded credential key names.
 */
function validatePrerequisites(): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check 1: Unresolved 1Password references
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.startsWith('op://')) {
      errors.push(`${name} contains unresolved 1Password reference`);
    }
  }

  // Check 2: When the project uses auth, at least one credential env var should be set.
  // Credential env vars are those injected by mcp-launcher.js from 1Password (typically
  // SUPABASE_URL, DATABASE_URL, API_KEY, etc.). We detect them by checking for env vars
  // that are NOT standard Node/system vars and have non-empty values.
  if (pwConfig.authFiles.length > 0) {
    const credentialVars = Object.entries(process.env).filter(([name, value]) => {
      if (!value || value.startsWith('op://')) return false;
      // Skip known system/Node vars — credential vars are the remainder
      const isSystem = /^(PATH|HOME|USER|SHELL|TERM|LANG|LC_|TMPDIR|PWD|OLDPWD|SHLVL|_|NODE|npm_|CLAUDE_|GENTYR_|HTTPS?_PROXY|NO_PROXY|HOSTNAME|LOGNAME|DISPLAY|XDG_|SSH_|GPG_)/i.test(name);
      return !isSystem;
    });
    if (credentialVars.length === 0) {
      errors.push('No credential environment variables found — 1Password injection may have failed entirely');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

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
      child.stderr.removeAllListeners('data');
      child.stderr.resume(); // keep pipe open and draining to prevent SIGPIPE
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
 * Launch Playwright tests in headed auto-play mode.
 * Runs tests in a visible browser at configurable speed via DEMO_SLOW_MO env var.
 * Validates prerequisites, spawns a detached process, and monitors for early crashes.
 */
async function runDemo(args: RunDemoArgs): Promise<RunDemoResult> {
  const { project, slow_mo, base_url } = args;

  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      project,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  const cmdArgs = ['playwright', 'test', '--project', project, '--headed'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (slow_mo !== undefined) {
    env.DEMO_SLOW_MO = String(slow_mo);
  }

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

    // Wait up to 15s for early crash detection (longer than UI mode — headed browser + webServer startup is slower)
    const earlyExit = await new Promise<{ code: number | null; signal: string | null } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), 15000);

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
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
      return {
        success: false,
        project,
        message: `Playwright process crashed within 15s (exit code: ${earlyExit.code}, signal: ${earlyExit.signal})${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    // Still running after 15s — detach and return success
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.resume(); // keep pipe open and draining to prevent SIGPIPE
    }
    child.unref();

    const warningText = preflight.warnings.length > 0
      ? `\nWarnings:\n${preflight.warnings.map(w => `  - ${w}`).join('\n')}`
      : '';

    return {
      success: true,
      project,
      message: `Headed auto-play demo launched for project "${project}" with ${slow_mo}ms slow motion. The browser window should open shortly.${warningText}`,
      pid: child.pid,
      slow_mo,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      project,
      message: `Failed to launch headed demo: ${message}`,
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
 * Projects are discovered dynamically from playwright.config.ts.
 */
function getCoverageStatus(): GetCoverageStatusResult {
  const personas: CoverageEntry[] = [];
  let totalTests = 0;
  let activeProjects = 0;
  let deferredProjects = 0;

  // Active test directories (discovered from playwright.config.ts)
  for (const [project, testDir] of Object.entries(pwConfig.projectDirMap)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    const testCount = countTestFiles(fullDir, project);

    const entry: CoverageEntry = {
      project,
      persona: pwConfig.personaMap[project] || project,
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

  // Deferred test directories: scan <defaultTestDir>/_deferred/ for subdirectories
  const deferredBase = path.join(PROJECT_DIR, pwConfig.defaultTestDir, '_deferred');
  if (fs.existsSync(deferredBase)) {
    try {
      const subdirs = fs.readdirSync(deferredBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const name of subdirs) {
        const testDir = path.join(pwConfig.defaultTestDir, '_deferred', name);
        const fullDir = path.join(PROJECT_DIR, testDir);
        const testCount = countTestFiles(fullDir);

        const personaLabel = name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

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
    } catch {
      // _deferred directory unreadable — skip
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

    // Exclude manual/ subdirectory for extension projects (counted separately as extension-manual)
    if (projectFilter) {
      const discovered = pwConfig.projects.find(p => p.name === projectFilter);
      if (discovered?.isExtension && !discovered.isManual && filename.includes('manual/')) return false;
    }

    return true;
  }).length;
}

// parseTestOutput and truncateOutput imported from ./helpers.js

// ============================================================================
// Preflight Check
// ============================================================================

// Extension projects discovered from playwright.config.ts (names containing 'extension' or 'demo')

/**
 * Validate a Chrome extension match pattern per the Chrome docs spec.
 * <scheme>://<host>/<path> where host is * | *.domain | exact domain.
 * file:// has empty host (file:///path). No partial wildcards.
 */
function isValidChromeMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  if (/^file:\/\/\/(.+)$/.test(pattern)) return true;
  const m = pattern.match(/^(\*|https?):\/\/([^/]+)\/(.*)$/);
  if (!m) return false;
  const host = m[2];
  if (host === '*') return true;
  if (host.startsWith('*.')) return !host.slice(2).includes('*');
  return !host.includes('*');
}

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
      const testDir = pwConfig.projectDirMap[args.project!];
      if (!testDir) {
        return { status: 'skip', message: `No known test directory mapping for project "${args.project}" — compilation check (#6) will validate it` };
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

  // 8. Auth state freshness (only when a project is specified)
  if (args.project) {
    checks.push(runCheck('auth_state', () => {
      const authDir = path.join(PROJECT_DIR, '.auth');

      // Find primary auth file: from config discovery, or scan .auth/
      let primaryFilePath: string | null = null;
      if (pwConfig.primaryAuthFile) {
        primaryFilePath = path.join(PROJECT_DIR, pwConfig.primaryAuthFile);
      } else if (fs.existsSync(authDir)) {
        try {
          const files = fs.readdirSync(authDir).filter(f => f.endsWith('.json'));
          if (files.length > 0) {
            // Use the most recently modified
            const sorted = files
              .map(f => ({ f, mtime: fs.statSync(path.join(authDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            primaryFilePath = path.join(authDir, sorted[0].f);
          }
        } catch {
          // ignore
        }
      }

      if (!primaryFilePath || !fs.existsSync(primaryFilePath)) {
        // Fail-closed: if config declares storageState files, missing auth is a failure.
        // Skip only when the project genuinely has no auth files configured.
        if (pwConfig.authFiles.length > 0) {
          return {
            status: 'fail',
            message: `Auth state file missing — expected ${pwConfig.primaryAuthFile || '.auth/*.json'}. Run mcp__playwright__run_auth_setup`,
          };
        }
        return { status: 'skip', message: 'No auth state files configured in playwright.config' };
      }

      const primaryBasename = path.basename(primaryFilePath);
      const stat = fs.statSync(primaryFilePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = ageMs / (1000 * 60 * 60);

      // Check cookie expiry from inside the JSON
      try {
        const state = JSON.parse(fs.readFileSync(primaryFilePath, 'utf-8'));
        const cookies: Array<{ expires?: number }> = state.cookies || [];
        const now = Date.now() / 1000;
        const expired = cookies.filter(c => c.expires && c.expires > 0 && c.expires < now);
        if (expired.length > 0) {
          return { status: 'fail', message: `Auth cookies are expired (${expired.length} expired in .auth/${primaryBasename}) — run mcp__playwright__run_auth_setup` };
        }
      } catch {
        return { status: 'warn', message: `Could not parse .auth/${primaryBasename} (${ageHours.toFixed(1)}h old)` };
      }

      if (ageHours > 24) {
        return { status: 'fail', message: `.auth files are ${ageHours.toFixed(1)}h old — run mcp__playwright__run_auth_setup` };
      }
      if (ageHours > 4) {
        return { status: 'warn', message: `.auth files are ${ageHours.toFixed(1)}h old — may expire soon` };
      }
      return { status: 'pass', message: `.auth files are ${ageHours.toFixed(1)}h old — fresh` };
    }));
  } else {
    checks.push({ name: 'auth_state', status: 'skip', message: 'No project specified — skipping auth state check', duration_ms: 0 });
  }

  // 9. Extension manifest validation (only for extension projects)
  if (args.project && pwConfig.extensionProjects.has(args.project)) {
    checks.push(runCheck('extension_manifest', () => {
      const distPath = process.env.GENTYR_EXTENSION_DIST_PATH;
      if (!distPath) {
        return { status: 'skip', message: 'GENTYR_EXTENSION_DIST_PATH not set — skipping manifest validation' };
      }

      // Try manifest at dist path, then parent directory
      const primaryPath = path.join(PROJECT_DIR, distPath, 'manifest.json');
      const fallbackPath = path.join(PROJECT_DIR, path.dirname(distPath), 'manifest.json');
      let manifestPath: string | null = null;

      if (fs.existsSync(primaryPath)) {
        manifestPath = primaryPath;
      } else if (fs.existsSync(fallbackPath)) {
        manifestPath = fallbackPath;
      }

      if (!manifestPath) {
        return { status: 'fail', message: `manifest.json not found at ${primaryPath} or ${fallbackPath}` };
      }

      let manifest: { content_scripts?: Array<{ matches?: string[]; exclude_matches?: string[] }> };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'fail', message: `Failed to parse ${manifestPath}: ${msg}` };
      }

      const invalidPatterns: string[] = [];
      const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      for (let i = 0; i < contentScripts.length; i++) {
        const cs = contentScripts[i];
        if (!cs || typeof cs !== 'object') continue;
        const allPatterns: Array<[string, string]> = [
          ...((Array.isArray(cs.matches) ? cs.matches : []) as string[]).map(p => ['matches', p] as [string, string]),
          ...((Array.isArray(cs.exclude_matches) ? cs.exclude_matches : []) as string[]).map(p => ['exclude_matches', p] as [string, string]),
        ];
        for (const [field, pattern] of allPatterns) {
          if (typeof pattern === 'string' && !isValidChromeMatchPattern(pattern)) {
            invalidPatterns.push(`content_scripts[${i}].${field}: ${pattern}`);
          }
        }
      }

      if (invalidPatterns.length > 0) {
        return {
          status: 'fail',
          message: `Invalid match patterns in ${path.relative(PROJECT_DIR, manifestPath)}:\n${invalidPatterns.map(p => `  - ${p}`).join('\n')}`,
        };
      }

      const totalPatterns = contentScripts.reduce((sum, cs) => {
        if (!cs || typeof cs !== 'object') return sum;
        return sum + (Array.isArray(cs.matches) ? cs.matches.length : 0) + (Array.isArray(cs.exclude_matches) ? cs.exclude_matches.length : 0);
      }, 0);
      return { status: 'pass', message: `${totalPatterns} match pattern(s) validated in ${path.relative(PROJECT_DIR, manifestPath)}` };
    }));
  } else {
    checks.push({ name: 'extension_manifest', status: 'skip', message: args.project ? `Project "${args.project}" is not an extension project` : 'No project specified', duration_ms: 0 });
  }

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
        recoverySteps.push('Check 1Password credential injection — ensure all op:// references in MCP server env are resolved');
        break;
      case 'compilation':
        recoverySteps.push('Fix TypeScript compilation errors — run: npx playwright test --list to see details');
        break;
      case 'auth_state':
        recoverySteps.push('Run: mcp__playwright__run_auth_setup() to refresh auth cookies');
        break;
      case 'extension_manifest':
        recoverySteps.push('Fix invalid match patterns in manifest.json — Chrome requires host to be * | *.domain.com | exact.domain.com (no partial wildcards like *-admin.example.com)');
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
// Auth Setup
// ============================================================================

/**
 * Refresh Playwright auth state by running seed + auth-setup projects.
 * Seeds test data first, then runs the auth-setup project to generate .auth/*.json files.
 */
async function runAuthSetup(args: RunAuthSetupArgs): Promise<RunAuthSetupResult> {
  const startTime = Date.now();
  const prereq = validatePrerequisites();
  if (!prereq.ok) {
    return {
      success: false,
      phases: [],
      auth_files_refreshed: [],
      total_duration_ms: 0,
      error: `Credential check failed: ${prereq.errors.join('; ')}`,
      output_summary: '',
    };
  }

  const phases: RunAuthSetupResult['phases'] = [];

  // Phase 1: Seed
  const seedStart = Date.now();
  try {
    execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
      timeout: 60_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env as Record<string, string>,
    });
    phases.push({ name: 'seed', success: true, message: 'Seed completed', duration_ms: Date.now() - seedStart });
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string };
    const msg = (execErr.stderr || execErr.message || 'unknown').slice(0, 300);
    phases.push({ name: 'seed', success: false, message: `Seed failed: ${msg}`, duration_ms: Date.now() - seedStart });
    return {
      success: false,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: 'Seed phase failed — auth-setup aborted',
      output_summary: msg.slice(0, 500),
    };
  }

  if (args.seed_only) {
    return {
      success: true,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      output_summary: 'Seed only',
    };
  }

  // Phase 2: Auth setup
  const authStart = Date.now();
  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=auth-setup'], {
      cwd: PROJECT_DIR,
      timeout: 240_000, // 4 min: web server startup + 4 persona sign-ins
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env as Record<string, string>,
    });
    phases.push({ name: 'auth-setup', success: true, message: 'Auth setup completed', duration_ms: Date.now() - authStart });

    const authDir = path.join(PROJECT_DIR, '.auth');
    const expected = pwConfig.authFiles.length > 0
      ? pwConfig.authFiles.map(f => path.basename(f))
      : (fs.existsSync(authDir) ? fs.readdirSync(authDir).filter(f => f.endsWith('.json')) : []);
    const refreshed = expected.filter(f => fs.existsSync(path.join(authDir, f)));

    return {
      success: true,
      phases,
      auth_files_refreshed: refreshed,
      total_duration_ms: Date.now() - startTime,
      output_summary: truncateOutput(output, 1000),
    };
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const msg = ((execErr.stderr || '') + (execErr.stdout || '') || execErr.message || 'unknown').slice(0, 500);
    phases.push({ name: 'auth-setup', success: false, message: `Auth setup failed: ${msg.slice(0, 300)}`, duration_ms: Date.now() - authStart });
    return {
      success: false,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: 'Auth setup phase failed',
      output_summary: msg,
    };
  }
}

/**
 * List all open tabs in the CDP-connected extension test browser.
 * Requires --remote-debugging-port to be exposed in the fixture.
 */
async function listExtensionTabs(args: ListExtensionTabsArgs): Promise<ListExtensionTabsResult> {
  const { port } = args;

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/json',
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const raw = JSON.parse(data) as Array<{
              id: string;
              title: string;
              url: string;
              type: string;
            }>;
            const tabs: ExtensionTab[] = raw
              .filter(t => t.type === 'page' || t.type === 'background_page' || t.url.startsWith('chrome-extension://'))
              .map(t => ({ id: t.id, title: t.title, url: t.url, type: t.type }));
            resolve({
              success: true,
              tabs,
              message: `Found ${tabs.length} tab(s) in extension browser (port ${port})`,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            resolve({ success: false, tabs: [], message: `Failed to parse CDP response: ${msg}` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        tabs: [],
        message: `CDP endpoint at port ${port} did not respond within 5s. Is the extension browser running with --remote-debugging-port=${port}?`,
      });
    });
    req.on('error', () => {
      resolve({
        success: false,
        tabs: [],
        message: `Cannot connect to CDP endpoint at port ${port}. Launch extension tests first (mcp__playwright__launch_ui_mode with project "demo" or "extension-manual").`,
      });
    });
    req.end();
  });
}

/**
 * Take a screenshot of a specific tab in the CDP-connected extension test browser.
 * Returns a base64 PNG image for inline rendering in Claude Code.
 */
async function screenshotExtensionTab(args: ScreenshotExtensionTabArgs): Promise<ScreenshotExtensionTabResult> {
  const { port, url_pattern, tab_id } = args;

  // Step 1: List tabs
  const listResult = await listExtensionTabs({ port });
  if (!listResult.success || listResult.tabs.length === 0) {
    return {
      success: false,
      message: listResult.success
        ? `No tabs found in extension browser at port ${port}`
        : listResult.message,
    };
  }

  // Step 2: Find the target tab
  let targetTab: ExtensionTab | undefined;

  if (tab_id) {
    targetTab = listResult.tabs.find(t => t.id === tab_id);
    if (!targetTab) {
      return {
        success: false,
        message: `Tab with id "${tab_id}" not found. Available tabs: ${listResult.tabs.map(t => t.id).join(', ')}`,
      };
    }
  } else if (url_pattern) {
    targetTab = listResult.tabs.find(t => t.url.includes(url_pattern));
    if (!targetTab) {
      // Fall back to first tab
      targetTab = listResult.tabs[0];
    }
  } else {
    targetTab = listResult.tabs[0];
  }

  if (!targetTab) {
    return { success: false, message: 'No tab selected' };
  }

  const selectedTab = targetTab;

  // Step 3: Activate the tab via CDP HTTP endpoint
  await new Promise<void>((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: `/json/activate/${selectedTab.id}`, method: 'GET', timeout: 3000 },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });

  // Step 4: Get WebSocket debugger URL for this tab
  const wsDebuggerUrl = await new Promise<string | null>((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: `/json`, method: 'GET', timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data) as Array<{ id: string; webSocketDebuggerUrl?: string }>;
            const tab = tabs.find(t => t.id === selectedTab.id);
            resolve(tab?.webSocketDebuggerUrl ?? null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });

  if (!wsDebuggerUrl) {
    return {
      success: false,
      tab: selectedTab,
      message: `Failed to get WebSocket debugger URL for tab "${selectedTab.title}" (${selectedTab.url})`,
    };
  }

  // Step 5: Connect via raw WebSocket and capture screenshot via CDP Page.captureScreenshot
  const base64png = await new Promise<string | null>((resolve) => {
    const url = new URL(wsDebuggerUrl);
    const wsPort = parseInt(url.port || String(port));

    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: url.hostname, port: wsPort }, () => {
      const handshake = [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      socket.write(handshake);
    });

    let upgraded = false;
    let buffer = Buffer.alloc(0);

    socket.setTimeout(10000);
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        upgraded = true;
        buffer = buffer.slice(headerEnd + 4);

        // Send Page.captureScreenshot
        const msg = JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } });
        const msgBytes = Buffer.from(msg, 'utf8');
        const mask = crypto.randomBytes(4);

        // Build WebSocket frame: FIN=1, opcode=1 (text), MASK=1, payload length
        let headerBuf: Buffer;
        if (msgBytes.length < 126) {
          headerBuf = Buffer.alloc(6); // 2 bytes header + 4 bytes mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | msgBytes.length;
          mask.copy(headerBuf, 2);
        } else if (msgBytes.length < 65536) {
          headerBuf = Buffer.alloc(8); // 2 + 2 extended len + 4 mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | 126;
          headerBuf.writeUInt16BE(msgBytes.length, 2);
          mask.copy(headerBuf, 4);
        } else {
          headerBuf = Buffer.alloc(14); // 2 + 8 extended len + 4 mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | 127;
          headerBuf.writeBigUInt64BE(BigInt(msgBytes.length), 2);
          mask.copy(headerBuf, 10);
        }

        const maskedPayload = Buffer.alloc(msgBytes.length);
        for (let i = 0; i < msgBytes.length; i++) {
          maskedPayload[i] = msgBytes[i] ^ mask[i % 4];
        }

        socket.write(Buffer.concat([headerBuf, maskedPayload]));
        return;
      }

      // Parse incoming WebSocket frame(s) — may arrive in chunks
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;

        if (opcode === 0x08) {
          // Connection close
          socket.destroy();
          resolve(null);
          return;
        }

        const isMasked = (buffer[1] & 0x80) !== 0;
        const payloadLenByte = buffer[1] & 0x7f;
        let headerLen = 2 + (isMasked ? 4 : 0);
        let actualLen = payloadLenByte;

        if (payloadLenByte === 126) {
          if (buffer.length < 4) return; // wait for more data
          actualLen = buffer.readUInt16BE(2);
          headerLen = 4 + (isMasked ? 4 : 0);
        } else if (payloadLenByte === 127) {
          if (buffer.length < 10) return; // wait for more data
          actualLen = Number(buffer.readBigUInt64BE(2));
          headerLen = 10 + (isMasked ? 4 : 0);
        }

        if (buffer.length < headerLen + actualLen) return; // wait for complete frame

        let payload = buffer.slice(headerLen, headerLen + actualLen);

        if (isMasked) {
          const maskOffset = headerLen - 4;
          const frameMask = buffer.slice(maskOffset, maskOffset + 4);
          const unmasked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            unmasked[i] = payload[i] ^ frameMask[i % 4];
          }
          payload = unmasked;
        }

        buffer = buffer.slice(headerLen + actualLen);

        try {
          const msgParsed = JSON.parse(payload.toString('utf8')) as { result?: { data?: string } };
          if (msgParsed.result?.data) {
            socket.destroy();
            resolve(msgParsed.result.data);
            return;
          }
        } catch {
          // Not valid JSON or not our message — continue reading
        }
      }
    });
  });

  if (!base64png) {
    return {
      success: false,
      tab: selectedTab,
      message: `Failed to capture screenshot of tab "${selectedTab.title}" (${selectedTab.url})`,
    };
  }

  return {
    success: true,
    tab: selectedTab,
    image: base64png,
    message: `Screenshot captured for tab "${selectedTab.title}" (${selectedTab.url})`,
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
      'Project names are discovered from the target project\'s playwright.config.ts.',
    schema: LaunchUiModeArgsSchema,
    handler: launchUiMode,
  },
  {
    name: 'run_demo',
    description:
      'Launch Playwright tests in a visible headed browser that runs automatically at human-watchable speed. ' +
      'No clicking required — tests play through on their own with configurable pace. ' +
      'Best for presentations and demos. The target project\'s playwright.config.ts must read ' +
      'parseInt(process.env.DEMO_SLOW_MO || "0") in use.launchOptions.slowMo for pace control to work.',
    schema: RunDemoArgsSchema,
    handler: runDemo,
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
      'compilation, dev server, and auth state freshness. ALWAYS run before launch_ui_mode or run_tests. ' +
      'Returns structured result with pass/fail per check and recovery steps.',
    schema: PreflightCheckArgsSchema,
    handler: preflightCheck,
  },
  {
    name: 'run_auth_setup',
    description:
      'Refresh Playwright auth state by running seed + auth-setup projects. ' +
      'Run when .auth/*.json files are missing, expired, or stale (>4h old). ' +
      'Automatically starts the dev server via playwright.config.ts webServer config. ' +
      'Takes 2–4 minutes. Required before demo tests can authenticate.',
    schema: RunAuthSetupArgsSchema,
    handler: runAuthSetup,
  },
  {
    name: 'list_extension_tabs',
    description:
      'List all open tabs in the CDP-connected extension test browser. ' +
      'Requires the extension test browser to be running with --remote-debugging-port=9222. ' +
      'Launch it first with launch_ui_mode({ project: "demo" }) and click a test. ' +
      'Returns tab IDs, titles, and URLs — use with screenshot_extension_tab.',
    schema: ListExtensionTabsArgsSchema,
    handler: listExtensionTabs,
  },
  {
    name: 'screenshot_extension_tab',
    description:
      'Take a screenshot of a specific tab in the extension test browser via CDP. ' +
      'Returns a base64 PNG image that renders inline in Claude Code. ' +
      'Use url_pattern to match by URL substring (e.g. "popup.html", "dashboard"). ' +
      'Requires the extension test browser to be running (see launch_ui_mode with project "demo").',
    schema: ScreenshotExtensionTabArgsSchema,
    handler: screenshotExtensionTab,
  },
];

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
