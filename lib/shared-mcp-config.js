/**
 * Shared MCP server configuration.
 *
 * Defines which servers are Tier 1 (safe to share in a single daemon process),
 * which servers require remote services (excluded in local mode),
 * and their default port.
 *
 * Tier 1 servers are stateless/read-only API proxies that do not hold
 * per-session state, making them safe to share across all concurrent agents.
 *
 * @module lib/shared-mcp-config
 */

import fs from 'node:fs';
import path from 'node:path';

export const MCP_DAEMON_PORT = 18090;

export const TIER1_SERVERS = [
  'github',
  'cloudflare',
  'supabase',
  'vercel',
  'render',
  'codecov',
  'resend',
  'elastic-logs',
  'onepassword',
  'secret-sync',
  'feedback-explorer',
  'cto-report',
  'specs-browser',
  'setup-helper',
  'show',
];

/**
 * Remote servers excluded from .mcp.json when local mode is active.
 * These all require external service credentials via 1Password.
 */
export const REMOTE_SERVERS = [
  'github',
  'cloudflare',
  'supabase',
  'vercel',
  'render',
  'codecov',
  'resend',
  'elastic-logs',
  'onepassword',
  'secret-sync',
];

/**
 * Generate the HTTP URL for a shared server.
 *
 * @param {string} serverName - The server name (must be in TIER1_SERVERS)
 * @param {number} [port] - Override the default port
 * @returns {string} The full HTTP URL for the server's MCP endpoint
 */
export function sharedServerUrl(serverName, port = MCP_DAEMON_PORT) {
  return `http://127.0.0.1:${port}/mcp/${serverName}`;
}

// ---------------------------------------------------------------------------
// Local Mode utilities
// ---------------------------------------------------------------------------

/**
 * Check if local prototyping mode is enabled for a project.
 * Reads .claude/state/local-mode.json synchronously. Returns false on any error.
 *
 * @param {string} [projectDir] - Project directory (defaults to CLAUDE_PROJECT_DIR or cwd)
 * @returns {boolean}
 */
export function isLocalModeEnabled(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const statePath = path.join(dir, '.claude', 'state', 'local-mode.json');
    if (!fs.existsSync(statePath)) return false;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Read the full local mode state object.
 * Returns null if local mode is not enabled or state file is missing.
 *
 * @param {string} [projectDir]
 * @returns {{ enabled: boolean, enabledAt: string, enabledBy: string } | null}
 */
export function getLocalModeState(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const statePath = path.join(dir, '.claude', 'state', 'local-mode.json');
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.enabled === true) return state;
    return null;
  } catch {
    return null;
  }
}

/**
 * Enable or disable local prototyping mode.
 *
 * @param {string} projectDir - Project directory
 * @param {boolean} enabled
 * @param {string} [enabledBy='cto'] - Who toggled ('init', 'cto', 'mcp-tool')
 * @returns {{ enabled: boolean, enabledAt: string, enabledBy: string }}
 */
export function setLocalMode(projectDir, enabled, enabledBy = 'cto') {
  const state = { enabled, enabledAt: new Date().toISOString(), enabledBy };
  const stateDir = path.join(projectDir, '.claude', 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'local-mode.json'), JSON.stringify(state, null, 2));
  return state;
}
