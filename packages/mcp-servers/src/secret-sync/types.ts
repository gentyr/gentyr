/**
 * Secret Sync MCP Server Types
 *
 * Type definitions for orchestrating secret syncing from 1Password to Render and Vercel.
 * Secret values never pass through the agent's context window.
 */

import { z } from 'zod';

// ============================================================================
// Tool Argument Schemas
// ============================================================================

export const SyncSecretsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'local', 'all'])
    .describe('Target platform to sync secrets to'),
});

export const ListMappingsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'local', 'all'])
    .optional()
    .describe('Target platform to list mappings for (default: all)'),
});

export const VerifySecretsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'local', 'all'])
    .describe('Target platform to verify secrets on'),
});

// ============================================================================
// Dev Server Tool Argument Schemas
// ============================================================================

export const DevServiceSchema = z.object({
  filter: z.string()
    .regex(/^[@a-zA-Z0-9][@a-zA-Z0-9./_-]*$/, 'filter must be a valid pnpm workspace filter (alphanumeric, @, /, -, _, .)')
    .describe('pnpm workspace filter (e.g. "@acme-app/backend")'),
  command: z.string()
    .regex(/^[a-zA-Z][a-zA-Z0-9:_-]*$/, 'command must be a valid pnpm script name')
    .default('dev')
    .describe('pnpm script to run'),
  port: z.number().int().min(0).max(65535).describe('Expected port (0 = no port, e.g. extension)'),
  label: z.string().describe('Human-readable service name'),
});

export const DevServerStartArgsSchema = z.object({
  services: z.array(z.string()).optional()
    .describe('Service names to start (omit to start all)'),
  force: z.boolean().default(false)
    .describe('Kill existing processes on port conflict'),
  cwd: z.string().optional()
    .describe('Working directory for spawned processes (defaults to CLAUDE_WORKTREE_DIR or PROJECT_DIR)'),
  port_overrides: z.record(z.string(), z.number().int().min(1).max(65535)).optional()
    .describe('Override ports per service name (e.g. {"web": 3100, "backend": 3101})'),
});

export const DevServerStopArgsSchema = z.object({
  services: z.array(z.string()).optional()
    .describe('Service names to stop (omit to stop all)'),
  cwd: z.string().optional()
    .describe('Working directory to match (defaults to CLAUDE_WORKTREE_DIR or PROJECT_DIR)'),
});

export const DevServerStatusArgsSchema = z.object({
  cwd: z.string().optional()
    .describe('Filter to processes spawned with this CWD'),
});

// ============================================================================
// Run Command Tool Argument Schema
// ============================================================================

export const RunCommandArgsSchema = z.object({
  command: z.array(z.string()).min(1)
    .describe('Command as argv array (no shell). First element = executable, rest = args.'),
  background: z.boolean().default(false)
    .describe('If true, track as managed process and return PID. If false, run to completion.'),
  cwd: z.string().optional()
    .describe('Working directory (must be within PROJECT_DIR). Defaults to PROJECT_DIR.'),
  timeout: z.number().int().min(1000).max(600000).default(120000)
    .describe('Timeout in ms for foreground mode. Default 120s, max 10min.'),
  secretKeys: z.array(z.string()).optional()
    .describe('Subset of secrets.local keys to inject. Omit = inject all.'),
  profile: z.string().optional()
    .describe('Named secret profile from services.json. Merges profile secretKeys with any explicit secretKeys. Use list_secret_profiles to discover available profiles.'),
  outputLines: z.number().int().min(0).max(500).default(100)
    .describe('Max output lines to return (foreground only). Sanitized of secret values.'),
  label: z.string().optional()
    .describe('Label for background process tracking. Defaults to command[0].'),
});

export const RunCommandPollArgsSchema = z.object({
  label: z.string().optional()
    .describe('Label of the background process to check.'),
  pid: z.number().int().optional()
    .describe('PID of the background process to check.'),
  outputLines: z.number().int().min(0).max(500).default(50)
    .describe('Number of recent output lines to return.'),
}).refine(data => data.label !== undefined || data.pid !== undefined,
  { message: 'Either label or pid is required' });

export type RunCommandPollArgs = z.infer<typeof RunCommandPollArgsSchema>;

