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
  timeout: z.coerce.number()
    .int()
    .min(30000)
    .max(600000)
    .optional()
    .describe('Per-test timeout in milliseconds (30s-600s). If omitted, uses Playwright config default.'),
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
  timeout: z.coerce.number().int().min(30000).max(600000).optional().default(120000)
    .describe('Per-test timeout in milliseconds (30s-600s, default 120s)'),
  headless: z.coerce.boolean().optional().default(false)
    .describe('Run demos in headless mode. Sets DEMO_HEADLESS=1 env var. Extension demos will auto-skip.'),
  trace: z.coerce.boolean().optional().default(false)
    .describe('Enable Playwright trace recording (--trace on). Default: false.'),
  scenario_id: z.string()
    .describe('Demo scenario ID from user-feedback DB. Required — used for video recording persistence, prerequisite resolution, and env_vars lookup.'),
  skip_recording: z.coerce.boolean().optional().default(false)
    .describe('Skip window recording even in headed mode. Useful for automated validation runs.'),
  success_pause_ms: z.coerce.number().int().min(0).max(30000).optional().default(0)
    .describe('Milliseconds to keep the browser open after a successful demo before teardown (0-30000, default 0). Only applies in headed mode when all tests pass. The technical flush buffer (5s) is always added on top.'),
  stall_timeout_ms: z.coerce.number().int().min(0).max(300000).optional()
    .refine(v => v === undefined || v === 0 || v >= 10000, 'stall_timeout_ms must be 0 (disable) or >= 10000ms (10s)')
    .describe('Stall detection timeout in milliseconds (0 to disable, or 10000-300000). If no stdout/stderr/progress output is produced for this long after the 30s startup grace period, the demo process is killed. Default: 45000 (45s). Increase for demos with slow fixture setup (bridge server, extension rebuild).'),
  extra_env: z.record(z.string(), z.string())
    .optional()
    .describe(
      'Additional environment variables to pass to the Playwright child process. ' +
      'Use for replay data (REPLAY_SESSION_ID, REPLAY_AUDIT_DATA) or custom flags. ' +
      'Max 25 keys, max 512KB total size. Values are not persisted to demo-runs.json.'
    ),
  remote: z.coerce.boolean().optional()
    .describe('Run on remote Fly.io machine. Auto-routes when Fly.io is configured and demo is headless-eligible. Pass false to force local execution.'),
});

export type RunDemoArgs = z.infer<typeof RunDemoArgsSchema>;

export interface RunDemoResult {
  success: boolean;
  project: string;
  message: string;
  pid?: number;
  slow_mo?: number;
  test_file?: string;
  context?: string;
  remote?: boolean;
  execution_target?: 'local' | 'remote';
  execution_target_reason?: string;
  fly_machine_id?: string;
}

export const CheckDemoResultArgsSchema = z.object({
  pid: z.coerce.number().int()
    .describe('Process ID returned by run_demo (negative PIDs indicate remote Fly.io execution).'),
});

export const StopDemoArgsSchema = z.object({
  pid: z.coerce.number().int()
    .describe('Process ID of the demo to stop (from run_demo). Negative PIDs indicate remote Fly.io execution.'),
});

export type CheckDemoResultArgs = z.infer<typeof CheckDemoResultArgsSchema>;
export type StopDemoArgs = z.infer<typeof StopDemoArgsSchema>;
export type DemoRunStatus = 'running' | 'passed' | 'failed' | 'interrupted' | 'unknown';

export interface DemoProgress {
  tests_completed: number;
  tests_passed: number;
  tests_failed: number;
  total_tests: number | null;
  current_test: string | null;
  current_file: string | null;
  has_failures: boolean;
  recent_errors: string[];
  last_5_results: Array<{ title: string; status: string }>;
  suite_completed: boolean;
  annotations: Array<{ test_title: string; type: string; description: string }>;
  has_warnings: boolean;
  interrupted: boolean;
}

