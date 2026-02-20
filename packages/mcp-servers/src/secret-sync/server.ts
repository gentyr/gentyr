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

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SyncSecretsArgsSchema,
  ListMappingsArgsSchema,
  VerifySecretsArgsSchema,
  ServicesConfigSchema,
  type SyncSecretsArgs,
  type ListMappingsArgs,
  type VerifySecretsArgs,
  type ServicesConfig,
  type SyncResult,
  type MappingResult,
  type VerifyResult,
  type SyncedSecret,
  type SecretMapping,
  type VerifiedSecret,
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
] satisfies AnyToolHandler[];

const server = new McpServer({
  name: 'secret-sync-mcp',
  version: '1.0.0',
  tools,
});

server.start();