// ============================================================================
// Secret Profile Schemas
// ============================================================================

export const SecretProfileSchema = z.object({
  secretKeys: z.array(z.string()).min(1)
    .describe('Secret key names from secrets.local to inject when this profile is used.'),
  description: z.string().optional()
    .describe('Human-readable description of what this profile provides.'),
  match: z.object({
    commandPattern: z.string().optional()
      .refine(
        (val) => { if (!val) return true; try { new RegExp(val); return true; } catch { return false; } },
        { message: 'commandPattern must be a valid regular expression' },
      )
      .refine(
        (val) => { if (!val) return true; return !/\([^)]*[+*]\)[+*?{]/.test(val) && !/[+*]\??\{/.test(val); },
        { message: 'commandPattern contains nested quantifiers (potential ReDoS). Simplify the pattern.' },
      )
      .describe('Regex tested against the joined command string (e.g. "vitest.*aws-login"). Also matched against demo test_file paths.'),
    cwdPattern: z.string().optional()
      .describe('Glob-style suffix tested against cwd (e.g. "*/aws-integration").'),
    scenarioTags: z.array(z.string()).optional()
      .describe('Scenario flags that trigger this profile (e.g., ["stealth_required"]). When a demo scenario has any of these flags set to true, this profile\'s secretKeys are resolved.'),
  }).optional()
    .describe('Auto-match rules. When a secret_run_command call or run_demo scenario matches these patterns, the profile\'s secrets are resolved.'),
});

export type SecretProfile = z.infer<typeof SecretProfileSchema>;

export const RegisterSecretProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'Profile name must be lowercase alphanumeric with hyphens')
    .describe('Profile name (lowercase alphanumeric + hyphens).'),
  secretKeys: z.array(z.string()).min(1)
    .describe('Secret key names from secrets.local.'),
  description: z.string().optional()
    .describe('What this profile provides.'),
  commandPattern: z.string().optional()
    .refine(
      (val) => { if (!val) return true; try { new RegExp(val); return true; } catch { return false; } },
      { message: 'commandPattern must be a valid regular expression' },
    )
    .refine(
      (val) => { if (!val) return true; return !/\([^)]*[+*]\)[+*?{]/.test(val) && !/[+*]\??\{/.test(val); },
      { message: 'commandPattern contains nested quantifiers (potential ReDoS). Simplify the pattern.' },
    )
    .describe('Regex to auto-match against command (e.g. "vitest.*aws-login").'),
  cwdPattern: z.string().optional()
    .describe('Suffix pattern to auto-match against cwd (e.g. "*/aws-integration").'),
});

export type RegisterSecretProfileArgs = z.infer<typeof RegisterSecretProfileArgsSchema>;

export const GetSecretProfileArgsSchema = z.object({
  name: z.string().min(1).describe('Profile name to retrieve.'),
});

export type GetSecretProfileArgs = z.infer<typeof GetSecretProfileArgsSchema>;

export const DeleteSecretProfileArgsSchema = z.object({
  name: z.string().min(1).describe('Profile name to delete.'),
});

export type DeleteSecretProfileArgs = z.infer<typeof DeleteSecretProfileArgsSchema>;

export const ListSecretProfilesArgsSchema = z.object({});

// ============================================================================
// Test Scope Profile Schemas
// ============================================================================

export const TestScopeGatingSchema = z.object({
  matchedTests: z.enum(['block', 'warn']).default('block')
    .describe('Action for tests matching the scope: "block" fails the push, "warn" only warns'),
  unmatchedTests: z.enum(['block', 'warn']).default('warn')
    .describe('Action for tests NOT matching the scope: "block" fails the push, "warn" only warns'),
});

