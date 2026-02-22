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
