#!/usr/bin/env node
/**
 * PreToolUse Hook: Block --no-verify flag
 *
 * This hook intercepts Bash tool calls and blocks any git commands
 * that include --no-verify or -n flags, which would skip git hooks.
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 * On block, creates a deferred action via the Unified CTO Authorization System.
 * The agent does NOT retry — the deferred action auto-executes after CTO approval + audit pass.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 4.0.0
 */

import crypto from 'node:crypto';
import { createDeferredAction, openDb, findDuplicatePending } from './lib/deferred-action-db.js';
import { computePendingHmac } from './lib/deferred-action-executor.js';

// Patterns that indicate hook bypass attempts
const forbiddenPatterns = [
  { pattern: /--no-verify/i, reason: 'Using --no-verify skips pre-commit hooks (lint, security checks). Fix the root cause instead — if hooks fail in a worktree, check that .claude/hooks symlink exists; if the branch is stale, create a fresh branch from the base' },
  { pattern: /\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|am)\b.*\s-n(\s|$)/, reason: 'The -n flag is shorthand for --no-verify, which skips pre-commit hooks. Fix the root cause instead of bypassing hooks' },
  { pattern: /--(no-)?gpg-sign/i, reason: 'Skipping GPG signing bypasses commit verification' },
  { pattern: /\bgit\s+config\s+(?:.*--unset.*core\.hooksPath|.*core\.hooksPath\s+\S)/i, reason: 'Changing core.hooksPath redirects or disables git hooks' },
  { pattern: /\brm\s+(-rf?|--recursive)?\s+.*\.husky/i, reason: 'Deleting .husky/ removes the git hook infrastructure' },
  { pattern: /\brm\s+(-rf?|--recursive)?\s+.*\.claude\/hooks/i, reason: 'Deleting .claude/hooks/ removes Claude Code hook enforcement' },
];

// Additional patterns for weakening lint
const lintWeakeningPatterns = [
  { pattern: /eslint.*--quiet/i, reason: 'The --quiet flag suppresses ESLint warnings' },
  { pattern: /eslint.*--max-warnings\s+[1-9]/i, reason: 'Allowing warnings violates zero-tolerance lint policy' },
  { pattern: /eslint.*--no-error-on-unmatched-pattern/i, reason: 'This flag can silently skip linting of files' },
];

// Patterns blocking direct credential/secret access via CLI tools
// Even if OP_SERVICE_ACCOUNT_TOKEN is in the shell environment, agents cannot use
// the 1Password CLI to extract secrets. Secrets flow only through MCP server env
// fields (which are spawned by MCP infrastructure, not by Bash).
const credentialAccessPatterns = [
  { pattern: /\bop\s+(run|read|item|inject|signin|signout|whoami|vault|document|connect|account|group|user|service-account|events-api|plugin)\b/i,
    reason: '1Password CLI access blocked — secrets must only flow through MCP server env fields, not Bash' },
  { pattern: /\bop\s+--/i,
    reason: '1Password CLI access blocked — global op flags indicate CLI usage' },
  { pattern: /(?:^|[\/\s])op\s+(run|read|item|inject|signin|signout|whoami|vault|document|connect|account|group|user|service-account|events-api|plugin)\b/i,
    reason: '1Password CLI access blocked (full-path variant) — secrets must only flow through MCP server env fields' },
];

/**
 * Create a deferred action for a blocked command, or return existing duplicate.
 * @param {string} command - The blocked shell command
 * @param {string} reason - Why it was blocked
 * @param {string} category - Block category label
 * @returns {{ id: string, code: string } | null} Deferred action info or null on failure
 */
