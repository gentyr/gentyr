#!/usr/bin/env node
/**
 * Secret Sync MCP Server
 *
 * Orchestrates reading secrets from 1Password and pushing them as environment
 * variables to Render and Vercel services. Secret values never pass through
 * the agent's context window - they are read and pushed internally.
 *
 * Required env vars:
 * - OP_SERVICE_ACCOUNT_TOKEN: 1Password service account token
 * - RENDER_API_KEY: Render API key (for Render targets)
 * - VERCEL_TOKEN: Vercel API token (for Vercel targets)
 * - VERCEL_TEAM_ID: Vercel team ID (optional, for team accounts)
 * - CLAUDE_PROJECT_DIR: Project directory (for services.json)
 *
 * @version 1.0.0
 */

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { safeReadJson, safeWriteJson } from '../shared/safe-json-io.js';
import { createServer } from 'net';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { INFRA_CRED_KEYS, opRead, loadServicesConfig as loadServicesConfigShared, resolveLocalSecrets } from '../shared/op-secrets.js';
import {
  SyncSecretsArgsSchema,
  ListMappingsArgsSchema,
  VerifySecretsArgsSchema,
  DevServerStartArgsSchema,
  DevServerStopArgsSchema,
  DevServerStatusArgsSchema,
  RunCommandArgsSchema,
  RunCommandPollArgsSchema,
  RegisterSecretProfileArgsSchema,
  GetSecretProfileArgsSchema,
  DeleteSecretProfileArgsSchema,
  ListSecretProfilesArgsSchema,
  type SyncSecretsArgs,
  type ListMappingsArgs,
  type VerifySecretsArgs,
  type DevServerStartArgs,
  type DevServerStopArgs,
  type DevServerStatusArgs,
  type RunCommandArgs,
  type RunCommandPollArgs,
  type RunCommandPollResult,
  type RegisterSecretProfileArgs,
  type GetSecretProfileArgs,
  type DeleteSecretProfileArgs,
  type ServicesConfig,
  type VercelSecretEntry,
  type SyncResult,
  type MappingResult,
  type VerifyResult,
  type SyncedSecret,
  type SecretMapping,
  type VerifiedSecret,
  type DevServerStartResult,
  type DevServerStopResult,
  type DevServerStatusResult,
  type DevServerServiceResult,
  type DevServerStopServiceResult,
  type DevServerStatusService,
  type RunCommandForegroundResult,
  type RunCommandBackgroundResult,
  UpdateServicesConfigArgsSchema,
  GetServicesConfigArgsSchema,
  ServicesConfigSchema,
  PopulateSecretsLocalArgsSchema,
  PopulateSecretsFlyArgsSchema,
  type UpdateServicesConfigArgs,
  type PopulateSecretsLocalArgs,
  type PopulateSecretsFlyArgs,
} from './types.js';

const { RENDER_API_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID } = process.env;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '.';
const WORKTREE_DIR = process.env.CLAUDE_WORKTREE_DIR || null;

const SERVICES_BACKUP_PATH = join(PROJECT_DIR, '.claude', 'state', 'services.json.backup');

/** Returns true if the config has non-empty secrets.local (worth backing up). */
const hasSecretsLocal = (d: unknown): boolean => {
  const s = d as Record<string, unknown>;
  const secrets = s?.secrets as Record<string, unknown> | undefined;
  const local = secrets?.local as Record<string, unknown> | undefined;
  return !!local && Object.keys(local).length > 0;
};

/** Compute effective CWD for dev server processes: explicit arg > worktree > project */
function effectiveCwd(argCwd?: string): string {
  return argCwd || WORKTREE_DIR || PROJECT_DIR;
}

/** Key for managedProcesses map: service name scoped by CWD */
function processKey(name: string, cwd: string): string {
  return `${name}:${cwd}`;
}

function safeProjectPath(relativePath: string): string {
  const resolved = resolve(PROJECT_DIR, relativePath);
  const projectRoot = resolve(PROJECT_DIR);
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside project directory`);
  }
  return resolved;
}

const RENDER_BASE_URL = 'https://api.render.com/v1';
const VERCEL_BASE_URL = 'https://api.vercel.com';

// ============================================================================
// Config Loading
// ============================================================================

function loadServicesConfig(): ServicesConfig {
  return loadServicesConfigShared(PROJECT_DIR);
}

// ============================================================================
// Dev Server Process Management
// ============================================================================

const MAX_OUTPUT_LINES = 500;
const SIGTERM_TIMEOUT_MS = 5000;

interface ManagedProcess {
  name: string;
  label: string;
  process: ChildProcess;
  pid: number;
  port: number;
  startedAt: number;
  outputBuffer: string[];
}

const managedProcesses = new Map<string, ManagedProcess>();

function appendOutput(proc: ManagedProcess, line: string): void {
  proc.outputBuffer.push(line);
  if (proc.outputBuffer.length > MAX_OUTPUT_LINES) {
    proc.outputBuffer.shift();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortInUse(port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(true);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

function killPort(port: number): Promise<void> {
  if (port === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const output = execFileSync('lsof', ['-ti', `:${port}`], {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const pids = output.split('\n').filter(Boolean);
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch (err) {
            // Process may have already exited — log for observability (G001)
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[secret-sync] killPort: failed to SIGTERM pid ${pid}: ${message}\n`);
          }
        }
      }
    } catch (err) {
      // lsof may fail if no process is on port (exit code 1) — expected behavior
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('exit code 1') && !message.includes('status 1')) {
        process.stderr.write(`[secret-sync] killPort(${port}): lsof failed: ${message}\n`);
      }
    }
    resolve();
  });
}

function detectPort(lines: string[]): number | null {
  // Scan for common port-binding messages
  const portPatterns = [
    /listening on.*:(\d+)/i,
    /started.*on.*:(\d+)/i,
    /ready on.*:(\d+)/i,
    /http:\/\/localhost:(\d+)/i,
    /http:\/\/127\.0\.0\.1:(\d+)/i,
    /port\s+(\d+)/i,
  ];

  for (let i = lines.length - 1; i >= 0; i--) {
    for (const pattern of portPatterns) {
      const match = lines[i].match(pattern);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port > 0 && port < 65536) return port;
      }
    }
  }
  return null;
}

