#!/usr/bin/env node
/**
 * Session Restart MCP Server
 *
 * Automates Claude Code session restart after MCP server rebuilds.
 * Discovers the current session, spawns a detached restart script,
 * kills Claude, and the script resumes the session in the same terminal.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SessionRestartArgsSchema,
  type SessionRestartArgs,
  type SessionRestartResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Get the Claude session directory for this project.
 * Reuses the same path normalization as cto-report/server.ts.
 */
function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Try to discover the current session ID via lsof.
 * Checks which .jsonl file the Claude parent process has open,
 * which avoids picking up automation/task sessions that may have
 * a more recent mtime.
 */
function discoverSessionIdViaLsof(sessionDir: string, claudePid: number): string | null {
  try {
    const output = execSync(
      `lsof -p ${claudePid} 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    );

    for (const line of output.split('\n')) {
      if (!line.includes('.jsonl')) continue;
      const match = line.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/
      );
      if (match && match[1]) {
        // Verify the file is actually in our session directory
        const candidate = path.join(sessionDir, `${match[1]}.jsonl`);
        if (fs.existsSync(candidate)) {
          return match[1];
        }
      }
    }
  } catch {
    // lsof unavailable or failed — fall through
  }
  return null;
}

/**
 * Content-aware session discovery.
 * Reads the tail of each .jsonl file and looks for "session_restart" —
 * by the time this MCP tool executes, Claude has already written the
 * tool_use block to the calling session's transcript.
 * Among matches, picks the most recently modified (handles old sessions
 * that may also contain a past restart call).
 */
function discoverSessionIdViaContent(sessionDir: string): string | null {
  const TAIL_BYTES = 8192;
  const candidates: { id: string; mtime: number }[] = [];

  const fileNames = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'));

  for (const f of fileNames) {
    const id = f.replace('.jsonl', '');
    if (!UUID_REGEX.test(id)) continue;

    const filePath = path.join(sessionDir, f);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;

      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(TAIL_BYTES, stat.size);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      if (buffer.toString('utf8').includes('session_restart')) {
        candidates.push({ id, mtime: stat.mtimeMs });
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

/**
 * Discover the current session ID.
 * 1. lsof: find the .jsonl file Claude has open (most reliable).
 * 2. Content: find the file whose tail contains "session_restart" (avoids automation confusion).
 * 3. mtime: most recently modified .jsonl file (last resort).
 */
function discoverSessionId(): string {
  const sessionDir = getSessionDir();

  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session directory not found: ${sessionDir}`);
  }

  // Tier 1: find which session file Claude actually has open
  const claudePid = process.ppid;
  const lsofResult = discoverSessionIdViaLsof(sessionDir, claudePid);
  if (lsofResult) {
    return lsofResult;
  }

  // Tier 2: content-aware — find the session with session_restart in its tail
  const contentResult = discoverSessionIdViaContent(sessionDir);
  if (contentResult) {
    return contentResult;
  }

  // Tier 3: most recently modified .jsonl file
  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const filePath = path.join(sessionDir, f);
      const stat = fs.statSync(filePath);
      return { name: f, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime || b.size - a.size);

  if (files.length === 0) {
    throw new Error(`No session files found in: ${sessionDir}`);
  }

  const sessionId = files[0].name.replace('.jsonl', '');

  if (!UUID_REGEX.test(sessionId)) {
    throw new Error(`Session filename is not a valid UUID: ${sessionId}`);
  }

  return sessionId;
}

// ============================================================================
// Parent PID Discovery
// ============================================================================

/**
 * Get and validate the Claude Code PID.
 * Since mcp-launcher uses import() (not spawn()), process.ppid is Claude.
 */
function getClaudePid(): number {
  const pid = process.ppid;

  try {
    const command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim();
    if (!command.toLowerCase().includes('claude')) {
      throw new Error(
        `Parent process (PID ${pid}) does not appear to be Claude Code: "${command}"`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not appear')) {
      throw err;
    }
    // ps failed — process might have exited or we lack permissions
    throw new Error(`Could not verify parent process (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`);
  }

  return pid;
}

// ============================================================================
// Terminal Detection
// ============================================================================

type TerminalType = 'apple_terminal' | 'iterm' | 'unknown';

function detectTerminal(): TerminalType {
  // AppleScript only works on macOS
  if (process.platform !== 'darwin') {
    return 'unknown';
  }

  const termProgram = process.env['TERM_PROGRAM'] || '';

  if (termProgram === 'Apple_Terminal') {
    return 'apple_terminal';
  }

  if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    return 'iterm';
  }

  return 'unknown';
}

// ============================================================================
// Restart Script Generation
// ============================================================================

/**
 * Escape a string for embedding inside an AppleScript double-quoted string
 * that is itself inside a bash single-quoted -e argument.
 *
 * Layers: bash -c '...' → osascript -e '...' → AppleScript "..."
 *
 * Since the osascript -e argument uses single quotes in bash, we only need
 * to handle the AppleScript string escaping (backslash and double-quote).
 * The session ID is validated as UUID (safe chars only) and the project dir
 * is validated to contain no single quotes (which would break the bash layer).
 */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Validate that a project directory path is safe for embedding in shell scripts.
 * Rejects paths with characters that could break multi-layer quoting.
 */
