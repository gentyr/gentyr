#!/usr/bin/env node
/**
 * PreToolUse Hook: Branch Checkout Guard (Layer 2)
 *
 * Intercepts Bash tool calls containing git checkout/switch commands and blocks
 * them in the main working tree. Defense-in-depth complement to the git wrapper
 * script (Layer 1) which covers spawned agents via PATH injection.
 *
 * This hook covers:
 *   - Interactive sessions (where the PATH wrapper isn't injected)
 *   - Agents that call /usr/bin/git directly (bypassing PATH)
 *
 * Uses the same tokenizer pattern from credential-file-guard.js for robust
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
// Shell Tokenizer (from credential-file-guard.js)
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
 * Analyze a single sub-command for blocked git checkout/switch patterns.
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

  if (subcmd !== 'checkout' && subcmd !== 'switch') return { blocked: false };

  // Parse checkout/switch args after the subcommand
  let hasDashDash = false;
  let hasCreateFlag = false;
  let targetBranch = '';

  for (let i = subcmdIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') {
      hasDashDash = true;
      break;
    }
    if (tok === '-b' || tok === '-B' || tok === '--create' || tok === '--force-create') {
      hasCreateFlag = true;
      continue;
    }
    if (/^-[bB].+/.test(tok)) {
      // Combined -b<branch> form
      hasCreateFlag = true;
      targetBranch = tok.slice(2);
      continue;
    }
    if (tok.startsWith('-')) continue; // Other flags
    if (!targetBranch) targetBranch = tok;
  }

  // File restore (-- present) -> allow
  if (hasDashDash) return { blocked: false };

  // checkout main (recovery path) -> allow
  if (targetBranch === 'main') return { blocked: false };

  // No target and no create flag -> harmless
  if (!targetBranch && !hasCreateFlag) return { blocked: false };

  // BLOCK
  const action = hasCreateFlag ? `checkout -b ${targetBranch || '<branch>'}` : `checkout ${targetBranch}`;
  return {
    blocked: true,
    reason: `Branch switching blocked in main working tree. '${action}' would change the main tree's branch.`,
  };
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
      const reason = `BLOCKED: Branch Change in Main Working Tree\n\nWhy: ${result.reason}\n\nThe main tree must stay on 'main' to prevent drift, preflight failures, and stale worktree bases.\nYou are in the main working tree — use a worktree for feature work.\nWorktrees are created automatically by the task runner.\nTo recover: 'git checkout main' is always allowed.`;

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