function cleanupManagedProcesses(): void {
  for (const [name, managed] of managedProcesses.entries()) {
    try {
      if (isProcessAlive(managed.pid)) {
        // Kill entire process group to ensure children (esbuild, etc.) are also killed
        try { process.kill(-managed.pid, 'SIGTERM'); } catch { managed.process.kill('SIGTERM'); }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[secret-sync] cleanup failed for ${name} (pid ${managed.pid}): ${message}\n`);
    }
    managedProcesses.delete(name);
  }
}

// Register cleanup handlers
process.on('exit', cleanupManagedProcesses);
process.on('SIGINT', () => {
  cleanupManagedProcesses();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupManagedProcesses();
  process.exit(0);
});

// ============================================================================
// Render Operations
// ============================================================================

async function renderFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  if (!RENDER_API_KEY) {
    throw new Error('RENDER_API_KEY not set');
  }

  const url = `${RENDER_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorData = await response.json() as { message?: string; errors?: unknown[] };
      if (errorData.message) {
        errorMessage = errorData.message;
      } else if (errorData.errors && Array.isArray(errorData.errors)) {
        errorMessage = `HTTP ${response.status}: ${JSON.stringify(errorData.errors)}`;
      }
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    }
    throw new Error(errorMessage);
  }

  if (response.status === 204) {
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  return data;
}

/**
 * Push env var to Render (creates if not exists, updates if exists).
 * Render API uses PUT as an upsert: PUT /services/{id}/env-vars/{key}
 */
async function renderSetEnvVar(serviceId: string, key: string, value: string): Promise<'created' | 'updated'> {
  // Check if key already exists for accurate reporting
  const existingKeys = await renderListEnvVars(serviceId);
  const exists = existingKeys.includes(key);

  // Render API PUT /services/{id}/env-vars/{key} is an upsert
  await renderFetch(`/services/${serviceId}/env-vars/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });

  return exists ? 'updated' : 'created';
}

/**
 * List env vars on Render (key names only)
 */
async function renderListEnvVars(serviceId: string): Promise<string[]> {
  const data = await renderFetch(`/services/${serviceId}/env-vars`) as Array<{
    envVar: {
      key: string;
    };
  }>;

  return data.map(item => item.envVar.key);
}

// ============================================================================
// Vercel Operations
// ============================================================================

async function vercelFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  if (!VERCEL_TOKEN) {
    throw new Error('VERCEL_TOKEN not set');
  }

  const url = new URL(endpoint, VERCEL_BASE_URL);
  if (VERCEL_TEAM_ID) {
    url.searchParams.set('teamId', VERCEL_TEAM_ID);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const error = data.error as { message?: string } | undefined;
    throw new Error(error?.message || `HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Push env var to Vercel (creates if not exists, updates if exists)
 */
async function vercelSetEnvVar(
  projectId: string,
  key: string,
  value: string,
  target: string[],
  type: string
): Promise<'created' | 'updated'> {
  const body = { key, value, target, type };

  try {
    // Try POST (create)
    await vercelFetch(`/v10/projects/${projectId}/env`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return 'created';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // If env var exists, delete and recreate (Vercel doesn't have update endpoint)
    if (message.toLowerCase().includes('already exists') || message.toLowerCase().includes('duplicate')) {
      // List env vars to find ID
      const envVars = await vercelFetch(`/v9/projects/${projectId}/env`) as { envs: Array<{ id: string; key: string }> };
      const existing = envVars.envs.find(e => e.key === key);

      if (existing) {
        // Delete existing
        await vercelFetch(`/v9/projects/${projectId}/env/${existing.id}`, {
          method: 'DELETE',
        });

        // Create new
        await vercelFetch(`/v10/projects/${projectId}/env`, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        return 'updated';
      }
    }

    throw err;
  }
}

/**
 * List env vars on Vercel (key names only)
 */
async function vercelListEnvVars(projectId: string): Promise<string[]> {
  const data = await vercelFetch(`/v9/projects/${projectId}/env`) as { envs: Array<{ key: string }> };
  return data.envs.map(e => e.key);
}

// ============================================================================
// Tool Handlers
// ============================================================================

function normalizeVercelEntries(
  config: VercelSecretEntry | VercelSecretEntry[]
): VercelSecretEntry[] {
  return Array.isArray(config) ? config : [config];
}

async function vercelDeleteAllEnvVarsForKey(projectId: string, key: string): Promise<number> {
  const envVars = await vercelFetch(`/v9/projects/${projectId}/env`) as { envs: Array<{ id: string; key: string }> };
  const matching = envVars.envs.filter(e => e.key === key);
  for (const env of matching) {
    await vercelFetch(`/v9/projects/${projectId}/env/${env.id}`, { method: 'DELETE' });
  }
  return matching.length;
}

// ── Fly.io Secrets API ──────────────────────────────────────────────────────

async function flySetSecrets(
  appName: string,
  secrets: Array<{ label: string; value: string }>,
  flyApiToken: string,
): Promise<void> {
  const response = await fetch(
    `https://api.machines.dev/v1/apps/${appName}/secrets`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${flyApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(secrets.map(s => ({
        label: s.label,
        type: 'opaque',
        value: s.value,
      }))),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Fly secrets API ${response.status}: ${body}`);
  }
}

// ── Sync Orchestrator ───────────────────────────────────────────────────────

async function syncSecrets(args: SyncSecretsArgs): Promise<SyncResult> {
  const config = loadServicesConfig();
  const synced: SyncedSecret[] = [];
  const errors: Array<{ key: string; service: string; error: string }> = [];
  const manual = config.secrets.manual || [];

  const targets = args.target === 'all'
    ? ['render-production', 'render-staging', 'vercel', 'fly'] as const
    : [args.target];

  for (const target of targets) {
    if (target === 'render-production') {
      if (!config.render?.production?.serviceId) {
        errors.push({ key: 'N/A', service: 'render-production', error: 'No serviceId configured' });
        continue;
      }

      const serviceId = config.render.production.serviceId;
      const secrets = config.secrets.renderProduction || {};

      for (const [key, ref] of Object.entries(secrets)) {
        try {
          const value = opRead(ref);
          const status = await renderSetEnvVar(serviceId, key, value);
          synced.push({ key, service: 'render-production', status });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          synced.push({ key, service: 'render-production', status: 'error', error: message });
        }
      }
    }

    if (target === 'render-staging') {
      if (!config.render?.staging?.serviceId) {
        errors.push({ key: 'N/A', service: 'render-staging', error: 'No serviceId configured' });
        continue;
      }

      const serviceId = config.render.staging.serviceId;
      const secrets = config.secrets.renderStaging || {};

      for (const [key, ref] of Object.entries(secrets)) {
        try {
          const value = opRead(ref);
          const status = await renderSetEnvVar(serviceId, key, value);
          synced.push({ key, service: 'render-staging', status });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          synced.push({ key, service: 'render-staging', status: 'error', error: message });
        }
      }
    }

    if (target === 'vercel') {
      if (!config.vercel?.projectId) {
        errors.push({ key: 'N/A', service: 'vercel', error: 'No projectId configured' });
        continue;
      }

      const projectId = config.vercel.projectId;
      const secrets = config.secrets.vercel || {};

      for (const [key, rawConfig] of Object.entries(secrets)) {
        const entries = normalizeVercelEntries(rawConfig);

        if (entries.length === 1) {
          // Single entry — use existing vercelSetEnvVar (handles create/update)
          try {
            const value = opRead(entries[0].ref);
            const status = await vercelSetEnvVar(projectId, key, value, entries[0].target, entries[0].type);
            synced.push({ key, service: 'vercel', status });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            synced.push({ key, service: 'vercel', status: 'error', error: message });
          }
        } else {
          // Multi-entry — delete all existing, then create each
          try {
            const deletedCount = await vercelDeleteAllEnvVarsForKey(projectId, key);

            for (const entry of entries) {
              const value = opRead(entry.ref);
              await vercelFetch(`/v10/projects/${projectId}/env`, {
                method: 'POST',
                body: JSON.stringify({ key, value, target: entry.target, type: entry.type }),
              });
            }

            synced.push({ key, service: 'vercel', status: deletedCount > 0 ? 'updated' : 'created' });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            synced.push({ key, service: 'vercel', status: 'error', error: message });
          }
        }
      }
    }

    if (target === 'fly') {
      const flySecrets = config.secrets?.fly;
      const flyConfig = config.fly;
      if (!flySecrets || Object.keys(flySecrets).length === 0) {
        const appNameHint = flyConfig?.appName || '<app-name>';
        errors.push({
          key: 'N/A',
          service: 'fly',
          error: `No secrets.fly mappings configured. Add via update_services_config with shape: { "secrets": { "fly": { "${appNameHint}": { "ENV_VAR_NAME": "op://vault/item/field" } } } }. Use mcp__onepassword__op_vault_map to discover op:// refs first.`,
        });
        continue;
      }
      if (!flyConfig?.apiToken) {
        errors.push({ key: 'N/A', service: 'fly', error: 'No fly.apiToken configured in services.json. Run /setup-fly first.' });
        continue;
      }

      let flyToken: string;
      try {
        flyToken = opRead(flyConfig.apiToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ key: 'FLY_API_TOKEN', service: 'fly', error: `Failed to resolve fly.apiToken: ${message}` });
        continue;
      }

      for (const [appName, appSecrets] of Object.entries(flySecrets)) {
        const resolvedSecrets: Array<{ label: string; value: string }> = [];
        for (const [key, ref] of Object.entries(appSecrets)) {
          try {
            const value = opRead(ref);
            resolvedSecrets.push({ label: key, value });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            synced.push({ key, service: `fly:${appName}`, status: 'error', error: message });
          }
        }
        if (resolvedSecrets.length > 0) {
          try {
            await flySetSecrets(appName, resolvedSecrets, flyToken);
            for (const s of resolvedSecrets) {
              synced.push({ key: s.label, service: `fly:${appName}`, status: 'created' });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const s of resolvedSecrets) {
              synced.push({ key: s.label, service: `fly:${appName}`, status: 'error', error: message });
            }
          }
        }
      }
    }

    if (target === 'local') {
      const secrets = config.secrets.local || {};
      const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');

      if (Object.keys(secrets).length === 0) {
        errors.push({ key: 'N/A', service: 'local', error: 'No secrets.local mappings configured' });
        continue;
      }

      try {
        const lines = [
          '# Auto-generated by secret-sync MCP server',
          '# Contains op:// references only — NOT resolved secret values.',
          '# Actual secrets are resolved at runtime by `op run`.',
          '#',
          `# Generated: ${new Date().toISOString()}`,
          '',
        ];

        for (const [key, ref] of Object.entries(secrets)) {
          lines.push(`${key}=${ref}`);
          synced.push({ key, service: 'local', status: 'created' });
        }

        writeFileSync(confFile, lines.join('\n') + '\n', 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ key: 'N/A', service: 'local', error: `Failed to write conf file: ${message}` });
      }
    }
  }

  return {
    synced,
    errors,
    manual,
  };
}

async function listMappings(args: ListMappingsArgs): Promise<MappingResult> {
  const config = loadServicesConfig();
  const mappings: SecretMapping[] = [];

  const targets = args.target === 'all' || !args.target
    ? ['render-production', 'render-staging', 'vercel', 'fly'] as const
    : [args.target];

  for (const target of targets) {
    if (target === 'render-production' && config.secrets.renderProduction) {
      for (const [key, ref] of Object.entries(config.secrets.renderProduction)) {
        mappings.push({ key, reference: ref, service: 'render-production' });
      }
    }

    if (target === 'render-staging' && config.secrets.renderStaging) {
      for (const [key, ref] of Object.entries(config.secrets.renderStaging)) {
        mappings.push({ key, reference: ref, service: 'render-staging' });
      }
    }

    if (target === 'vercel' && config.secrets.vercel) {
      for (const [key, rawConfig] of Object.entries(config.secrets.vercel)) {
        const entries = normalizeVercelEntries(rawConfig);
        for (const entry of entries) {
          mappings.push({ key, reference: entry.ref, service: 'vercel' });
        }
      }
    }

    if (target === 'local' && config.secrets.local) {
      for (const [key, ref] of Object.entries(config.secrets.local)) {
        mappings.push({ key, reference: ref, service: 'local' });
      }
    }
  }

  return {
    mappings,
    manual: config.secrets.manual || [],
  };
}

async function verifySecrets(args: VerifySecretsArgs): Promise<VerifyResult> {
  const config = loadServicesConfig();
  const verified: VerifiedSecret[] = [];
  const errors: Array<{ service: string; error: string }> = [];

  const targets = args.target === 'all'
    ? ['render-production', 'render-staging', 'vercel', 'fly'] as const
    : [args.target];

  for (const target of targets) {
    if (target === 'render-production' && config.render?.production?.serviceId) {
      const serviceId = config.render.production.serviceId;
      const secrets = config.secrets.renderProduction || {};

      try {
        const existingKeys = await renderListEnvVars(serviceId);

        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'render-production',
            exists: existingKeys.includes(key),
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ service: 'render-production', error: message });
        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'render-production',
            exists: false,
            error: `Verification failed: ${message}`,
          });
        }
      }
    }

    if (target === 'render-staging' && config.render?.staging?.serviceId) {
      const serviceId = config.render.staging.serviceId;
      const secrets = config.secrets.renderStaging || {};

      try {
        const existingKeys = await renderListEnvVars(serviceId);

        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'render-staging',
            exists: existingKeys.includes(key),
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ service: 'render-staging', error: message });
        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'render-staging',
            exists: false,
            error: `Verification failed: ${message}`,
          });
        }
      }
    }

    if (target === 'vercel' && config.vercel?.projectId) {
      const projectId = config.vercel.projectId;
      const secrets = config.secrets.vercel || {};

      try {
        const existingKeys = await vercelListEnvVars(projectId);

        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'vercel',
            exists: existingKeys.includes(key),
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ service: 'vercel', error: message });
        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'vercel',
            exists: false,
            error: `Verification failed: ${message}`,
          });
        }
      }
    }

    if (target === 'local') {
      const secrets = config.secrets.local || {};
      const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');

      try {
        if (!existsSync(confFile)) {
          errors.push({ service: 'local', error: `Conf file not found: ${confFile}` });
          for (const key of Object.keys(secrets)) {
            verified.push({ key, service: 'local', exists: false, error: 'Conf file not found' });
          }
        } else {
          const content = readFileSync(confFile, 'utf-8');
          const existingKeys = content
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(line => line.split('=')[0]);

          for (const key of Object.keys(secrets)) {
            verified.push({
              key,
              service: 'local',
              exists: existingKeys.includes(key),
            });
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ service: 'local', error: message });
        for (const key of Object.keys(secrets)) {
          verified.push({
            key,
            service: 'local',
            exists: false,
            error: `Verification failed: ${message}`,
          });
        }
      }
    }
  }

  return { verified, errors };
}

