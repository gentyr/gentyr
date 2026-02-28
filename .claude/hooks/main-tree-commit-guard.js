#!/usr/bin/env node
/**
 * PreToolUse Hook: Main Tree Commit Guard
 *
 * Blocks destructive git operations (add, commit, reset --hard, stash) when
 * ALL conditions are true:
 *   - CLAUDE_SPAWNED_SESSION === 'true' (sub-agent, not interactive user)
 *   - .git is a directory (main working tree, not a worktree)
 *   - GENTYR_PROMOTION_PIPELINE !== 'true' (not a trusted promotion agent)
 *
 * This prevents spawned sub-agents from triggering lint-staged's
 * stash/reset --hard chain which destroys the parent session's uncommitted work.
 *
 * Uses the same tokenizer pattern from branch-checkout-guard.js for robust
 * command parsing (quote-aware tokenize + splitOnShellOperators).
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Shell Tokenizer (from credential-file-guard.js / branch-checkout-guard.js)
// ============================================================================

/**
 * Simple shell tokenizer that respects single and double quotes.
 * @param {string} str
 * @returns {string[]}
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of str) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Split a command string on shell operators (|, ||, &&, ;) while respecting
 * single and double quotes.
 *
 * @param {string} command
 * @returns {string[]} Array of sub-command strings
 */
function splitOnShellOperators(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Only split on operators when outside quotes
    if (!inSingle && !inDouble) {
      if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ============================================================================
// Git Command Analysis
// ============================================================================

/**
 * Check if we're in a worktree (not the main working tree).
 * In a worktree, .git is a file containing "gitdir: ..." reference.
 * @returns {boolean}
 */
function isWorktree() {
  try {
    const gitPath = path.join(PROJECT_DIR, '.git');
    const stat = fs.lstatSync(gitPath);
    return stat.isFile(); // .git file = worktree
  } catch {
    return false; // No .git at all = not a repo
  }
}

/**
 * Check if we're in a git repo (main tree).
 * @returns {boolean}
 */
function isMainTree() {
  try {
    const gitPath = path.join(PROJECT_DIR, '.git');
    const stat = fs.lstatSync(gitPath);
    return stat.isDirectory(); // .git directory = main tree
  } catch {
    return false;
  }
}

/**
 * Git subcommands that are always allowed for spawned agents in main tree.
 * Includes read-only commands and network commands that don't modify the working tree.
 * Note: `push` is allowed (sends existing commits), `fetch` is allowed (updates remote refs only).
 * `pull` is intentionally excluded — it runs fetch+merge which can clobber working tree files.
 * `clone` is allowed (creates a new directory, doesn't modify current tree).
 */
const ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'branch', 'remote',
  'tag', 'describe', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'for-each-ref', 'name-rev', 'reflog', 'shortlog', 'whatchanged',
  'cherry', 'count-objects', 'fsck', 'verify-commit', 'verify-tag',
  'push', 'fetch', 'clone',
]);

/**
 * Analyze a single sub-command for blocked destructive git operations.
 * Only blocks for spawned agents in main tree.
 *
 * Blocked:
 *   - git add (any form)
 *   - git commit (any form)
 *   - git reset --hard
 *   - git stash (push/pop/drop/clear/bare) — but NOT stash list/show
 *
 * @param {string} subCommand
 * @returns {{ blocked: boolean, reason?: string }}
 */