function createBlockedCommandDeferredAction(command, reason, category) {
  try {
    const db = openDb();
    if (!db) return null;

    try {
      const argsHash = crypto.createHash('sha256').update(command).digest('hex');
      const existing = findDuplicatePending(db, 'Bash', 'Bash', argsHash);
      if (existing) {
        return { id: existing.id, code: existing.code };
      }

      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      const pendingHmac = computePendingHmac(code, 'Bash', 'Bash', argsHash);
      if (!pendingHmac) {
        // G001 fail-closed: cannot create HMAC without protection key
        return null;
      }

      const result = createDeferredAction(db, {
        server: 'Bash',
        tool: 'Bash',
        args: { command, cwd: process.cwd() },
        argsHash,
        code,
        phrase: 'UNIFIED',
        pendingHmac,
        sourceHook: 'block-no-verify',
      });

      return { id: result.id, code: result.code };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error(`[block-no-verify] Failed to create deferred action: ${err.message}`);
    return null;
  }
}

/**
 * Block the tool call using Claude Code's permissionDecision system.
 * Creates a deferred action so the command can auto-execute after CTO approval + audit pass.
 */
function blockCommand(command, reason, category) {
  const deferred = createBlockedCommandDeferredAction(command, reason, category);

  const deferredInfo = deferred
    ? [
        '',
        `  Deferred Action ID: ${deferred.id}`,
        '',
        '  Present this to the CTO with context about why this command is needed.',
        '  Then call: mcp__agent-tracker__record_cto_decision({',
        `    decision_type: "command_bypass",`,
        `    decision_id: "${deferred.id}",`,
        '    verbatim_text: "<CTO exact words>"',
        '  })',
        '',
        '  The command will auto-execute after CTO approval + independent audit pass.',
        '  Do NOT retry the command — the system handles execution automatically.',
      ].join('\n')
    : [
        '',
        '  Failed to create deferred action. Contact the CTO directly.',
      ].join('\n');

  const rootCauseGuide = category === 'Security Hook Bypass Attempt'
    ? [
        '',
        'INSTEAD OF BYPASSING HOOKS, fix the root cause:',
        '  1. Missing hooks in worktree → ln -s <project>/.claude/hooks <worktree>/.claude/hooks',
        '  2. Branch too old → git fetch origin && git merge origin/<base> --no-edit',
        '  3. Lint failures → fix the lint errors',
        '  4. Build failures → pnpm install in the worktree',
      ].join('\n')
    : '';

  const fullReason = [
    `BLOCKED: ${category}`,
    '',
    `Why: ${reason}`,
    '',
    `Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`,
    rootCauseGuide,
    deferredInfo,
  ].join('\n');

  // Output JSON to stdout for Claude Code's permission system (hard deny)
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: fullReason,
    },
  }));

  // Also output to stderr for visibility
  console.error('');
  console.error('══════════════════════════════════════════════════════════════');
  console.error(`  COMMAND BLOCKED: ${category}`);
  console.error('══════════════════════════════════════════════════════════════');
  console.error('');
  console.error(`  Why: ${reason}`);
  console.error('');
  console.error(`  Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
  if (deferred) {
    console.error(`  Deferred Action: ${deferred.id}`);
  }
  console.error('');
  console.error('══════════════════════════════════════════════════════════════');
  console.error('');

  process.exit(0); // Exit 0 - the JSON output handles the deny
}

// Read JSON input from stdin
let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);

    const toolName = hookInput.tool_name;
    const toolInput = hookInput.tool_input || {};

    // Only check Bash commands
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = toolInput.command || '';

    // Check for forbidden patterns — always deny, create deferred action
    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(command)) {
        blockCommand(
          command,
          reason,
          'Security Hook Bypass Attempt'
        );
        return; // blockCommand calls process.exit, but just in case
      }
    }

    // Check for lint weakening
    for (const { pattern, reason } of lintWeakeningPatterns) {
      if (pattern.test(command)) {
        blockCommand(
          command,
          reason,
          'Lint Enforcement Weakening Attempt'
        );
        return;
      }
    }

    // Check for credential/secret access via CLI
    for (const { pattern, reason } of credentialAccessPatterns) {
      if (pattern.test(command)) {
        blockCommand(
          command,
          reason,
          'Credential Access Attempt'
        );
        return;
      }
    }

    // Command is allowed
    process.exit(0);
  } catch (err) {
    // G001: fail-closed on parse errors — output deny JSON so Claude Code blocks the action
    console.error(`[block-no-verify] G001 FAIL-CLOSED: Error parsing input: ${err.message}`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `G001 FAIL-CLOSED: Hook error - ${err.message}`,
      },
    }));
    process.exit(0);
  }
});
