/**
 * Shared 1Password secret resolution utilities.
 * Used by secret-sync and playwright MCP servers.
 */

import { execFileSync } from 'child_process';
import { lstatSync, readFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { ServicesConfigSchema, type ServicesConfig } from '../secret-sync/types.js';

/** Read OP_SERVICE_ACCOUNT_TOKEN at call time, not module load time.
 *  mcp-launcher.js may set it after this module is first imported. */
function getOpToken(): string | undefined {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN;
}

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
  const token = getOpToken();
  if (!token) {
    throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
  }

  try {
    return execFileSync('op', ['read', reference], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      // ELOOP = circular or excessively deep symlinks in .claude/config path
      let diagnostic = '';
      try {
        const configDir = join(projectDir, '.claude/config');
        const stat = lstatSync(configDir);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(configDir);
          diagnostic = ` .claude/config is a symlink -> ${target}.`;
          if (target === configDir || target.endsWith('/.claude/config')) {
            diagnostic += ' If running in a worktree, this symlink should point to the MAIN tree config (not itself).';
          }
        }
      } catch { /* diagnostic is best-effort */ }
      throw new Error(`Failed to load services.json: ELOOP (too many symbolic links) at ${configPath}.${diagnostic} Verify .claude/config in the main tree is a real directory, not a symlink.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load services.json: ${message}`);
  }
}

/**
 * Resolve local secrets from 1Password — values stay in MCP server memory.
 * Returns env vars ready to inject into child process, plus any failed keys.
 */
export function resolveLocalSecrets(config: ServicesConfig): { resolvedEnv: Record<string, string>; failedKeys: string[]; failureDetails: Record<string, string> } {
  const resolvedEnv: Record<string, string> = {};
  const failedKeys: string[] = [];
  const failureDetails: Record<string, string> = {};
  const localSecrets = config.secrets.local || {};

  for (const [key, ref] of Object.entries(localSecrets)) {
    try {
      resolvedEnv[key] = opRead(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[op-secrets] resolveLocalSecrets: failed to resolve ${key}: ${message}\n`);
      failedKeys.push(key);
      failureDetails[key] = message;
    }
  }

  return { resolvedEnv, failedKeys, failureDetails };
}

/**
 * Resolve any op:// references in an env var map.
 * Values starting with "op://" are resolved via opRead(); others are left as-is.
 * Failed resolutions are removed from the map and logged to stderr.
 */
export function resolveOpReferences(envVars: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('op://')) {
      try {
        resolved[key] = opRead(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[op-secrets] resolveOpReferences: failed to resolve ${key}: ${message}\n`);
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Strict variant of resolveOpReferences — returns failed keys instead of silently dropping them.
 * Callers can decide whether to abort or continue with partial results.
 */
export function resolveOpReferencesStrict(envVars: Record<string, string>): {
  resolved: Record<string, string>;
  failedKeys: string[];
  failureDetails: Record<string, string>;
} {
  const resolved: Record<string, string> = {};
  const failedKeys: string[] = [];
  const failureDetails: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('op://')) {
      try {
        resolved[key] = opRead(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[op-secrets] resolveOpReferencesStrict: failed to resolve ${key}: ${message}\n`);
        failedKeys.push(key);
        failureDetails[key] = message;
      }
    } else {
      resolved[key] = value;
    }
  }
  return { resolved, failedKeys, failureDetails };
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
