/**
 * Types for the Playwright E2E MCP Server
 *
 * Provides MCP tools for launching Playwright in UI mode, running E2E tests
 * headlessly, seeding/cleaning test data, and checking test coverage.
 *
 * Persona mapping tied to AcmeIntegrate's three-persona architecture:
 * - SaaS Vendor (owner, admin, developer, viewer roles)
 * - End Customer (extension — headed Chromium with --load-extension)
 * - Platform Operator (deferred — requires operator panel)
 *
 * @see playwright.config.ts
 * @see specs/global/G028-playwright-e2e-testing.md
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/**
 * Playwright project names mapped to AcmeIntegrate personas.
 * These match the `name` field in playwright.config.ts projects.
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

/** Projects available for UI mode launch (user-facing personas + manual) */
const UI_MODE_PROJECTS = [
  'vendor-owner',
  'vendor-admin',
  'vendor-dev',
  'vendor-viewer',
  'manual',
  'extension',
  'extension-manual',
  'demo',
  'cross-persona',
  'auth-flows',
] as const;

/** Projects available for headless test runs */
const TEST_PROJECTS = [
  'vendor-owner',
  'vendor-admin',
  'vendor-dev',
  'vendor-viewer',
  'extension',
  'cross-persona',
  'auth-flows',
] as const;

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const LaunchUiModeArgsSchema = z.object({
  project: z.enum(UI_MODE_PROJECTS)
    .describe(
      'Playwright project to launch in UI mode. ' +
      'vendor-owner: SaaS Vendor (Owner) — Full dashboard access, primary vendor persona. ' +
      'vendor-admin: SaaS Vendor (Admin) — Most features except billing and danger zone. ' +
      'vendor-dev: SaaS Vendor (Developer) — API-focused features, limited admin access. ' +
      'vendor-viewer: SaaS Vendor (Viewer) — Read-only access to all dashboard pages. ' +
      'manual: Manual QA — Navigates to page with page.pause() for human inspection. Best for demos. ' +
      'extension: Extension E2E — Browser extension tests with --load-extension (headed Chromium). ' +
      'extension-manual: Extension Manual QA — Extension scaffolds with page.pause() for interactive inspection. ' +
      'demo: Unified Demo — Dashboard + extension in a single Chromium session for full product demos. ' +
      'cross-persona: Cross-Persona — Multi-context workflows testing interactions between roles. ' +
      'auth-flows: Auth Flows — Signup/signin tests without pre-loaded auth state.'
    ),
  base_url: z.string()
    .url()
    .optional()
    .describe('Override the base URL (default: http://localhost:3000)'),
});

export const RunTestsArgsSchema = z.object({
  project: z.enum(TEST_PROJECTS)
    .optional()
    .describe(
      'Playwright project to run. If omitted, runs vendor-owner + cross-persona (default). ' +
      'vendor-owner: SaaS Vendor (Owner) — Full dashboard access. ' +
      'vendor-admin: SaaS Vendor (Admin). ' +
      'vendor-dev: SaaS Vendor (Developer). ' +
      'vendor-viewer: SaaS Vendor (Viewer) — Read-only. ' +
      'extension: Extension E2E — Browser extension tests (headed Chromium). ' +
      'cross-persona: Multi-context workflows. ' +
      'auth-flows: Signup/signin tests.'
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

// ============================================================================
// Type Definitions
// ============================================================================

export type LaunchUiModeArgs = z.infer<typeof LaunchUiModeArgsSchema>;
export type RunTestsArgs = z.infer<typeof RunTestsArgsSchema>;
export type SeedDataArgs = z.infer<typeof SeedDataArgsSchema>;
export type CleanupDataArgs = z.infer<typeof CleanupDataArgsSchema>;
export type GetReportArgs = z.infer<typeof GetReportArgsSchema>;
export type GetCoverageStatusArgs = z.infer<typeof GetCoverageStatusArgsSchema>;

export interface LaunchUiModeResult {
  success: boolean;
  project: string;
  message: string;
  pid?: number;
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