export interface CheckDemoResultResult {
  status: DemoRunStatus;
  pid: number;
  scenario_id?: string;
  project?: string;
  test_file?: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  failure_summary?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  screenshot_paths?: string[];
  trace_summary?: string;
  progress?: DemoProgress;
  artifacts?: string[];
  degraded_features?: string[];
  recording_path?: string;
  recording_source?: 'window' | 'none';
  recording_permission_error?: string;
  duration_seconds?: number;
  screenshot_hint?: string;
  failure_frames?: Array<{ file_path: string; timestamp_seconds: number }>;
  analysis_guidance?: string;
  remote?: boolean;
  fly_machine_id?: string;
  fly_region?: string;
  /** Warning about remote execution failure and fallback to local execution */
  remote_routing_warning?: string;
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
  trace_summary?: string;
  progress_file?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  artifacts?: string[];
  scenario_id?: string;
  window_recorder_pid?: number;
  window_recording_path?: string;
  window_recorder_permission_error?: string;  // Set when recorder exits with code 2 (permission denied)
  screenshot_dir?: string;
  screenshot_start_time?: number;
  success_pause_ms?: number;
  suite_end_detected_at?: number;  // Runtime-only — epoch ms when suite_end was first seen
  interrupt_detected_at?: number;  // Runtime-only — epoch ms when demo_interrupted was first seen
  bypass_request_id?: string;      // Links interrupted demo to its bypass request for auto-resolution
  // Runtime-only — NOT persisted (NodeJS.Timeout is not serializable)
  screenshot_interval?: ReturnType<typeof setInterval>;
  // Remote execution fields (set when run is on Fly.io)
  remote?: boolean;
  fly_machine_id?: string;
  fly_app_name?: string;
  /** Set when auto-routing attempted remote execution but fell back to local. Surfaces in check_demo_result. */
  remote_routing_warning?: string;
}

