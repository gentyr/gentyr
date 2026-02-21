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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createServer } from 'net';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SyncSecretsArgsSchema,
  ListMappingsArgsSchema,
  VerifySecretsArgsSchema,
  DevServerStartArgsSchema,
  DevServerStopArgsSchema,
  DevServerStatusArgsSchema,
  RunCommandArgsSchema,
  ServicesConfigSchema,
  type SyncSecretsArgs,
  type ListMappingsArgs,
  type VerifySecretsArgs,
  type DevServerStartArgs,
  type DevServerStopArgs,
  type DevServerStatusArgs,
  type RunCommandArgs,
  type ServicesConfig,
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
} from './types.js';

const { RENDER_API_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID, OP_SERVICE_ACCOUNT_TOKEN } = process.env;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '.';

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
  const configPath = join(PROJECT_DIR, '.claude/config/services.json');
  try {
    const configData = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configData) as unknown;
    const result = ServicesConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Invalid services.json: ${result.error.message}`);
    }

    return result.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load services.json: ${message}`);
  }
}

// ============================================================================
// Dev Server Process Management
// ============================================================================

const MAX_OUTPUT_LINES = 50;
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

/**
 * Resolve local secrets from 1Password — values stay in MCP server memory.
 * Returns env vars ready to inject into child process, plus any failed keys.
 */
