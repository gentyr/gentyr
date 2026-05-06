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
    .max(1800000)
    .optional()
    .describe('Per-test timeout in milliseconds (30s-1800s). If omitted, uses Playwright config default.'),
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
    .default(200)
    .describe(
      'Milliseconds to pause between Playwright actions (default: 200). ' +
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
  timeout: z.coerce.number().int().min(30000).max(1800000).optional().default(1800000)
    .describe('Per-test timeout in milliseconds (30s-1800s, default 30min). Remote Fly.io demos need time for install + build + test execution.'),
  recorded: z.coerce.boolean().optional().default(true)
    .describe('Capture video recording of the demo (default: true). When true, runs headed with window recording (ScreenCaptureKit locally, Xvfb+ffmpeg remotely). When false, runs headless without recording. This is the primary flag — use this instead of headless/skip_recording.'),
  headless: z.coerce.boolean().optional()
    .describe('Low-level override. Prefer using "recorded" instead. When set, takes precedence over "recorded" for headless mode.'),
  trace: z.coerce.boolean().optional().default(false)
    .describe('Enable Playwright trace recording (--trace on). Default: false.'),
  scenario_id: z.string()
    .describe('Demo scenario ID from user-feedback DB. Required — used for video recording persistence, prerequisite resolution, and env_vars lookup.'),
  skip_recording: z.coerce.boolean().optional()
    .describe('Low-level override. Prefer using "recorded" instead. When set, takes precedence over "recorded" for the recording flag.'),
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
  remote: z.coerce.boolean().optional().default(true)
    .describe('Run on remote Fly.io machine (default: true). Auto-routes to Fly.io when configured. Pass false to force local execution.'),
  telemetry: z.coerce.boolean().optional().default(false)
    .describe('Enable maximum telemetry capture (browser console/network/errors/performance + system metrics). Overrides scenario-level telemetry setting when true. Telemetry data is stored as JSONL files alongside demo artifacts and shipped to Elastic with the run ID.'),
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
  execution_target?: 'local' | 'remote' | 'steel';
  execution_target_reason?: string;
  fly_machine_id?: string;
  steel_session_id?: string;
  run_id?: string;
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
  recording_source?: 'window' | 'none' | 'steel';
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
  /** Errors from artifact retrieval — explains WHY artifacts may be missing */
  artifact_errors?: string[];
  execution_target?: 'local' | 'remote' | 'steel';
  /** Steel.dev session ID for stealth demo runs */
  steel_session_id?: string;
  /** Steel cloud browser recording path (user-facing view) for dual-instance scenarios */
  steel_recording_path?: string;
  /** Fly.io recording path (test orchestration view) for dual-instance scenarios */
  fly_recording_path?: string;
  run_id?: string;
  telemetry_dir?: string;
  telemetry_summary?: { console_count: number; network_count: number; error_count: number; perf_entries: number; metric_samples: number };
  /** Warning emitted when a running demo has not been polled for an extended period */
  stale_warning?: string;
  /** True when OOM (out-of-memory) was detected as the likely failure cause */
  oom_detected?: boolean;
  /** Actionable suggestion for resolving OOM failures (includes exact MCP tool call) */
  compute_size_suggestion?: string;
  /** Which compute_size was used for this run ('standard' = 4GB, 'large' = 8GB) */
  compute_size_used?: 'standard' | 'large';
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
  /** Set when artifacts have been proactively pulled while the machine was alive */
  artifacts_pulled?: boolean;
  /** Local directory where pulled artifacts are stored (proactive pull path) */
  artifacts_dest_dir?: string;
  // Steel.dev execution fields (set when run is on Steel cloud browser)
  steel_session_id?: string;
  /** Whether this is a dual-instance run (Fly.io + Steel) */
  dual_instance?: boolean;
  /** Fly.io side recording path for dual-instance scenarios */
  fly_recording_path?: string;
  /** Steel side recording path for dual-instance scenarios */
  steel_recording_path?: string;
  /** Execution target resolved by routing */
  execution_target?: 'local' | 'remote' | 'steel';
  /** Runtime-only — prevents double DB writes to demo_results */
  result_persisted?: boolean;
  /** Runtime-only — epoch ms of last check_demo_result poll. Used for stale demo warnings. */
  last_polled_at?: number;
  run_id?: string;
  telemetry_dir?: string;
  /** Warning when Fly.io image is stale (Dockerfile or remote-runner.sh changed since last deploy) */
  image_staleness_warning?: string;
  /** Which compute_size was used for this run ('standard' = 4GB, 'large' = 8GB) */
  compute_size_used?: 'standard' | 'large';
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
  timeout: z.coerce.number().int().min(30000).max(1800000).optional().default(1800000)
    .describe('Per-test timeout in milliseconds (default: 30min).'),
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
  remote: z.coerce.boolean().optional().default(true)
    .describe('Run batch on remote Fly.io machines (default: true). Prefer remote execution — it avoids local resource contention and runs scenarios in parallel across multiple Fly machines.'),
  scenario_timeout: z.coerce.number().int().min(60000).max(3600000).optional().default(600000)
    .describe('Per-scenario timeout in milliseconds (default: 10min = 600000). If a scenario exceeds this, its machine is killed and it is marked failed with timeout classification.'),
  batch_timeout: z.coerce.number().int().min(120000).max(7200000).optional().default(1800000)
    .describe('Overall batch timeout in milliseconds (default: 30min = 1800000). If the entire batch exceeds this, remaining scenarios are skipped.'),
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

/** Failure classification for automatic triage of machine deaths */
export type FailureClassification = 'test_failure' | 'oom' | 'startup_failure' | 'timeout' | 'external_kill' | 'recording_failure' | 'unknown';

export interface FailureClassificationResult {
  classification: FailureClassification;
  reason: string;
  suggestion?: string;
}

export interface BatchScenarioResult {
  scenario_id: string;
  scenario_title: string;
  test_file: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  failure_summary?: string;
  video_path?: string;
  /** Last 5KB of stderr from the remote machine */
  stderr_tail?: string;
  /** Last 3KB of fly-machine.log (dmesg/ps/meminfo) */
  fly_machine_log?: string;
  /** Automatic failure classification (oom, timeout, startup_failure, etc.) */
  failure_classification?: FailureClassification;
  /** Actionable suggestion for resolving the failure */
  failure_suggestion?: string;
  /** Unique run ID for Elastic log correlation */
  run_id?: string;
  /** Elastic query hint for debugging this scenario's run */
  elastic_query_hint?: string;
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

export const DeployFlyImageArgsSchema = z.object({
  force: z.boolean().optional().default(false)
    .describe('Re-deploy even if image already exists. Use when the Dockerfile has changed.'),
});
export type DeployFlyImageArgs = z.infer<typeof DeployFlyImageArgsSchema>;

export const DeployProjectImageArgsSchema = z.object({
  force: z.boolean().optional().default(false)
    .describe('Rebuild even if a project image already exists in the registry.'),
  git_ref: z.string().max(200).optional()
    .describe('Git ref to build from (default: current branch). Must exist on the remote.'),
  build_cmd: z.string().max(1000).optional()
    .describe('Build command to run inside the image after install (e.g., "pnpm --recursive build"). Passed as BUILD_CMD build arg.'),
});
export type DeployProjectImageArgs = z.infer<typeof DeployProjectImageArgsSchema>;

export const SetFlyMachineRamArgsSchema = z.object({
  machineRamHeadless: z.number().int().min(512).max(16384).optional()
    .describe('RAM in MB for headless remote demos (default: 2048). Headless skips Xvfb/ffmpeg, uses ~900MB.'),
  machineRamHeaded: z.number().int().min(512).max(16384).optional()
    .describe('RAM in MB for headed remote demos with video recording (default: 4096). Headed needs Xvfb + ffmpeg + headed Chromium.'),
});
export type SetFlyMachineRamArgs = z.infer<typeof SetFlyMachineRamArgsSchema>;

export const GetFlyMachineRamArgsSchema = z.object({});
export type GetFlyMachineRamArgs = z.infer<typeof GetFlyMachineRamArgsSchema>;

export const GetFlyLogsArgsSchema = z.object({
  lines: z.coerce.number().int().min(10).max(500).optional().default(100)
    .describe('Number of log lines to retrieve (default: 100, max: 500).'),
  machine_id: z.string().optional()
    .describe('Filter logs to a specific machine ID. If omitted, shows recent logs from all machines.'),
});
export type GetFlyLogsArgs = z.infer<typeof GetFlyLogsArgsSchema>;

// Steel.dev MCP tool schemas
export const SteelHealthCheckArgsSchema = z.object({});
export type SteelHealthCheckArgs = z.infer<typeof SteelHealthCheckArgsSchema>;

export const UploadSteelExtensionArgsSchema = z.object({
  zip_path: z.string().min(1).max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'zip_path must be a relative path without ".." traversal')
    .describe('Relative path to the extension ZIP or CRX file to upload to Steel.dev. Resolved from project root.'),
  force: z.coerce.boolean().optional().default(false)
    .describe('Re-upload even if steel.extensionId already exists in services.json.'),
});
export type UploadSteelExtensionArgs = z.infer<typeof UploadSteelExtensionArgsSchema>;

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
