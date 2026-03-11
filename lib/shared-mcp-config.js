/**
 * Shared MCP server configuration.
 *
 * Defines which servers are Tier 1 (safe to share in a single daemon process)
 * and their default port.
 *
 * Tier 1 servers are stateless/read-only API proxies that do not hold
 * per-session state, making them safe to share across all concurrent agents.
 *
 * @module lib/shared-mcp-config
 */

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
 * Generate the HTTP URL for a shared server.
 *
 * @param {string} serverName - The server name (must be in TIER1_SERVERS)
 * @param {number} [port] - Override the default port
 * @returns {string} The full HTTP URL for the server's MCP endpoint
 */
export function sharedServerUrl(serverName, port = MCP_DAEMON_PORT) {
  return `http://127.0.0.1:${port}/mcp/${serverName}`;
}
