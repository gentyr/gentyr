#!/usr/bin/env node
/**
 * PreToolUse Hook: Block --no-verify flag
 *
 * This hook intercepts Bash tool calls and blocks any git commands
 * that include --no-verify or -n flags, which would skip git hooks.
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 1.0.0
 */

// PreToolUse hooks receive tool info via environment variables
const toolName = process.env.TOOL_NAME;
const toolInput = process.env.TOOL_INPUT;

// Only check Bash commands
if (toolName !== 'Bash') {
  process.exit(0);
}

// Parse the tool input
let command = '';
try {
  const input = JSON.parse(toolInput || '{}');
  command = input.command || '';
} catch {
  // If we can't parse, allow (fail-open for parsing, but we check content)
  process.exit(0);
}

// Patterns that indicate hook bypass attempts
const forbiddenPatterns = [
  /--no-verify/i,
  /\bgit\b.*\s-n\s/,           // git commit -n (short for --no-verify)
  /\bgit\b.*\s-n$/,            // git commit -n at end of command
  /--(no-)?gpg-sign/i,         // Skip GPG signing
  /\bgit\s+config\s+.*core\.hooksPath/i,  // Changing hooks path
  /\brm\s+(-rf?|--recursive)?\s+.*\.husky/i,  // Deleting .husky
  /\brm\s+(-rf?|--recursive)?\s+.*\.claude\/hooks/i,  // Deleting hooks dir
];

// Additional patterns for weakening lint
const lintWeakeningPatterns = [
  /eslint.*--quiet/i,           // Suppresses warnings
  /eslint.*--max-warnings\s+[1-9]/i,  // Allows warnings (we require 0)
  /eslint.*--no-error-on-unmatched-pattern/i,
];

// Check for forbidden patterns
for (const pattern of forbiddenPatterns) {
  if (pattern.test(command)) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  COMMAND BLOCKED: Attempt to bypass security hooks detected');
    console.error('');
    console.error(`  Pattern matched: ${pattern}`);
    console.error(`  Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
    console.error('');
    console.error('  --no-verify and similar flags are not allowed.');
    console.error('  All commits must go through the pre-commit review process.');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }
}

// Check for lint weakening
for (const pattern of lintWeakeningPatterns) {
  if (pattern.test(command)) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  COMMAND BLOCKED: Attempt to weaken lint enforcement detected');
    console.error('');
    console.error(`  Pattern matched: ${pattern}`);
    console.error(`  Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
    console.error('');
    console.error('  Lint must run with --max-warnings 0 (zero tolerance).');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }
}

// Command is allowed
process.exit(0);
