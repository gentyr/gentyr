#!/usr/bin/env node
/**
 * PreToolUse Hook: Staging Promotion Guard (Always-On)
 *
 * ALWAYS blocks Bash commands that would merge into staging unless the caller
 * is a promotion pipeline agent (GENTYR_PROMOTION_PIPELINE=true). This ensures
 * all staging merges go through the preview-promoter quality gate pipeline.
 *
 * When staging is additionally locked for a production release, the error message
 * references the active release. When staging is NOT locked, the error message
 * directs the user to /promote-to-staging or the automated 30-minute cycle.
 *
 * Blocked patterns:
 *   - `gh pr create` targeting staging (--base staging, -B staging)
 *   - `gh pr merge` targeting staging (runtime PR target check via gh CLI)
 *   - `git push` to staging or origin staging
 *   - `git merge` into staging (when on the staging branch)
 *
 * Fast exits:
 *   - GENTYR_PROMOTION_PIPELINE=true (promotion pipeline agents need staging access)
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
 * @version 2.0.0
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isStagingLocked, getStagingLockState } from './lib/staging-lock.js';
import { createDeferredAction, openDb, findDuplicatePending } from './lib/deferred-action-db.js';
import { computePendingHmac } from './lib/deferred-action-executor.js';

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

  // --- gh pr create targeting staging ---
  const ghIdx = tokens.indexOf('gh');
  if (ghIdx !== -1) {
    const afterGh = tokens.slice(ghIdx + 1);

    // Check for: gh pr create --base staging / -B staging
    if (afterGh.length >= 2 && afterGh[0] === 'pr' && afterGh[1] === 'create') {
      for (let i = 0; i < afterGh.length; i++) {
        if (afterGh[i] === '--base' && i + 1 < afterGh.length && afterGh[i + 1] === 'staging') {
          return { blocked: true, reason: 'gh pr create --base staging' };
        }
        if (afterGh[i].startsWith('--base=') && afterGh[i].split('=')[1] === 'staging') {
          return { blocked: true, reason: 'gh pr create --base=staging' };
        }
        if (afterGh[i] === '-B' && i + 1 < afterGh.length && afterGh[i + 1] === 'staging') {
          return { blocked: true, reason: 'gh pr create -B staging' };
        }
      }
    }

    // --- gh pr merge targeting staging (runtime check) ---
    // gh pr merge does not accept --base — extract PR number and check target branch via API
    if (afterGh.length >= 2 && afterGh[0] === 'pr' && afterGh[1] === 'merge') {
      // Block --admin flag (prevents CI bypass via admin privileges)
      if (afterGh.includes('--admin')) {
        return { blocked: true, reason: 'gh pr merge --admin (admin CI bypass not permitted for staging)' };
      }

      const prNumber = afterGh.slice(2).find(t => /^\d+$/.test(t));
      if (prNumber) {
        try {
          const base = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'baseRefName', '-q', '.baseRefName'], {
            encoding: 'utf8', timeout: 2000, stdio: 'pipe',
          }).trim();
          if (base === 'staging') {
            // Verify CI is passing before allowing staging merge
            try {
              const checksOutput = execFileSync('gh', ['pr', 'checks', prNumber, '--json', 'state,name'], {
                encoding: 'utf8', timeout: 3000, stdio: 'pipe',
              }).trim();
              const checks = JSON.parse(checksOutput);
              const failing = checks.filter(c => c.state === 'FAILURE' || c.state === 'ERROR');
              if (failing.length > 0) {
                return { blocked: true, reason: `gh pr merge #${prNumber} — ${failing.length} CI check(s) failing (${failing.map(c => c.name).join(', ')})` };
              }
            } catch {
              // Fail-open on CI check parse — primary defense is GENTYR_PROMOTION_PIPELINE
            }
            return { blocked: true, reason: `gh pr merge #${prNumber} (PR targets staging)` };
          }
        } catch {
          // Fail-open: if gh CLI is unavailable or times out, allow.
          // Primary defense is GENTYR_PROMOTION_PIPELINE env var.
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
      // Create a deferred action for the blocked command
      let deferredInfo = '';
      try {
        const db = openDb();
        if (db) {
          try {
            const argsHash = crypto.createHash('sha256').update(command).digest('hex');
            const existing = findDuplicatePending(db, 'Bash', 'Bash', argsHash);
            if (existing) {
              deferredInfo = `\n\nDeferred action already pending: ${existing.id}.`;
            } else {
              const code = crypto.randomBytes(3).toString('hex').toUpperCase();
              const pendingHmac = computePendingHmac(code, 'Bash', 'Bash', argsHash);
              if (pendingHmac) {
                const deferredResult = createDeferredAction(db, {
                  server: 'Bash',
                  tool: 'Bash',
                  args: { command, cwd: process.cwd() },
                  argsHash,
                  code,
                  phrase: 'UNIFIED',
                  pendingHmac,
                  sourceHook: 'staging-lock-guard',
                });
                deferredInfo = `\n\nDeferred action created: ${deferredResult.id}\nPresent this to the CTO, then call record_cto_decision({ decision_type: "command_bypass", decision_id: "${deferredResult.id}", verbatim_text: "<CTO exact words>" }). The command will auto-execute after CTO approval + audit pass. Do NOT retry.`;
              }
            }
          } finally {
            try { db.close(); } catch { /* ignore */ }
          }
        }
      } catch {
        // Non-fatal — proceed with deny even if deferred action creation fails
      }

      // Determine the appropriate error message based on lock state
      const locked = isStagingLocked(PROJECT_DIR);
      let reason;

      if (locked) {
        const lockState = getStagingLockState(PROJECT_DIR);
        const releaseId = lockState.release_id || 'unknown';
        reason = [
          `BLOCKED: Staging is LOCKED — production release in progress (release ${releaseId})`,
          '',
          `Detected: ${result.reason}`,
          '',
          'Staging is locked to prevent new merges from contaminating the release candidate.',
          'No code may be merged to staging until the release completes or is cancelled.',
          '',
          'Use /promote-to-prod to manage the release.',
          deferredInfo,
        ].join('\n');
      } else {
        reason = [
          `BLOCKED: Staging merges MUST go through the preview-promoter agent pipeline.`,
          '',
          `Detected: ${result.reason}`,
          '',
          'Direct staging merges are not allowed — they bypass quality gates (tests, demos, migration safety).',
          'Use /promote-to-staging to trigger the promotion pipeline, or wait for the automated 30-minute cycle.',
          deferredInfo,
        ].join('\n');
      }

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

main().catch((err) => {
  // G001 fail-closed: staging promotion guard must not silently allow on crash
  try { process.stderr.write(`[staging-lock-guard] Unexpected error: ${err?.message || err}\n`); } catch (_) { /* ignore */ }
  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: `Staging promotion guard crashed: ${err?.message || 'unknown error'}. Run again or check .claude/state/staging-lock.json manually.`,
  }));
});