// ============================================================================
// Run Command — Security & Sanitization
// ============================================================================

const DEFAULT_ALLOWED_EXECUTABLES = new Set([
  'pnpm', 'npx', 'node', 'tsx', 'playwright', 'prisma', 'drizzle-kit', 'vitest',
]);

/** Blocked arg prefixes — matches both `-e` and `--eval=<code>` forms */
const BLOCKED_ARG_PREFIXES = ['-e', '--eval', '-c', '--print', '-p'];

/** Blocked command patterns — commands that must use specialized MCP tools */
const BLOCKED_COMMAND_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bplaywright\b.*\btest\b/i,
    message: 'Playwright tests must use MCP tools: mcp__playwright__run_demo (demos) or mcp__playwright__run_tests (E2E). Direct CLI bypasses prerequisite execution, credential injection, and result tracking.',
  },
  {
    pattern: /\bplaywright\b.*\bshow-report\b/i,
    message: 'Use the Playwright MCP server tools instead of direct CLI.',
  },
];

/**
 * Validate command against executable allowlist and blocked args.
 * Throws on violation.
 */
function validateCommand(command: string[], allowedExtras: string[] = []): void {
  const executable = command[0];
  const allowed = new Set([...DEFAULT_ALLOWED_EXECUTABLES, ...allowedExtras]);

  if (!allowed.has(executable)) {
    throw new Error(
      `Executable "${executable}" is not in the allowlist. ` +
      `Allowed: ${[...allowed].sort().join(', ')}`
    );
  }

  for (const arg of command.slice(1)) {
    for (const blocked of BLOCKED_ARG_PREFIXES) {
      // Match exact `-e` or prefix `--eval=...`
      if (arg === blocked || arg.startsWith(blocked + '=')) {
        throw new Error(
          `Argument "${arg}" is blocked for security. ` +
          `Inline code execution is not allowed.`
        );
      }
    }
  }

  // Blocked command patterns — redirect to specialized MCP tools
  const commandStr = command.join(' ');
  for (const { pattern, message } of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(commandStr)) {
      throw new Error(message);
    }
  }
}

