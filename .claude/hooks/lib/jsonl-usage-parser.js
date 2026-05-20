/**
 * Shared JSONL parser for token usage extraction.
 *
 * Used by the token-usage-collector daemon to incrementally scan session JSONL
 * files. Provides both incremental (resume from byte offset) and full-file scan
 * modes, plus utilities for finding agent markers and CLAUDE_USAGE_TAG env vars.
 *
 * JSONL message shape (assistant entries with usage):
 *   {
 *     "type": "assistant",
 *     "uuid": "...",            // optional message id
 *     "timestamp": "ISO-8601",
 *     "message": {
 *       "model": "claude-opus-4-7",
 *       "usage": {
 *         "input_tokens": N,
 *         "output_tokens": N,
 *         "cache_creation_input_tokens": N,
 *         "cache_read_input_tokens": N
 *       }
 *     }
 *   }
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();

/**
 * Encode a project directory path into the canonical
 * ~/.claude/projects/<encoded> directory name. Matches the convention used by
 * Claude Code itself (every non-alphanumeric char becomes a dash).
 */
export function encodeProjectPath(projectDir) {
  return projectDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve the JSONL session directory for a project.
 * Falls back to the variant without a leading dash if the dashed one is missing
 * (matches compact-session.js getSessionDir behavior).
 */
export function getSessionDir(projectDir) {
  const dashed = path.join(HOME, '.claude', 'projects', encodeProjectPath(projectDir));
  if (fs.existsSync(dashed)) return dashed;
  // Older variant: leading dash stripped
  const stripped = path.join(HOME, '.claude', 'projects', encodeProjectPath(projectDir).replace(/^-/, ''));
  if (fs.existsSync(stripped)) return stripped;
  return dashed; // return canonical even if missing — caller can detect
}

/**
 * List all JSONL files (including sub-agent files) under a project's session dir.
 *
 * Returns:
 *   [
 *     { path, sessionId, isSubagent: false, parentSessionId: null },
 *     { path, sessionId, isSubagent: true,  parentSessionId: 'parent-uuid' },
 *     ...
 *   ]
 *
 * Sub-agent JSONLs live at: <sessionDir>/<parent-session-id>/subagents/<sub-id>.jsonl
 */
export function listSessionFiles(sessionDir) {
  const out = [];
  if (!fs.existsSync(sessionDir)) return out;

  let entries;
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      out.push({
        path: path.join(sessionDir, entry.name),
        sessionId,
        isSubagent: false,
        parentSessionId: null,
      });
      continue;
    }
    if (entry.isDirectory()) {
      // Look for subagents/ subdirectory
      const subagentsDir = path.join(sessionDir, entry.name, 'subagents');
      if (!fs.existsSync(subagentsDir)) continue;
      let subFiles;
      try {
        subFiles = fs.readdirSync(subagentsDir);
      } catch {
        continue;
      }
      for (const sf of subFiles) {
        if (!sf.endsWith('.jsonl')) continue;
        out.push({
          path: path.join(subagentsDir, sf),
          sessionId: sf.replace(/\.jsonl$/, ''),
          isSubagent: true,
          parentSessionId: entry.name,
        });
      }
    }
  }
  return out;
}

/**
 * Parse usage events from a JSONL file starting at a given byte offset.
 *
 * Returns:
 *   {
 *     events: [{ messageUuid, timestamp, model, input_tokens, output_tokens,
 *                cache_creation_tokens, cache_read_tokens }],
 *     newOffset: bytes after the last fully-parsed line,
 *     bytesScanned: total bytes read this call
 *   }
 *
 * Partial trailing lines are NOT consumed — newOffset stops at the last
 * newline so the next scan picks up where this one left off.
 */
