/**
 * Pure helper functions for the Playwright MCP server.
 *
 * Extracted to a separate module so tests can import them without
 * triggering the server's stdio side effects (process.exit on readline close).
 */

/**
 * Parse Playwright test output for pass/fail/skip counts.
 */
export function parseTestOutput(output: string): {
  passed: number;
  failed: number;
  skipped: number;
  duration: string;
} {
  // Playwright outputs lines like: "  10 passed (5.2s)"
  const passedMatch = output.match(/(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  const skippedMatch = output.match(/(\d+)\s+skipped/);
  const durationMatch = output.match(/\((\d+\.?\d*s)\)/);

  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
    duration: durationMatch ? durationMatch[1] : 'unknown',
  };
}

/**
 * Truncate output to prevent huge MCP responses.
 */
export function truncateOutput(output: string, maxLength = 4000): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + '\n... (output truncated)';
}

// Environment variable prefixes/names that extra_env is not allowed to override.
// Any key that equals a prefix exactly, or starts with "<prefix>_", or starts
// with a prefix that itself ends in "_" (e.g. "DYLD_") is blocked.
export const EXTRA_ENV_BLOCKED_PREFIXES = [
  'PATH', 'HOME', 'USER', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_',
  'SUPABASE_', 'DATABASE_', 'NEXT_PUBLIC_SUPABASE_',
  'GITHUB_TOKEN', 'CLOUDFLARE_', 'CODECOV_', 'RESEND_',
  'OP_SERVICE_ACCOUNT_TOKEN', 'GENTYR_',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'DEMO_SLOW_MO', 'DEMO_PAUSE_AT_END', 'DEMO_HEADLESS',
  'DEMO_SHOW_CURSOR', 'DEMO_PROGRESS_FILE', 'DEMO_RECORD_VIDEO', 'DEMO_MAXIMIZE',
  'PLAYWRIGHT_BASE_URL', 'CLAUDE_',
];

/**
 * Validate the extra_env map supplied to run_demo.
 * Returns null on success, or an error-message string on failure.
 */
export function validateExtraEnv(
  extra_env: Record<string, string>,
): string | null {
  const keys = Object.keys(extra_env);

  if (keys.length > 10) {
    return 'extra_env: max 10 keys allowed';
  }

  const totalSize = keys.reduce((sum, k) => sum + k.length + (extra_env[k]?.length ?? 0), 0);
  if (totalSize > 512 * 1024) {
    return 'extra_env: total size exceeds 512KB limit';
  }

  const blocked = keys.filter(k =>
    EXTRA_ENV_BLOCKED_PREFIXES.some(
      prefix => k === prefix || k.startsWith(prefix + '_') || k.startsWith(prefix),
    ),
  );
  if (blocked.length > 0) {
    return `extra_env: blocked keys: ${blocked.join(', ')}`;
  }

  return null;
}
