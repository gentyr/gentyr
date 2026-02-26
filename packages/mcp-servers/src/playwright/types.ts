/**
 * Types for the Playwright E2E MCP Server
 *
 * Provides MCP tools for launching Playwright in UI mode, running E2E tests
 * headlessly, seeding/cleaning test data, and checking test coverage.
 *
 * Project discovery is automatic from playwright.config.ts.
 *
 * @see playwright.config.ts
 * @see specs/global/G028-playwright-e2e-testing.md
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/**
 * @deprecated Use discoverPlaywrightConfig() from config-discovery.ts instead.
 * Kept for backwards compatibility with existing test imports.
 */
export const PLAYWRIGHT_PROJECTS = {
  // SaaS Vendor persona — primary dashboard user
  VENDOR_OWNER: 'vendor-owner',
  VENDOR_ADMIN: 'vendor-admin',
  VENDOR_DEV: 'vendor-dev',
  VENDOR_VIEWER: 'vendor-viewer',

  // Manual QA — interactive inspection with page.pause()
  MANUAL: 'manual',

  // Browser extension (headed Chromium with --load-extension)
  EXTENSION: 'extension',
  EXTENSION_MANUAL: 'extension-manual',

  // Unified demo (dashboard + extension in single session)
  DEMO: 'demo',

  // Infrastructure
  SEED: 'seed',
  AUTH_SETUP: 'auth-setup',

  // Multi-context
  CROSS_PERSONA: 'cross-persona',
  AUTH_FLOWS: 'auth-flows',
} as const;

export type PlaywrightProject = typeof PLAYWRIGHT_PROJECTS[keyof typeof PLAYWRIGHT_PROJECTS];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const LaunchUiModeArgsSchema = z.object({
  project: z.string()
    .min(1)
    .max(100)
    .describe(
      'Playwright project name from the target project\'s playwright.config.ts. ' +
      'Common examples: vendor-owner, manual, extension-manual, demo, cross-persona, auth-flows.'
    ),
  base_url: z.string()
    .url()
    .optional()
    .describe('Override the base URL (default: http://localhost:3000)'),
  test_file: z.string()
    .max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .optional()
    .describe('Relative path to a specific test file. When provided, only this file is shown in the UI.'),
});

export const RunTestsArgsSchema = z.object({
  project: z.string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Playwright project name from the target project\'s playwright.config.ts. ' +
      'If omitted, runs the default project set defined in the config.'
    ),
  grep: z.string()
    .max(200)
    .regex(/^[a-zA-Z0-9\s\-_.*()[\]|]+$/, 'grep pattern must contain only safe characters')
    .optional()
    .describe('Filter tests by title pattern (passed to --grep). Max 200 chars, alphanumeric and basic regex only.'),
  retries: z.coerce.number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe('Number of retries for failed tests (0-5, default: 0 locally, 2 in CI)'),
  workers: z.coerce.number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe('Number of parallel workers (1-16, default: 1 locally, 4 in CI)'),
});

export const SeedDataArgsSchema = z.object({});

export const CleanupDataArgsSchema = z.object({});

export const GetReportArgsSchema = z.object({
  open_browser: z.boolean()
    .optional()
    .default(false)
    .describe('Open the HTML report in the default browser'),
});

export const GetCoverageStatusArgsSchema = z.object({});

export const PreflightCheckArgsSchema = z.object({
  project: z.string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Playwright project name to validate. If omitted, checks general readiness only ' +
      '(config, deps, browsers, credentials). If provided, also validates test files ' +
      'exist and compilation succeeds for that specific project.'
    ),
  base_url: z.string()
    .url()
    .optional()
    .describe('Override base URL for dev server check (default: http://localhost:3000)'),
  skip_compilation: z.boolean()
    .optional()
    .default(false)
    .describe('Skip the compilation check (faster but less thorough)'),
});

export const ListExtensionTabsArgsSchema = z.object({
  port: z.coerce.number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .default(9222)
    .describe('CDP remote debugging port (default: 9222)'),
});

