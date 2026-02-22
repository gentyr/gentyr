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
// Platform Guard
// ============================================================================

if (process.platform !== 'darwin') {
  throw new Error(
    `session-restart MCP server requires macOS (darwin). ` +
    `Current platform: ${process.platform}. ` +
    `Features like osascript, lsof -p, and Terminal/iTerm detection are macOS-only.`
  );
}

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const LOCK_DIR = path.join(os.tmpdir(), 'session-restart-locks');

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
 * Validate that a project directory path is safe for embedding in shell scripts.
 * Rejects paths with characters that could break shell quoting.
 */
function validateProjectDir(dir: string): void {
  if (!path.isAbsolute(dir)) {
    throw new Error(`Project directory must be an absolute path: ${dir}`);
  }
  // Control characters could inject commands
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

  // Write the resume command to a temp script file to avoid multi-layer escaping.
  // The temp script path contains only safe characters (UUID = hex + hyphens).
  const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${sessionId}.sh`);
  const resumeCommand = `cd ${shellEscape(projectDir)} && claude --resume ${sessionId}`;
  fs.writeFileSync(tempScriptPath, `#!/bin/bash\n${resumeCommand}\n`, { mode: 0o700 });

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
    // Temp script path is safe (tmpdir + UUID only) — no escaping needed inside AppleScript
    resumeBlock = `
# Resume in the same Terminal.app tab
osascript -e 'tell application "Terminal" to do script "bash ${tempScriptPath}" in selected tab of front window'
`;
  } else if (terminal === 'iterm') {
    resumeBlock = `
# Resume in the same iTerm session
osascript -e 'tell application "iTerm2" to tell current session of current window to write text "bash ${tempScriptPath}"'
`;
  } else {
    // No automated resume for unknown terminals
    resumeBlock = `
# Unknown terminal — cannot auto-resume
echo ""
echo "Claude Code killed. Resume manually with:"
echo "  bash ${tempScriptPath}"
echo ""
`;
  }

  // Cleanup: remove the temp script after a delay (it may still be needed for a few seconds)
  const cleanupBlock = `
# Clean up temp script after 60s
(sleep 60 && rm -f ${shellEscape(tempScriptPath)}) &
`;

  return `#!/bin/bash
${killBlock}
${resumeBlock}
${cleanupBlock}
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
// Idempotency Lock (G011)
// ============================================================================

/**
 * Acquire a file-based lock to prevent concurrent restart attempts.
 * Uses a lock file at /tmp/session-restart-locks/{sessionId}.lock.
 * The lock contains the PID and timestamp for diagnostics.
 * Stale locks (>30s) are automatically cleaned up.
 */
function acquireLock(sessionId: string): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${sessionId}.lock`);

  if (fs.existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const ageMs = Date.now() - (lockData.timestamp || 0);
      // Stale lock cleanup: 30s is generous given the restart script takes ~12s max
      if (ageMs < 30_000) {
        throw new Error(
          `A restart is already in progress for session ${sessionId} ` +
          `(locked ${Math.round(ageMs / 1000)}s ago by PID ${lockData.pid}). ` +
          `Wait for it to complete or remove ${lockPath} manually.`
        );
      }
      // Stale lock — fall through to overwrite
    } catch (err) {
      if (err instanceof Error && err.message.includes('already in progress')) {
        throw err;
      }
      // Corrupt lock file — overwrite it
    }
  }

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    sessionId,
  }));
}

/**
 * Release the lock file for a session.
 * Exported for use by callers that need manual cleanup (e.g., tests).
 * In normal operation, the lock auto-expires after 30s since the restart
 * script kills the process that holds the lock.
 */
export function releaseLock(sessionId: string): void {
  const lockPath = path.join(LOCK_DIR, `${sessionId}.lock`);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock file may already be gone — not an error
  }
}

// ============================================================================
// Tool Implementation
// ============================================================================

// In-process idempotency guard (fast path)
let restartInProgress = false;

async function sessionRestart(args: SessionRestartArgs): Promise<SessionRestartResult> {
  // Safety guard
  if (args.confirm !== true) {
    throw new Error('confirm must be true to proceed with session restart');
  }

  // In-process idempotency: reject if a restart is already in flight
  if (restartInProgress) {
    throw new Error('A restart is already in progress (in-process lock)');
  }

  // 1. Validate provided session_id BEFORE using it
  if (args.session_id && !UUID_REGEX.test(args.session_id)) {
    throw new Error(`Invalid session_id format: ${args.session_id}`);
  }

  // 2. Discover session ID (uses validated arg or auto-discovers)
  const sessionId = args.session_id ?? discoverSessionId();

  // 3. File-based idempotency guard (G011: cross-process protection)
  acquireLock(sessionId);

  // 4. Validate project directory path for shell safety
  validateProjectDir(PROJECT_DIR);

  // 5. Find Claude PID
  const claudePid = getClaudePid();

  // 6. Detect terminal
  const terminal = detectTerminal();

  // 7. Determine method
  let method: SessionRestartResult['method'];
  if (terminal === 'apple_terminal') {
    method = 'applescript_terminal';
  } else if (terminal === 'iterm') {
    method = 'applescript_iterm';
  } else {
    method = 'manual';
  }

  // 8. Mark restart in progress (after all validation passes)
  restartInProgress = true;

  // 9. Generate and spawn detached restart script
  const script = generateRestartScript(claudePid, sessionId, PROJECT_DIR, terminal);

  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Note: lock is intentionally NOT released here — the restart script will
  // kill this process. The lock auto-expires after 30s (stale lock cleanup).

  // 10. Build resume command for fallback
  const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${sessionId}.sh`);
  const resumeCommand = fs.existsSync(tempScriptPath)
    ? `bash ${tempScriptPath}`
    : `cd ${shellEscape(PROJECT_DIR)} && claude --resume ${sessionId}`;

  const message = method === 'manual'
    ? `Restart initiated. Claude (PID ${claudePid}) will be killed in ~1s. Terminal auto-resume not available — run the resume_command manually.`
    : `Restart initiated. Claude (PID ${claudePid}) will be killed in ~1s and resumed automatically via ${method}.`;

  return {
    initiated: true,
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
    description: 'Restart Claude Code session (macOS only). Kills the current Claude process and resumes the session in the same terminal. Use after rebuilding MCP servers or framework code. Requires confirm=true as a safety guard. Non-idempotent: concurrent calls are rejected via lock file. Returns initiated=true (restart happens asynchronously after response).',
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
