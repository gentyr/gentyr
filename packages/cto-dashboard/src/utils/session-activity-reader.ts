/**
 * Session Activity Reader — reads live activity snippets from running session JSONL files.
 *
 * Uses the readTail pattern (read last N bytes) for efficiency — does NOT read
 * the entire file. Parses partial JSONL (first line may be truncated) and extracts:
 * - Last tool call name + truncated input
 * - Last assistant text snippet
 * - Spawned sub-agents (Agent tool_use blocks)
 * - Git commit tool calls
 * - Message count estimate
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Public Interfaces
// ============================================================================

export interface SessionActivity {
  agentId: string;
  lastTool: string | null;
  lastToolInput: string | null;
  lastText: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  spawnedAgents: string[];
  gitCommits: string[];
}

// ============================================================================
// Internal Types
// ============================================================================

interface RawEntry {
  type?: string;
  message?: {
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
  };
  content?: string;
  timestamp?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read the last N bytes from a file. Returns the content as a UTF-8 string.
 * The first line may be truncated if the file is larger than the requested bytes.
 */
export function readTail(filePath: string, bytes: number = 8192): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return '';
    const start = Math.max(0, stat.size - bytes);
    const toRead = Math.min(bytes, stat.size);
    const buf = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * Parse JSONL content into entries, skipping the first line (may be truncated
 * due to readTail starting mid-line) and skipping blank/unparseable lines.
 */
function parseTailLines(content: string): RawEntry[] {
  const lines = content.split('\n');
  const entries: RawEntry[] = [];

  // Skip the first line — it may be truncated from reading a tail
  const startIdx = content.startsWith('\n') ? 0 : 1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as RawEntry);
    } catch {
      // Skip unparseable lines — common at tail boundaries
    }
  }

  return entries;
}

/**
 * Extract text content from an assistant message content array.
 */
function extractAssistantText(content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>): string {
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n')
    .trim();
}

/**
 * Truncate a JSON input preview to a human-readable string.
 */
function inputPreview(input: unknown, maxLen: number = 80): string {
  if (input === null || input === undefined) return '';
  try {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
  } catch {
    return '[complex input]';
  }
}

/**
 * Find the project session directory for a given project directory path.
 * Encodes path using the same convention as the rest of GENTYR:
 * replace all non-alphanumeric chars with '-'.
 */
function getSessionDir(projectDir: string): string | null {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const encoded = projectDir.replace(/[^a-zA-Z0-9]/g, '-');

  const primary = path.join(claudeProjectsDir, encoded);
  if (fs.existsSync(primary)) return primary;

  // Try without leading dash (alternative convention)
  const alt = path.join(claudeProjectsDir, encoded.replace(/^-/, ''));
  if (fs.existsSync(alt)) return alt;

  return null;
}

/**
 * Scan session files in a directory for one containing [AGENT:agentId] in its
 * first 16KB.
 */
function findSessionFileByAgentId(sessionDir: string, agentId: string): string | null {
  const marker = `[AGENT:${agentId}]`;
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16000);
      const bytesRead = fs.readSync(fd, buf, 0, 16000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch {
      // Skip unreadable files
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
      }
    }
  }

  return null;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Read the latest activity for a running agent session.
 *
 * Searches for the session JSONL in the main project dir (and optionally a
 * worktree dir), then reads the last 8KB and extracts activity signals.
 *
 * Returns null if the session file cannot be located.
 */