function validateProjectDir(dir: string): void {
  // Single quotes break the osascript -e '...' bash quoting
  if (dir.includes("'")) {
    throw new Error(`Project directory path contains single quotes, which are not supported: ${dir}`);
  }
  // Newlines/control chars could inject commands
  if (/[\x00-\x1f\x7f]/.test(dir)) {
    throw new Error('Project directory path contains control characters');
  }
}

function generateRestartScript(
  claudePid: number,
  sessionId: string,
  projectDir: string,
  terminal: TerminalType,
): string {
  // sessionId is already validated as UUID (hex + hyphens only)
  // projectDir is validated by validateProjectDir() before we get here
  const resumeCommand = `cd ${shellEscape(projectDir)} && claude --resume ${sessionId}`;

  const killBlock = `
# Wait for MCP response to propagate
sleep 1

# Graceful shutdown
kill -TERM ${claudePid} 2>/dev/null

# Poll for exit (up to 10s)
for i in $(seq 1 20); do
  kill -0 ${claudePid} 2>/dev/null || break
  sleep 0.5
done

# Force kill if still alive
kill -0 ${claudePid} 2>/dev/null && kill -9 ${claudePid} 2>/dev/null

# Let shell settle
sleep 0.5
`;

  let resumeBlock: string;

  if (terminal === 'apple_terminal') {
    const escapedCommand = escapeForAppleScript(resumeCommand);
    resumeBlock = `
# Resume in the same Terminal.app tab
osascript -e 'tell application "Terminal" to do script "${escapedCommand}" in selected tab of front window'
`;
  } else if (terminal === 'iterm') {
    const escapedCommand = escapeForAppleScript(resumeCommand);
    resumeBlock = `
# Resume in the same iTerm session
osascript -e 'tell application "iTerm2" to tell current session of current window to write text "${escapedCommand}"'
`;
  } else {
    // No automated resume for unknown terminals
    resumeBlock = `
# Unknown terminal — cannot auto-resume
echo ""
echo "Claude Code killed. Resume manually with:"
echo "  ${resumeCommand}"
echo ""
`;
  }

  return `#!/bin/bash
${killBlock}
${resumeBlock}
`;
}

function shellEscape(s: string): string {
  // If the string contains no special characters, return as-is
  if (/^[a-zA-Z0-9._\-/~]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Tool Implementation
// ============================================================================

// Idempotency guard: prevent concurrent restart attempts
let restartInProgress = false;

async function sessionRestart(args: SessionRestartArgs): Promise<SessionRestartResult> {
  // Safety guard
  if (args.confirm !== true) {
    throw new Error('confirm must be true to proceed with session restart');
  }

  // Idempotency: reject if a restart is already in flight
  if (restartInProgress) {
    throw new Error('A restart is already in progress');
  }

  // 1. Validate provided session_id BEFORE using it
  if (args.session_id && !UUID_REGEX.test(args.session_id)) {
    throw new Error(`Invalid session_id format: ${args.session_id}`);
  }

  // 2. Discover session ID (uses validated arg or auto-discovers)
  const sessionId = args.session_id ?? discoverSessionId();

  // 3. Validate project directory path for shell safety
  validateProjectDir(PROJECT_DIR);

  // 4. Find Claude PID
  const claudePid = getClaudePid();

  // 5. Detect terminal
  const terminal = detectTerminal();

  // 6. Determine method
  let method: SessionRestartResult['method'];
  if (terminal === 'apple_terminal') {
    method = 'applescript_terminal';
  } else if (terminal === 'iterm') {
    method = 'applescript_iterm';
  } else {
    method = 'manual';
  }

  // 7. Mark restart in progress (after all validation passes)
  restartInProgress = true;

  // 8. Generate and spawn detached restart script
  const script = generateRestartScript(claudePid, sessionId, PROJECT_DIR, terminal);

  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 9. Build resume command for fallback
  const resumeCommand = `cd ${shellEscape(PROJECT_DIR)} && claude --resume ${sessionId}`;

  const message = method === 'manual'
    ? `Restart script spawned. Claude (PID ${claudePid}) will be killed in ~1s. Terminal auto-resume not available — run the resume_command manually.`
    : `Restart script spawned. Claude (PID ${claudePid}) will be killed in ~1s and resumed automatically via ${method}.`;

  return {
    success: true,
    session_id: sessionId,
    project_dir: PROJECT_DIR,
    claude_pid: claudePid,
    method,
    message,
    resume_command: resumeCommand,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'session_restart',
    description: 'Restart Claude Code session. Kills the current Claude process and resumes the session in the same terminal. Use after rebuilding MCP servers or framework code. Requires confirm=true as a safety guard.',
    schema: SessionRestartArgsSchema,
    handler: sessionRestart,
  },
];

const server = new McpServer({
  name: 'session-restart',
  version: '1.0.0',
  tools,
});

server.start();