export const TestScopeSchema = z.object({
  description: z.string().optional()
    .describe('Human-readable description of what this scope covers'),
  unitTestPattern: z.string().optional()
    .refine(
      (val) => { if (!val) return true; try { new RegExp(val); return true; } catch { return false; } },
      { message: 'unitTestPattern must be a valid regular expression' },
    )
    .describe('Regex for matching unit/integration test file paths (e.g., "\\.allow\\.")'),
  // e2eTestPattern, e2eDemoPath, additionalPatterns: defined in schema for config validation
  // but not yet wired into the pre-push hook (which only runs unit + integration tests).
  // These will be consumed by future e2e/demo scope gating in the promotion pipeline.
  e2eTestPattern: z.string().optional()
    .describe('Pattern for e2e test name filtering via --grep (e.g., "@allow"). Reserved for promotion pipeline.'),
  e2eDemoPath: z.string().optional()
    .describe('Directory prefix for demo tests in scope (e.g., "e2e/demo/allow/"). Reserved for promotion pipeline.'),
  additionalPatterns: z.array(z.string()).optional()
    .describe('Extra regex patterns matched against test file paths. Reserved for promotion pipeline.'),
  scopedUnitCommand: z.string().optional()
    .describe('Override: explicit command to run scoped unit tests (bypasses pattern construction)'),
  scopedIntegrationCommand: z.string().optional()
    .describe('Override: explicit command to run scoped integration tests'),
  // gatingBehavior: currently the pre-push hook hardcodes matched=block, unmatched=warn.
  // This field allows future customization (e.g., both block during release freeze).
  gatingBehavior: TestScopeGatingSchema.optional()
    .describe('Controls whether matched/unmatched test failures block or warn. Defaults: matched=block, unmatched=warn. Reserved for future customization.'),
});

export type TestScopeGating = z.infer<typeof TestScopeGatingSchema>;
export type TestScope = z.infer<typeof TestScopeSchema>;

// ============================================================================
// Type Exports
// ============================================================================

export type SyncSecretsArgs = z.infer<typeof SyncSecretsArgsSchema>;
export type ListMappingsArgs = z.infer<typeof ListMappingsArgsSchema>;
export type VerifySecretsArgs = z.infer<typeof VerifySecretsArgsSchema>;
export type DevService = z.infer<typeof DevServiceSchema>;
export type DevServerStartArgs = z.infer<typeof DevServerStartArgsSchema>;
export type DevServerStopArgs = z.infer<typeof DevServerStopArgsSchema>;
export type DevServerStatusArgs = z.infer<typeof DevServerStatusArgsSchema>;
export type RunCommandArgs = z.infer<typeof RunCommandArgsSchema>;

// ============================================================================
// Services Config Schema
// ============================================================================

export const VercelSecretEntrySchema = z.object({
  ref: z.string(),
  target: z.array(z.string()),
  type: z.string(),
});

export type VercelSecretEntry = z.infer<typeof VercelSecretEntrySchema>;

