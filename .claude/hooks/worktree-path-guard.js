#!/usr/bin/env node
/**
 * PreToolUse Hook: Worktree Path Guard
 *
 * When the session is running in a worktree (detected by .git being a file,
 * not a directory), blocks Write and Edit operations that target files OUTSIDE
 * the worktree root. This prevents agents from accidentally writing files to
 * the main repo's working tree when they should be writing to the worktree.
 *
 * Detection:
 *   - .git is a file (not a directory) → worktree context
 *   - Read .git file to find worktree root
 *   - Compare target file_path against worktree root
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Worktree Detection
// ============================================================================

/**
 * Detect if the given directory is a git worktree.
 * In a worktree, .git is a file containing "gitdir: /path/to/main/.git/worktrees/<name>"
 *
 * @param {string} dir - Directory to check
 * @returns {{ isWorktree: boolean, worktreeRoot: string|null, mainRepoRoot: string|null }}
 */
function detectWorktree(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    const stat = fs.lstatSync(dotGit);

    if (!stat.isFile()) {
      // .git is a directory → main repo, not a worktree
      return { isWorktree: false, worktreeRoot: null, mainRepoRoot: null };
    }

    // Read .git file: "gitdir: /path/to/main/.git/worktrees/<name>"
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    const gitdirMatch = content.match(/^gitdir:\s*(.+)$/);
    if (!gitdirMatch) {
      return { isWorktree: false, worktreeRoot: null, mainRepoRoot: null };
    }

    const gitdir = gitdirMatch[1];

    // Extract main repo root from gitdir path
    // gitdir format: /path/to/main/.git/worktrees/<name>
    const worktreesMatch = gitdir.match(/^(.+)\/\.git\/worktrees\/[^/]+$/);
    const mainRepoRoot = worktreesMatch ? worktreesMatch[1] : null;

    return {
      isWorktree: true,
      worktreeRoot: dir,
      mainRepoRoot,
    };
  } catch {
    return { isWorktree: false, worktreeRoot: null, mainRepoRoot: null };
  }
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

  // Only guard file-writing tools
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Determine session directory
  // In worktree sessions, CLAUDE_PROJECT_DIR should be the worktree path.
  // Fall back to hookInput.cwd, then process.cwd().
  const sessionDir = process.env.CLAUDE_PROJECT_DIR || event?.cwd || process.cwd();

  // Detect worktree context
  const { isWorktree, worktreeRoot, mainRepoRoot } = detectWorktree(sessionDir);

  if (!isWorktree) {
    // Not in a worktree — allow everything
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Extract target file path from tool input
  // NotebookEdit uses notebook_path; Write/Edit use file_path
  const targetPath = event?.tool_input?.file_path || event?.tool_input?.notebook_path || '';
  if (!targetPath) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Resolve to absolute path
  const resolvedTarget = path.resolve(targetPath);
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);

  // Check if target path is inside the worktree
  if (resolvedTarget.startsWith(resolvedWorktreeRoot + '/') || resolvedTarget === resolvedWorktreeRoot) {
    // Inside worktree — allow
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Allow writes to temp directories — these aren't repo paths
  if (resolvedTarget.startsWith('/tmp/')) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Allow writes to OS tmpdir (e.g., /var/folders/xx/xxx/T/ on macOS)
  const osTmpDir = os.tmpdir();
  if (osTmpDir && resolvedTarget.startsWith(osTmpDir + '/')) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Allow writes to user-level config (e.g., ~/.claude/memory/)
  const homeDir = process.env.HOME || '';
  if (homeDir && resolvedTarget.startsWith(path.join(homeDir, '.claude/'))) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Target is OUTSIDE the worktree — block
  const mainRepoMsg = mainRepoRoot
    ? ` It looks like this path is in the main repo at "${mainRepoRoot}".`
    : '';

  const suggestedPath = mainRepoRoot && resolvedTarget.startsWith(mainRepoRoot + '/')
    ? resolvedTarget.replace(mainRepoRoot, resolvedWorktreeRoot)
    : null;

  const suggestion = suggestedPath
    ? `\n\nDid you mean: ${suggestedPath}`
    : `\n\nUse paths relative to your worktree root: ${resolvedWorktreeRoot}`;

  const reason = [
    `BLOCKED: File path outside worktree`,
    '',
    `Target: ${resolvedTarget}`,
    `Worktree root: ${resolvedWorktreeRoot}`,
    '',
    `You are running in a worktree. ${toolName} operations must target files`,
    `inside the worktree to avoid writing to the main repo's working tree.${mainRepoMsg}`,
    suggestion,
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
