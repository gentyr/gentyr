#!/usr/bin/env node
/**
 * PreToolUse Hook: Credential File Guard
 *
 * Intercepts Read, Write, Edit, Grep, Glob, and Bash tool calls and blocks
 * access to files containing credentials, secrets, or sensitive configuration.
 *
 * For Bash commands, also detects:
 *   - ANY command argument referencing protected files (not just known read commands)
 *   - Output redirection targets (>, >>)
 *   - Embedded file path references in code strings (raw command scan)
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
 * @version 3.0.0
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
  '.claude/protected-action-approvals.json',
  '.claude/vault-mappings.json',
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
 * Commands that do NOT access files via their arguments, so their arguments
 * should NOT be checked as file paths. This prevents false positives like
 * "echo .env" (which just prints the text ".env", not reading any file).
 *
 * All other commands have their arguments checked against protected paths.
 */
const NON_FILE_COMMANDS = new Set([
  'echo', 'printf',           // Output text, don't access files
  'mkdir', 'rmdir',           // Create/remove directories
  'cd', 'pushd', 'popd',     // Change directory
  'touch',                    // Create/update timestamps (not reading)
  'chmod', 'chown', 'chgrp',  // Change permissions (not reading contents)
  'ln',                       // Create links
  'alias', 'unalias',        // Shell aliases
  'export', 'set', 'unset',  // Shell variables
  'type', 'which', 'whereis', 'command', // Command location
  'hash', 'history',         // Shell builtins
  'true', 'false',           // No-ops
  'test', '[',               // Conditionals
  'kill', 'killall',         // Process signals
  'sleep', 'wait',           // Timing
  'exit', 'return',          // Flow control
  'npm', 'npx', 'pnpm', 'yarn', 'bun',  // Package managers (install commands)
  'pip', 'pip3',             // Python package manager
  'gem',                     // Ruby package manager
  'cargo',                   // Rust package manager
  'go',                      // Go toolchain
  'git',                     // Git (has its own security checks)
  'docker', 'docker-compose', // Container tools
  'brew', 'apt', 'yum',     // System package managers
]);

/**
 * Commands that dump all environment variables.
 * Requires whitespace or start-of-string before command name to avoid
 * matching filenames like ".env" (where \b would falsely match).
 */
const ENV_DUMP_COMMANDS = /(?:^|\s)(env|printenv|export\s+-p)(?:\s|$|\|)/;

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
 * single and double quotes. This prevents mangling paths like 'path;with;semicolons/.env'.
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
      // Check for && or ||
      if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // Check for single | (not ||)
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // Check for ;
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

/**
 * Extract file paths from a bash command that may access protected files.
 * Splits on pipes, semicolons, && and || to process individual sub-commands,
 * respecting shell quoting to avoid mangling quoted paths.
 *
 * SECURITY FIX (C2): Uses universal argument scanning for ALL commands except
 * those in NON_FILE_COMMANDS (echo, printf, mkdir, etc.). Previously only
 * checked 14 specific file-reading commands, allowing bypass via grep, awk,
 * python3, node, sort, diff, or any other command.
 *
 * SECURITY FIX (M1): Checks output redirection targets (>, >>) in addition
 * to input redirection (<). This prevents writing to protected files via
 * echo/printf redirection.
 *
 * @param {string} command
 * @returns {string[]} Array of file paths found
 */
function extractFilePathsFromCommand(command) {
  const paths = [];

  // Split on pipe, semicolons, && and || respecting quotes
  const subCommands = splitOnShellOperators(command);

  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;

    // Tokenize: split on whitespace but respect quotes
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;

    const cmd = path.basename(tokens[0]); // Handle /usr/bin/cat etc.

    // Check arguments as file paths for ALL commands EXCEPT known non-file commands.
    // This is safer than maintaining a blocklist of file-reading commands (C2 fix).
    if (!NON_FILE_COMMANDS.has(cmd)) {
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        // Skip flags (but not paths starting with ./ or ../)
        if (token.startsWith('-') && !token.startsWith('./') && !token.startsWith('../')) {
          continue;
        }
        // Skip redirection operators (targets handled below)
        if (token === '>' || token === '>>' || token === '<' || token === '2>' || token === '2>>') {
          i++; // skip the target
          continue;
        }
        // Skip variable references (checked separately)
        if (token.startsWith('$')) {
          continue;
        }
        // This looks like a potential file path argument
        if (token) {
          paths.push(token);
        }
      }
    }

    // Check ALL output and input redirection targets regardless of command (M1 fix).
    // This catches: echo '{}' > .claude/bypass-approval-token.json
    // and: grep secret < .env
    const redirectMatches = trimmed.matchAll(/(?:^|[^<>])(>>?|2>>?|<)\s*(\S+)/g);
    for (const match of redirectMatches) {
      const target = match[2];
      if (target && !target.startsWith('$') && !target.startsWith('&')) {
        paths.push(target);
      }
    }
  }

  return paths;
}

