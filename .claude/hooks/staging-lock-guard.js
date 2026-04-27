#!/usr/bin/env node
/**
 * PreToolUse Hook: Staging Lock Guard
 *
 * Blocks Bash commands that would merge into staging when a production release
 * is in progress (staging is locked). The lock state is read from
 * .claude/state/staging-lock.json via the staging-lock shared module.
 *
 * Blocked patterns:
 *   - `gh pr merge` targeting staging (--base staging, or PR against staging)
 *   - `git push` to staging or origin staging
 *   - `git merge` into staging (when on the staging branch)
 *
 * Fast exits:
 *   - GENTYR_PROMOTION_PIPELINE=true (release agents need staging access)
 *   - Staging not locked (most common path)
 *   - Non-Bash tool calls
 *
 * Uses the same tokenizer / splitOnShellOperators pattern from
 * main-tree-commit-guard.js for robust command parsing.
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

import path from 'node:path';
import { isStagingLocked, getStagingLockState } from './lib/staging-lock.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Shell Tokenizer (from main-tree-commit-guard.js / branch-checkout-guard.js)
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
// Command Analysis
// ============================================================================

/**
 * Analyze a single sub-command for operations that would merge into staging.
 *
 * @param {string} subCommand
 * @returns {{ blocked: boolean, reason?: string }}
 */
function analyzeSubCommand(subCommand) {
  const tokens = tokenize(subCommand);
  if (tokens.length === 0) return { blocked: false };

  // --- gh pr merge targeting staging ---
  const ghIdx = tokens.indexOf('gh');
  if (ghIdx !== -1) {
    // Check for: gh pr merge [flags]
    const afterGh = tokens.slice(ghIdx + 1);
    if (afterGh.length >= 2 && afterGh[0] === 'pr' && afterGh[1] === 'merge') {
      // Check if --base staging is specified
      for (let i = 0; i < afterGh.length; i++) {
        if (afterGh[i] === '--base' && i + 1 < afterGh.length && afterGh[i + 1] === 'staging') {
          return {
            blocked: true,
            reason: 'gh pr merge --base staging',
          };
        }
        if (afterGh[i].startsWith('--base=') && afterGh[i].split('=')[1] === 'staging') {
          return {
            blocked: true,
            reason: 'gh pr merge --base=staging',
          };
        }
      }
      // Also check for -B flag (gh shorthand for --base)
      for (let i = 0; i < afterGh.length; i++) {
        if (afterGh[i] === '-B' && i + 1 < afterGh.length && afterGh[i + 1] === 'staging') {
          return {
            blocked: true,
            reason: 'gh pr merge -B staging',
          };
        }
      }
    }
  }

  // --- git push to staging ---
  let gitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const base = path.basename(tokens[i]);
    if (base === 'git') {
      gitIdx = i;
      break;
    }
  }
  if (gitIdx === -1) return { blocked: false };

  // Extract git subcommand (skip global flags)
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

  // --- git push [remote] staging ---
  if (subcmd === 'push') {
    const argsAfterPush = tokens.slice(subcmdIdx + 1);
    // Collect non-flag positional args after 'push'
    const positionals = [];
    for (let i = 0; i < argsAfterPush.length; i++) {
      const tok = argsAfterPush[i];
      // Skip flags that take a value
      if (tok === '--repo' || tok === '--push-option' || tok === '-o' || tok === '--receive-pack' || tok === '--exec') {
        i++;
        continue;
      }
      // Skip all other flags
      if (tok.startsWith('-')) continue;
      positionals.push(tok);
    }

    // Positional patterns for pushing to staging:
    //   git push origin staging
    //   git push origin staging:staging
    //   git push origin HEAD:staging
    //   git push origin <anything>:staging
    //   git push staging (bare refspec — remote named 'staging' is unlikely but check refspecs)
    for (const pos of positionals) {
      // Check refspec targets like "anything:staging" or "anything:refs/heads/staging"
      if (pos.includes(':')) {
        const dst = pos.split(':').pop();
        if (dst === 'staging' || dst === 'refs/heads/staging') {
          return {
            blocked: true,
            reason: `git push with refspec targeting staging (${pos})`,
          };
        }
      }
      // Direct branch name match (e.g., "git push origin staging")
      if (pos === 'staging') {
        return {
          blocked: true,
          reason: 'git push to staging',
        };
      }
    }
  }

  // --- git merge staging (while on staging branch would merge into it) ---
  // This catches: git merge <branch> while on staging, or
  // explicit "git merge ... staging" patterns
  if (subcmd === 'merge') {
    // If someone is explicitly merging *into* staging, the broader workflow
    // concern is that they're on the staging branch. We block any merge
    // command that references staging as a source (since they'd only be
    // running this while on staging).
    const argsAfterMerge = tokens.slice(subcmdIdx + 1);
    for (const tok of argsAfterMerge) {
      if (tok.startsWith('-')) continue;
      if (tok === 'staging' || tok === 'origin/staging') {
        return {
          blocked: true,
          reason: `git merge ${tok}`,
        };
      }
    }
  }

  return { blocked: false };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Fast exit: promotion pipeline agents always pass through
  if (process.env.GENTYR_PROMOTION_PIPELINE === 'true') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    console.error('[staging-lock-guard] Warning:', err.message);
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

  // Fast path: if staging is not locked, allow everything
  if (!isStagingLocked(PROJECT_DIR)) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Extract command from tool input
  const command = event?.tool_input?.command || '';
  if (!command) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Get lock state for the deny message
  const lockState = getStagingLockState(PROJECT_DIR);
  const releaseId = lockState.release_id || 'unknown';

  // Split on shell operators and analyze each sub-command
  const subCommands = splitOnShellOperators(command);
  for (const sub of subCommands) {
    const result = analyzeSubCommand(sub);
    if (result.blocked) {
      const reason = [
        `BLOCKED: Staging is locked — production release in progress (release ${releaseId})`,
        '',
        `Detected: ${result.reason}`,
        '',
        'Staging is locked to prevent new merges from contaminating the release candidate.',
        'No code may be merged to staging until the release completes or is aborted.',
        '',
        'Use /promote-to-prod to manage the release.',
      ].join('\n');

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
