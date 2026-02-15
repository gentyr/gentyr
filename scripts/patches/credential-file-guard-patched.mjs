#!/usr/bin/env node
/**
 * PreToolUse Hook: Credential File Guard
 *
 * Intercepts Read, Write, Edit, and Bash tool calls and blocks access to files
 * containing credentials, secrets, or sensitive configuration.
 *
 * For Bash commands, also detects:
 *   - File-reading commands targeting protected files (cat, head, tail, etc.)
 *   - References to protected credential environment variables ($TOKEN, etc.)
 *   - Environment dump commands (env, printenv, export -p)
 *
 * NOTE: Bash detection is defense-in-depth only. Primary defenses are:
 *   - Root-ownership of credential files (OS-level, unbypassable)
 *   - Credentials only in .mcp.json env blocks, not in shell env (architectural)
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 2.1.0
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
// Bash Command Analysis
// ============================================================================

/**
 * Commands that read file contents
 */
const FILE_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'strings', 'xxd',
  'hexdump', 'base64', 'open', 'source', 'bat', 'nl',
]);

/**
 * Commands that copy/move files (source file is first path argument)
 */
const FILE_COPY_COMMANDS = new Set(['cp', 'mv']);

/**
 * Commands that dump all environment variables.
 * Requires whitespace or start-of-string before command name to avoid
 * matching filenames like ".env" (where \b would falsely match).
 */
const ENV_DUMP_COMMANDS = /(?:^|\s)(env|printenv|export\s+-p)(?:\s|$|\|)/;

/**
 * Shell operator tokens emitted by tokenize().
 * Used by splitOnOperators() to split token arrays into sub-commands.
 */
const OPERATOR_TOKENS = new Set(['|', '||', '&&', ';']);

/**
 * Load protected credential key names from protected-actions.json
 * @param {string} projectDir
 * @returns {Set<string>}
 */
function loadCredentialKeys(projectDir) {
  const keys = new Set();
  try {
    const configPath = path.join(projectDir, '.claude', 'hooks', 'protected-actions.json');
    if (!fs.existsSync(configPath)) {
      return keys;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && config.servers) {
      for (const server of Object.values(config.servers)) {
        if (Array.isArray(server.credentialKeys)) {
          for (const key of server.credentialKeys) {
            keys.add(key);
          }
        }
      }
    }
  } catch (err) {
    // Fail open for credential key loading - the architectural defense
    // (creds not in env) is the primary protection
    console.error(`[credential-file-guard] Warning: Could not load credential keys: ${err.message}`);
  }
  return keys;
}

/**
 * Shell tokenizer that respects single/double quotes and emits shell
 * operators (|, ||, &&, ;, <, >, >>) as separate tokens.
 *
 * This ensures pipes/semicolons inside quoted strings are NOT treated
 * as command separators — the full command is tokenized first, then
 * split on operator tokens.
 *
 * @param {string} str
 * @returns {string[]}
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const chars = [...str];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = i + 1 < chars.length ? chars[i + 1] : '';

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

    // Inside quotes: everything is literal
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Outside quotes: check for operators and whitespace
    if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    // Shell operators (only outside quotes)
    if (ch === '|') {
      if (current) { tokens.push(current); current = ''; }
      if (next === '|') {
        tokens.push('||');
        i++;
      } else {
        tokens.push('|');
      }
      continue;
    }
    if (ch === '&' && next === '&') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('&&');
      i++;
      continue;
    }
    if (ch === ';') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(';');
      continue;
    }
    if (ch === '>') {
      if (current) { tokens.push(current); current = ''; }
      if (next === '>') {
        tokens.push('>>');
        i++;
      } else {
        tokens.push('>');
      }
      continue;
    }
    if (ch === '<') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('<');
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
 * Split a token array into sub-command groups at operator boundaries.
 * @param {string[]} tokens
 * @returns {string[][]}
 */
function splitOnOperators(tokens) {
  const groups = [[]];
  for (const token of tokens) {
    if (OPERATOR_TOKENS.has(token)) {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(token);
    }
  }
  return groups;
}

/**
 * Extract file paths from a bash command that may access protected files.
 * Tokenizes the full command first (preserving quoted strings), then splits
 * on operator tokens to process individual sub-commands.
 * @param {string} command
 * @returns {string[]} Array of file paths found
 */