/**
 * Scan the raw command string for embedded references to protected file paths.
 * This catches cases where file paths are embedded inside code strings
 * (e.g., python3 -c "open('.mcp.json').read()") that token-based extraction misses.
 *
 * Only checks BLOCKED_PATH_SUFFIXES (longer, more specific paths like .mcp.json,
 * .claude/protection-key). Does NOT check BLOCKED_BASENAMES (short names like .env)
 * to avoid false positives with commands like "echo .env" or "npm install .env-parser".
 * Basename detection is handled by the universal argument scanning in extractFilePathsFromCommand().
 *
 * SECURITY FIX (C2): Provides a second layer of defense against bypass via
 * scripting language interpreters.
 *
 * @param {string} command
 * @returns {{ blocked: boolean, reason: string }}
 */
function scanRawCommandForProtectedPaths(command) {
  // Check for blocked path suffixes as substrings in the command.
  // These are specific enough to not cause false positives.
  for (const suffix of BLOCKED_PATH_SUFFIXES) {
    if (command.includes(suffix)) {
      return {
        blocked: true,
        reason: `Command references protected path "${suffix}"`,
      };
    }
  }

  return { blocked: false, reason: '' };
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
 * Tools that access files and should be blocked for credential files.
 *
 * SECURITY FIX (C1): Added Grep and Glob which can also access file contents.
 * Grep with output_mode="content" returns matching lines from files.
 * Glob returns file paths (not contents) but is blocked for defense-in-depth.
 */
const FILE_ACCESS_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);

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

      // Check 1: File paths extracted from command tokens
      const filePaths = extractFilePathsFromCommand(command);
      for (const fp of filePaths) {
        const result = checkFilePath(fp, projectDir);
        if (result.blocked) {
          blockBash(command, result.reason);
          return;
        }
      }

      // Check 2: Raw command scan for embedded protected path references
      // Catches: python3 -c "open('.mcp.json')", node -e "fs.readFileSync('.env')", etc.
      const rawScanResult = scanRawCommandForProtectedPaths(command);
      if (rawScanResult.blocked) {
        blockBash(command, rawScanResult.reason);
        return;
      }

      // Check 3: Credential env var references
      const credentialKeys = loadCredentialKeys(projectDir);
      const envResult = checkBashEnvAccess(command, credentialKeys);
      if (envResult.blocked) {
        blockBash(command, envResult.reason);
        return;
      }

      // Bash command is allowed
      process.exit(0);
    }

    // --- Grep tool: check path parameter ---
    if (toolName === 'Grep') {
      const grepPath = toolInput.path || '';
      if (grepPath) {
        const result = checkFilePath(grepPath, projectDir);
        if (result.blocked) {
          blockRead(grepPath, result.reason);
          return;
        }
      }
      // Also check glob parameter for protected file patterns
      const grepGlob = toolInput.glob || '';
      if (grepGlob) {
        for (const basename of BLOCKED_BASENAMES) {
          if (grepGlob.includes(basename)) {
            blockRead(grepGlob, `Grep glob pattern targets protected file "${basename}"`);
            return;
          }
        }
        for (const suffix of BLOCKED_PATH_SUFFIXES) {
          if (grepGlob.includes(suffix)) {
            blockRead(grepGlob, `Grep glob pattern targets protected path "${suffix}"`);
            return;
          }
        }
      }
      // When no path and no glob, Grep searches the entire directory tree
      // which includes protected credential files. Block to prevent exposure.
      if (!grepPath && !grepGlob) {
        blockRead('(recursive search)',
          'Grep without path or glob would search all files including protected credential files. ' +
          'Specify a path (e.g., path: "src/") or glob (e.g., glob: "*.ts") to restrict the search.');
        return;
      }
      process.exit(0);
    }

    // --- Glob tool: check path parameter ---
    if (toolName === 'Glob') {
      const globPath = toolInput.path || '';
      if (globPath) {
        const result = checkFilePath(globPath, projectDir);
        if (result.blocked) {
          blockRead(globPath, result.reason);
          return;
        }
      }
      // Check pattern for protected file names
      const globPattern = toolInput.pattern || '';
      if (globPattern) {
        for (const basename of BLOCKED_BASENAMES) {
          if (globPattern.includes(basename)) {
            blockRead(globPattern, `Glob pattern targets protected file "${basename}"`);
            return;
          }
        }
        for (const suffix of BLOCKED_PATH_SUFFIXES) {
          if (globPattern.includes(suffix)) {
            blockRead(globPattern, `Glob pattern targets protected path "${suffix}"`);
            return;
          }
        }
      }
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