export function getSessionActivity(
  agentId: string,
  projectDir: string,
  worktreePath?: string,
): SessionActivity | null {
  // Try to find the session file
  let sessionFile: string | null = null;

  const mainSessionDir = getSessionDir(projectDir);
  if (mainSessionDir) {
    sessionFile = findSessionFileByAgentId(mainSessionDir, agentId);
  }

  if (!sessionFile && worktreePath) {
    const wtSessionDir = getSessionDir(worktreePath);
    if (wtSessionDir) {
      sessionFile = findSessionFileByAgentId(wtSessionDir, agentId);
    }
  }

  if (!sessionFile) return null;

  // Read the tail of the session file
  let tailContent: string;
  try {
    tailContent = readTail(sessionFile, 8192);
  } catch {
    return null;
  }

  const entries = parseTailLines(tailContent);

  // Extract activity signals from parsed entries
  let lastTool: string | null = null;
  let lastToolInput: string | null = null;
  let lastText: string | null = null;
  let lastTimestamp: string | null = null;
  const spawnedAgents: string[] = [];
  const gitCommits: string[] = [];
  let messageCount = 0;

  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      messageCount++;
      const content = entry.message!.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;

      // Extract text
      const text = extractAssistantText(content);
      if (text) lastText = text.substring(0, 200);

      // Extract tool calls
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const toolName = block.name ?? 'unknown';
        lastTool = toolName;
        lastToolInput = inputPreview(block.input);

        // Detect sub-agent spawning (Agent/Task tool)
        if (toolName === 'Agent' || toolName === 'Task') {
          const inputObj = block.input as Record<string, unknown> | null;
          if (inputObj && typeof inputObj.description === 'string') {
            spawnedAgents.push(inputObj.description.substring(0, 60));
          }
        }

        // Detect git commits in Bash tool calls
        if (toolName === 'Bash') {
          const inputObj = block.input as Record<string, unknown> | null;
          const cmd = typeof inputObj?.command === 'string' ? inputObj.command : '';
          if (cmd.includes('git commit')) {
            // Extract commit message if -m flag is present
            const mMatch = cmd.match(/-m\s+"([^"]+)"/);
            gitCommits.push(mMatch ? mMatch[1] : 'git commit');
          }
        }
      }
    } else if (entry.type === 'human' || entry.type === 'user') {
      messageCount++;
    } else if (entry.type === 'tool_result') {
      // Count tool results but don't extract content (it can be very large)
    }
  }

  return {
    agentId,
    lastTool,
    lastToolInput,
    lastText,
    lastTimestamp,
    messageCount,
    spawnedAgents,
    gitCommits,
  };
}

/**
 * Get session activity for a known session file path directly (no agent ID scan needed).
 * Used by the MCP server tools when the session file is known from the queue DB.
 */
export function getSessionActivityFromFile(
  agentId: string,
  sessionFile: string,
  depthKb: number = 8,
): SessionActivity | null {
  if (!fs.existsSync(sessionFile)) return null;

  let tailContent: string;
  try {
    tailContent = readTail(sessionFile, depthKb * 1024);
  } catch {
    return null;
  }

  const entries = parseTailLines(tailContent);

  let lastTool: string | null = null;
  let lastToolInput: string | null = null;
  let lastText: string | null = null;
  let lastTimestamp: string | null = null;
  const spawnedAgents: string[] = [];
  const gitCommits: string[] = [];
  let messageCount = 0;

  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      messageCount++;
      const content = entry.message!.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;

      const text = extractAssistantText(content);
      if (text) lastText = text.substring(0, 200);

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const toolName = block.name ?? 'unknown';
        lastTool = toolName;
        lastToolInput = inputPreview(block.input);

        if (toolName === 'Agent' || toolName === 'Task') {
          const inputObj = block.input as Record<string, unknown> | null;
          if (inputObj && typeof inputObj.description === 'string') {
            spawnedAgents.push(inputObj.description.substring(0, 60));
          }
        }

        if (toolName === 'Bash') {
          const inputObj = block.input as Record<string, unknown> | null;
          const cmd = typeof inputObj?.command === 'string' ? inputObj.command : '';
          if (cmd.includes('git commit')) {
            const mMatch = cmd.match(/-m\s+"([^"]+)"/);
            gitCommits.push(mMatch ? mMatch[1] : 'git commit');
          }
        }
      }
    } else if (entry.type === 'human' || entry.type === 'user') {
      messageCount++;
    }
  }

  return {
    agentId,
    lastTool,
    lastToolInput,
    lastText,
    lastTimestamp,
    messageCount,
    spawnedAgents,
    gitCommits,
  };
}