function resolveLocalSecrets(config: ServicesConfig): { resolvedEnv: Record<string, string>; failedKeys: string[] } {
  const resolvedEnv: Record<string, string> = {};
  const failedKeys: string[] = [];
  const localSecrets = config.secrets.local || {};

  for (const [key, ref] of Object.entries(localSecrets)) {
    try {
      resolvedEnv[key] = opRead(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[secret-sync] resolveLocalSecrets: failed to resolve ${key}: ${message}\n`);
      failedKeys.push(key);
    }
  }

  return { resolvedEnv, failedKeys };
}

function cleanupManagedProcesses(): void {
  for (const [name, managed] of managedProcesses.entries()) {
    try {
      if (isProcessAlive(managed.pid)) {
        managed.process.kill('SIGTERM');
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
// 1Password Operations
// ============================================================================

/**
 * Read a secret from 1Password (value stays in-process, never returned to agent)
 */
function opRead(reference: string): string {
  if (!OP_SERVICE_ACCOUNT_TOKEN) {
    throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
  }

  try {
    return execFileSync('op', ['read', reference], {
      encoding: 'utf-8',
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN },
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${reference}: ${message}`);
  }
}

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

async function syncSecrets(args: SyncSecretsArgs): Promise<SyncResult> {
  const config = loadServicesConfig();
  const synced: SyncedSecret[] = [];
  const errors: Array<{ key: string; service: string; error: string }> = [];
  const manual = config.secrets.manual || [];

  const targets = args.target === 'all'
    ? ['render-production', 'render-staging', 'vercel'] as const
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

      for (const [key, secretConfig] of Object.entries(secrets)) {
        try {
          const value = opRead(secretConfig.ref);
          const status = await vercelSetEnvVar(projectId, key, value, secretConfig.target, secretConfig.type);
          synced.push({ key, service: 'vercel', status });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          synced.push({ key, service: 'vercel', status: 'error', error: message });
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
    ? ['render-production', 'render-staging', 'vercel'] as const
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
      for (const [key, secretConfig] of Object.entries(config.secrets.vercel)) {
        mappings.push({ key, reference: secretConfig.ref, service: 'vercel' });
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
    ? ['render-production', 'render-staging', 'vercel'] as const
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

/** Infrastructure credentials that must NOT leak to child processes */
const INFRA_CRED_KEYS = new Set([
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RENDER_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

const DEFAULT_ALLOWED_EXECUTABLES = new Set([
  'pnpm', 'npx', 'node', 'tsx', 'playwright', 'prisma', 'drizzle-kit', 'vitest',
]);

/** Blocked arg prefixes — matches both `-e` and `--eval=<code>` forms */
const BLOCKED_ARG_PREFIXES = ['-e', '--eval', '-c', '--print', '-p'];

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
 */
function runCommandBackground(
  command: string[],
  childEnv: Record<string, string>,
  sanitize: (text: string) => string,
  cwd: string,
  label: string,
): RunCommandBackgroundResult {
  const child = spawn(command[0], command.slice(1), {
    env: childEnv,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: false,
  });

  const pid = child.pid;
  if (!pid) {
    throw new Error('Failed to spawn process (no PID)');
  }

  const name = `run:${label}`;
  const managed: ManagedProcess = {
    name,
    label,
    process: child,
    pid,
    port: 0,
    startedAt: Date.now(),
    outputBuffer: [],
  };

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) appendOutput(managed, sanitize(line));
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) appendOutput(managed, sanitize(line));
  });

  child.on('exit', () => {
    managedProcesses.delete(name);
  });

  managedProcesses.set(name, managed);

  return {
    mode: 'background',
    pid,
    label,
    secretsResolved: 0, // filled by caller
    secretsFailed: [],   // filled by caller
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

  // Filter to requested subset if specified
  let injectedEnv: Record<string, string>;
  if (args.secretKeys) {
    injectedEnv = {};
    for (const key of args.secretKeys) {
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

    // Check if already running
    const existing = managedProcesses.get(name);
    if (existing && isProcessAlive(existing.pid)) {
      started.push({
        name,
        label: svc.label,
        pid: existing.pid,
        port: svc.port,
        status: 'already_running',
      });
      continue;
    }

    // Check port conflict
    if (svc.port > 0) {
      const portBusy = await isPortInUse(svc.port);
      if (portBusy) {
        if (args.force) {
          await killPort(svc.port);
          // Brief wait for port release
          await new Promise(r => setTimeout(r, 500));
        } else {
          started.push({
            name,
            label: svc.label,
            pid: 0,
            port: svc.port,
            status: 'error',
            error: `Port ${svc.port} already in use. Use force: true to kill existing process.`,
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
      // Set port if specified
      if (svc.port > 0) {
        childEnv.PORT = String(svc.port);
      }

      const child = spawn('pnpm', ['--filter', svc.filter, 'run', svc.command], {
        env: childEnv,
        cwd: PROJECT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      const pid = child.pid;
      if (!pid) {
        started.push({
          name,
          label: svc.label,
          pid: 0,
          port: svc.port,
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
        port: svc.port,
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
        managedProcesses.delete(name);
      });

      managedProcesses.set(name, managed);

      started.push({
        name,
        label: svc.label,
        pid,
        port: svc.port,
        status: 'started',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      started.push({
        name,
        label: svc.label,
        pid: 0,
        port: svc.port,
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
  const serviceNames = args.services || [...managedProcesses.keys()];

  for (const name of serviceNames) {
    const managed = managedProcesses.get(name);
    if (!managed) {
      stopped.push({ name, pid: 0, status: 'not_running' });
      continue;
    }

    const pid = managed.pid;

    if (!isProcessAlive(pid)) {
      managedProcesses.delete(name);
      stopped.push({ name, pid, status: 'not_running' });
      continue;
    }

    try {
      managed.process.kill('SIGTERM');

      // Wait up to SIGTERM_TIMEOUT_MS for graceful exit
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), SIGTERM_TIMEOUT_MS);
        managed.process.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      if (!exited && isProcessAlive(pid)) {
        managed.process.kill('SIGKILL');
        managedProcesses.delete(name);
        stopped.push({ name, pid, status: 'force_killed' });
      } else {
        managedProcesses.delete(name);
        stopped.push({ name, pid, status: 'stopped' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      managedProcesses.delete(name);
      stopped.push({ name, pid, status: 'error', error: message });
    }
  }

  return { stopped };
}

async function devServerStatus(_args: DevServerStatusArgs): Promise<DevServerStatusResult> {
  const services: DevServerStatusService[] = [];

  for (const [name, managed] of managedProcesses.entries()) {
    const running = isProcessAlive(managed.pid);

    if (!running) {
      managedProcesses.delete(name);
    }

    services.push({
      name,
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
// Server Setup
// ============================================================================

const tools = [
  {
    name: 'secret_sync_secrets',
    description: 'Sync secrets from 1Password to Render, Vercel, or local dev (op-secrets.conf). Secret values are never exposed to the agent.',
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
    description: 'Run an arbitrary command with 1Password secrets injected into env vars. Secrets are resolved in MCP server memory and never returned to the agent. Output is sanitized to redact any leaked secret values. Executable must be in the allowlist (pnpm, npx, node, tsx, playwright, prisma, drizzle-kit, vitest). No shell interpretation — command is an argv array.',
    schema: RunCommandArgsSchema,
    handler: runCommand as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

const server = new McpServer({
  name: 'secret-sync-mcp',
  version: '1.0.0',
  tools,
});

server.start();
