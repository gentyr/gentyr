#!/usr/bin/env node
/**
 * PreToolUse Hook: Block --no-verify flag
 *
 * This hook intercepts Bash tool calls and blocks any git commands
 * that include --no-verify or -n flags, which would skip git hooks.
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 * Supports CTO bypass via bypass-approval-token.json.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 3.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

// Patterns that indicate hook bypass attempts
const forbiddenPatterns = [
  { pattern: /--no-verify/i, reason: 'Using --no-verify skips pre-commit hooks (lint, deputy-cto review)' },
  { pattern: /\bgit\b.*\s-n\s/, reason: 'The -n flag is shorthand for --no-verify, which skips pre-commit hooks' },
  { pattern: /\bgit\b.*\s-n$/, reason: 'The -n flag is shorthand for --no-verify, which skips pre-commit hooks' },
  { pattern: /--(no-)?gpg-sign/i, reason: 'Skipping GPG signing bypasses commit verification' },
  { pattern: /\bgit\s+config\s+.*core\.hooksPath/i, reason: 'Changing core.hooksPath redirects or disables git hooks' },
  { pattern: /\brm\s+(-rf?|--recursive)?\s+.*\.husky/i, reason: 'Deleting .husky/ removes the git hook infrastructure' },
  { pattern: /\brm\s+(-rf?|--recursive)?\s+.*\.claude\/hooks/i, reason: 'Deleting .claude/hooks/ removes Claude Code hook enforcement' },
];

// Additional patterns for weakening lint
const lintWeakeningPatterns = [
  { pattern: /eslint.*--quiet/i, reason: 'The --quiet flag suppresses ESLint warnings' },
  { pattern: /eslint.*--max-warnings\s+[1-9]/i, reason: 'Allowing warnings violates zero-tolerance lint policy' },
  { pattern: /eslint.*--no-error-on-unmatched-pattern/i, reason: 'This flag can silently skip linting of files' },
];

/**
 * Check if a valid CTO bypass token exists.
 */
function hasValidBypassToken(projectDir) {
  try {
    const tokenPath = path.join(projectDir, '.claude', 'bypass-approval-token.json');

    if (!fs.existsSync(tokenPath)) {
      return false;
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

    if (token.expires_timestamp && Date.now() > token.expires_timestamp) {
      return false;
    }
    if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Block the tool call using Claude Code's permissionDecision system.
 */
function blockCommand(command, reason, category, bypassContext) {
  const bypassInstructions = [
    '',
    '  HOW TO REQUEST A CTO BYPASS (if you have a valid reason):',
    '',
    '  1. Call: mcp__deputy-cto__request_bypass({',
    `       reason: "${bypassContext}",`,
    '       reporting_agent: "your-agent-name",',
    '       blocked_by: "block-no-verify hook"',
    '     })',
    '',
    '  2. You will receive a 6-character bypass code (e.g. X7K9M2)',
    '',
    '  3. STOP and ask the CTO to type in chat:',
    '       APPROVE BYPASS <CODE>',
    '',
    '  4. After CTO approval, retry your command.',
    '     The bypass token is valid for 5 minutes (one-time use).',
  ].join('\n');

  const fullReason = [
    `BLOCKED: ${category}`,
    '',
    `Why: ${reason}`,
    '',
    `Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`,
    '',
    bypassInstructions,
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
  console.error('');
  console.error('  ──────────────────────────────────────────────────────────');
  console.error(bypassInstructions);
  console.error('  ──────────────────────────────────────────────────────────');
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
    const projectDir = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

    // Only check Bash commands
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = toolInput.command || '';

    // Check if CTO has granted a bypass
    if (hasValidBypassToken(projectDir)) {
      console.error('[block-no-verify] Active CTO bypass token found - allowing command through');
      process.exit(0);
    }

    // Check for forbidden patterns
    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(command)) {
        blockCommand(
          command,
          reason,
          'Security Hook Bypass Attempt',
          'Explain why --no-verify is needed'
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
          'Lint Enforcement Weakening Attempt',
          'Explain why lint relaxation is needed'
        );
        return;
      }
    }

    // Command is allowed
    process.exit(0);
  } catch (err) {
    // G001: fail-closed on parse errors
    console.error(`[block-no-verify] Error parsing input: ${err.message}`);
    process.exit(2);
  }
});