/**
 * Build a sanitizer function that replaces secret values in text with [REDACTED:KEY].
 * Handles base64, URL-encoded, and hex-encoded forms.
 * Skips values <= 3 chars (too many false positives).
 */
function createSanitizer(resolvedEnv: Record<string, string>): (text: string) => string {
  const replacements: Array<{ pattern: string; replacement: string }> = [];

  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (value.length <= 3) continue;

    const redacted = `[REDACTED:${key}]`;

    // Plain value
    replacements.push({ pattern: value, replacement: redacted });

    // Base64-encoded
    try {
      const b64 = Buffer.from(value).toString('base64');
      if (b64 !== value) replacements.push({ pattern: b64, replacement: redacted });
    } catch { /* ignore encoding errors */ }

    // URL-encoded
    try {
      const urlEncoded = encodeURIComponent(value);
      if (urlEncoded !== value) replacements.push({ pattern: urlEncoded, replacement: redacted });
    } catch { /* ignore encoding errors */ }

    // Hex-encoded
    try {
      const hex = Buffer.from(value).toString('hex');
      if (hex !== value) replacements.push({ pattern: hex, replacement: redacted });
    } catch { /* ignore encoding errors */ }
  }

  // Sort by pattern length descending (longer patterns first to avoid partial matches)
  replacements.sort((a, b) => b.pattern.length - a.pattern.length);

  return (text: string): string => {
    let result = text;
    for (const { pattern, replacement } of replacements) {
      // Use split/join for literal string replacement (no regex escaping needed)
      result = result.split(pattern).join(replacement);
    }
    return result;
  };
}

/**
 * Run a command in foreground mode: spawn, collect sanitized output, enforce timeout.
 */
async function runCommandForeground(
  command: string[],
  childEnv: Record<string, string>,
  sanitize: (text: string) => string,
  cwd: string,
  timeout: number,
  maxLines: number,
): Promise<RunCommandForegroundResult> {
  const startTime = Date.now();

  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      env: childEnv,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const outputBuffer: string[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (isProcessAlive(child.pid!)) child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    const collectOutput = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        outputBuffer.push(sanitize(line));
      }
    };

    child.stdout?.on('data', collectOutput);
    child.stderr?.on('data', collectOutput);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      // Take last N lines
      const truncated = outputBuffer.length > maxLines;
      const output = truncated
        ? outputBuffer.slice(-maxLines)
        : outputBuffer;

      resolvePromise({
        mode: 'foreground',
        exitCode: code ?? -1,
        signal: signal ?? null,
        timedOut,
        output,
        outputTruncated: truncated,
        secretsResolved: 0, // filled by caller
        secretsFailed: [],  // filled by caller
        durationMs,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolvePromise({
        mode: 'foreground',
        exitCode: -1,
        signal: null,
        timedOut: false,
        output: [sanitize(`Spawn error: ${err.message}`)],
        outputTruncated: false,
        secretsResolved: 0,
        secretsFailed: [],
        durationMs,
      });
    });
  });
}

/**
 * Run a command in background mode: spawn, register in managedProcesses.
 * When progressFile is provided, writes typed JSONL events (start/stdout/stderr/exit)
 * so the poll tool can reconstruct state even after the process exits.
 */
function runCommandBackground(
  command: string[],
  childEnv: Record<string, string>,
  sanitize: (text: string) => string,
  cwd: string,
  label: string,
  progressFile?: string,
): RunCommandBackgroundResult {
  const child = spawn(command[0], command.slice(1), {
    env: childEnv,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
  });
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error('Failed to spawn process (no PID)');
  }

  const startedAt = Date.now();
  const name = `run:${label}`;
  const managed: ManagedProcess = {
    name,
    label,
    process: child,
    pid,
    port: 0,
    startedAt,
    outputBuffer: [],
  };

  // Write a single JSONL event to the progress file. Non-fatal on error.
  const writeProgress = progressFile
    ? (event: object): void => {
        try { appendFileSync(progressFile, JSON.stringify(event) + '\n'); } catch { /* non-fatal */ }
      }
    : null;

  if (writeProgress) {
    // Ensure parent directory exists before first write
    try { mkdirSync(dirname(progressFile!), { recursive: true }); } catch { /* non-fatal */ }
    writeProgress({ type: 'start', command: command.join(' '), label, pid, timestamp: Date.now() });
  }

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const sanitized = sanitize(line);
      appendOutput(managed, sanitized);
      if (writeProgress) writeProgress({ type: 'stdout', line: sanitized, timestamp: Date.now() });
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const sanitized = sanitize(line);
      appendOutput(managed, sanitized);
      if (writeProgress) writeProgress({ type: 'stderr', line: sanitized, timestamp: Date.now() });
    }
  });

  child.on('exit', (code, signal) => {
    managedProcesses.delete(name);
    if (writeProgress) {
      writeProgress({
        type: 'exit',
        exitCode: code ?? -1,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });
    }
  });

  managedProcesses.set(name, managed);

  return {
    mode: 'background',
    pid,
    label,
    secretsResolved: 0, // filled by caller
    secretsFailed: [],   // filled by caller
    progressFile: progressFile ?? null,
  };
}

/**
 * Main handler for secret_run_command tool.
 */
