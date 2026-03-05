/**
 * Shared 1Password secret resolution utilities.
 * Used by secret-sync and playwright MCP servers.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ServicesConfigSchema, type ServicesConfig } from '../secret-sync/types.js';

const { OP_SERVICE_ACCOUNT_TOKEN } = process.env;

/** Infrastructure credentials that must NOT leak to child processes */
export const INFRA_CRED_KEYS = new Set([
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RENDER_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

/**
 * Read a secret from 1Password (value stays in-process, never returned to agent)
 */
export function opRead(reference: string): string {
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

/**
 * Load and validate services.json from the project directory.
 */
export function loadServicesConfig(projectDir: string): ServicesConfig {
  const configPath = join(projectDir, '.claude/config/services.json');
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

/**
 * Resolve local secrets from 1Password — values stay in MCP server memory.
 * Returns env vars ready to inject into child process, plus any failed keys.
 */
export function resolveLocalSecrets(config: ServicesConfig): { resolvedEnv: Record<string, string>; failedKeys: string[] } {
  const resolvedEnv: Record<string, string> = {};
  const failedKeys: string[] = [];
  const localSecrets = config.secrets.local || {};

  for (const [key, ref] of Object.entries(localSecrets)) {
    try {
      resolvedEnv[key] = opRead(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[op-secrets] resolveLocalSecrets: failed to resolve ${key}: ${message}\n`);
      failedKeys.push(key);
    }
  }

  return { resolvedEnv, failedKeys };
}

/**
 * Build a clean child environment from process.env:
 * - Strips INFRA_CRED_KEYS
 * - Merges in optional extra secrets
 */
export function buildCleanEnv(extraSecrets?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !INFRA_CRED_KEYS.has(k)) env[k] = v;
  }
  if (extraSecrets) {
    Object.assign(env, extraSecrets);
  }
  return env;
}