export interface StopDemoResult {
  success: boolean;
  pid: number;
  project?: string;
  message: string;
  progress?: DemoProgress;
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

export const OpenVideoArgsSchema = z.object({
  video_path: z.string()
    .min(1)
    .max(1000)
    .refine(v => !v.includes('..'), 'video_path must not contain ".." traversal')
    .describe(
      'Relative path to a video file (e.g., test-results/demo/video.webm or .claude/recordings/demos/scenario.mp4). ' +
      'Resolved from the project directory. Must not contain ".." segments.'
    ),
});

export type OpenVideoArgs = z.infer<typeof OpenVideoArgsSchema>;

export interface OpenVideoResult {
  success: boolean;
  video_path: string;
  message: string;
}

// ============================================================================
// Batch Demo Schemas & Types
// ============================================================================

export const RunDemoBatchArgsSchema = z.object({
  project: z.string()
    .min(1)
    .max(100)
    .describe('Playwright project name (e.g., "demo").'),
  batch_size: z.coerce.number().int().min(1).max(20).optional().default(5)
    .describe('Number of scenarios to run per batch (default: 5).'),
  headless: z.coerce.boolean().optional().default(true)
    .describe('Run in headless mode (default: true). Set false for watchable demos.'),
  slow_mo: z.coerce.number().int().min(0).max(5000).optional().default(0)
    .describe('Milliseconds between actions (default: 0 for batch, 800 for sessions).'),
  timeout: z.coerce.number().int().min(30000).max(600000).optional().default(120000)
    .describe('Per-test timeout in milliseconds (default: 120s).'),
  stop_on_failure: z.coerce.boolean().optional().default(false)
    .describe('Stop the entire batch run if any scenario fails.'),
  scenario_ids: z.array(z.string()).optional()
    .describe('Run specific scenarios by ID. When omitted, discovers all enabled scenarios.'),
  persona_ids: z.array(z.string()).optional()
    .describe('Run all scenarios for these persona IDs.'),
  category_filter: z.string().max(50).optional()
    .describe('Filter scenarios by category (e.g., "gui", "sdk", "adk").'),
  base_url: z.string().url().optional()
    .describe('Override the base URL (default: http://localhost:3000).'),
  trace: z.coerce.boolean().optional().default(false)
    .describe('Enable Playwright trace recording.'),
  remote: z.coerce.boolean().optional()
    .describe('Run batch on remote Fly.io machines. Default: auto-route headless scenarios remotely when Fly.io is configured.'),
});

export type RunDemoBatchArgs = z.infer<typeof RunDemoBatchArgsSchema>;

export const CheckDemoBatchResultArgsSchema = z.object({
  batch_id: z.string()
    .min(1)
    .describe('Batch ID returned by run_demo_batch.'),
});

export type CheckDemoBatchResultArgs = z.infer<typeof CheckDemoBatchResultArgsSchema>;

export const StopDemoBatchArgsSchema = z.object({
  batch_id: z.string()
    .min(1)
    .describe('Batch ID of the batch run to stop.'),
});

export type StopDemoBatchArgs = z.infer<typeof StopDemoBatchArgsSchema>;

export type DemoBatchStatus = 'running' | 'passed' | 'failed' | 'stopped';

export interface BatchScenarioResult {
  scenario_id: string;
  scenario_title: string;
  test_file: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  failure_summary?: string;
  video_path?: string;
}

export interface DemoBatchProgress {
  total_scenarios: number;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  current_batch: number;
  total_batches: number;
  current_scenario?: string;
}

export interface CheckDemoBatchResultResult {
  status: DemoBatchStatus;
  batch_id: string;
  progress: DemoBatchProgress;
  scenarios: BatchScenarioResult[];
  message: string;
}

export interface StopDemoBatchResult {
  success: boolean;
  batch_id: string;
  progress: DemoBatchProgress;
  scenarios: BatchScenarioResult[];
  message: string;
}

export interface DemoBatchState {
  batch_id: string;
  project: string;
  status: DemoBatchStatus;
  started_at: string;
  ended_at?: string;
  scenarios: BatchScenarioResult[];
  progress: DemoBatchProgress;
  current_pid?: number;
  current_progress_file?: string;
  stop_on_failure: boolean;
}

export const GetFlyStatusArgsSchema = z.object({});
export type GetFlyStatusArgs = z.infer<typeof GetFlyStatusArgsSchema>;

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

// ============================================================================
// Prerequisite Execution
// ============================================================================

export const RunPrerequisitesArgsSchema = z.object({
  scenario_id: z.string().optional()
    .describe('Run prerequisites for this scenario (resolves persona, runs global + persona + scenario prerequisites)'),
  persona_id: z.string().optional()
    .describe('Run prerequisites for this persona (runs global + persona prerequisites)'),
  dry_run: z.coerce.boolean().optional().default(false)
    .describe('If true, only list what would run without executing'),
});

export type RunPrerequisitesArgs = z.infer<typeof RunPrerequisitesArgsSchema>;

export interface PrerequisiteExecEntry {
  id: string;
  description: string;
  scope: string;
  health_check_result: 'passed' | 'failed' | 'skipped' | 'not_configured';
  command_result: 'passed' | 'failed' | 'skipped';
  duration_ms: number;
  error?: string;
}

export interface RunPrerequisitesResult {
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  entries: PrerequisiteExecEntry[];
  message: string;
}

// ============================================================================
// Demo Screenshot Retrieval
// ============================================================================

export const GetDemoScreenshotArgsSchema = z.object({
  scenario_id: z.string().describe('The scenario_id from the demo run'),
  timestamp_seconds: z.number().min(0).describe('Seconds from demo start. The closest available screenshot is returned.'),
});

export type GetDemoScreenshotArgs = z.infer<typeof GetDemoScreenshotArgsSchema>;

export interface GetDemoScreenshotResult {
  file_path: string;
  actual_timestamp_seconds: number;
  total_screenshots: number;
  message: string;
}

// ============================================================================
// Video Frame Extraction
// ============================================================================

export const ExtractVideoFramesArgsSchema = z.object({
  scenario_id: z.string().describe('The scenario_id from the demo run'),
  timestamp_seconds: z.number().min(0).describe('Center timestamp in seconds. Frames are extracted from 3s before to 3s after this point.'),
});

export type ExtractVideoFramesArgs = z.infer<typeof ExtractVideoFramesArgsSchema>;

// ============================================================================
// Display Queue Schemas
// ============================================================================

export const AcquireDisplayLockArgsSchema = z.object({
  title: z.string().min(1).max(200)
    .describe('Description of what you need headed mode for (e.g., "Demo: checkout flow", "Chrome inspection: login page")'),
  ttl_minutes: z.coerce.number().int().min(1).max(60).optional().default(15)
    .describe('Lock TTL in minutes (auto-expires if not renewed). Default: 15.'),
});

export const ReleaseDisplayLockArgsSchema = z.object({});

export const RenewDisplayLockArgsSchema = z.object({});

export const GetDisplayQueueStatusArgsSchema = z.object({});

export type AcquireDisplayLockArgs = z.infer<typeof AcquireDisplayLockArgsSchema>;
export type ReleaseDisplayLockArgs = z.infer<typeof ReleaseDisplayLockArgsSchema>;
export type RenewDisplayLockArgs = z.infer<typeof RenewDisplayLockArgsSchema>;
export type GetDisplayQueueStatusArgs = z.infer<typeof GetDisplayQueueStatusArgsSchema>;

export interface ExtractVideoFramesResult {
  frames: Array<{ file_path: string; timestamp_seconds: number }>;
  video_path: string;
  range: { start_seconds: number; end_seconds: number };
  total_frames: number;
  message: string;
}