export const ServicesConfigSchema = z.object({
  render: z.object({
    production: z.object({
      serviceId: z.string(),
    }).optional(),
    staging: z.object({
      serviceId: z.string(),
    }).optional(),
  }).optional(),
  vercel: z.object({
    projectId: z.string(),
  }).optional(),
  local: z.object({
    confFile: z.string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'confFile must be a simple filename (no paths)')
      .default('op-secrets.conf'),
  }).optional(),
  devServices: z.record(z.string(), DevServiceSchema).optional(),
  demoDevModeEnv: z.record(z.string(), z.string()).optional(),
  worktreeBuildCommand: z.string().optional()
    .describe('Shell command to build workspace packages in worktrees (e.g., "pnpm --recursive build")'),
  worktreeBuildHealthCheck: z.string().optional()
    .describe('Shell command that exits 0 if build artifacts exist (e.g., "test -f packages/browser-proxy/dist/index.js")'),
  worktreeInstallTimeout: z.number().int().min(10000).max(600000).optional()
    .describe('Timeout in ms for pnpm/yarn/npm install in worktrees (default: 120000). Large monorepos may need 300000+.'),
  worktreeProvisioningMode: z.enum(['strict', 'lenient']).optional()
    .describe('When "strict", install/build failures abort worktree creation and clean up. Default: "lenient" (non-fatal warnings).'),
  worktreeArtifactCopy: z.array(z.string()).optional()
    .describe('Glob patterns of build artifact directories to copy from main tree to worktrees (e.g., ["packages/*/dist"]). Copied BEFORE install so bin symlinks resolve. Single-level * wildcards only.'),
  testScopes: z.record(z.string(), TestScopeSchema).optional()
    .describe('Named test scope profiles for vertical slice deployment gating. Each scope defines patterns that classify which tests are "in scope" for push/promotion gating.'),
  activeTestScope: z.string().nullable().optional()
    .describe('Active scope name from testScopes. Only scoped test failures block push; non-scoped failures produce warnings. null or absent = full suite gates (default behavior).'),
  distVerification: z.array(z.object({
    srcGlob: z.string().describe('Glob pattern for source files (e.g., "apps/extension/src/**")'),
    distPath: z.string().describe('Path to compiled artifact to verify (e.g., "apps/extension/dist-proxy-chrome/background.js")'),
    buildCommand: z.string().optional().describe('Command to rebuild if stale (e.g., "npx tsx scripts/build.ts")'),
    expectedPatterns: z.array(z.string()).optional()
      .describe('Strings that MUST appear in the compiled output (e.g., ["evaluateViaCDP", "Runtime.evaluate"]). If missing, the artifact may be stale.'),
  })).optional()
    .describe('Build artifact verification checks run before demos. Detects stale compiled code that does not match source. Each entry defines a source→dist mapping with optional content verification patterns.'),
  runCommandConfig: z.object({
    allowedExecutables: z.array(z.string()).optional()
      .describe('Additional executables to allow beyond defaults'),
  }).optional(),
  fly: z.object({
    apiToken: z.string().regex(/^op:\/\//, 'Must be an op:// reference')
      .describe('op:// reference to FLY_API_TOKEN for Fly Machines API'),
    appName: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Must be a valid Fly.io app name')
      .describe('Fly.io app name (e.g., "gentyr-playwright")'),
    region: z.string().default('iad')
      .describe('Fly.io region (default: iad)'),
    machineSize: z.string().default('shared-cpu-2x')
      .describe('Fly.io machine size preset'),
    machineRam: z.number().int().min(512).max(16384).default(2048)
      .describe('Machine RAM in MB'),
    image: z.string().optional()
      .describe('Custom container image override (default: built from gentyr infra/fly-playwright/)'),
    maxConcurrentMachines: z.number().int().min(1).max(10).default(3)
      .describe('Max concurrent Fly machines for parallel batch runs'),
    cacheVolumeId: z.string().optional()
      .describe('Fly volume ID for dependency caching'),
    enabled: z.boolean().default(true)
      .describe('Enable/disable remote Playwright execution'),
  }).optional().describe('Fly.io remote Playwright execution configuration. When configured, headless demos auto-route to ephemeral Fly machines.'),
  steel: z.object({
    apiKey: z.string().regex(/^op:\/\//, 'Must be an op:// reference')
      .describe('op:// reference to STEEL_API_KEY for Steel.dev Cloud Browser API'),
    orgId: z.string().optional()
      .describe('Steel.dev organization ID (optional, for multi-org accounts)'),
    enabled: z.boolean().default(false)
      .describe('Enable/disable Steel.dev cloud browser execution for stealth-required scenarios'),
    defaultTimeout: z.number().int().min(30000).max(600000).default(120000)
      .describe('Default Steel session timeout in ms (default: 120s)'),
    extensionId: z.string().optional()
      .describe('Pre-uploaded Chrome extension ID for Steel sessions (from dist-steel/ build via upload_steel_extension)'),
    proxyConfig: z.object({
      enabled: z.boolean().default(false),
      country: z.string().max(5).default('US')
        .describe('Residential proxy country code (e.g., "US", "GB")'),
    }).optional()
      .describe('Residential proxy configuration for Steel sessions'),
    maxConcurrentSessions: z.number().int().min(1).max(10).default(2)
      .describe('Max concurrent Steel browser sessions'),
  }).optional().describe('Steel.dev cloud browser configuration for stealth-required scenarios. Provides anti-bot stealth (residential proxies, undetectable Chromium). Scenarios with stealth_required=true route here.'),
  environments: z.record(z.string(), z.object({
    baseUrl: z.string().url().describe('Base URL for this environment (e.g., "https://staging.example.com")'),
    label: z.string().optional().describe('Human-readable label shown in the dashboard (defaults to the key name)'),
    branch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).optional().describe('Git branch to auto-pull before running demos locally (e.g., "staging", "main"). When set, the dashboard auto-pulls this branch into the main tree before starting the dev server.'),
  })).optional()
    .describe('Named environments for demo targeting. Keys are environment names (e.g., "staging", "production"). The CTO Dashboard uses these to run demos against deployed URLs instead of localhost.'),
  secretProfiles: z.record(z.string(), SecretProfileSchema).optional(),
  secrets: z.object({
    renderProduction: z.record(z.string(), z.string()).optional(),
    renderStaging: z.record(z.string(), z.string()).optional(),
    vercel: z.record(z.string(), z.union([
      VercelSecretEntrySchema,
      z.array(VercelSecretEntrySchema).min(1),
    ])).optional(),
    local: z.record(z.string(), z.string().regex(/^op:\/\//, 'Local secrets must be op:// references')).optional(),
    manual: z.array(z.object({
      service: z.string(),
      key: z.string(),
      notes: z.string(),
    })).optional(),
  }),
});

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

export const UpdateServicesConfigArgsSchema = z.object({
  updates: z.record(z.string(), z.unknown())
    .describe('Top-level key-value pairs to merge into services.json. The "secrets" key is not allowed — use secret_sync_secrets for secret management.'),
});
export type UpdateServicesConfigArgs = z.infer<typeof UpdateServicesConfigArgsSchema>;

export const GetServicesConfigArgsSchema = z.object({});
export type GetServicesConfigArgs = z.infer<typeof GetServicesConfigArgsSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface SyncedSecret {
  key: string;
  service: string;
  status: 'created' | 'updated' | 'error';
  error?: string;
}

export interface SyncResult {
  synced: SyncedSecret[];
  errors: Array<{
    key: string;
    service: string;
    error: string;
  }>;
  manual: Array<{
    service: string;
    key: string;
    notes: string;
  }>;
}

export interface SecretMapping {
  key: string;
  reference: string;
  service: string;
}

export interface MappingResult {
  mappings: SecretMapping[];
  manual: Array<{
    service: string;
    key: string;
    notes: string;
  }>;
}

export interface VerifiedSecret {
  key: string;
  service: string;
  exists: boolean;
  error?: string;
}

export interface VerifyResult {
  verified: VerifiedSecret[];
  errors: Array<{
    service: string;
    error: string;
  }>;
}

// ============================================================================
// Dev Server Response Types
// ============================================================================

export interface DevServerServiceResult {
  name: string;
  label: string;
  pid: number;
  port: number;
  status: 'started' | 'already_running' | 'error';
  error?: string;
}

export interface DevServerStartResult {
  started: DevServerServiceResult[];
  secretsResolved: number;
  secretsFailed: string[];
}

export interface DevServerStopServiceResult {
  name: string;
  pid: number;
  status: 'stopped' | 'not_running' | 'force_killed' | 'error';
  error?: string;
}

export interface DevServerStopResult {
  stopped: DevServerStopServiceResult[];
}

export interface DevServerStatusService {
  name: string;
  label: string;
  pid: number;
  port: number;
  running: boolean;
  uptime: number;
  detectedPort: number | null;
}

export interface DevServerStatusResult {
  services: DevServerStatusService[];
}

// ============================================================================
// Run Command Response Types
// ============================================================================

export interface RunCommandForegroundResult {
  mode: 'foreground';
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  output: string[];
  outputTruncated: boolean;
  secretsResolved: number;
  secretsFailed: string[];
  durationMs: number;
}

export interface RunCommandBackgroundResult {
  mode: 'background' | 'auto_background';
  pid: number;
  label: string;
  secretsResolved: number;
  secretsFailed: string[];
  progressFile: string | null;
  message?: string;
}

export interface RunCommandPollResult {
  found: boolean;
  running: boolean;
  pid: number | null;
  label: string | null;
  exitCode: number | null;
  durationMs: number;
  outputLines: string[];
  progressFile: string | null;
}

// Populate secrets.local
export const PopulateSecretsLocalArgsSchema = z.object({
  entries: z.record(
    z.string().min(1),
    z.string().regex(/^op:\/\//, 'Values must be op:// references'),
  ).refine(obj => Object.keys(obj).length > 0, { message: 'At least one entry is required' })
    .describe('Map of env var names to op:// references. Example: { "AWS_ACCESS_KEY_ID": "op://Preview/AWS/access-key-id" }'),
});
export type PopulateSecretsLocalArgs = z.infer<typeof PopulateSecretsLocalArgsSchema>;