function analyzeSubCommand(subCommand) {
  const tokens = tokenize(subCommand);
  if (tokens.length === 0) return { blocked: false };

  // Find the git command (could be "/usr/bin/git", "git", etc.)
  let gitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const base = path.basename(tokens[i]);
    if (base === 'git') {
      gitIdx = i;
      break;
    }
  }
  if (gitIdx === -1) return { blocked: false };

  // Extract subcommand (skip global flags)
  let subcmd = '';
  let subcmdIdx = -1;
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    // Skip global flags that take a value
    if (tok === '-C' || tok === '-c' || tok === '--git-dir' || tok === '--work-tree' || tok === '--namespace') {
      i++; // skip next token (the value)
      continue;
    }
    // Skip combined global flags
    if (/^--git-dir=|^--work-tree=|^--namespace=|^-C./.test(tok)) continue;
    // Skip valueless global flags
    if (/^--(bare|no-pager|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|no-optional-locks)$/.test(tok)) continue;
    // Skip any other flag-looking token before the subcommand
    if (tok.startsWith('-')) continue;
    subcmd = tok;
    subcmdIdx = i;
    break;
  }

  if (!subcmd) return { blocked: false };

  // Allowed commands (read-only + safe network ops) pass through
  if (ALLOWED_SUBCOMMANDS.has(subcmd)) return { blocked: false };

  // --- git add ---
  if (subcmd === 'add') {
    return {
      blocked: true,
      reason: "Spawned agents must not run 'git add' in the main working tree. Staging files triggers the lint-staged chain on commit, which can destroy the parent session's uncommitted work via 'git stash' + 'git reset --hard'. Use a worktree (isolation: \"worktree\") instead.",
    };
  }

  // --- git commit ---
  if (subcmd === 'commit') {
    return {
      blocked: true,
      reason: "Spawned agents must not run 'git commit' in the main working tree. Commits trigger pre-commit hooks including lint-staged, which uses 'git stash push' / 'git stash pop' / 'git reset --hard' internally. A failed stash pop destroys ALL uncommitted working tree changes. Use a worktree (isolation: \"worktree\") instead.",
    };
  }

  // --- git reset --hard ---
  if (subcmd === 'reset') {
    const argsAfterSubcmd = tokens.slice(subcmdIdx + 1);
    const hasHard = argsAfterSubcmd.some(t => t === '--hard');
    if (hasHard) {
      return {
        blocked: true,
        reason: "Spawned agents must not run 'git reset --hard' in the main working tree. This directly destroys all uncommitted working tree changes. Use a worktree (isolation: \"worktree\") instead.",
      };
    }
    // Soft reset / unstaging is fine
    return { blocked: false };
  }

  // --- git stash ---
  if (subcmd === 'stash') {
    const argsAfterSubcmd = tokens.slice(subcmdIdx + 1);
    // Find the stash action (first non-flag token after 'stash')
    let stashAction = '';
    for (const tok of argsAfterSubcmd) {
      if (tok.startsWith('-')) continue;
      stashAction = tok;
      break;
    }

    // Read-only stash subcommands are always allowed
    if (stashAction === 'list' || stashAction === 'show') {
      return { blocked: false };
    }

    // Everything else (push, pop, drop, clear, apply, bare 'git stash') is blocked
    return {
      blocked: true,
      reason: `Spawned agents must not run 'git stash${stashAction ? ' ' + stashAction : ''}' in the main working tree. Stash operations displace uncommitted changes and can cause data loss when pop fails. Use a worktree (isolation: \"worktree\") instead.`,
    };
  }

  // --- git clean ---
  if (subcmd === 'clean') {
    return {
      blocked: true,
      reason: "Spawned agents must not run 'git clean' in the main working tree. This deletes untracked files created by the parent session. Use a worktree (isolation: \"worktree\") instead.",
    };
  }

  // --- git pull ---
  if (subcmd === 'pull') {
    return {
      blocked: true,
      reason: "Spawned agents must not run 'git pull' in the main working tree. Pull runs fetch+merge which can overwrite the parent session's uncommitted work with upstream changes. Use a worktree (isolation: \"worktree\") instead.",
    };
  }

  // --- git checkout / git restore with staged changes could also be risky,
  //     but those are already handled by branch-checkout-guard.js ---

  // Unknown subcommand — allow (fail-open for unrecognized commands)
  return { blocked: false };
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

  // Only handle Bash tool calls
  const toolName = event?.tool_name || '';
  if (toolName !== 'Bash') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Only block for spawned sessions (sub-agents)
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Allow promotion pipeline agents
  if (process.env.GENTYR_PROMOTION_PIPELINE === 'true') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Skip if we're in a worktree (all git ops allowed)
  if (isWorktree()) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Skip if we're NOT in a main tree (not a git repo)
  if (!isMainTree()) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Extract command from tool input
  const command = event?.tool_input?.command || '';
  if (!command) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Split on shell operators and analyze each sub-command
  const subCommands = splitOnShellOperators(command);
  for (const sub of subCommands) {
    const result = analyzeSubCommand(sub);
    if (result.blocked) {
      const reason = `BLOCKED: Destructive Git Operation in Main Working Tree (spawned agent)\n\n${result.reason}\n\nYou are a spawned sub-agent running in the main working tree. Git write operations\nare blocked here because they can trigger lint-staged, which destroys uncommitted\nwork via 'git stash' + 'git reset --hard'.\n\nTo commit changes, you must be spawned with isolation: "worktree".\nTo review code without committing, you can still use git status, git diff, git log, etc.`;

      process.stdout.write(JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }));
      return;
    }
  }

  // All sub-commands passed -> allow
  process.stdout.write(JSON.stringify({ allow: true }));
}

main().catch(() => {
  // Fail-open on unexpected errors
  process.stdout.write(JSON.stringify({ allow: true }));
});
