#!/usr/bin/env node
/**
 * PreToolUse Hook: Credential File Guard
 *
 * Intercepts Read, Write, and Edit tool calls and blocks access to files
 * containing credentials, secrets, or sensitive configuration.
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

// ============================================================================
// Protected File Patterns
// ============================================================================

/**
 * File basenames that are always blocked regardless of path
 */
const BLOCKED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  '.env.development',
  '.env.test',
  '.credentials.json',
]);

/**
 * Path suffixes that are blocked (matched against the end of the resolved path)
 * These are relative to the project directory
 */
const BLOCKED_PATH_SUFFIXES = [
  '.claude/protection-key',
  '.claude/api-key-rotation.json',
  '.claude/bypass-approval-token.json',
  '.claude/commit-approval-token.json',
  '.claude/credential-provider.json',
  '.mcp.json',
];

/**
 * Patterns matched against the full path
 */
const BLOCKED_PATH_PATTERNS = [
  /\.env(\.[a-z]+)?$/i,  // Any .env or .env.* file
];

// ============================================================================
// Guard Logic
// ============================================================================

/**
 * Check if a file path should be blocked
 * @param {string} filePath - The file path being read
 * @param {string} projectDir - The project directory
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkFilePath(filePath, projectDir) {
  if (!filePath) {
    return { blocked: false, reason: '' };
  }

  // Normalize the path
  const normalizedPath = path.resolve(filePath);
  const basename = path.basename(normalizedPath);

  // Check blocked basenames
  if (BLOCKED_BASENAMES.has(basename)) {
    return {
      blocked: true,
      reason: `File "${basename}" contains credentials or secrets`,
    };
  }

  // Check blocked path suffixes
  const normalizedForSuffix = normalizedPath.replace(/\\/g, '/');
  for (const suffix of BLOCKED_PATH_SUFFIXES) {
    if (normalizedForSuffix.endsWith(suffix)) {
      return {
        blocked: true,
        reason: `File "${suffix}" contains sensitive configuration`,
      };
    }
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return {
        blocked: true,
        reason: `File matches protected credential pattern: ${basename}`,
      };
    }
  }

  return { blocked: false, reason: '' };
}

/**
 * Tools that access files and should be blocked for credential files
 */
const FILE_ACCESS_TOOLS = new Set(['Read', 'Write', 'Edit']);

/**
 * Block the file operation using Claude Code's permissionDecision system
 */
function blockRead(filePath, reason) {
  const fullReason = [
    'BLOCKED: Credential File Access',
    '',
    `Why: ${reason}`,
    '',
    `Path: ${filePath}`,
    '',
    'This file is protected by GENTYR to prevent credential exposure.',
    'If you need access to this file, request CTO approval.',
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
  console.error('  READ BLOCKED: Credential File Protection');
  console.error('══════════════════════════════════════════════════════════════');
  console.error('');
  console.error(`  Why: ${reason}`);
  console.error('');
  console.error(`  Path: ${filePath}`);
  console.error('');
  console.error('══════════════════════════════════════════════════════════════');
  console.error('');

  process.exit(0); // Exit 0 - the JSON output handles the deny
}

// ============================================================================
// Main
// ============================================================================

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

    // Only check file access tools (Read, Write, Edit)
    if (!FILE_ACCESS_TOOLS.has(toolName)) {
      process.exit(0);
    }

    // Read uses file_path, Write uses file_path, Edit uses file_path
    const filePath = toolInput.file_path || '';

    if (!filePath) {
      process.exit(0);
    }

    // Check if this file is protected
    const result = checkFilePath(filePath, projectDir);

    if (result.blocked) {
      blockRead(filePath, result.reason);
      return; // blockRead calls process.exit, but just in case
    }

    // File is allowed
    process.exit(0);
  } catch (err) {
    // G001: fail-closed on parse errors - block the read
    console.error(`[credential-file-guard] G001 FAIL-CLOSED: Error parsing input: ${err.message}`);
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
