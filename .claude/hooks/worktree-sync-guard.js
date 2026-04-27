#!/usr/bin/env node
/**
 * PreToolUse Hook: Worktree Sync Guard
 *
 * Blocks `npx gentyr sync` (and variants) when the session CWD is inside
 * a worktree. Sync must always run from the main project tree — running it
 * from a worktree can destroy the worktree directory, leaving the agent
 * with a stale CWD.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * @version 1.0.0
 */

// ============================================================================
// Helpers
// ============================================================================

const WORKTREE_PATH_RE = /\/\.claude\/worktrees\/[^/]+\/?/;

/**
 * Matches commands that invoke gentyr sync, regardless of invocation style:
 *   npx gentyr sync
 *   node_modules/.bin/gentyr sync
 *   node node_modules/gentyr/cli/index.js sync
 *   ./node_modules/gentyr/cli/index.js sync
 */
const SYNC_CMD_RE = /\bgentyr\s+sync\b/;

/**
 * Detect if the current session is running inside a worktree.
 * Checks both CWD env var and the event cwd.
 */
function isInWorktree(event) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || event?.cwd || '';
  return WORKTREE_PATH_RE.test(cwd) ? cwd : null;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    // Invalid JSON — fail-open
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Only guard Bash and secret_run_command
  if (toolName !== 'Bash' && toolName !== 'mcp__secret-sync__secret_run_command') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const command = event?.tool_input?.command || '';

  // Fast exit: not a sync command
  if (!SYNC_CMD_RE.test(command)) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Check if running from a worktree
  const worktreeCwd = isInWorktree(event);
  if (!worktreeCwd) {
    // Main tree — allow
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Extract main project dir for the recovery hint
  const match = worktreeCwd.match(/^(.+)\/\.claude\/worktrees\/[^/]+\/?$/);
  const mainDir = match ? match[1] : '/path/to/project';

  const reason = [
    'BLOCKED: `gentyr sync` must not run from a worktree',
    '',
    `CWD: ${worktreeCwd}`,
    '',
    'Running sync from a worktree can destroy this directory.',
    'Sync must always run from the main project tree.',
    '',
    `Run instead: cd ${mainDir} && npx gentyr sync`,
  ].join('\n');

  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  }));
}

main().catch(() => {
  // Fail-open on unexpected errors
  process.stdout.write(JSON.stringify({ allow: true }));
});
