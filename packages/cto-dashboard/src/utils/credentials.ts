/**
 * Shared credential resolution for dashboard data readers.
 *
 * Resolution chain:
 * 1. Environment variable
 * 2. vault-mappings.json (op:// references resolved via `op read`, plain values returned directly)
 * 3. null if unavailable
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const VAULT_MAPPINGS_PATH = path.join(PROJECT_DIR, '.claude', 'vault-mappings.json');
const MCP_JSON_PATH = path.join(PROJECT_DIR, '.mcp.json');

let opTokenLoaded = false;

/**
 * Ensure OP_SERVICE_ACCOUNT_TOKEN is in the environment before calling `op read`.
 * Loads from .mcp.json (source of truth after token rotation).
 */
export function loadOpTokenFromMcpJson(): void {
  if (opTokenLoaded) return;
  opTokenLoaded = true;

  try {
    const config = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));
    for (const server of Object.values(config.mcpServers || {}) as Array<{ env?: Record<string, string> }>) {
      if (server.env?.['OP_SERVICE_ACCOUNT_TOKEN']) {
        process.env['OP_SERVICE_ACCOUNT_TOKEN'] = server.env['OP_SERVICE_ACCOUNT_TOKEN'];
        return;
      }
    }
  } catch {
    // .mcp.json not readable — op read will rely on env token or desktop session
  }
}

/**
 * Read a vault mapping value for the given key.
 */
function getVaultMapping(key: string): string | null {
  try {
    if (!fs.existsSync(VAULT_MAPPINGS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(VAULT_MAPPINGS_PATH, 'utf8')) as { mappings?: Record<string, string> };
    return data.mappings?.[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * Execute `op read` to resolve an op:// reference.
 */
function opRead(ref: string): string | null {
  try {
    return execFileSync('op', ['read', ref], { timeout: 10000, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a credential by key.
 *
 * 1. Check environment variable
 * 2. Load OP token from .mcp.json, read vault-mappings.json, resolve op:// ref
 * 3. Return null if unavailable
 */
export function resolveCredential(key: string): string | null {
  // 1. Env var (highest priority)
  if (process.env[key]) return process.env[key]!;

  // 2. Vault mappings
  loadOpTokenFromMcpJson();
  const ref = getVaultMapping(key);
  if (!ref) return null;

  if (ref.startsWith('op://')) {
    return opRead(ref);
  }

  // Direct value (e.g., zone IDs, non-secret config)
  return ref;
}