function extractFilePathsFromCommand(command) {
  const paths = [];

  // Tokenize the full command first — operators inside quotes stay literal
  const allTokens = tokenize(command);

  // Split tokens into sub-commands at operator boundaries
  const subCommands = splitOnOperators(allTokens);

  for (const tokens of subCommands) {
    if (tokens.length === 0) continue;

    const cmd = path.basename(tokens[0]); // Handle /usr/bin/cat etc.

    if (FILE_READ_COMMANDS.has(cmd) || FILE_COPY_COMMANDS.has(cmd)) {
      // Extract non-flag arguments as potential file paths
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        // Skip flags (but not paths starting with ./ or ../)
        // Don't try to skip flag values - it's safer to over-check
        // (non-paths like "10" won't match any blocked pattern)
        if (token.startsWith('-') && !token.startsWith('./') && !token.startsWith('../')) {
          continue;
        }
        // Skip output redirection targets (now handled as separate tokens)
        if (token === '>' || token === '>>') {
          i++; // skip the target path
          continue;
        }
        // This looks like a file path argument
        if (token && !token.startsWith('$')) {
          paths.push(token);
        }
      }
    }

    // Check for input redirection: '<' token followed by path token
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '<' && i + 1 < tokens.length) {
        paths.push(tokens[i + 1]);
      }
    }
  }

  return paths;
}

/**
 * Escape special regex characters in a string
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a bash command references protected credential env vars.
 * @param {string} command
 * @param {Set<string>} credentialKeys
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkBashEnvAccess(command, credentialKeys) {
  // 1. Block full environment dump commands
  if (ENV_DUMP_COMMANDS.test(command)) {
    return {
      blocked: true,
      reason: 'Environment dump commands are blocked to prevent credential exposure',
    };
  }

  // 2. Check for direct references to credential env vars
  if (credentialKeys.size > 0) {
    for (const key of credentialKeys) {
      // Match $KEY or ${KEY}
      const varPattern = new RegExp('\\$\\{?' + escapeRegExp(key) + '\\}?\\b');
      if (varPattern.test(command)) {
        return {
          blocked: true,
          reason: `Command references protected credential variable: ${key}`,
        };
      }

      // Also check printenv KEY
      const printenvPattern = new RegExp('\\bprintenv\\s+' + escapeRegExp(key) + '\\b');
      if (printenvPattern.test(command)) {
        return {
          blocked: true,
          reason: `Command reads protected credential variable: ${key}`,
        };
      }
    }
  }

  return { blocked: false, reason: '' };
}

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
const FILE_ACCESS_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash']);

// ============================================================================
// Blocking Functions
// ============================================================================

/**
 * Block a file operation using Claude Code's permissionDecision system
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

/**
 * Block a Bash command using Claude Code's permissionDecision system
 */
function blockBash(command, reason) {
  const truncatedCmd = command.length > 100 ? command.substring(0, 100) + '...' : command;
  const fullReason = [
    'BLOCKED: Credential Access via Bash',
    '',
    `Why: ${reason}`,
    '',
    `Command: ${truncatedCmd}`,
    '',
    'This command is blocked by GENTYR to prevent credential exposure.',
    'Credentials should only be accessed through approved MCP server tools.',
    'If you need access, request CTO approval.',
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
  console.error('  BASH BLOCKED: Credential Protection');
  console.error('══════════════════════════════════════════════════════════════');
  console.error('');
  console.error(`  Why: ${reason}`);
  console.error('');
  console.error(`  Command: ${truncatedCmd}`);
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

    // Only check tools that access files or credentials
    if (!FILE_ACCESS_TOOLS.has(toolName)) {
      process.exit(0);
    }

    // --- Bash tool: check command for file paths and env var references ---
    if (toolName === 'Bash') {
      const command = toolInput.command || '';
      if (!command) {
        process.exit(0);
      }

      // Check 1: File paths in bash command
      const filePaths = extractFilePathsFromCommand(command);
      for (const fp of filePaths) {
        const result = checkFilePath(fp, projectDir);
        if (result.blocked) {
          blockBash(command, result.reason);
          return;
        }
      }

      // Check 2: Credential env var references
      const credentialKeys = loadCredentialKeys(projectDir);
      const envResult = checkBashEnvAccess(command, credentialKeys);
      if (envResult.blocked) {
        blockBash(command, envResult.reason);
        return;
      }

      // Bash command is allowed
      process.exit(0);
    }

    // --- Read/Write/Edit tools: check file_path ---
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
    // G001: fail-closed on parse errors - block the operation
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