export function parseUsageEventsIncremental(filePath, startOffset = 0) {
  const events = [];
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { events, newOffset: startOffset, bytesScanned: 0 };
  }

  if (startOffset >= stat.size) {
    return { events, newOffset: startOffset, bytesScanned: 0 };
  }

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { events, newOffset: startOffset, bytesScanned: 0 };
  }

  const toRead = stat.size - startOffset;
  const buf = Buffer.alloc(toRead);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, toRead, startOffset);
  } finally {
    try { fs.closeSync(fd); } catch { /* non-fatal */ }
  }

  if (bytesRead <= 0) {
    return { events, newOffset: startOffset, bytesScanned: 0 };
  }

  const text = buf.toString('utf8', 0, bytesRead);
  // Split into lines; the last element is either "" (trailing newline) or a
  // partial line (no trailing newline yet).
  const parts = text.split('\n');
  const lastNewlineIdx = text.lastIndexOf('\n');
  let lastCompleteEnd;
  if (lastNewlineIdx < 0) {
    // No newline at all in this read — nothing complete to consume.
    return { events, newOffset: startOffset, bytesScanned: bytesRead };
  }
  lastCompleteEnd = lastNewlineIdx + 1; // bytes from startOffset

  const completeLines = parts.slice(0, -1); // drop the last (incomplete) chunk
  // If the file ended with a newline, the last entry of parts is "" which is fine to skip

  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || !msg.usage) continue;
    const usage = msg.usage;
    events.push({
      messageUuid: entry.uuid || msg.id || null,
      timestamp: entry.timestamp || null,
      model: msg.model || 'unknown',
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
    });
  }

  return {
    events,
    newOffset: startOffset + lastCompleteEnd,
    bytesScanned: bytesRead,
  };
}

/**
 * Find an `[AGENT:agent-xxx]` marker in the first N bytes of a JSONL file.
 * Returns the agent id (e.g. "agent-abc123") or null.
 */
export function findAgentMarker(filePath, scanBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  const buf = Buffer.alloc(scanBytes);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, scanBytes, 0);
  } finally {
    try { fs.closeSync(fd); } catch { /* non-fatal */ }
  }
  if (bytesRead <= 0) return null;
  const text = buf.toString('utf8', 0, bytesRead);
  const match = text.match(/\[AGENT:(agent-[a-zA-Z0-9_-]+)\]/);
  return match ? match[1] : null;
}

/**
 * Detect CLAUDE_USAGE_TAG and CLAUDE_USAGE_PARENT env vars by scanning the
 * first N bytes of a JSONL file. Some Claude Code versions emit env dumps
 * in early system messages; we match permissively.
 *
 * Returns { tag, parentSessionId } — fields may be null.
 */
export function findUsageTagInJsonl(filePath, scanBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { tag: null, parentSessionId: null };
  }
  const buf = Buffer.alloc(scanBytes);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, scanBytes, 0);
  } finally {
    try { fs.closeSync(fd); } catch { /* non-fatal */ }
  }
  if (bytesRead <= 0) return { tag: null, parentSessionId: null };
  const text = buf.toString('utf8', 0, bytesRead);
  // Accept both raw and JSON-escaped quote forms (`X="v"` and `X=\"v\"`)
  const tagMatch = text.match(/CLAUDE_USAGE_TAG[=:]\s*["\\]*([a-zA-Z0-9_.:-]+)/);
  const parentMatch = text.match(/CLAUDE_USAGE_PARENT[=:]\s*["\\]*([a-zA-Z0-9_-]+)/);
  return {
    tag: tagMatch ? tagMatch[1] : null,
    parentSessionId: parentMatch ? parentMatch[1] : null,
  };
}

/**
 * Detect if a JSONL is from a spawned session by looking for CLAUDE_SPAWNED_SESSION=true
 * in the first 64KB. Used to distinguish interactive CTO sessions from spawned ones
 * when no other attribution signal is found.
 */
export function isSpawnedSession(filePath, scanBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  const buf = Buffer.alloc(scanBytes);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, scanBytes, 0);
  } finally {
    try { fs.closeSync(fd); } catch { /* non-fatal */ }
  }
  if (bytesRead <= 0) return false;
  const text = buf.toString('utf8', 0, bytesRead);
  return /CLAUDE_SPAWNED_SESSION[=:"]\s*"?true"?/.test(text);
}

/**
 * Read sub-agent metadata from the sibling .meta.json file (if present).
 * Returns a normalized object with both camelCase and snake_case keys
 * (Claude Code writes `agentType`; older callers read `agent_type`), or null.
 */
export function readSubagentMeta(subagentJsonlPath) {
  const metaPath = subagentJsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const agentType = raw.agentType ?? raw.agent_type ?? null;
    const agentId = raw.agentId ?? raw.agent_id ?? null;
    const description = raw.description ?? null;
    return {
      ...raw,
      agent_type: agentType,
      agentType,
      agent_id: agentId,
      agentId,
      description,
    };
  } catch {
    return null;
  }
}

/**
 * Detect a `/compact` sub-process JSONL by its session_id prefix.
 * Claude Code names auto-compaction subagent files like
 * `agent-acompact-<hex>.jsonl` under `<parent>/subagents/`. These have no
 * `.meta.json` sidecar because they are spawned by Claude Code itself, not
 * the Agent tool.
 */
export function isCompactionSubagent(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('agent-acompact-');
}