async function runCommand(args: RunCommandArgs): Promise<RunCommandForegroundResult | RunCommandBackgroundResult> {
  const config = loadServicesConfig();

  // Validate command
  const allowedExtras = config.runCommandConfig?.allowedExecutables || [];
  validateCommand(args.command, allowedExtras);

  // Validate cwd is within PROJECT_DIR
  const cwd = args.cwd ? safeProjectPath(args.cwd) : resolve(PROJECT_DIR);

  // Resolve secrets
  const { resolvedEnv, failedKeys } = resolveLocalSecrets(config);

  // Profile resolution: merge profile keys with explicit keys
  let effectiveSecretKeys = args.secretKeys;
  if (args.profile) {
    const profiles = config.secretProfiles || {};
    const profile = profiles[args.profile];
    if (!profile) {
      const available = Object.keys(profiles);
      throw new Error(`Secret profile "${args.profile}" not found. Available: ${available.length ? available.join(', ') : '(none)'}`);
    }
    const merged = new Set(profile.secretKeys);
    if (args.secretKeys) {
      for (const key of args.secretKeys) merged.add(key);
    }
    effectiveSecretKeys = Array.from(merged);
  }

  // Filter to requested subset if specified
  let injectedEnv: Record<string, string>;
  if (effectiveSecretKeys) {
    injectedEnv = {};
    for (const key of effectiveSecretKeys) {
      if (key in resolvedEnv) {
        injectedEnv[key] = resolvedEnv[key];
      } else if (!failedKeys.includes(key)) {
        failedKeys.push(key);
      }
    }
  } else {
    injectedEnv = resolvedEnv;
  }

  // Build child env: parent env minus infra creds, plus resolved secrets
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !INFRA_CRED_KEYS.has(k)) childEnv[k] = v;
  }
  Object.assign(childEnv, injectedEnv);

  const secretsResolved = Object.keys(injectedEnv).length;
  const sanitize = createSanitizer(injectedEnv);

  // Auto-background: when timeout > 55s and not already background,
  // auto-switch to prevent MCP transport timeout (~60s) from killing the call.
  const AUTO_BG_THRESHOLD_MS = 55000;
  if (!args.background && args.timeout > AUTO_BG_THRESHOLD_MS) {
    const rawLabel = args.label || args.command[0];
    // Sanitize label for use in filename (replace path separators and spaces)
    const label = rawLabel.replace(/[/\\ ]+/g, '-').replace(/^-+|-+$/g, '');
    const stateDir = join(PROJECT_DIR, '.claude', 'state');
    const progressFile = join(stateDir, `run-command-${label}-${Date.now()}.jsonl`);
    const result = runCommandBackground(args.command, childEnv, sanitize, cwd, rawLabel, progressFile);
    result.secretsResolved = secretsResolved;
    result.secretsFailed = failedKeys;
    result.mode = 'auto_background';
    result.message = `Command timeout (${args.timeout}ms) exceeds MCP transport limit (~60s). Running in background automatically. Poll with secret_run_command_poll({ label: "${rawLabel}" }) or read progress file: ${progressFile}`;
    return result;
  }

  if (args.background) {
    const label = args.label || args.command[0];
    const result = runCommandBackground(args.command, childEnv, sanitize, cwd, label);
    result.secretsResolved = secretsResolved;
    result.secretsFailed = failedKeys;
    return result;
  }

  const result = await runCommandForeground(
    args.command, childEnv, sanitize, cwd, args.timeout, args.outputLines,
  );
  result.secretsResolved = secretsResolved;
  result.secretsFailed = failedKeys;
  return result;
}

/**
 * Poll the status of a background command started by secret_run_command.
 * Searches in-memory managedProcesses first; falls back to JSONL progress file
 * written by runCommandBackground() after the process exits.
 */
async function runCommandPoll(args: RunCommandPollArgs): Promise<RunCommandPollResult> {
  // Search in-memory managed processes by label or pid
  let found: ManagedProcess | undefined;
  for (const managed of managedProcesses.values()) {
    if (args.label !== undefined && managed.label === args.label) { found = managed; break; }
    if (args.pid !== undefined && managed.pid === args.pid) { found = managed; break; }
  }

  if (found) {
    const running = isProcessAlive(found.pid);
    const maxLines = args.outputLines ?? 50;
    const outputLines = found.outputBuffer.slice(-maxLines);
    return {
      found: true,
      running,
      pid: found.pid,
      label: found.label,
      exitCode: null, // not available while still in managedProcesses
      durationMs: Date.now() - found.startedAt,
      outputLines,
      progressFile: null, // in-memory process, no separate progress file reference
    };
  }

  // Process not in memory — try to find a matching JSONL progress file
  if (args.label !== undefined) {
    const stateDir = join(PROJECT_DIR, '.claude', 'state');
    try {
      const sanitizedLabel = args.label.replace(/[/\\ ]+/g, '-').replace(/^-+|-+$/g, '');
      const files = readdirSync(stateDir)
        .filter(f => f.startsWith(`run-command-${sanitizedLabel}-`) && f.endsWith('.jsonl'));
      if (files.length > 0) {
        // Read the most-recent progress file (sort lexicographically — timestamp suffix ensures order)
        const latest = files.sort().pop()!;
        const progressFile = join(stateDir, latest);
        const content = readFileSync(progressFile, 'utf8');
        const events: Array<Record<string, unknown>> = content
          .split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
          .filter((e): e is Record<string, unknown> => e !== null);

        const startEvent = events.find(e => e.type === 'start');
        const exitEvent = events.find(e => e.type === 'exit');
        const maxLines = args.outputLines ?? 50;
        const outputLines = events
          .filter(e => e.type === 'stdout' || e.type === 'stderr')
          .map(e => e.line as string)
          .slice(-maxLines);

        return {
          found: true,
          running: exitEvent === undefined,
          pid: (startEvent?.pid as number | undefined) ?? (args.pid ?? null),
          label: args.label,
          exitCode: exitEvent !== undefined ? (exitEvent.exitCode as number) : null,
          durationMs: exitEvent !== undefined
            ? (exitEvent.durationMs as number)
            : (startEvent ? Date.now() - (startEvent.timestamp as number) : 0),
          outputLines,
          progressFile,
        };
      }
    } catch { /* non-fatal: stateDir may not exist or file may be unreadable */ }
  }

  // Not found anywhere
  return {
    found: false,
    running: false,
    pid: args.pid ?? null,
    label: args.label ?? null,
    exitCode: null,
    durationMs: 0,
    outputLines: [],
    progressFile: null,
  };
}

// ============================================================================
// Dev Server Tool Handlers
// ============================================================================

async function devServerStart(args: DevServerStartArgs): Promise<DevServerStartResult> {
  const config = loadServicesConfig();
  const devServices = config.devServices || {};
  const started: DevServerServiceResult[] = [];

  if (Object.keys(devServices).length === 0) {
    throw new Error('No devServices configured in services.json');
  }

  const serviceNames = args.services || Object.keys(devServices);
  const spawnCwd = effectiveCwd(args.cwd);

  // Validate all service names first
  for (const name of serviceNames) {
    if (!devServices[name]) {
      const available = Object.keys(devServices).join(', ');
      throw new Error(`Unknown service "${name}". Available: ${available}`);
    }
  }

  // Resolve secrets — values stay in MCP server memory
  const { resolvedEnv, failedKeys } = resolveLocalSecrets(config);

  for (const name of serviceNames) {
    const svc = devServices[name];
    const key = processKey(name, spawnCwd);
    const port = args.port_overrides?.[name] ?? svc.port;

    // Check if already running
    const existing = managedProcesses.get(key);
    if (existing && isProcessAlive(existing.pid)) {
      started.push({
        name,
        label: svc.label,
        pid: existing.pid,
        port,
        status: 'already_running',
      });
      continue;
    }

    // Check port conflict
    if (port > 0) {
      const portBusy = await isPortInUse(port);
      if (portBusy) {
        if (args.force) {
          await killPort(port);
          // Brief wait for port release
          await new Promise(r => setTimeout(r, 500));
        } else {
          started.push({
            name,
            label: svc.label,
            pid: 0,
            port,
            status: 'error',
            error: `Port ${port} already in use. Use force: true to kill existing process.`,
          });
          continue;
        }
      }
    }

    try {
      const childEnv: Record<string, string> = {};
      // Copy parent env vars, excluding infrastructure credentials
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !INFRA_CRED_KEYS.has(k)) childEnv[k] = v;
      }
      // Inject resolved secrets (application-level only, from secrets.local)
      Object.assign(childEnv, resolvedEnv);
      // Set port if specified (use override or config)
      if (port > 0) {
        childEnv.PORT = String(port);
      }

      const child = spawn('pnpm', ['--filter', svc.filter, 'run', svc.command], {
        env: childEnv,
        cwd: spawnCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      child.unref();

      const pid = child.pid;
      if (!pid) {
        started.push({
          name,
          label: svc.label,
          pid: 0,
          port,
          status: 'error',
          error: 'Failed to spawn process (no PID)',
        });
        continue;
      }

      const managed: ManagedProcess = {
        name,
        label: svc.label,
        process: child,
        pid,
        port,
        startedAt: Date.now(),
        outputBuffer: [],
      };

      // Capture stdout/stderr in ring buffer (never returned to agent)
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) appendOutput(managed, line);
      });
      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) appendOutput(managed, line);
      });

      // Auto-remove on exit
      child.on('exit', () => {
        managedProcesses.delete(key);
      });

      managedProcesses.set(key, managed);

      started.push({
        name,
        label: svc.label,
        pid,
        port,
        status: 'started',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      started.push({
        name,
        label: svc.label,
        pid: 0,
        port,
        status: 'error',
        error: message,
      });
    }
  }

  return {
    started,
    secretsResolved: Object.keys(resolvedEnv).length,
    secretsFailed: failedKeys,
  };
}