export const ScreenshotExtensionTabArgsSchema = z.object({
  url_pattern: z.string()
    .max(500)
    .optional()
    .describe('Substring to match against tab URL (e.g. "popup.html", "dashboard"). Screenshots the first matching tab, or the first tab if no match.'),
  tab_id: z.string()
    .max(200)
    .optional()
    .describe('Specific CDP tab ID (from list_extension_tabs). Takes precedence over url_pattern.'),
  port: z.coerce.number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .default(9222)
    .describe('CDP remote debugging port (default: 9222)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type LaunchUiModeArgs = z.infer<typeof LaunchUiModeArgsSchema>;
export type RunTestsArgs = z.infer<typeof RunTestsArgsSchema>;
export type SeedDataArgs = z.infer<typeof SeedDataArgsSchema>;
export type CleanupDataArgs = z.infer<typeof CleanupDataArgsSchema>;
export type GetReportArgs = z.infer<typeof GetReportArgsSchema>;
export type GetCoverageStatusArgs = z.infer<typeof GetCoverageStatusArgsSchema>;
export type PreflightCheckArgs = z.infer<typeof PreflightCheckArgsSchema>;

export type PreflightCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface PreflightCheckEntry {
  name: string;
  status: PreflightCheckStatus;
  message: string;
  duration_ms: number;
}

export interface PreflightCheckResult {
  ready: boolean;
  project: string | null;
  checks: PreflightCheckEntry[];
  failures: string[];
  warnings: string[];
  recovery_steps: string[];
  total_duration_ms: number;
}

export const RunAuthSetupArgsSchema = z.object({
  seed_only: z.boolean()
    .optional()
    .default(false)
    .describe('Run only the seed project (skip auth-setup). Useful when just refreshing test data.'),
});

export type RunAuthSetupArgs = z.infer<typeof RunAuthSetupArgsSchema>;

export interface RunAuthSetupResult {
  success: boolean;
  phases: { name: 'seed' | 'auth-setup'; success: boolean; message: string; duration_ms: number }[];
  auth_files_refreshed: string[];
  total_duration_ms: number;
  error?: string;
  output_summary: string;
}

export const RunDemoArgsSchema = z.object({
  project: z.string()
    .min(1)
    .max(100)
    .describe(
      'Playwright project name to run in headed auto-play mode. ' +
      'Read the target project\'s playwright.config.ts to discover available project names. ' +
      'Exclude infrastructure projects (setup, seed, auth-setup) and manual projects (*-manual, manual) ' +
      'which use page.pause() and are incompatible with auto-play.'
    ),
  slow_mo: z.coerce.number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .default(800)
    .describe(
      'Milliseconds to pause between Playwright actions (default: 800). ' +
      'Target project must read process.env.DEMO_SLOW_MO in playwright.config.ts ' +
      'under use.launchOptions.slowMo for this to take effect.'
    ),
  base_url: z.string()
    .url()
    .optional()
    .describe('Override the base URL (default: http://localhost:3000)'),
  test_file: z.string()
    .max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .optional()
    .describe('Relative path to a specific test file (e.g., e2e/demo/onboarding.demo.ts). When provided, only this file runs.'),
  pause_at_end: z.coerce.boolean()
    .optional()
    .default(false)
    .describe('Set DEMO_PAUSE_AT_END=1 env var. Target project demo files that import the shared helper will call page.pause() at the end.'),
});

export type RunDemoArgs = z.infer<typeof RunDemoArgsSchema>;

export interface RunDemoResult {
  success: boolean;
  project: string;
  message: string;
  pid?: number;
  slow_mo?: number;
  test_file?: string;
  pause_at_end?: boolean;
}

export const CheckDemoResultArgsSchema = z.object({
  pid: z.coerce.number().int().min(1)
    .describe('Process ID returned by run_demo.'),
});

export type CheckDemoResultArgs = z.infer<typeof CheckDemoResultArgsSchema>;
export type DemoRunStatus = 'running' | 'passed' | 'failed' | 'unknown';

export interface CheckDemoResultResult {
  status: DemoRunStatus;
  pid: number;
  project?: string;
  test_file?: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  failure_summary?: string;
  screenshot_paths?: string[];
  message: string;
}

export interface DemoRunState {
  pid: number;
  project: string;
  test_file?: string;
  started_at: string;
  status: DemoRunStatus;
  ended_at?: string;
  exit_code?: number;
  failure_summary?: string;
  screenshot_paths?: string[];
}

export interface LaunchUiModeResult {
  success: boolean;
  project: string;
  message: string;
  pid?: number;
  test_file?: string;
}

export interface RunTestsResult {
  success: boolean;
  project: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: string;
  output: string;
  error?: string;
}

export interface SeedDataResult {
  success: boolean;
  message: string;
  output: string;
}

export interface CleanupDataResult {
  success: boolean;
  message: string;
  output: string;
}

export interface GetReportResult {
  success: boolean;
  reportPath: string;
  exists: boolean;
  lastModified?: string;
  message: string;
}

export interface CoverageEntry {
  project: string;
  persona: string;
  testDir: string;
  testCount: number;
  status: 'active' | 'deferred' | 'no-tests';
}

export interface GetCoverageStatusResult {
  personas: CoverageEntry[];
  totalTests: number;
  activeProjects: number;
  deferredProjects: number;
}

export interface ErrorResult {
  error: string;
}

export type ListExtensionTabsArgs = z.infer<typeof ListExtensionTabsArgsSchema>;
export type ScreenshotExtensionTabArgs = z.infer<typeof ScreenshotExtensionTabArgsSchema>;

export interface ExtensionTab {
  id: string;
  title: string;
  url: string;
  type: string;
}

export interface ListExtensionTabsResult {
  success: boolean;
  tabs: ExtensionTab[];
  message: string;
}

export interface ScreenshotExtensionTabResult {
  success: boolean;
  tab?: ExtensionTab;
  message: string;
  image?: string;  // base64 PNG
}
