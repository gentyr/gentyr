#!/usr/bin/env node
/**
 * PreToolUse Hook: Worktree CWD Guard
 *
 * Detects when the session's working directory no longer exists (typically
 * because a worktree was deleted by cleanup automation or manual removal).
 * Blocks Bash commands with a helpful recovery message instead of letting
 * them fail with cryptic "no such file or directory" errors.
 *
 * Recovery: allows commands that start with `cd` so the agent can navigate
 * to a valid directory and recover the session.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the main project directory from a worktree path.
 * Worktree paths follow the pattern: /path/to/project/.claude/worktrees/<name>/
 *
 * @param {string} worktreePath
 * @returns {string|null} Main project directory or null if not a worktree path
 */
function extractMainProjectDir(worktreePath) {
  const match = worktreePath.match(/^(.+)\/\.claude\/worktrees\/[^/]+\/?$/);
  return match ? match[1] : null;
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
    // Invalid JSON — allow (fail-open)
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Only guard Bash tool
  if (toolName !== 'Bash') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Get the session's working directory
  const sessionCwd = process.env.CLAUDE_PROJECT_DIR || event?.cwd;

  if (!sessionCwd) {
    // Can't determine CWD — allow (fail-open)
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Check if the CWD exists
  if (fs.existsSync(sessionCwd)) {
    // CWD is valid — allow
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // CWD doesn't exist — likely a deleted worktree
  const command = event?.tool_input?.command || '';
  const trimmedCmd = command.trim();

  // Allow commands that start with `cd` — the agent is trying to recover
  // by navigating to a valid directory. This includes:
  //   - `cd /path/to/project`
  //   - `cd /path && other-command`
  if (/^\s*cd\s+/.test(trimmedCmd)) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Try to extract the main project directory for a helpful recovery message
  const mainProjectDir = extractMainProjectDir(sessionCwd);

  const recoveryCmd = mainProjectDir
    ? `cd ${mainProjectDir}`
    : 'cd /path/to/your/project';

  const reason = [
    'BLOCKED: Working directory no longer exists',
    '',
    `CWD: ${sessionCwd}`,
    '',
    'The worktree directory was deleted (by cleanup automation or manual removal).',
    'Your session is pointing to a stale directory.',
    '',
    `To recover, run: ${recoveryCmd}`,
    '',
    'Then retry your command.',
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