async function devServerStop(args: DevServerStopArgs): Promise<DevServerStopResult> {
  const stopped: DevServerStopServiceResult[] = [];
  const stopCwd = effectiveCwd(args.cwd);

  // If services specified, look up by processKey; otherwise stop all matching CWD
  let keys: string[];
  if (args.services) {
    keys = args.services.map(name => processKey(name, stopCwd));
  } else {
    keys = [...managedProcesses.keys()].filter(k => k.endsWith(`:${stopCwd}`));
  }

  for (const key of keys) {
    const managed = managedProcesses.get(key);
    if (!managed) {
      stopped.push({ name: key, pid: 0, status: 'not_running' });
      continue;
    }

    const pid = managed.pid;

    if (!isProcessAlive(pid)) {
      managedProcesses.delete(key);
      stopped.push({ name: managed.name, pid, status: 'not_running' });
      continue;
    }

    try {
      // Kill entire process group (negative PID) to ensure children (esbuild, etc.) are also killed
      try { process.kill(-pid, 'SIGTERM'); } catch { managed.process.kill('SIGTERM'); }

      // Wait up to SIGTERM_TIMEOUT_MS for graceful exit
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), SIGTERM_TIMEOUT_MS);
        managed.process.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      if (!exited && isProcessAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { managed.process.kill('SIGKILL'); }
        managedProcesses.delete(key);
        stopped.push({ name: managed.name, pid, status: 'force_killed' });
      } else {
        managedProcesses.delete(key);
        stopped.push({ name: managed.name, pid, status: 'stopped' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      managedProcesses.delete(key);
      stopped.push({ name: managed.name, pid, status: 'error', error: message });
    }
  }

  return { stopped };
}

async function devServerStatus(args: DevServerStatusArgs): Promise<DevServerStatusResult> {
  const services: DevServerStatusService[] = [];
  const filterCwd = args.cwd ? args.cwd : null;

  for (const [key, managed] of managedProcesses.entries()) {
    // If cwd filter specified, only include matching entries
    if (filterCwd && !key.endsWith(`:${filterCwd}`)) continue;

    const running = isProcessAlive(managed.pid);

    if (!running) {
      managedProcesses.delete(key);
    }

    services.push({
      name: managed.name,
      label: managed.label,
      pid: managed.pid,
      port: managed.port,
      running,
      uptime: running ? Math.floor((Date.now() - managed.startedAt) / 1000) : 0,
      detectedPort: detectPort(managed.outputBuffer),
    });
  }

  return { services };
}

// ============================================================================
// Secret Profile Management
// ============================================================================

function writeServicesConfig(config: ServicesConfig): { applied: boolean; pending: boolean } {
  const configPath = join(PROJECT_DIR, '.claude', 'config', 'services.json');
  const pendingPath = join(PROJECT_DIR, '.claude', 'state', 'services-config-pending.json');

  // Validate against schema
  const result = ServicesConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }

  try {
    safeWriteJson(configPath, result.data, { backupPath: SERVICES_BACKUP_PATH, backupValidator: hasSecretsLocal });
    return { applied: true, pending: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      // Diff new config against on-disk config, stage only changed keys
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Cannot read services.json to compute diff: ${(e as Error).message}`);
        }
      }
      let pending: Record<string, unknown> = {};
      try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }
      const validated = result.data as Record<string, unknown>;
      for (const key of Object.keys(validated)) {
        if (key !== 'secrets' && JSON.stringify(validated[key]) !== JSON.stringify(current[key])) {
          pending[key] = validated[key];
        }
      }
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
      return { applied: false, pending: true };
    }
    throw err;
  }
}

async function registerSecretProfile(args: RegisterSecretProfileArgs): Promise<string> {
  const config = loadServicesConfig();
  if (!config.secretProfiles) config.secretProfiles = {};

  // Build profile object
  const match = (args.commandPattern || args.cwdPattern)
    ? {
      ...(args.commandPattern ? { commandPattern: args.commandPattern } : {}),
      ...(args.cwdPattern ? { cwdPattern: args.cwdPattern } : {}),
    }
    : undefined;

  config.secretProfiles[args.name] = {
    secretKeys: args.secretKeys,
    ...(args.description ? { description: args.description } : {}),
    ...(match ? { match } : {}),
  };

  // Check which secretKeys exist in secrets.local
  const localKeys = Object.keys(config.secrets?.local || {});
  const missingKeys = args.secretKeys.filter(k => !localKeys.includes(k));

  const { applied, pending } = writeServicesConfig(config);

  const result: Record<string, unknown> = {
    name: args.name,
    profile: config.secretProfiles[args.name],
    applied,
    pending,
  };
  if (missingKeys.length > 0) {
    result.warning = `These secretKeys are not yet defined in secrets.local: ${missingKeys.join(', ')}. They must be added before the profile can resolve them.`;
  }
  if (pending) {
    result.message = 'Config staged — ask the CTO to run "npx gentyr sync" to apply.';
  }
  return JSON.stringify(result, null, 2);
}

async function getSecretProfile(args: GetSecretProfileArgs): Promise<string> {
  const config = loadServicesConfig();
  const profiles = config.secretProfiles || {};
  const profile = profiles[args.name];
  if (!profile) {
    const available = Object.keys(profiles);
    return JSON.stringify({ error: `Profile "${args.name}" not found. Available: ${available.length ? available.join(', ') : '(none)'}` });
  }

  // Health check: which keys exist in secrets.local
  const localKeys = Object.keys(config.secrets?.local || {});
  const health = profile.secretKeys.map(k => ({ key: k, configured: localKeys.includes(k) }));

  return JSON.stringify({ name: args.name, profile, health }, null, 2);
}

async function deleteSecretProfile(args: DeleteSecretProfileArgs): Promise<string> {
  const config = loadServicesConfig();
  if (!config.secretProfiles || !(args.name in config.secretProfiles)) {
    return JSON.stringify({ error: `Profile "${args.name}" not found.` });
  }

  delete config.secretProfiles[args.name];
  if (Object.keys(config.secretProfiles).length === 0) {
    delete config.secretProfiles;
  }

  const { applied, pending } = writeServicesConfig(config);
  const result: Record<string, unknown> = { deleted: args.name, applied, pending };
  if (pending) result.message = 'Config staged — ask the CTO to run "npx gentyr sync" to apply.';
  return JSON.stringify(result);
}

async function listSecretProfiles(): Promise<string> {
  const config = loadServicesConfig();
  const profiles = config.secretProfiles || {};
  const localKeys = Object.keys(config.secrets?.local || {});

  const entries = Object.entries(profiles).map(([name, profile]) => ({
    name,
    ...profile,
    health: {
      total: profile.secretKeys.length,
      configured: profile.secretKeys.filter(k => localKeys.includes(k)).length,
      missing: profile.secretKeys.filter(k => !localKeys.includes(k)),
    },
  }));

  return JSON.stringify({ profiles: entries, count: entries.length }, null, 2);
}

// ============================================================================
// Services Config Management
// ============================================================================

async function updateServicesConfig(args: UpdateServicesConfigArgs): Promise<string> {
  if ('secrets' in args.updates) {
    return JSON.stringify({ error: 'Cannot modify secrets via this tool. Use populate_secrets_local to add op:// entries to secrets.local.' });
  }
  if ('secretProfiles' in args.updates) {
    return JSON.stringify({ error: 'Cannot modify secretProfiles via this tool. Use register_secret_profile / delete_secret_profile for profile management.' });
  }

  const configPath = join(PROJECT_DIR, '.claude', 'config', 'services.json');
  const pendingPath = join(PROJECT_DIR, '.claude', 'state', 'services-config-pending.json');

  // Load current config — seed with { secrets: {} } only when file truly doesn't exist
  let current: Record<string, unknown>;
  try {
    const existing = safeReadJson<Record<string, unknown>>(configPath, { backupPath: SERVICES_BACKUP_PATH });
    current = existing ?? { secrets: {} };
  } catch (readErr) {
    return JSON.stringify({ error: `Cannot read services.json: ${(readErr as Error).message}. Aborting update to prevent data loss.` });
  }

  // Merge updates (top-level only — nested objects like devServices are replaced wholesale)
  const merged = { ...current, ...args.updates };

  // Validate against schema
  const result = ServicesConfigSchema.safeParse(merged);
  if (!result.success) {
    return JSON.stringify({ error: `Validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
  }

  // Try direct write — atomic with backup
  try {
    safeWriteJson(configPath, result.data, { backupPath: SERVICES_BACKUP_PATH, backupValidator: hasSecretsLocal });
    return JSON.stringify({ applied: true, pending: false, updatedKeys: Object.keys(args.updates) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      // File is protected (root-owned) — stage validated data for next sync
      let pending: Record<string, unknown> = {};
      try { pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }
      // Store validated values (not raw input) so Zod defaults/transforms are preserved
      const validatedData = result.data as Record<string, unknown>;
      for (const key of Object.keys(args.updates)) {
        if (key in validatedData) pending[key] = validatedData[key];
      }
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
      return JSON.stringify({
        applied: false,
        pending: true,
        updatedKeys: Object.keys(args.updates),
        message: 'Config staged — ask the CTO to run "npx gentyr sync" to apply.',
      });
    }
    throw err;
  }
}

async function getServicesConfig(): Promise<string> {
  const configPath = join(PROJECT_DIR, '.claude', 'config', 'services.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    // Omit secrets — agents should not see 1Password references via this tool
    const { secrets: _, ...safe } = raw;
    return JSON.stringify(safe, null, 2);
  } catch {
    return JSON.stringify({ error: 'services.json not found or unreadable' });
  }
}

// ============================================================================
// Populate secrets.local
// ============================================================================

async function populateSecretsLocal(args: PopulateSecretsLocalArgs): Promise<string> {
  const parsed = PopulateSecretsLocalArgsSchema.parse(args);
  const entries = parsed.entries as Record<string, string>;

  const configPath = join(PROJECT_DIR, '.claude', 'config', 'services.json');
  const pendingPath = join(PROJECT_DIR, '.claude', 'state', 'secrets-local-pending.json');

  // Load current config — seed with { secrets: {} } only when file truly doesn't exist
  let current: Record<string, unknown>;
  try {
    const existing = safeReadJson<Record<string, unknown>>(configPath, { backupPath: SERVICES_BACKUP_PATH });
    current = existing ?? { secrets: {} };
  } catch (readErr) {
    return JSON.stringify({ error: `Cannot read services.json: ${(readErr as Error).message}. Aborting update to prevent data loss.` });
  }

  // Merge into secrets.local
  const secrets = (current.secrets || {}) as Record<string, unknown>;
  const existingLocal = (secrets.local || {}) as Record<string, string>;
  const merged = { ...existingLocal, ...entries };

  let newCount = 0;
  let updatedCount = 0;
  for (const key of Object.keys(entries)) {
    if (key in existingLocal) { updatedCount++; } else { newCount++; }
  }

  // Build the updated config
  const updated = { ...current, secrets: { ...secrets, local: merged } };

  // Validate against schema
  const result = ServicesConfigSchema.safeParse(updated);
  if (!result.success) {
    return JSON.stringify({ error: `Validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
  }

  // Try direct write ��� atomic with backup
  try {
    safeWriteJson(configPath, result.data, { backupPath: SERVICES_BACKUP_PATH, backupValidator: hasSecretsLocal });
    return JSON.stringify({
      applied: true,
      pending: false,
      newCount,
      updatedCount,
      totalLocalSecrets: Object.keys(merged).length,
      message: `${newCount} new + ${updatedCount} updated entries in secrets.local.`,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      // Root-owned — stage for next sync, merging with existing pending
      let existingPending: Record<string, string> = {};
      try {
        const raw = JSON.parse(readFileSync(pendingPath, 'utf-8')) as { entries?: Record<string, string> };
        existingPending = raw.entries || {};
      } catch { /* new */ }
      const mergedPending = { ...existingPending, ...entries };
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, JSON.stringify({ entries: mergedPending, timestamp: new Date().toISOString() }, null, 2) + '\n');
      return JSON.stringify({
        applied: false,
        pending: true,
        newCount,
        updatedCount,
        stagedEntries: Object.keys(mergedPending).length,
        message: `Entries staged in secrets-local-pending.json. Ask the CTO to run 'npx gentyr sync' to apply them. Do NOT re-add — they are already staged.`,
      });
    }
    throw err;
  }
}

async function populateSecretsFly(args: PopulateSecretsFlyArgs): Promise<string> {
  const parsed = PopulateSecretsFlyArgsSchema.parse(args);
  const appName = parsed.appName;
  const entries = parsed.entries as Record<string, string>;

  const configPath = join(PROJECT_DIR, '.claude', 'config', 'services.json');
  const pendingPath = join(PROJECT_DIR, '.claude', 'state', 'secrets-fly-pending.json');

  let current: Record<string, unknown>;
  try {
    const existing = safeReadJson<Record<string, unknown>>(configPath, { backupPath: SERVICES_BACKUP_PATH });
    current = existing ?? { secrets: {} };
  } catch (readErr) {
    return JSON.stringify({ error: `Cannot read services.json: ${(readErr as Error).message}. Aborting update to prevent data loss.` });
  }

  // Merge into secrets.fly[appName]
  const secrets = (current.secrets || {}) as Record<string, unknown>;
  const existingFly = (secrets.fly || {}) as Record<string, Record<string, string>>;
  const existingApp = (existingFly[appName] || {}) as Record<string, string>;
  const mergedApp = { ...existingApp, ...entries };

  let newCount = 0;
  let updatedCount = 0;
  for (const key of Object.keys(entries)) {
    if (key in existingApp) { updatedCount++; } else { newCount++; }
  }

  const updated = {
    ...current,
    secrets: {
      ...secrets,
      fly: { ...existingFly, [appName]: mergedApp },
    },
  };

  const result = ServicesConfigSchema.safeParse(updated);
  if (!result.success) {
    return JSON.stringify({ error: `Validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
  }

  try {
    safeWriteJson(configPath, result.data, { backupPath: SERVICES_BACKUP_PATH });
    return JSON.stringify({
      applied: true,
      pending: false,
      appName,
      newCount,
      updatedCount,
      totalAppSecrets: Object.keys(mergedApp).length,
      message: `${newCount} new + ${updatedCount} updated entries for Fly app '${appName}'. Next: call secret_sync_secrets({ target: 'fly' }) to push them to Fly.io.`,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      // Root-owned — stage for next sync
      let existingPending: Record<string, Record<string, string>> = {};
      try {
        const raw = JSON.parse(readFileSync(pendingPath, 'utf-8')) as { entries?: Record<string, Record<string, string>> };
        existingPending = raw.entries || {};
      } catch { /* new */ }
      const pendingApp = existingPending[appName] || {};
      existingPending[appName] = { ...pendingApp, ...entries };
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, JSON.stringify({ entries: existingPending, timestamp: new Date().toISOString() }, null, 2) + '\n');
      return JSON.stringify({
        applied: false,
        pending: true,
        appName,
        newCount,
        updatedCount,
        stagedEntries: Object.keys(existingPending[appName]).length,
        message: `Entries staged in secrets-fly-pending.json. Ask the CTO to run 'npx gentyr sync' to apply them. Do NOT re-add — they are already staged.`,
      });
    }
    throw err;
  }
}

// ============================================================================
// Server Setup
// ============================================================================

export const tools = [
  {
    name: 'secret_sync_secrets',
    description: 'Sync secrets from 1Password to Render, Vercel, Fly.io, or local dev (op-secrets.conf). Secret values are never exposed to the agent. Targets: render-production, render-staging, vercel, fly, local, all. For Fly.io: requires secrets.fly[appName] map in services.json — populate via populate_secrets_fly first.',
    schema: SyncSecretsArgsSchema,
    handler: syncSecrets as (args: unknown) => unknown,
  },
  {
    name: 'secret_list_mappings',
    description: 'List secret mappings from services.json. Shows key names and 1Password references (but not actual secret values).',
    schema: ListMappingsArgsSchema,
    handler: listMappings as (args: unknown) => unknown,
  },
  {
    name: 'secret_verify_secrets',
    description: 'Verify that secrets exist on target services or in local conf file (checks existence only, does not return values).',
    schema: VerifySecretsArgsSchema,
    handler: verifySecrets as (args: unknown) => unknown,
  },
  {
    name: 'secret_dev_server_start',
    description: 'Start dev servers with secrets resolved from 1Password. Secret values stay in MCP server memory and are injected into child process env vars — never returned to agent. Returns PIDs, ports, and status only.',
    schema: DevServerStartArgsSchema,
    handler: devServerStart as (args: unknown) => unknown,
  },
  {
    name: 'secret_dev_server_stop',
    description: 'Stop managed dev servers gracefully (SIGTERM, then SIGKILL after 5s). Returns shutdown status per service.',
    schema: DevServerStopArgsSchema,
    handler: devServerStop as (args: unknown) => unknown,
  },
  {
    name: 'secret_dev_server_status',
    description: 'Check status of managed dev servers. Returns running state, uptime, and detected ports. No secret values exposed.',
    schema: DevServerStatusArgsSchema,
    handler: devServerStatus as (args: unknown) => unknown,
  },
  {
    name: 'secret_run_command',
    description: 'Run a command with 1Password secrets injected into env vars. IMPORTANT: Check list_secret_profiles first — if a profile matches your command, use the profile param to ensure all required secrets are injected. Omitting a matching profile will be blocked on first attempt. Secrets resolved in MCP server memory, never returned to agent. Output sanitized. Executable must be in allowlist (pnpm, npx, node, tsx, playwright, prisma, drizzle-kit, vitest). No shell — argv array. Do NOT use for Playwright tests/demos — use run_demo or run_demo_batch. Commands with timeout > 55s are automatically run in background to avoid MCP transport timeout — poll results with secret_run_command_poll.',
    schema: RunCommandArgsSchema,
    handler: runCommand as (args: unknown) => unknown,
  },
  {
    name: 'secret_run_command_poll',
    description: 'Poll status of a background command started by secret_run_command. Returns running state, exit code, recent output lines, and progress file path. Use after secret_run_command returns mode "auto_background" or "background". Specify label (recommended) or pid.',
    schema: RunCommandPollArgsSchema,
    handler: runCommandPoll as (args: unknown) => unknown,
  },
  {
    name: 'register_secret_profile',
    description: 'Create or update a named secret profile. Profiles declare which secrets.local keys a command needs, preventing agents from forgetting required secrets. Use commandPattern/cwdPattern for auto-matching — when an agent calls secret_run_command with a matching command/cwd, the profile gate will block unless the profile is used.',
    schema: RegisterSecretProfileArgsSchema,
    handler: registerSecretProfile as (args: unknown) => unknown,
  },
  {
    name: 'get_secret_profile',
    description: 'Get a secret profile by name. Shows secretKeys, match patterns, and whether each key exists in secrets.local.',
    schema: GetSecretProfileArgsSchema,
    handler: getSecretProfile as (args: unknown) => unknown,
  },
  {
    name: 'delete_secret_profile',
    description: 'Delete a secret profile by name.',
    schema: DeleteSecretProfileArgsSchema,
    handler: deleteSecretProfile as (args: unknown) => unknown,
  },
  {
    name: 'list_secret_profiles',
    description: 'List all secret profiles with their secretKeys and match patterns. Call this before secret_run_command to check if a profile exists for your command.',
    schema: ListSecretProfilesArgsSchema,
    handler: listSecretProfiles as (args: unknown) => unknown,
  },
  {
    name: 'update_services_config',
    description: 'Update services.json config fields (e.g., worktreeArtifactCopy, worktreeBuildCommand, worktreeInstallTimeout, devServices). Validates against schema before writing. If file is root-owned (protected), stages changes for next "npx gentyr sync". Cannot modify the "secrets" key. Tip: Set worktreeArtifactCopy to copy pre-built dist/ directories into worktrees instead of running a full build (e.g., ["packages/*/dist"]).',
    schema: UpdateServicesConfigArgsSchema,
    handler: updateServicesConfig as (args: unknown) => unknown,
  },
  {
    name: 'get_services_config',
    description: 'Read current services.json config (excluding secrets). Returns all non-secret configuration fields.',
    schema: GetServicesConfigArgsSchema,
    handler: getServicesConfig as (args: unknown) => unknown,
  },
  {
    name: 'populate_secrets_local',
    description: 'Add or update op:// references in secrets.local (services.json). Use mcp__onepassword__op_vault_map to discover available op:// references first. If services.json is root-protected, stages entries for next "npx gentyr sync". Values must be op:// references (e.g., "op://Preview/AWS/access-key-id").',
    schema: PopulateSecretsLocalArgsSchema,
    handler: populateSecretsLocal as (args: unknown) => unknown,
  },
  {
    name: 'populate_secrets_fly',
    description: 'Add or update op:// references in secrets.fly[appName] (services.json) for pushing to a Fly.io app. Use mcp__onepassword__op_vault_map to discover available op:// references first. After populating, call secret_sync_secrets({ target: "fly" }) to push to Fly.io. If services.json is root-protected, stages entries for next "npx gentyr sync". Example: { appName: "myapp-playwright", entries: { "E2E_OPENAI_API_KEY": "op://Staging/OpenAI/credential" } }',
    schema: PopulateSecretsFlyArgsSchema,
    handler: populateSecretsFly as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

export const server = new McpServer({
  name: 'secret-sync-mcp',
  version: '1.0.0',
  tools,
});

if (!process.env.MCP_SHARED_DAEMON) { server.start(); }
