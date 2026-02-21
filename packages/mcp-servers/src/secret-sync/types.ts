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
});

export const DevServerStopArgsSchema = z.object({
  services: z.array(z.string()).optional()
    .describe('Service names to stop (omit to stop all)'),
});

export const DevServerStatusArgsSchema = z.object({});

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
  outputLines: z.number().int().min(0).max(200).default(100)
    .describe('Max output lines to return (foreground only). Sanitized of secret values.'),
  label: z.string().optional()
    .describe('Label for background process tracking. Defaults to command[0].'),
});

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
  runCommandConfig: z.object({
    allowedExecutables: z.array(z.string()).optional()
      .describe('Additional executables to allow beyond defaults'),
  }).optional(),
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
  mode: 'background';
  pid: number;
  label: string;
  secretsResolved: number;
  secretsFailed: string[];
}
