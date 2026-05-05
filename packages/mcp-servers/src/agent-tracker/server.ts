#!/usr/bin/env node
/**
 * Agent Tracker MCP Server
 *
 * Tracks all Claude agents spawned by hooks in this project.
 * Provides tools to list agents, view prompts, and access session transcripts.
 * Extended with unified session browser for ALL Claude Code sessions.
 *
 * @version 4.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { openReadonlyDb } from '../shared/readonly-db.js';
import { resolveFrameworkDir } from '../shared/resolve-framework.js';
import {
  ListSpawnedAgentsArgsSchema,
  GetAgentPromptArgsSchema,
  GetAgentSessionArgsSchema,
  GetAgentStatsArgsSchema,
  GetConcurrencyStatusArgsSchema,
  ForceSpawnTasksArgsSchema,
  ForceTriageReportsArgsSchema,
  MonitorAgentsArgsSchema,
  ListSessionsArgsSchema,
  SearchSessionsArgsSchema,
  GetSessionSummaryArgsSchema,
  GetSessionQueueStatusArgsSchema,
  SetMaxConcurrentSessionsArgsSchema,
  CancelQueuedSessionArgsSchema,
  DrainSessionQueueArgsSchema,
  ActivateQueuedSessionArgsSchema,
  SetReservedSlotsArgsSchema,
  GetReservedSlotsArgsSchema,
  SetFocusModeArgsSchema,
  GetFocusModeArgsSchema,
  SetAutomationRateArgsSchema,
  GetAutomationRateArgsSchema,
  SetLockdownModeArgsSchema,
  GetLockdownModeArgsSchema,
  SetLocalModeArgsSchema,
  GetLocalModeArgsSchema,
  SetAutomationToggleArgsSchema,
  GetAutomationTogglesArgsSchema,
  GetUserPromptArgsSchema,
  SearchUserPromptsArgsSchema,
  ListUserPromptsArgsSchema,
  SubscribeSessionSummariesArgsSchema,
  UnsubscribeSessionSummariesArgsSchema,
  ListSummarySubscriptionsArgsSchema,
  SendSessionSignalArgsSchema,
  BroadcastSignalArgsSchema,
  GetSessionSignalsArgsSchema,
  GetCommsLogArgsSchema,
  AcknowledgeSignalArgsSchema,
  PeekSessionArgsSchema,
  BrowseSessionArgsSchema,
  UpdateMonitorStateArgsSchema,
  StopMonitoringArgsSchema,
  GetSessionActivitySummaryArgsSchema,
  SearchCtoSessionsArgsSchema,
  SuspendSessionArgsSchema,
  KillSessionArgsSchema,
  RestartSessionArgsSchema,
  ReorderQueueArgsSchema,
  InspectPersistentTaskArgsSchema,
  LaunchInteractiveMonitorArgsSchema,
  SubmitBypassRequestArgsSchema,
  ResolveBypassRequestArgsSchema,
  ListBypassRequestsArgsSchema,
  ListBlockingItemsArgsSchema,
  ResolveBlockingItemArgsSchema,
  GetBlockingSummaryArgsSchema,
  StageMcpServerArgsSchema,
  AcquireSharedResourceArgsSchema,
  ReleaseSharedResourceArgsSchema,
  RenewSharedResourceArgsSchema,
  GetSharedResourceStatusArgsSchema,
  RegisterSharedResourceArgsSchema,
  ForceReleaseSharedResourceArgsSchema,
  RequestSelfCompactArgsSchema,
  AGENT_TYPES,
  type ListSpawnedAgentsArgs,
  type GetAgentPromptArgs,
  type GetAgentSessionArgs,
  type ListSessionsArgs,
  type SearchSessionsArgs,
  type GetSessionSummaryArgs,
  type GetConcurrencyStatusArgs,
  type ForceSpawnTasksArgs,
  type MonitorAgentsArgs,
  type GetSessionQueueStatusArgs,
  type SetMaxConcurrentSessionsArgs,
  type CancelQueuedSessionArgs,
  type DrainSessionQueueArgs,
  type ActivateQueuedSessionArgs,
  type SetReservedSlotsArgs,
  type GetReservedSlotsArgs,
  type SetFocusModeArgs,
  type GetFocusModeArgs,
  type SetAutomationRateArgs,
  type GetAutomationRateArgs,
  type SetLockdownModeArgs,
  type GetLockdownModeArgs,
  type SetLocalModeArgs,
  type SetAutomationToggleArgs,
  type GetAutomationTogglesArgs,
  type SubscribeSessionSummariesArgs,
  type UnsubscribeSessionSummariesArgs,
  type ListSummarySubscriptionsArgs,
  type SendSessionSignalArgs,
  type BroadcastSignalArgs,
  type GetSessionSignalsArgs,
  type GetCommsLogArgs,
  type AcknowledgeSignalArgs,
  type PeekSessionArgs,
  type BrowseSessionArgs,
  type UpdateMonitorStateArgs,
  type StopMonitoringArgs,
  type GetSessionActivitySummaryArgs,
  type SearchCtoSessionsArgs,
  type SuspendSessionArgs,
  type KillSessionArgs,
  type RestartSessionArgs,
  type ReorderQueueArgs,
  type InspectPersistentTaskArgs,
  type LaunchInteractiveMonitorArgs,
  type SubmitBypassRequestArgs,
  type ResolveBypassRequestArgs,
  type ListBypassRequestsArgs,
  type ListBlockingItemsArgs,
  type ResolveBlockingItemArgs,
  type GetBlockingSummaryArgs,
  type StageMcpServerArgs,
  type CheckDeferredActionArgs,
  CheckDeferredActionArgsSchema,
  type RecordCtoDecisionArgs,
  RecordCtoDecisionArgsSchema,
  type CheckCtoDecisionArgs,
  CheckCtoDecisionArgsSchema,
  DeputyResolveBypassRequestArgsSchema,
  type DeputyResolveBypassRequestArgs,
  DeputyApproveDeferredActionArgsSchema,
  type DeputyApproveDeferredActionArgs,
  DeputyEscalateToCtoArgsSchema,
  type DeputyEscalateToCtoArgs,
  type AcquireSharedResourceArgs,
  type ReleaseSharedResourceArgs,
  type RenewSharedResourceArgs,
  type GetSharedResourceStatusArgs,
  type RegisterSharedResourceArgs,
  type ForceReleaseSharedResourceArgs,
  type ForceTriageReportsResult,
  type MonitorAgentsResult,
  type AgentProgress,
  type WorktreeGitState,
  type ListSpawnedAgentsResult,
  type GetAgentPromptResult,
  type GetAgentSessionResult,
  type ListSessionsResult,
  type SearchSessionsResult,
  type SessionSummaryResult,
  type ConcurrencyStatusResult,
  type ForceSpawnTasksResult,
  type AgentStats,
  type AgentHistory,
  type AgentRecord,
  type ListAgentItem,
  type FormattedSession,
  type SessionMessage,
  type ErrorResult,
  type HookInfo,
  type SessionListItem,
  type SearchMatch,
  type SearchResultItem,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const TRACKER_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_PROMPT_PREVIEW_LENGTH = 200;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Read the agent history from file
 */
function readHistory(): AgentHistory {
  // G001: File-not-found is different from corruption
  if (!fs.existsSync(TRACKER_FILE)) {
    return { agents: [], stats: {} };
  }

  // File exists - must read successfully or throw (G001: no silent corruption)
  try {
    const content = fs.readFileSync(TRACKER_FILE, 'utf8');
    return JSON.parse(content) as AgentHistory;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[agent-tracker] History file corrupted at ${TRACKER_FILE}: ${message}. Delete file to reset.`);
  }
}

/**
 * Resolve a project path to its ~/.claude/projects/ session directory.
 * Ported from revival-utils.js:getSessionDir().
 */
function getSessionDir(projectDir: string): string | null {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Find a session JSONL file by scanning for [AGENT:id] marker in the first 2KB.
 * Ported from revival-utils.js:findSessionFileByAgentId().
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
      const buf = Buffer.alloc(2000);
      const bytesRead = fs.readSync(fd, buf, 0, 2000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch {
      // skip unreadable files
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return null;
}

/**
 * Search across all session directories matching a project prefix for an agent's session.
 * Worktree agents get their own session dir (e.g. -Users-...-git-my-project--claude-worktrees-feature-...).
 * This scans all dirs starting with the encoded project path to find sessions in worktree dirs.
 */
function findSessionFileAcrossProject(projectDir: string, agentId: string): string | null {
  const encodedPrefix = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    if (!dir.startsWith(encodedPrefix) && !dir.startsWith(encodedPrefix.replace(/^-/, ''))) continue;
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch { continue; }
    const found = findSessionFileByAgentId(candidate, agentId);
    if (found) return found;
  }
  return null;
}

/**
 * Find a session JSONL file by UUID across all session directories matching a project prefix.
 */
function findSessionFileByIdAcrossProject(projectDir: string, sessionUuid: string): string | null {
  const encodedPrefix = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  const filename = `${sessionUuid}.jsonl`;
  for (const dir of dirs) {
    if (!dir.startsWith(encodedPrefix) && !dir.startsWith(encodedPrefix.replace(/^-/, ''))) continue;
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find Claude session transcript for a given spawn.
 * 3-step pattern ported from reap-completed-agents.js:
 *   1. Return cached sessionFile if it exists on disk
 *   2. Search main project dir, then worktree dir by agent ID marker
 *   3. Return null (not a random file) when nothing matches
 */
function findSessionFile(agent: AgentRecord): string | null {
  // Step 1: Return cached sessionFile if still on disk (Bug 1 fix)
  if (agent.sessionFile && fs.existsSync(agent.sessionFile)) {
    return agent.sessionFile;
  }

  if (!agent.projectDir) return null;

  try {
    // Step 2a: Search main project session dir by agent ID marker
    const mainSessionDir = getSessionDir(agent.projectDir);
    if (mainSessionDir) {
      const found = findSessionFileByAgentId(mainSessionDir, agent.id);
      if (found) return found;
    }

    // Step 2b: Search worktree session dir if agent ran in a worktree (Bug 2 fix)
    const worktreePath = agent.metadata?.worktreePath as string | undefined;
    if (worktreePath) {
      const wtSessionDir = getSessionDir(worktreePath);
      if (wtSessionDir) {
        const found = findSessionFileByAgentId(wtSessionDir, agent.id);
        if (found) return found;
      }
    }

    // Step 3: Return null — not a random file (Bug 3 fix)
    return null;
  } catch (err) {
    // G001: Log session search errors (non-critical, return null)
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-tracker] Error finding session file: ${message}\n`);
    return null;
  }
}

interface RawSessionMessage {
  type?: string;
  message?: {
    content?: string | Array<{ type: string; text?: string; name?: string; id?: string }>;
  };
  content?: string;
  tool_use_id?: string;
  timestamp?: string;
}

/**
 * Read and parse a session JSONL file
 */
function readSessionFile(filePath: string): RawSessionMessage[] {
  // G001: File read errors should be logged, not silently ignored
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const messages: RawSessionMessage[] = [];
    let parseErrors = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RawSessionMessage;
        messages.push(parsed);
      } catch {
        // JSONL files may have occasional malformed lines - count but don't fail
        parseErrors++;
      }
    }

    // Log if significant parse failures (>10%)
    if (parseErrors > 0 && parseErrors > lines.length * 0.1) {
      process.stderr.write(`[agent-tracker] Warning: ${parseErrors}/${lines.length} lines failed to parse in ${filePath}\n`);
    }

    return messages;
  } catch (err) {
    // G001: Log file read errors
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-tracker] Error reading session file ${filePath}: ${message}\n`);
    return [];
  }
}

/**
 * Format session messages for display
 */
function formatSession(messages: RawSessionMessage[]): FormattedSession {
  const formatted: FormattedSession = {
    messageCount: messages.length,
    summary: {
      userMessages: 0,
      assistantMessages: 0,
      toolResults: 0,
      totalMessages: messages.length,
    },
    messages: [],
  };

  for (const msg of messages) {
    const entry: SessionMessage = {
      type: msg.type ?? 'unknown',
      timestamp: msg.timestamp ?? null,
    };

    if (msg.type === 'human' || msg.type === 'user') {
      entry.role = 'user';
      entry.content = typeof msg.message?.content === 'string'
        ? msg.message.content
        : (msg.content ?? '[no content]');
      formatted.summary.userMessages++;
    } else if (msg.type === 'assistant') {
      entry.role = 'assistant';
      // Extract text content from assistant messages
      if (Array.isArray(msg.message?.content)) {
        entry.content = msg.message.content
          .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text)
          .join('\n');
        entry.toolCalls = msg.message.content
          .filter((c): c is { type: string; name: string; id: string } =>
            c.type === 'tool_use' && typeof c.name === 'string' && typeof c.id === 'string')
          .map(c => ({ name: c.name, id: c.id }));
      } else {
        entry.content = typeof msg.message?.content === 'string'
          ? msg.message.content
          : (msg.content ?? '[no content]');
      }
      formatted.summary.assistantMessages++;
    } else if (msg.type === 'tool_result') {
      entry.role = 'tool_result';
      entry.toolId = msg.tool_use_id;
      entry.content = typeof msg.content === 'string'
        ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '')
        : '[complex content]';
      formatted.summary.toolResults++;
    }

    formatted.messages.push(entry);
  }

  return formatted;
}

// ============================================================================
// Session Browser Helpers
// ============================================================================

interface SessionFile {
  session_id: string;
  file_path: string;
  mtime: Date;
  size_bytes: number;
}

/**
 * Discover all session files for the current project
 */
function discoverSessions(): SessionFile[] {
  try {
    // Normalize path: replace / with - to get leading-dash format (e.g., "-home-user-project")
    const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);

    if (!fs.existsSync(sessionDir)) {
      // Try alternative path format (without leading dash, for backwards compatibility)
      const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
      if (!fs.existsSync(altPath)) {return [];}
    }

    const actualDir = fs.existsSync(sessionDir)
      ? sessionDir
      : path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));

    const files = fs.readdirSync(actualDir);
    const sessions: SessionFile[] = [];

    for (const f of files) {
      // Only top-level JSONL files (not in subdirectories)
      if (!f.endsWith('.jsonl')) {continue;}

      const filePath = path.join(actualDir, f);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          sessions.push({
            session_id: f.replace('.jsonl', ''),
            file_path: filePath,
            mtime: stats.mtime,
            size_bytes: stats.size,
          });
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return sessions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-tracker] Error discovering sessions: ${message}\n`);
    return [];
  }
}

/**
 * Match a session to a hook-spawned agent using timestamp proximity
 */
function matchSessionToHook(session: SessionFile, agentHistory: AgentRecord[]): HookInfo | null {
  const sessionTime = session.mtime.getTime();

  // Find agent spawned within 5 minutes of session modification
  const match = agentHistory.find(agent => {
    const agentTime = new Date(agent.timestamp).getTime();
    return Math.abs(sessionTime - agentTime) < 5 * 60 * 1000;
  });

  if (!match) {return null;}

  return {
    agent_id: match.id,
    type: match.type,
    hook_type: match.hookType,
    description: match.description,
  };
}

interface SessionLine {
  line: string;
  lineNum: number;
}

/**
 * Read session file lines (for searching)
 */
function readSessionLines(filePath: string): SessionLine[] {
  if (!fs.existsSync(filePath)) {return [];}

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const result: SessionLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        result.push({ line: lines[i], lineNum: i + 1 });
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-tracker] Error reading session: ${message}\n`);
    return [];
  }
}

/**
 * Get message type from parsed session entry
 */
function getMessageType(entry: RawSessionMessage): string {
  if (entry.type === 'human' || entry.type === 'user') {return 'user';}
  if (entry.type === 'assistant') {return 'assistant';}
  if (entry.type === 'tool_result') {return 'tool_result';}
  return 'unknown';
}

// ============================================================================
// WS5 Helper Functions
// ============================================================================

/**
 * Read a window of bytes from a file, offset from the end.
 * Returns content and position metadata for pagination.
 */
function readTailBytes(filePath: string, bytes: number = 16384, offsetFromEnd: number = 0): { content: string; fileSize: number; windowStart: number; windowEnd: number } {
  const fd = fs.openSync(filePath, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;
  const windowEnd = Math.max(0, fileSize - offsetFromEnd);
  const windowStart = Math.max(0, windowEnd - bytes);
  const readLen = windowEnd - windowStart;
  if (readLen <= 0) {
    fs.closeSync(fd);
    return { content: '', fileSize, windowStart: 0, windowEnd: 0 };
  }
  const buf = Buffer.alloc(readLen);
  fs.readSync(fd, buf, 0, readLen, windowStart);
  fs.closeSync(fd);
  return { content: buf.toString('utf8'), fileSize, windowStart, windowEnd };
}

/**
 * Parse JSONL tail content into array of objects, skipping unparseable lines.
 */
function parseTailEntries(tail: string): any[] {
  const lines = tail.split('\n').filter(l => l.trim());
  const entries: any[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return entries;
}

// ============================================================================
// Compaction Context Helpers
// ============================================================================

interface CompactionContext {
  boundaryCount: number;
  mostRecentSummary: string | null;
  mostRecentTimestamp: string | null;
  preTokensTotal: number;
}

const COMPACTION_MARKER = 'compact_boundary';
const COMPACTION_SCAN_CHUNK = 65536;  // 64KB per backward chunk
const COMPACTION_SCAN_MAX = 1048576;  // 1MB max backward scan

/**
 * Check if parsed tail entries contain any compaction boundaries.
 */
function detectCompactionInEntries(entries: any[]): boolean {
  return entries.some(e => e.type === 'system' && e.subtype === COMPACTION_MARKER);
}

/**
 * Scan a JSONL file backward for compact_boundary entries and their summaries.
 * Uses fast indexOf check per chunk before JSON parsing.
 */
function findCompactionContext(filePath: string, tailBytesAlreadyRead: number, maxSummaryChars: number = 4000): CompactionContext {
  const result: CompactionContext = { boundaryCount: 0, mostRecentSummary: null, mostRecentTimestamp: null, preTokensTotal: 0 };

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    // If tail already covered the whole file, caller has all data
    if (tailBytesAlreadyRead >= fileSize) return result;

    // Scan backward from the point where the tail started
    const scanEnd = Math.max(0, fileSize - tailBytesAlreadyRead);
    let scannedBytes = 0;
    let pos = scanEnd;

    // Track boundaries found: { byteOffset, timestamp, preTokens }
    const boundaries: Array<{ byteOffset: number; timestamp: string; trigger: string; preTokens: number }> = [];

    while (pos > 0 && scannedBytes < COMPACTION_SCAN_MAX) {
      const chunkSize = Math.min(COMPACTION_SCAN_CHUNK, pos);
      const chunkStart = pos - chunkSize;
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, chunkStart);
      const chunkStr = buf.toString('utf8');

      // Fast check: skip chunk if no boundary marker present
      if (chunkStr.includes(COMPACTION_MARKER)) {
        const lines = chunkStr.split('\n');
        for (const line of lines) {
          if (!line.includes(COMPACTION_MARKER)) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'system' && entry.subtype === COMPACTION_MARKER) {
              const meta = entry.compactMetadata ?? {};
              boundaries.push({
                byteOffset: chunkStart,  // approximate
                timestamp: entry.timestamp ?? '',
                trigger: meta.trigger ?? 'unknown',
                preTokens: meta.preTokens ?? 0,
              });
            }
          } catch { /* partial or malformed line */ }
        }
      }

      pos = chunkStart;
      scannedBytes += chunkSize;
    }

    if (boundaries.length === 0) return result;

    // Sort by timestamp descending to find most recent
    boundaries.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
    result.boundaryCount = boundaries.length;
    result.mostRecentTimestamp = boundaries[0].timestamp || null;
    result.preTokensTotal = boundaries.reduce((sum, b) => sum + b.preTokens, 0);

    // Also scan the tail-read portion's parsed entries (caller may have boundaries there too)
    // — handled externally by the caller who adds tail-detected boundaries

    // Find the most recent boundary's summary: the user message immediately after the boundary line.
    // Re-read from the most recent boundary's approximate region to find the summary.
    const mostRecent = boundaries[0];
    const summarySearchStart = mostRecent.byteOffset;
    const summarySearchSize = Math.min(65536, fileSize - summarySearchStart);  // Read up to 64KB after boundary
    const summaryBuf = Buffer.alloc(summarySearchSize);
    fs.readSync(fd, summaryBuf, 0, summarySearchSize, summarySearchStart);
    const summaryChunk = summaryBuf.toString('utf8');

    // Find the compact_boundary line, then read the next line (the summary)
    const summaryLines = summaryChunk.split('\n');
    let foundBoundary = false;
    for (const line of summaryLines) {
      if (!foundBoundary) {
        if (line.includes(COMPACTION_MARKER)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'system' && entry.subtype === COMPACTION_MARKER
                && entry.timestamp === mostRecent.timestamp) {
              foundBoundary = true;
            }
          } catch { /* skip */ }
        }
        continue;
      }

      // This should be the summary message
      if (!line.trim()) continue;
      try {
        const summaryEntry = JSON.parse(line);
        const content = summaryEntry.message?.content;
        if (typeof content === 'string' && content.includes('continued from a previous conversation')) {
          result.mostRecentSummary = content.length > maxSummaryChars
            ? content.substring(0, maxSummaryChars) + '...'
            : content;
        }
      } catch { /* malformed line */ }
      break;  // Only check the first non-empty line after the boundary
    }

    return result;
  } catch {
    return result;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* cleanup */ }
    }
  }
}

/**
 * Merge tail-detected compaction boundaries into a CompactionContext from backward scan.
 * Handles the case where the backward scan found boundaries outside the tail AND the
 * tail itself contains boundaries (small file or deep tail read).
 */
function mergeCompactionCounts(compaction: CompactionContext, tailEntries: any[]): CompactionContext {
  const tailBoundaries = tailEntries.filter(
    (e: any) => e.type === 'system' && e.subtype === COMPACTION_MARKER
  );
  if (tailBoundaries.length === 0) return compaction;

  const tailPreTokens = tailBoundaries.reduce(
    (sum: number, b: any) => sum + (b.compactMetadata?.preTokens ?? 0), 0
  );

  if (compaction.boundaryCount === 0) {
    // Backward scan found nothing; populate entirely from tail
    const mostRecent = tailBoundaries[tailBoundaries.length - 1];
    return {
      boundaryCount: tailBoundaries.length,
      mostRecentTimestamp: mostRecent.timestamp ?? null,
      mostRecentSummary: compaction.mostRecentSummary,
      preTokensTotal: tailPreTokens,
    };
  }

  // Backward scan found boundaries outside tail; add tail boundaries to the count
  return {
    ...compaction,
    boundaryCount: compaction.boundaryCount + tailBoundaries.length,
    preTokensTotal: compaction.preTokensTotal + tailPreTokens,
  };
}

// ============================================================================
// Activity Extraction
// ============================================================================

interface ActivityEntry {
  type: 'assistant_text' | 'tool_call' | 'tool_result' | 'compaction_boundary';
  timestamp?: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolId?: string;
  resultPreview?: string;
  resultToolId?: string;
}

function extractActivity(entries: any[]): ActivityEntry[] {
  const activity: ActivityEntry[] = [];

  for (const entry of entries) {
    // Emit compaction boundary as a distinct activity entry
    if (entry.type === 'system' && entry.subtype === COMPACTION_MARKER) {
      const meta = entry.compactMetadata ?? {};
      activity.push({
        type: 'compaction_boundary',
        timestamp: entry.timestamp ?? undefined,
        text: `Context compacted (${meta.trigger ?? 'unknown'}, ${meta.preTokens ?? '?'} tokens before compaction)`,
      });
      continue;
    }

    // Skip compaction summary messages (system-injected, not real user activity)
    if (entry.type === 'user' && typeof entry.message?.content === 'string'
        && entry.message.content.includes('continued from a previous conversation')) {
      continue;
    }

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const content = entry.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;

      const texts = content.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text as string);
      if (texts.length > 0) {
        const joined = texts.join('\n');
        activity.push({
          type: 'assistant_text',
          timestamp: entry.timestamp ?? undefined,
          text: joined,
        });
      }

      for (const block of content) {
        if ((block as any).type !== 'tool_use') continue;
        let inputStr = '';
        try {
          const input = (block as any).input;
          inputStr = (typeof input === 'string' ? input : JSON.stringify(input) ?? '');
          if (inputStr.length > 500) inputStr = inputStr.substring(0, 500) + '...';
        } catch { /* skip */ }

        activity.push({
          type: 'tool_call',
          timestamp: entry.timestamp ?? undefined,
          toolName: (block as any).name ?? 'unknown',
          toolInput: inputStr,
          toolId: (block as any).id ?? undefined,
        });
      }
    } else if (entry.type === 'tool_result') {
      let preview = '';
      if (typeof entry.content === 'string') {
        preview = entry.content.length > 300 ? entry.content.substring(0, 300) + '...' : entry.content;
      } else if (Array.isArray(entry.content)) {
        const textParts = entry.content
          .filter((c: any) => c.type === 'text' && c.text)
          .map((c: any) => c.text);
        const joined = textParts.join('\n');
        preview = joined.length > 300 ? joined.substring(0, 300) + '...' : joined;
      }

      activity.push({
        type: 'tool_result',
        timestamp: entry.timestamp ?? undefined,
        resultPreview: preview || undefined,
        resultToolId: entry.tool_use_id ?? undefined,
      });
    }
  }

  return activity;
}

function inspectPersistentTask(args: InspectPersistentTaskArgs): object {
  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) {
    return { error: 'persistent-tasks.db not found' };
  }

  // ── Phase 1: Read persistent-tasks.db ─────────────────────────────────
  let ptDb;
  try {
    ptDb = openReadonlyDb(ptDbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open persistent-tasks.db: ${message}` };
  }

  let task: any;
  let amendments: any[] = [];
  let subTaskLinks: Array<{ todo_task_id: string; linked_at: string }> = [];
  let recentEvents: any[] = [];

  try {
    task = ptDb.prepare('SELECT * FROM persistent_tasks WHERE id = ? OR id LIKE ?').get(args.id, `${args.id}%`);
    if (!task) {
      ptDb.close();
      return { error: `Persistent task not found: ${args.id}` };
    }

    amendments = ptDb.prepare(
      'SELECT id, amendment_type, content, created_at, created_by, acknowledged_at FROM amendments WHERE persistent_task_id = ? ORDER BY created_at ASC'
    ).all(task.id) as any[];

    subTaskLinks = ptDb.prepare(
      'SELECT todo_task_id, linked_at FROM sub_tasks WHERE persistent_task_id = ? ORDER BY linked_at ASC'
    ).all(task.id) as any[];

    recentEvents = ptDb.prepare(
      'SELECT event_type, details, created_at FROM events WHERE persistent_task_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(task.id) as any[];
  } finally {
    try { ptDb.close(); } catch { /* best-effort */ }
  }

  // ── Phase 2: Enrich sub-tasks from todo.db ────────────────────────────
  const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  interface TodoTaskRow { id: string; title: string; status: string; section: string }
  const todoMap = new Map<string, TodoTaskRow>();

  if (subTaskLinks.length > 0 && fs.existsSync(todoDbPath)) {
    let todoDb;
    try {
      todoDb = openReadonlyDb(todoDbPath);
      const placeholders = subTaskLinks.map(() => '?').join(',');
      const ids = subTaskLinks.map(s => s.todo_task_id);
      const rows = todoDb.prepare(
        `SELECT id, title, status, section FROM tasks WHERE id IN (${placeholders})`
      ).all(...ids) as TodoTaskRow[];
      for (const row of rows) {
        todoMap.set(row.id, row);
      }
    } catch { /* non-critical */ }
    finally {
      try { todoDb?.close(); } catch { /* best-effort */ }
    }
  }

  // Shared across Phase 3 and Phase 4
  const history = readHistory();

  // ── Phase 3: Monitor session ──────────────────────────────────────────
  const monitorAgentId = task.monitor_agent_id;
  let monitor: any = null;

  if (monitorAgentId) {
    const agentRecord = (history.agents ?? []).find((a: AgentRecord) => a.id === monitorAgentId);

    let sessionFile: string | null = null;
    if (agentRecord) {
      sessionFile = findSessionFile(agentRecord);
    } else {
      const sessionDir = getSessionDir(PROJECT_DIR);
      if (sessionDir) {
        sessionFile = findSessionFileByAgentId(sessionDir, monitorAgentId);
      }
    }

    let pidAlive = false;
    const monitorPid = task.monitor_pid;
    if (monitorPid) {
      try { process.kill(monitorPid, 0); pidAlive = true; } catch { pidAlive = false; }
    }

    let recentActivity: ActivityEntry[] | null = null;
    let monitorCompaction: CompactionContext | null = null;
    if (sessionFile) {
      try {
        const depthBytes = (args.depth_kb ?? 32) * 1024;
        const entries = parseTailEntries(readTailBytes(sessionFile, depthBytes).content);
        recentActivity = extractActivity(entries);

        // Auto-include compaction context for monitor sessions (deep inspection tool)
        if (detectCompactionInEntries(entries)) {
          monitorCompaction = mergeCompactionCounts(
            findCompactionContext(sessionFile, depthBytes, 6000),
            entries
          );
        }
      } catch { /* non-critical */ }
    }

    let progress: any = null;
    const progressFile = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress', `${monitorAgentId}.json`);
    const resolvedMonitorProgress = fs.existsSync(progressFile) ? progressFile : fs.existsSync(progressFile + '.retired') ? progressFile + '.retired' : null;
    try {
      if (resolvedMonitorProgress) {
        const raw = fs.readFileSync(resolvedMonitorProgress, 'utf8');
        const pf = JSON.parse(raw);
        const completedStages = ((pf.pipeline?.stages ?? []) as Array<{ name: string; status: string }>)
          .filter(s => s.status === 'completed')
          .map(s => s.name);
        const staleSince = pf.lastToolCall?.at
          ? Math.floor((Date.now() - new Date(pf.lastToolCall.at).getTime()) / 60000)
          : null;
        progress = {
          currentStage: pf.pipeline?.currentStage ?? null,
          progressPercent: pf.pipeline?.progressPercent ?? 0,
          stagesCompleted: completedStages,
          lastToolCall: pf.lastToolCall?.name ?? null,
          lastToolAt: pf.lastToolCall?.at ?? null,
          staleSinceMinutes: staleSince,
        };
      }
    } catch { /* non-critical */ }

    monitor = {
      agentId: monitorAgentId,
      pid: monitorPid ?? null,
      pidAlive,
      sessionFile: sessionFile ?? null,
      progress,
      recentActivity,
      compaction: monitorCompaction,
    };
  }

  // ── Phase 4: Child sessions ───────────────────────────────────────────
  const allAgents = history.agents ?? [];
  let childrenTotal = 0;
  let childrenRunning = 0;
  let childrenCompleted = 0;
  let childrenPending = 0;
  const childSessions: any[] = [];
  let excerptCount = 0;

  for (const link of subTaskLinks) {
    const todoTask = todoMap.get(link.todo_task_id);
    childrenTotal++;

    const tStatus = todoTask?.status ?? 'unknown';
    if (tStatus === 'in_progress') childrenRunning++;
    else if (tStatus === 'completed') childrenCompleted++;
    else if (tStatus === 'pending') childrenPending++;

    if (args.running_only && tStatus !== 'in_progress') continue;

    const childAgent = [...allAgents]
      .reverse()
      .find(a => (a.metadata as Record<string, unknown>)?.taskId === link.todo_task_id);

    if (!childAgent) {
      childSessions.push({
        todoTaskId: link.todo_task_id,
        title: todoTask?.title ?? null,
        status: tStatus,
        section: todoTask?.section ?? null,
        agentId: null,
        pid: null,
        pidAlive: false,
        elapsedSeconds: 0,
        progress: null,
        worktreeGit: null,
        recentActivity: null,
      });
      continue;
    }

    let pidAlive = false;
    if (childAgent.pid) {
      try { process.kill(childAgent.pid, 0); pidAlive = true; } catch { pidAlive = false; }
    }

    const elapsedMs = Date.now() - new Date(childAgent.timestamp).getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    let progress: any = null;
    const progressFile = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress', `${childAgent.id}.json`);
    const resolvedChildProgress = fs.existsSync(progressFile) ? progressFile : fs.existsSync(progressFile + '.retired') ? progressFile + '.retired' : null;
    try {
      if (resolvedChildProgress) {
        const raw = fs.readFileSync(resolvedChildProgress, 'utf8');
        const pf = JSON.parse(raw);
        const completedStages = ((pf.pipeline?.stages ?? []) as Array<{ name: string; status: string }>)
          .filter(s => s.status === 'completed')
          .map(s => s.name);
        const staleSince = pf.lastToolCall?.at
          ? Math.floor((Date.now() - new Date(pf.lastToolCall.at).getTime()) / 60000)
          : null;
        progress = {
          currentStage: pf.pipeline?.currentStage ?? null,
          progressPercent: pf.pipeline?.progressPercent ?? 0,
          stagesCompleted: completedStages,
          lastToolCall: pf.lastToolCall?.name ?? null,
          lastToolAt: pf.lastToolCall?.at ?? null,
          staleSinceMinutes: staleSince,
        };
      }
    } catch { /* non-critical */ }

    let worktreeGit: any = null;
    const worktreePath = (childAgent.metadata as Record<string, unknown>)?.worktreePath as string | undefined;
    if (worktreePath && fs.existsSync(worktreePath)) {
      try {
        const execOpts = { cwd: worktreePath, encoding: 'utf8' as const, timeout: 5000, stdio: 'pipe' as const };
        const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();

        let commitCount = 0;
        let lastCommitMessage: string | null = null;
        try {
          const baseRef = execSync(
            'git merge-base HEAD origin/preview 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1',
            execOpts
          ).trim();
          const commitLog = execSync(`git log --oneline ${baseRef}..HEAD`, execOpts).trim();
          const commits = commitLog ? commitLog.split('\n').filter(Boolean) : [];
          commitCount = commits.length;
          if (commitCount > 0) {
            lastCommitMessage = execSync('git log -1 --format=%s', execOpts).trim();
          }
        } catch { /* no commits or git error */ }

        let prUrl: string | null = null;
        let prStatus: string | null = null;
        let merged = false;
        if (pidAlive) {
          try {
            const prJson = execSync(
              `gh pr view ${branch} --json url,state,mergedAt 2>/dev/null || true`,
              { ...execOpts, timeout: 10000 }
            ).trim();
            if (prJson && prJson.startsWith('{')) {
              const pr = JSON.parse(prJson) as { url?: string; state?: string; mergedAt?: string | null };
              prUrl = pr.url ?? null;
              prStatus = (pr.state ?? '').toLowerCase() || null;
              merged = !!pr.mergedAt;
            }
          } catch { /* no PR or gh not available */ }
        }

        worktreeGit = { branch, commitCount, lastCommitMessage, prUrl, prStatus, merged };
      } catch { /* worktree git query failed — non-critical */ }
    }

    let recentActivity: ActivityEntry[] | null = null;
    let childCompacted = false;
    if (pidAlive && excerptCount < (args.max_children ?? 10)) {
      let sessionFile: string | null = null;
      sessionFile = findSessionFile(childAgent);
      if (sessionFile) {
        try {
          const childDepth = Math.floor(((args.depth_kb ?? 32) / 2) * 1024);
          const entries = parseTailEntries(readTailBytes(sessionFile, childDepth).content);
          recentActivity = extractActivity(entries);
          childCompacted = detectCompactionInEntries(entries);
          excerptCount++;
        } catch { /* non-critical */ }
      }
    }

    childSessions.push({
      todoTaskId: link.todo_task_id,
      title: todoTask?.title ?? null,
      status: tStatus,
      section: todoTask?.section ?? null,
      agentId: childAgent.id,
      pid: childAgent.pid ?? null,
      pidAlive,
      elapsedSeconds,
      progress,
      worktreeGit,
      recentActivity,
      compactionDetected: childCompacted,
    });
  }

  // ── Phase 4b: Enrich with daemon-generated summaries ─────────────────
  const saDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-activity.db');
  const daemonSummaryMap = new Map<string, string>();
  try {
    if (fs.existsSync(saDbPath)) {
      const saDb = openReadonlyDb(saDbPath);
      for (const cs of childSessions) {
        if (!cs.agentId) continue;
        const row = saDb.prepare(
          'SELECT summary FROM session_summaries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(cs.agentId) as { summary: string } | undefined;
        if (row?.summary) daemonSummaryMap.set(cs.agentId, row.summary);
      }
      saDb.close();
    }
  } catch { /* non-critical — session-activity.db may not exist or be locked */ }

  for (const cs of childSessions) {
    if (cs.agentId && daemonSummaryMap.has(cs.agentId)) {
      cs.daemonSummary = daemonSummaryMap.get(cs.agentId);
    }
  }

  // ── Phase 5: Plan context enrichment ──────────────────────────────────
  let metadata: Record<string, unknown> = {};
  try {
    if (task.metadata) metadata = JSON.parse(task.metadata);
  } catch { /* ignore */ }

  const planTaskId = (metadata.plan_task_id as string) ?? null;
  const planId = (metadata.plan_id as string) ?? null;
  const isPlanManager = !!(metadata.is_plan_manager);

  let planContext: any = null;
  if ((planTaskId || planId) || isPlanManager) {
    const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
    if (fs.existsSync(plansDbPath)) {
      let plansDb;
      try {
        plansDb = openReadonlyDb(plansDbPath);
        const effectivePlanId = planId ?? (planTaskId ? (plansDb.prepare('SELECT plan_id FROM plan_tasks WHERE id = ?').get(planTaskId) as any)?.plan_id : null);

        if (effectivePlanId) {
          const plan = plansDb.prepare('SELECT id, title, status FROM plans WHERE id = ?').get(effectivePlanId) as any;
          if (plan) {
            const allPlanTasks = plansDb.prepare(
              'SELECT pt.id, pt.title, pt.status, pt.persistent_task_id, pt.category_id, p.title as phase_title FROM plan_tasks pt JOIN phases p ON pt.phase_id = p.id WHERE pt.plan_id = ? ORDER BY p.phase_order, pt.task_order'
            ).all(effectivePlanId) as any[];

            const totalTasks = allPlanTasks.length;
            const completedTasks = allPlanTasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;

            // Find the current plan task's phase (if this is not a plan manager)
            let currentPhase: string | null = null;
            if (planTaskId) {
              const currentTask = allPlanTasks.find(t => t.id === planTaskId);
              currentPhase = currentTask?.phase_title ?? null;
            }

            // Get dependencies for the current plan task
            let dependencies: any[] = [];
            if (planTaskId) {
              dependencies = plansDb.prepare(
                `SELECT d.blocker_id, d.blocked_id, d.blocker_type, d.blocked_type,
                        CASE WHEN d.blocker_id = ? THEN 'blocks' ELSE 'blocked_by' END as relation,
                        CASE WHEN d.blocker_id = ? THEN pt2.title ELSE pt1.title END as related_title,
                        CASE WHEN d.blocker_id = ? THEN pt2.status ELSE pt1.status END as related_status
                 FROM dependencies d
                 LEFT JOIN plan_tasks pt1 ON d.blocker_id = pt1.id
                 LEFT JOIN plan_tasks pt2 ON d.blocked_id = pt2.id
                 WHERE d.blocker_id = ? OR d.blocked_id = ?`
              ).all(planTaskId, planTaskId, planTaskId, planTaskId, planTaskId) as any[];
            }

            planContext = {
              planId: effectivePlanId,
              planTitle: plan.title,
              planStatus: plan.status,
              progress: `${completedTasks}/${totalTasks}`,
              currentPhase,
              tasks: allPlanTasks.map(t => ({
                id: t.id,
                title: t.title,
                status: t.status,
                persistentTaskId: t.persistent_task_id ?? null,
                categoryId: t.category_id ?? null,
                phase: t.phase_title,
              })),
              dependencies: dependencies.map(d => ({
                relation: d.relation,
                relatedTitle: d.related_title,
                relatedStatus: d.related_status,
              })),
            };
          }
        }
      } catch { /* non-critical — plans.db may not exist or be incompatible */ }
      finally {
        try { plansDb?.close(); } catch { /* best-effort */ }
      }
    }
  }

  // ── Phase 5b: Enrich child sessions with category info ──────────────
  if (childSessions.length > 0 && fs.existsSync(todoDbPath)) {
    let todoDb2;
    try {
      todoDb2 = openReadonlyDb(todoDbPath);
      // Check if category columns exist
      let hasCategoryColumns = false;
      try {
        todoDb2.prepare('SELECT category_id FROM tasks LIMIT 0').get();
        hasCategoryColumns = true;
      } catch { /* column doesn't exist yet */ }

      if (hasCategoryColumns) {
        for (const cs of childSessions) {
          if (!cs.todoTaskId) continue;
          const row = todoDb2.prepare(
            'SELECT t.category_id, tc.name as category_name FROM tasks t LEFT JOIN task_categories tc ON t.category_id = tc.id WHERE t.id = ?'
          ).get(cs.todoTaskId) as { category_id: string | null; category_name: string | null } | undefined;
          if (row) {
            cs.categoryId = row.category_id ?? null;
            cs.categoryName = row.category_name ?? null;
          }
        }
      }
    } catch { /* non-critical */ }
    finally {
      try { todoDb2?.close(); } catch { /* best-effort */ }
    }
  }

  // ── Phase 6: Assemble response ──────────────────────────────────────
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    outcomeCriteria: task.outcome_criteria ?? null,
    lastHeartbeat: task.last_heartbeat ?? null,
    cycleCount: task.cycle_count ?? 0,
    activatedAt: task.activated_at ?? null,
    createdAt: task.created_at,
    demoInvolved: metadata.demo_involved ?? false,
    lastSummary: task.last_summary ?? null,

    // Plan linkage
    planTaskId,
    planId,
    isPlanManager,
    planContext,

    monitor,

    amendments: amendments.map(a => ({
      id: a.id,
      type: a.amendment_type,
      content: a.content,
      createdAt: a.created_at,
      createdBy: a.created_by,
      acknowledged: !!a.acknowledged_at,
    })),

    children: {
      total: childrenTotal,
      running: childrenRunning,
      completed: childrenCompleted,
      pending: childrenPending,
      sessions: childSessions,
    },

    recentEvents: recentEvents.map(e => ({
      type: e.event_type,
      details: e.details ?? null,
      createdAt: e.created_at,
    })),
  };
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all spawned agents
 */
function listAgents(args: ListSpawnedAgentsArgs): ListSpawnedAgentsResult {
  const history = readHistory();
  let agents = history.agents ?? [];

  // Apply filters
  if (args.type) {
    agents = agents.filter(a => a.type === args.type);
  }

  if (args.hookType) {
    agents = agents.filter(a => a.hookType === args.hookType);
  }

  if (args.since) {
    const sinceDate = new Date(args.since);
    agents = agents.filter(a => new Date(a.timestamp) >= sinceDate);
  }

  const limit = args.limit ?? 50;
  agents = agents.slice(0, limit);

  // Format for display
  const formatted: ListAgentItem[] = agents.map((a, index) => ({
    id: a.id,
    index,
    type: a.type,
    hookType: a.hookType,
    description: a.description,
    timestamp: a.timestamp,
    promptPreview: a.prompt
      ? a.prompt.substring(0, MAX_PROMPT_PREVIEW_LENGTH) +
        (a.prompt.length > MAX_PROMPT_PREVIEW_LENGTH ? '...' : '')
      : '[no prompt stored]',
    hasSession: Boolean(findSessionFile(a)),
    pid: a.pid,
    status: a.status,
    reapedAt: a.reapedAt,
    reapReason: a.reapReason,
  }));

  return {
    total: formatted.length,
    agents: formatted,
    availableTypes: Object.values(AGENT_TYPES),
  };
}

/**
 * Get full prompt for an agent
 */
function getAgentPrompt(args: GetAgentPromptArgs): GetAgentPromptResult | ErrorResult {
  const history = readHistory();
  const agent = history.agents.find(a => a.id === args.agentId);

  if (!agent) {
    return { error: `Agent not found: ${args.agentId}` };
  }

  return {
    id: agent.id,
    type: agent.type,
    hookType: agent.hookType,
    description: agent.description,
    timestamp: agent.timestamp,
    prompt: agent.prompt ?? '[no prompt stored]',
    promptLength: agent.prompt ? agent.prompt.length : 0,
    metadata: agent.metadata ?? {},
  };
}

/**
 * Get session transcript for an agent
 */
function getAgentSession(args: GetAgentSessionArgs): GetAgentSessionResult | ErrorResult {
  const history = readHistory();
  const agent = history.agents.find(a => a.id === args.agentId);

  if (!agent) {
    return { error: `Agent not found: ${args.agentId}` };
  }

  const sessionPath = findSessionFile(agent);

  if (!sessionPath) {
    return {
      id: agent.id,
      type: agent.type,
      description: agent.description,
      timestamp: agent.timestamp,
      session: null,
      sessionPath: null,
      message: 'No session file found. Session may have been cleaned up or not yet created.',
    };
  }

  const messages = readSessionFile(sessionPath);
  const formatted = formatSession(messages);

  // Limit messages if requested
  const limit = args.limit ?? 100;
  if (formatted.messages.length > limit) {
    formatted.messages = formatted.messages.slice(0, limit);
    formatted.truncated = true;
  }

  return {
    id: agent.id,
    type: agent.type,
    description: agent.description,
    timestamp: agent.timestamp,
    sessionPath,
    session: formatted,
  };
}

/**
 * Get statistics about spawned agents
 */
function getAgentStats(): AgentStats {
  const history = readHistory();
  const agents = history.agents ?? [];

  const stats: AgentStats = {
    totalSpawns: agents.length,
    byType: {},
    byHookType: {},
    last24Hours: 0,
    last7Days: 0,
    oldestSpawn: null,
    newestSpawn: null,
    byStatus: {},
    totalReaped: 0,
  };

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  for (const agent of agents) {
    // Count by type
    stats.byType[agent.type] = (stats.byType[agent.type] || 0) + 1;

    // Count by hook type
    stats.byHookType[agent.hookType] = (stats.byHookType[agent.hookType] || 0) + 1;

    // Count by status (running/completed/reaped)
    if (agent.status) {
      stats.byStatus[agent.status] = (stats.byStatus[agent.status] || 0) + 1;
      if (agent.status === 'reaped' || agent.reapReason) {
        stats.totalReaped++;
      }
    }

    // Time-based stats
    const spawnTime = new Date(agent.timestamp).getTime();
    if (now - spawnTime < day) {stats.last24Hours++;}
    if (now - spawnTime < 7 * day) {stats.last7Days++;}

    // Track oldest/newest
    if (!stats.oldestSpawn || spawnTime < new Date(stats.oldestSpawn).getTime()) {
      stats.oldestSpawn = agent.timestamp;
    }
    if (!stats.newestSpawn || spawnTime > new Date(stats.newestSpawn).getTime()) {
      stats.newestSpawn = agent.timestamp;
    }
  }

  return stats;
}

// ============================================================================
// Session Browser Tool Implementations
// ============================================================================

/**
 * List all sessions with optional hook metadata annotation
 */
function listSessions(args: ListSessionsArgs): ListSessionsResult {
  const history = readHistory();
  const agentHistory = history.agents ?? [];

  // Discover all sessions
  let sessions = discoverSessions();

  // Apply time filters - explicit 'since' overrides maxAgeDays
  if (args.since) {
    const sinceDate = new Date(args.since);
    sessions = sessions.filter(s => s.mtime >= sinceDate);
  } else if (args.maxAgeDays && args.maxAgeDays > 0) {
    // Default: only include sessions from last N days (performance optimization)
    const cutoffDate = new Date(Date.now() - args.maxAgeDays * 24 * 60 * 60 * 1000);
    sessions = sessions.filter(s => s.mtime >= cutoffDate);
  }

  if (args.before) {
    const beforeDate = new Date(args.before);
    sessions = sessions.filter(s => s.mtime <= beforeDate);
  }

  // Match sessions to hooks and build enriched list
  const enriched: Array<SessionFile & { hook_info?: HookInfo }> = sessions.map(s => ({
    ...s,
    hook_info: matchSessionToHook(s, agentHistory) ?? undefined,
  }));

  // Apply filter (all, hook-spawned, manual)
  let filtered = enriched;
  if (args.filter === 'hook-spawned') {
    filtered = enriched.filter(s => s.hook_info !== undefined);
  } else if (args.filter === 'manual') {
    filtered = enriched.filter(s => s.hook_info === undefined);
  }

  // Apply hookType filter if specified
  if (args.hookType) {
    filtered = filtered.filter(s => s.hook_info?.hook_type === args.hookType);
  }

  // Sort
  const sortBy = args.sortBy ?? 'newest';
  if (sortBy === 'newest') {
    filtered.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } else if (sortBy === 'oldest') {
    filtered.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  } else if (sortBy === 'largest') {
    filtered.sort((a, b) => b.size_bytes - a.size_bytes);
  }

  // Pagination
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const total = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  // Format result
  const sessionList: SessionListItem[] = paginated.map(s => ({
    session_id: s.session_id,
    file_path: s.file_path,
    mtime: s.mtime.toISOString(),
    size_bytes: s.size_bytes,
    hook_info: s.hook_info,
  }));

  return {
    total,
    sessions: sessionList,
    offset,
    limit,
    hasMore: offset + limit < total,
  };
}

/**
 * Search across session content
 */
function searchSessions(args: SearchSessionsArgs): SearchSessionsResult {
  const history = readHistory();
  const agentHistory = history.agents ?? [];
  const query = args.query.toLowerCase();
  const limit = args.limit ?? 20;

  // Discover and filter sessions
  let sessions = discoverSessions();

  // Apply time filters - explicit 'since' overrides maxAgeDays
  if (args.since) {
    const sinceDate = new Date(args.since);
    sessions = sessions.filter(s => s.mtime >= sinceDate);
  } else if (args.maxAgeDays && args.maxAgeDays > 0) {
    // Default: only search sessions from last N days (major performance optimization)
    const cutoffDate = new Date(Date.now() - args.maxAgeDays * 24 * 60 * 60 * 1000);
    sessions = sessions.filter(s => s.mtime >= cutoffDate);
  }

  // Match sessions to hooks
  const enriched: Array<SessionFile & { hook_info?: HookInfo }> = sessions.map(s => ({
    ...s,
    hook_info: matchSessionToHook(s, agentHistory) ?? undefined,
  }));

  // Apply filter
  let filtered = enriched;
  if (args.filter === 'hook-spawned') {
    filtered = enriched.filter(s => s.hook_info !== undefined);
  } else if (args.filter === 'manual') {
    filtered = enriched.filter(s => s.hook_info === undefined);
  }

  if (args.hookType) {
    filtered = filtered.filter(s => s.hook_info?.hook_type === args.hookType);
  }

  // Sort by newest first for search
  filtered.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const results: SearchResultItem[] = [];
  let totalMatches = 0;

  // Search through sessions
  for (const session of filtered) {
    if (results.length >= limit) {break;}

    const matches: SearchMatch[] = [];

    for (const { line, lineNum } of readSessionLines(session.file_path)) {
      if (line.toLowerCase().includes(query)) {
        try {
          const parsed = JSON.parse(line) as RawSessionMessage;
          const messageType = getMessageType(parsed);

          // Extract content for preview
          const content = (() => {
            if (typeof parsed.message?.content === 'string') {
              return parsed.message.content;
            }
            if (Array.isArray(parsed.message?.content)) {
              return parsed.message.content
                .filter((c): c is { type: string; text: string } => c.type === 'text')
                .map(c => c.text)
                .join(' ');
            }
            if (typeof parsed.content === 'string') {
              return parsed.content;
            }
            return '';
          })();

          // Find the match position and create preview
          const lowerContent = content.toLowerCase();
          const matchIndex = lowerContent.indexOf(query);
          const start = Math.max(0, matchIndex - 50);
          const end = Math.min(content.length, matchIndex + query.length + 50);
          const preview = (start > 0 ? '...' : '') +
            content.substring(start, end) +
            (end < content.length ? '...' : '');

          matches.push({
            line_number: lineNum,
            content_preview: preview || '[match in metadata]',
            message_type: messageType,
          });

          totalMatches++;

          // Limit matches per session for performance
          if (matches.length >= 10) {break;}
        } catch {
          // Skip unparseable lines
        }
      }
    }

    if (matches.length > 0) {
      results.push({
        session_id: session.session_id,
        file_path: session.file_path,
        mtime: session.mtime.toISOString(),
        matches,
        hook_info: session.hook_info,
      });
    }
  }

  return {
    query: args.query,
    total_sessions: results.length,
    total_matches: totalMatches,
    results,
  };
}

/**
 * Get detailed summary of a specific session
 */
function getSessionSummary(args: GetSessionSummaryArgs): SessionSummaryResult | ErrorResult {
  const history = readHistory();
  const agentHistory = history.agents ?? [];

  // Find the session file
  const sessions = discoverSessions();
  const session = sessions.find(s => s.session_id === args.session_id);

  if (!session) {
    return { error: `Session not found: ${args.session_id}` };
  }

  // Get hook info
  const hookInfo = matchSessionToHook(session, agentHistory) ?? undefined;

  // Parse session content
  const messages = readSessionFile(session.file_path);

  const messageCounts = {
    user: 0,
    assistant: 0,
    tool_result: 0,
    other: 0,
  };

  const toolsUsed = new Set<string>();
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let firstUserMessage: string | undefined;

  for (const msg of messages) {
    const msgType = getMessageType(msg);

    // Count message types
    if (msgType === 'user') {
      messageCounts.user++;

      // Capture first user message
      if (!firstUserMessage) {
        if (typeof msg.message?.content === 'string') {
          firstUserMessage = msg.message.content.substring(0, 200) +
            (msg.message.content.length > 200 ? '...' : '');
        } else if (typeof msg.content === 'string') {
          firstUserMessage = msg.content.substring(0, 200) +
            (msg.content.length > 200 ? '...' : '');
        }
      }
    } else if (msgType === 'assistant') {
      messageCounts.assistant++;

      // Extract tool calls
      if (Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) {
          if (c.type === 'tool_use' && typeof c.name === 'string') {
            toolsUsed.add(c.name);
          }
        }
      }
    } else if (msgType === 'tool_result') {
      messageCounts.tool_result++;
    } else {
      messageCounts.other++;
    }

    // Track timestamps
    if (msg.timestamp) {
      if (!firstTimestamp) {firstTimestamp = msg.timestamp;}
      lastTimestamp = msg.timestamp;
    }
  }

  // Calculate duration estimate
  let durationEstimate: string | undefined;
  if (firstTimestamp && lastTimestamp) {
    const first = new Date(firstTimestamp).getTime();
    const last = new Date(lastTimestamp).getTime();
    const durationMs = last - first;

    if (durationMs > 0) {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);

      if (minutes > 60) {
        const hours = Math.floor(minutes / 60);
        durationEstimate = `${hours}h ${minutes % 60}m`;
      } else if (minutes > 0) {
        durationEstimate = `${minutes}m ${seconds}s`;
      } else {
        durationEstimate = `${seconds}s`;
      }
    }
  }

  return {
    session_id: session.session_id,
    file_path: session.file_path,
    mtime: session.mtime.toISOString(),
    size_bytes: session.size_bytes,
    message_counts: messageCounts,
    tools_used: Array.from(toolsUsed).sort(),
    duration_estimate: durationEstimate,
    hook_info: hookInfo,
    first_user_message: firstUserMessage,
  };
}

// ============================================================================
// User Prompt Index
// ============================================================================

const USER_PROMPT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'user-prompts.db');
let _userPromptDb: Database.Database | null = null;
let _lastIndexCheck = 0;
const INDEX_CACHE_MS = 30_000; // 30-second in-process cache

function initUserPromptDb(): Database.Database {
  if (_userPromptDb) return _userPromptDb;

  const dbDir = path.dirname(USER_PROMPT_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(USER_PROMPT_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      uuid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_up_session ON user_prompts(session_id);
    CREATE INDEX IF NOT EXISTS idx_up_timestamp ON user_prompts(timestamp);

    CREATE TABLE IF NOT EXISTS indexed_sessions (
      session_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
  `);

  // Create FTS5 virtual table if not exists
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
        uuid UNINDEXED,
        content,
        content=user_prompts,
        content_rowid=rowid
      );
    `);
  } catch {
    // FTS5 may not be available on all SQLite builds
  }

  // Create triggers for FTS sync (idempotent via IF NOT EXISTS on table, triggers may already exist)
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, uuid, content) VALUES (new.rowid, new.uuid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, uuid, content) VALUES ('delete', old.rowid, old.uuid, old.content);
      END;
    `);
  } catch {
    // Triggers may already exist or FTS not available
  }

  _userPromptDb = db;
  return db;
}

/**
 * Extract user prompt content from a parsed JSONL message entry
 */
function extractUserContent(entry: RawSessionMessage): string | null {
  if (entry.type !== 'human' && entry.type !== 'user') return null;

  const msg = entry.message;
  if (!msg) return null;

  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const texts = msg.content
      .filter((block: { type: string; text?: string }) => block.type === 'text' && block.text)
      .map((block: { type: string; text?: string }) => block.text!);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/**
 * Generate a deterministic UUID from session_id + line_number
 */
function promptUuid(sessionId: string, lineNumber: number): string {
  // Use a simple hash-based approach for deterministic UUIDs
  const input = `${sessionId}:${lineNumber}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `up-${sessionId.substring(0, 8)}-${hex}-${lineNumber}`;
}

/**
 * Ensure the user prompt index is up to date.
 * Discovers sessions, diffs mtime against indexed_sessions, re-indexes new/changed only.
 */
function ensureIndex(): void {
  const now = Date.now();
  if (now - _lastIndexCheck < INDEX_CACHE_MS) return;
  _lastIndexCheck = now;

  const db = initUserPromptDb();
  const sessionDir = getSessionDir(PROJECT_DIR);
  if (!sessionDir) return;

  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return;
  }

  const getIndexed = db.prepare('SELECT mtime_ms FROM indexed_sessions WHERE session_id = ?');
  const upsertSession = db.prepare(
    'INSERT OR REPLACE INTO indexed_sessions (session_id, file_path, mtime_ms, indexed_at) VALUES (?, ?, ?, ?)'
  );
  const insertPrompt = db.prepare(
    'INSERT OR IGNORE INTO user_prompts (uuid, session_id, timestamp, content, line_number, indexed_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const deleteSessionPrompts = db.prepare('DELETE FROM user_prompts WHERE session_id = ?');

  const indexTransaction = db.transaction(() => {
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const sessionId = file.replace('.jsonl', '');

      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      const indexed = getIndexed.get(sessionId) as { mtime_ms: number } | undefined;
      if (indexed && indexed.mtime_ms >= mtimeMs) continue;

      // Re-index this session
      deleteSessionPrompts.run(sessionId);

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const indexedAt = new Date().toISOString();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        let parsed: RawSessionMessage;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const userContent = extractUserContent(parsed);
        if (!userContent) continue;

        const lineNumber = i + 1;
        const uuid = promptUuid(sessionId, lineNumber);
        const timestamp = parsed.timestamp || indexedAt;

        insertPrompt.run(uuid, sessionId, timestamp, userContent, lineNumber, indexedAt);
      }

      upsertSession.run(sessionId, filePath, mtimeMs, indexedAt);
    }
  });

  try {
    indexTransaction();
  } catch (err) {
    process.stderr.write(`[agent-tracker] User prompt indexing error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Get a user prompt by UUID, optionally with nearby messages for context
 */
function getUserPrompt(args: import('./types.js').GetUserPromptArgs): import('./types.js').UserPromptResult | import('./types.js').ErrorResult {
  ensureIndex();
  const db = initUserPromptDb();

  const prompt = db.prepare('SELECT * FROM user_prompts WHERE uuid = ?').get(args.uuid) as {
    uuid: string; session_id: string; timestamp: string; content: string; line_number: number;
  } | undefined;

  if (!prompt) {
    return { error: `User prompt not found: ${args.uuid}` };
  }

  const result: import('./types.js').UserPromptResult = {
    uuid: prompt.uuid,
    session_id: prompt.session_id,
    timestamp: prompt.timestamp,
    content: prompt.content,
  };

  // Fetch nearby messages from raw JSONL if requested
  if (args.nearby && args.nearby > 0) {
    const indexed = db.prepare('SELECT file_path FROM indexed_sessions WHERE session_id = ?')
      .get(prompt.session_id) as { file_path: string } | undefined;

    if (indexed && fs.existsSync(indexed.file_path)) {
      try {
        const content = fs.readFileSync(indexed.file_path, 'utf8');
        const lines = content.split('\n');
        const lineIdx = prompt.line_number - 1;
        const start = Math.max(0, lineIdx - args.nearby);
        const end = Math.min(lines.length - 1, lineIdx + args.nearby);
        const nearby: Array<{ type: string; content: string; timestamp: string | null }> = [];

        for (let i = start; i <= end; i++) {
          if (i === lineIdx) continue; // Skip the prompt itself
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as RawSessionMessage;
            const msgType = getMessageType(parsed);
            let msgContent = '';
            if (typeof parsed.message?.content === 'string') {
              msgContent = parsed.message.content.substring(0, 500);
            } else if (Array.isArray(parsed.message?.content)) {
              const texts = parsed.message!.content
                .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                .map((b: { type: string; text?: string }) => b.text!);
              msgContent = texts.join('\n').substring(0, 500);
            }
            nearby.push({ type: msgType, content: msgContent, timestamp: parsed.timestamp ?? null });
          } catch {
            // skip unparseable
          }
        }

        result.nearby_messages = nearby;
      } catch {
        // Non-critical: skip nearby messages
      }
    }
  }

  return result;
}

/**
 * Search user prompts using FTS5 or LIKE fallback
 */
function searchUserPrompts(args: import('./types.js').SearchUserPromptsArgs): import('./types.js').SearchUserPromptsResult {
  ensureIndex();
  const db = initUserPromptDb();

  let timeFilter = '';
  const params: unknown[] = [];

  if (args.since) {
    timeFilter = ' AND up.timestamp >= ?';
    params.push(args.since);
  } else if (args.maxAgeDays) {
    const cutoff = new Date(Date.now() - args.maxAgeDays * 86400000).toISOString();
    timeFilter = ' AND up.timestamp >= ?';
    params.push(cutoff);
  }

  const limit = args.limit ?? 20;
  let results: Array<{ uuid: string; session_id: string; timestamp: string; content: string; rank?: number }>;

  if (args.use_fts !== false) {
    // FTS5 ranked search
    try {
      // Wrap in double quotes to force FTS5 literal phrase search, neutralizing operators
      const ftsQuery = '"' + args.query.replace(/"/g, '') + '"';
      results = db.prepare(`
        SELECT up.uuid, up.session_id, up.timestamp, up.content, rank
        FROM user_prompts_fts fts
        JOIN user_prompts up ON up.rowid = fts.rowid
        WHERE user_prompts_fts MATCH ?${timeFilter}
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, ...params, limit) as typeof results;
    } catch {
      // FTS5 not available or query error, fall back to LIKE
      results = db.prepare(`
        SELECT uuid, session_id, timestamp, content
        FROM user_prompts up
        WHERE content LIKE ?${timeFilter}
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(`%${args.query}%`, ...params, limit) as typeof results;
    }
  } else {
    // LIKE fallback
    results = db.prepare(`
      SELECT uuid, session_id, timestamp, content
      FROM user_prompts up
      WHERE content LIKE ?${timeFilter}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`%${args.query}%`, ...params, limit) as typeof results;
  }

  return {
    query: args.query,
    total: results.length,
    results: results.map(r => ({
      uuid: r.uuid,
      session_id: r.session_id,
      timestamp: r.timestamp,
      content_preview: r.content.substring(0, 200),
      rank: r.rank,
    })),
  };
}

/**
 * List recent user prompts, optionally filtered by session
 */
function listUserPrompts(args: import('./types.js').ListUserPromptsArgs): import('./types.js').ListUserPromptsResult {
  ensureIndex();
  const db = initUserPromptDb();

  let whereClause = '';
  const params: unknown[] = [];

  if (args.session_id) {
    whereClause = ' WHERE session_id = ?';
    params.push(args.session_id);
  } else if (args.maxAgeDays) {
    const cutoff = new Date(Date.now() - args.maxAgeDays * 86400000).toISOString();
    whereClause = ' WHERE timestamp >= ?';
    params.push(cutoff);
  }

  const limit = args.limit ?? 50;
  const rows = db.prepare(`
    SELECT uuid, session_id, timestamp, content
    FROM user_prompts${whereClause}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...params, limit) as Array<{ uuid: string; session_id: string; timestamp: string; content: string }>;

  return {
    total: rows.length,
    prompts: rows.map(r => ({
      uuid: r.uuid,
      session_id: r.session_id,
      timestamp: r.timestamp,
      content_preview: r.content.substring(0, 200),
    })),
  };
}

// ============================================================================
// Concurrency & Force-Spawn Tool Implementations
// ============================================================================

/**
 * Get real-time concurrency status: running agents, max allowed, available slots
 */
function getConcurrencyStatus(_args: GetConcurrencyStatusArgs): ConcurrencyStatusResult {
  // Count running agents via pgrep (same pattern as force-spawn-tasks.js)
  let running = 0;
  try {
    const result = execSync(
      "pgrep -f 'claude.*--dangerously-skip-permissions' 2>/dev/null | wc -l",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    running = parseInt(result, 10) || 0;
  } catch {
    // pgrep returns exit code 1 when no processes match
  }

  // Read max concurrent from automation-config.json
  let maxConcurrent = 10;
  const automationConfigPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
  try {
    const config = JSON.parse(fs.readFileSync(automationConfigPath, 'utf8'));
    if (config?.effective?.MAX_CONCURRENT_AGENTS) {
      maxConcurrent = config.effective.MAX_CONCURRENT_AGENTS;
    }
  } catch {
    // Fall back to default
  }

  // Read agent-tracker-history.json, count agents with status === 'running' by type
  const history = readHistory();
  const trackedByType: Record<string, number> = {};
  for (const agent of history.agents ?? []) {
    if (agent.status === 'running') {
      trackedByType[agent.type] = (trackedByType[agent.type] || 0) + 1;
    }
  }

  return {
    running,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - running),
    trackedRunning: { byType: trackedByType },
  };
}

/**
 * Force-spawn pending tasks by wrapping the existing force-spawn-tasks.js script
 */
function forceSpawnTasks(args: ForceSpawnTasksArgs): ForceSpawnTasksResult | ErrorResult {
  // Derive framework path from import.meta.url
  // Compiled path: <framework>/packages/mcp-servers/dist/agent-tracker/server.js
  // Navigate up 4 levels to reach framework root
  const thisFile = fileURLToPath(import.meta.url);
  const frameworkRoot = path.resolve(path.dirname(thisFile), '..', '..', '..', '..');
  const scriptPath = path.join(frameworkRoot, 'scripts', 'force-spawn-tasks.js');

  if (!fs.existsSync(scriptPath)) {
    return { error: `force-spawn-tasks.js not found at ${scriptPath}. Framework root resolved to: ${frameworkRoot}` };
  }

  try {
    const scriptArgs = [scriptPath, '--project-dir', PROJECT_DIR];
    if (args.taskIds) {
      scriptArgs.push('--task-ids', args.taskIds.join(','));
    } else if (args.category_ids) {
      scriptArgs.push('--category-ids', args.category_ids.join(','));
    } else if (args.sections) {
      scriptArgs.push('--sections', args.sections.join(','));
    }
    const output = execFileSync('node', scriptArgs, {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });

    return JSON.parse(output.trim()) as ForceSpawnTasksResult;
  } catch (err: unknown) {
    // Attempt to parse stdout from the error (script may have written partial results)
    const execErr = err as { stdout?: string; message?: string };
    if (execErr.stdout) {
      try {
        return JSON.parse(execErr.stdout.trim()) as ForceSpawnTasksResult;
      } catch {
        // Fall through to error return
      }
    }
    return { error: `force-spawn-tasks.js failed: ${execErr.message ?? String(err)}` };
  }
}

function forceTriageReports(): ForceTriageReportsResult | ErrorResult {
  // G011: Check for already-running triage agent before spawning (defense-in-depth dedup)
  const triageHistory = readHistory();
  const existingTriage = (triageHistory.agents ?? []).find(
    (a) => a.type === AGENT_TYPES.DEPUTY_CTO_REVIEW && a.status === 'running'
  );
  if (existingTriage) {
    return {
      agentId: existingTriage.id,
      pid: existingTriage.pid ?? null,
      sessionId: null,
      pendingReports: 0,
      message: `Triage agent already running (${existingTriage.id}). Skipping duplicate spawn.`,
      deduplicated: true,
    };
  }

  const thisFile = fileURLToPath(import.meta.url);
  const frameworkRoot = path.resolve(path.dirname(thisFile), '..', '..', '..', '..');
  const scriptPath = path.join(frameworkRoot, 'scripts', 'force-triage-reports.js');

  if (!fs.existsSync(scriptPath)) {
    return { error: `force-triage-reports.js not found at ${scriptPath}. Framework root resolved to: ${frameworkRoot}` };
  }

  try {
    const output = execFileSync('node', [
      scriptPath,
      '--project-dir', PROJECT_DIR,
    ], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });

    return JSON.parse(output.trim()) as ForceTriageReportsResult;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; message?: string };
    if (execErr.stdout) {
      try {
        return JSON.parse(execErr.stdout.trim()) as ForceTriageReportsResult;
      } catch {
        // Fall through to error return
      }
    }
    return { error: `force-triage-reports.js failed: ${execErr.message ?? String(err)}` };
  }
}

/**
 * Monitor specific agents by ID - lightweight polling for status
 */
function monitorAgents(args: MonitorAgentsArgs): MonitorAgentsResult {
  const history = readHistory();
  const agents = history.agents ?? [];
  const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  const todoDbExists = fs.existsSync(todoDbPath);

  const results: MonitorAgentsResult['agents'] = [];
  let completedCount = 0;

  for (const agentId of args.agentIds) {
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      results.push({
        agentId,
        status: 'unknown',
        pid: null,
        pidAlive: false,
        taskId: null,
        taskStatus: null,
        taskTitle: null,
        elapsedSeconds: 0,
        section: null,
        progress: null,
        worktreeGit: null,
      });
      completedCount++; // Unknown agents count as complete for polling purposes
      continue;
    }

    // Check PID liveness
    let pidAlive = false;
    if (agent.pid) {
      try {
        process.kill(agent.pid, 0);
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
    }

    // Determine status - if agent is marked running but PID is gone, treat as completed
    let status: 'running' | 'completed' | 'reaped' | 'unknown' = agent.status ?? 'unknown';
    if (status === 'running' && !pidAlive) {
      status = 'completed';
    }

    // Get task info from metadata
    const taskId = (agent.metadata?.taskId as string) ?? null;
    const section = (agent.metadata?.section as string) ?? null;
    let taskStatus: string | null = null;
    let taskTitle: string | null = null;

    // Query todo.db for task status using better-sqlite3 (parameterized)
    if (taskId && todoDbExists) {
      try {
        const db = openReadonlyDb(todoDbPath);
        const row = db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId) as { status: string; title: string } | undefined;
        db.close();
        if (row) {
          taskStatus = row.status;
          taskTitle = row.title;
        }
      } catch {
        taskTitle = agent.description?.replace(/^Force-spawn: \w+ - /, '') ?? null;
      }
    } else if (!taskTitle) {
      taskTitle = agent.description ?? null;
    }

    // Calculate elapsed time from spawn timestamp
    const elapsedMs = Date.now() - new Date(agent.timestamp).getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    // Read agent progress file
    let progress: AgentProgress | null = null;
    const progressFile = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress', `${agentId}.json`);
    const resolvedAgentProgress = fs.existsSync(progressFile) ? progressFile : fs.existsSync(progressFile + '.retired') ? progressFile + '.retired' : null;
    try {
      if (resolvedAgentProgress) {
        const raw = fs.readFileSync(resolvedAgentProgress, 'utf8');
        const pf = JSON.parse(raw);
        const completedStages = ((pf.pipeline?.stages ?? []) as Array<{ name: string; status: string }>)
          .filter(s => s.status === 'completed')
          .map(s => s.name);
        const staleSince = pf.lastToolCall?.at
          ? Math.floor((Date.now() - new Date(pf.lastToolCall.at).getTime()) / 60000)
          : null;
        progress = {
          currentStage: pf.pipeline?.currentStage ?? null,
          stageIndex: pf.pipeline?.currentStageIndex ?? -1,
          totalStages: pf.pipeline?.totalStages ?? 0,
          progressPercent: pf.pipeline?.progressPercent ?? 0,
          stagesCompleted: completedStages,
          lastToolCall: pf.lastToolCall?.name ?? null,
          lastToolAt: pf.lastToolCall?.at ?? null,
          staleSinceMinutes: staleSince,
        };
      }
    } catch { /* non-critical — progress file may not exist */ }

    // Query worktree git state
    let worktreeGit: WorktreeGitState | null = null;
    const worktreePath = (agent.metadata as Record<string, unknown>)?.worktreePath as string | undefined;
    if (worktreePath && fs.existsSync(worktreePath)) {
      try {
        const execOpts = { cwd: worktreePath, encoding: 'utf8' as const, timeout: 5000, stdio: 'pipe' as const };

        // Branch name
        const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();

        // Commits since branch point
        let commitCount = 0;
        let lastCommitMessage: string | null = null;
        try {
          const baseRef = execSync(
            'git merge-base HEAD origin/preview 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1',
            execOpts
          ).trim();
          const commitLog = execSync(`git log --oneline ${baseRef}..HEAD`, execOpts).trim();
          const commits = commitLog ? commitLog.split('\n').filter(Boolean) : [];
          commitCount = commits.length;
          if (commitCount > 0) {
            lastCommitMessage = execSync('git log -1 --format=%s', execOpts).trim();
          }
        } catch { /* no commits or git error */ }

        // PR status (non-fatal, 10s timeout)
        let prUrl: string | null = null;
        let prStatus: string | null = null;
        let merged = false;
        try {
          const prJson = execSync(
            `gh pr view ${branch} --json url,state,mergedAt 2>/dev/null || true`,
            { ...execOpts, timeout: 10000 }
          ).trim();
          if (prJson && prJson.startsWith('{')) {
            const pr = JSON.parse(prJson) as { url?: string; state?: string; mergedAt?: string | null };
            prUrl = pr.url ?? null;
            prStatus = (pr.state ?? '').toLowerCase() || null;
            merged = !!pr.mergedAt;
          }
        } catch { /* no PR or gh not available */ }

        worktreeGit = { branch, commitCount, lastCommitMessage, prUrl, prStatus, merged };
      } catch { /* worktree git query failed — non-critical */ }
    }

    if (status !== 'running') {
      completedCount++;
    }

    results.push({
      agentId,
      status,
      pid: agent.pid ?? null,
      pidAlive,
      taskId,
      taskStatus,
      taskTitle: taskTitle || agent.description || null,
      elapsedSeconds,
      section,
      progress,
      worktreeGit,
    });
  }

  const total = args.agentIds.length;
  const allComplete = completedCount >= total;
  const runningCount = total - completedCount;

  // Build per-agent detail lines for summary
  const agentDetailLines: string[] = [];
  for (const r of results) {
    const parts: string[] = [`${r.agentId.slice(0, 8)}: ${r.status}`];
    if (r.progress) {
      parts.push(`stage: ${r.progress.currentStage ?? 'done'} (${r.progress.progressPercent}%)`);
    }
    if (r.worktreeGit && r.worktreeGit.commitCount > 0) {
      parts.push(`${r.worktreeGit.commitCount} commit(s)${r.worktreeGit.merged ? ', PR merged' : ''}`);
    }
    agentDetailLines.push(parts.join(', '));
  }

  const statusLine = allComplete
    ? `All ${total} agent(s) complete`
    : `${completedCount}/${total} complete (${runningCount} still running)`;
  const summary = agentDetailLines.length > 0
    ? `${statusLine} | ${agentDetailLines.join(' | ')}`
    : statusLine;

  return { agents: results, allComplete, summary };
}

// ============================================================================
// Session Queue Tool Implementations
// ============================================================================

const QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');

interface QueueItemRow {
  id: string;
  status: string;
  priority: string;
  lane: string;
  title: string;
  agent_type: string;
  source: string;
  pid: number | null;
  enqueued_at: string;
  spawned_at: string | null;
  completed_at: string | null;
}

interface QueueConfigRow {
  value: string;
}

interface QueueCountRow {
  cnt: number;
}

interface QueueAvgRow {
  avg_secs: number | null;
}

interface QueueSourceRow {
  source: string;
  cnt: number;
}

function formatQueueElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ''}`;
}

function isQueuePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get full session queue status: running items, queued items, capacity, 24h stats.
 */
async function getSessionQueueStatus(_args: GetSessionQueueStatusArgs): Promise<object | ErrorResult> {
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { hasData: false, message: 'Session queue database not found. Queue may not be initialized yet.' };
  }

  let db;
  try {
    db = openReadonlyDb(QUEUE_DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open session queue database: ${message}` };
  }

  try {
    const now = Date.now();

    // Get config
    const configRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('max_concurrent_sessions') as QueueConfigRow | undefined;
    const maxConcurrent = configRow ? parseInt(configRow.value, 10) : 10;

    const reservedRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots') as QueueConfigRow | undefined;
    const reservedSlots = reservedRow ? parseInt(reservedRow.value, 10) : 0;

    const reservedRestoreRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots_restore') as QueueConfigRow | undefined;
    let reservedSlotsRestore: { restoreAt: string; defaultValue: number } | null = null;
    if (reservedRestoreRow) {
      try { reservedSlotsRestore = JSON.parse(reservedRestoreRow.value); } catch { /* non-fatal */ }
    }

    // Get running items, filter to alive PIDs
    const runningRows = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all() as QueueItemRow[];
    const aliveRunning = runningRows.filter(r => r.pid && isQueuePidAlive(r.pid));

    // Get queued items
    const queuedRows = db.prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY enqueued_at ASC").all() as QueueItemRow[];

    // 24h stats
    const completed24h = (db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status IN ('completed', 'failed') AND completed_at > datetime('now', '-24 hours')").get() as QueueCountRow).cnt;
    const avgWait = db.prepare("SELECT AVG(CAST((julianday(spawned_at) - julianday(enqueued_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE spawned_at IS NOT NULL AND enqueued_at IS NOT NULL AND spawned_at > datetime('now', '-24 hours')").get() as QueueAvgRow;
    const avgRun = db.prepare("SELECT AVG(CAST((julianday(completed_at) - julianday(spawned_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE completed_at IS NOT NULL AND spawned_at IS NOT NULL AND completed_at > datetime('now', '-24 hours')").get() as QueueAvgRow;
    const bySourceRows = db.prepare("SELECT source, COUNT(*) as cnt FROM queue_items WHERE enqueued_at > datetime('now', '-24 hours') GROUP BY source ORDER BY cnt DESC LIMIT 10").all() as QueueSourceRow[];

    // Check memory pressure (best-effort — module may not be available)
    let memoryPressure: { pressure: string; freeMB: number } | null = null;
    try {
      const memModule = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'memory-pressure.js'));
      const mem = memModule.getMemoryPressure();
      memoryPressure = { pressure: mem.pressure, freeMB: mem.freeMB };
    } catch { /* non-fatal — module may not exist */ }

    // Separate running counts: automated sessions don't consume standard slots
    const automatedRunning = aliveRunning.filter(r => r.lane === 'automated').length;
    const standardRunning = aliveRunning.filter(r => !['gate', 'persistent', 'audit', 'automated'].includes(r.lane ?? '')).length;

    return {
      hasData: true,
      maxConcurrent,
      reservedSlots,
      reservedSlotsRestore,
      running: aliveRunning.length,
      standardRunning,
      automatedRunning,
      availableSlots: Math.max(0, maxConcurrent - standardRunning),
      memoryPressure,
      queuedItems: queuedRows.map(item => ({
        id: item.id,
        title: item.title,
        priority: item.priority,
        lane: item.lane,
        source: item.source,
        waitTime: formatQueueElapsed(now - new Date(item.enqueued_at).getTime()),
      })),
      runningItems: aliveRunning.map(item => ({
        id: item.id,
        title: item.title,
        source: item.source,
        agentType: item.agent_type,
        pid: item.pid,
        elapsed: item.spawned_at ? formatQueueElapsed(now - new Date(item.spawned_at).getTime()) : 'unknown',
      })),
      stats: {
        completedLast24h: completed24h,
        avgWaitSeconds: Math.round(avgWait?.avg_secs ?? 0),
        avgRunSeconds: Math.round(avgRun?.avg_secs ?? 0),
        bySource: Object.fromEntries(bySourceRows.map(r => [r.source, r.cnt])),
      },
    };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

/**
 * Update the max concurrent sessions limit in the queue config.
 */
function setMaxConcurrentSessions(args: SetMaxConcurrentSessionsArgs): object | ErrorResult {
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { error: 'Session queue database not found. Queue may not be initialized yet.' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(QUEUE_DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open session queue database: ${message}` };
  }

  try {
    const configRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('max_concurrent_sessions') as QueueConfigRow | undefined;
    const oldMax = configRow ? parseInt(configRow.value, 10) : 10;
    const newMax = args.max;

    db.prepare("INSERT OR REPLACE INTO queue_config (key, value, updated_at) VALUES (?, ?, datetime('now'))").run('max_concurrent_sessions', String(newMax));

    return { success: true, old: oldMax, new: newMax };
  } finally {
    try { db!.close(); } catch { /* best-effort */ }
  }
}

/**
 * Cancel a queued (not yet running) session queue item.
 */
function cancelQueuedSession(args: CancelQueuedSessionArgs): object | ErrorResult {
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { error: 'Session queue database not found. Queue may not be initialized yet.' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(QUEUE_DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open session queue database: ${message}` };
  }

  try {
    const item = db.prepare('SELECT id, status, title FROM queue_items WHERE id = ?').get(args.queue_id) as { id: string; status: string; title: string } | undefined;
    if (!item) {
      return { success: false, reason: `Queue item not found: ${args.queue_id}` };
    }
    if (item.status !== 'queued') {
      return { success: false, reason: `Cannot cancel item with status '${item.status}' — only 'queued' items can be cancelled` };
    }

    db.prepare("UPDATE queue_items SET status = 'cancelled', completed_at = datetime('now'), error = 'manually cancelled' WHERE id = ?").run(args.queue_id);

    return { success: true, id: args.queue_id, title: item.title };
  } finally {
    try { db!.close(); } catch { /* best-effort */ }
  }
}

/**
 * Drain the session queue: attempt to spawn queued items up to capacity.
 * Dynamically imports the session-queue.js module to use the live drainQueue function.
 */
async function drainSessionQueue(_args: DrainSessionQueueArgs): Promise<object | ErrorResult> {
  const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');

  if (!fs.existsSync(queueModulePath)) {
    return { error: `session-queue.js not found at ${queueModulePath}` };
  }

  try {
    const queueModule = await import(queueModulePath);
    const result = queueModule.drainQueue();
    return { success: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to drain session queue: ${message}` };
  }
}

/**
 * Instantly activate a queued session by promoting it to CTO priority.
 * Uses the inline preemption in drainQueue() to suspend a lower-priority
 * running session if at capacity.
 */
async function activateQueuedSession(args: ActivateQueuedSessionArgs): Promise<object | ErrorResult> {
  const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');

  if (!fs.existsSync(queueModulePath)) {
    return { error: `session-queue.js not found at ${queueModulePath}` };
  }

  try {
    const queueModule = await import(queueModulePath);
    if (typeof queueModule.activateQueuedItem !== 'function') {
      return { error: 'activateQueuedItem function not found in session-queue.js' };
    }
    const result = queueModule.activateQueuedItem(args.queue_id);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to activate queued session: ${message}` };
  }
}

/**
 * Set the number of reserved slots for priority-eligible tasks (persistent/CTO/critical).
 * Dynamically imports session-queue.js so the live module is used.
 */
async function setReservedSlots(args: SetReservedSlotsArgs): Promise<object | ErrorResult> {
  const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');

  if (!fs.existsSync(queueModulePath)) {
    return { error: `session-queue.js not found at ${queueModulePath}` };
  }

  try {
    const queueModule = await import(queueModulePath);
    if (typeof queueModule.setReservedSlots !== 'function') {
      return { error: 'setReservedSlots function not found in session-queue.js' };
    }
    const opts: { autoRestoreMinutes?: number; defaultValue?: number } = {};
    if (args.auto_restore_minutes && args.auto_restore_minutes > 0) {
      opts.autoRestoreMinutes = args.auto_restore_minutes;
      opts.defaultValue = args.default_value ?? 0;
    }
    const result = queueModule.setReservedSlots(args.count, opts);
    return {
      success: true,
      old: result.old,
      new: result.new,
      autoRestore: opts.autoRestoreMinutes
        ? { restoreAt: new Date(Date.now() + opts.autoRestoreMinutes * 60000).toISOString(), defaultValue: opts.defaultValue }
        : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to set reserved slots: ${message}` };
  }
}

/**
 * Get the current reserved slots configuration.
 * Dynamically imports session-queue.js so the live module is used.
 */
async function getReservedSlots(_args: GetReservedSlotsArgs): Promise<object | ErrorResult> {
  const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');

  if (!fs.existsSync(queueModulePath)) {
    return { error: `session-queue.js not found at ${queueModulePath}` };
  }

  try {
    const queueModule = await import(queueModulePath);
    if (typeof queueModule.getReservedSlots !== 'function') {
      return { error: 'getReservedSlots function not found in session-queue.js' };
    }
    const count = queueModule.getReservedSlots();

    // Also read the restore schedule if present
    let restoreSchedule = null;
    if (fs.existsSync(QUEUE_DB_PATH)) {
      try {
        const db = openReadonlyDb(QUEUE_DB_PATH);
        const row = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots_restore') as QueueConfigRow | undefined;
        db.close();
        if (row) {
          try { restoreSchedule = JSON.parse(row.value); } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    }

    return {
      count,
      restoreSchedule,
      description: count === 0
        ? 'No slots reserved — all concurrency slots available to any task'
        : `${count} slot(s) reserved for priority-eligible tasks (cto/critical priority, persistent lane, or persistentTaskId children)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get reserved slots: ${message}` };
  }
}

// ============================================================================
// Automation Rate Tool Implementations (replaces Focus Mode)
// ============================================================================

const RATE_DESCRIPTIONS: Record<string, string> = {
  none: 'No automated agents spawn. Only CTO-directed tasks, persistent monitors, and revivals are allowed.',
  low: 'Automations run at very slow rates (5x slower than baseline). This is the DEFAULT.',
  medium: 'Automations run at moderate rates (2x slower than baseline).',
  high: 'Automations run at baseline rates (current/original speeds).',
};

/**
 * Set the automation rate level.
 * Dynamically imports config-reader.js so the live module is used.
 */
async function setAutomationRateHandler(args: SetAutomationRateArgs): Promise<object | ErrorResult> {
  const configReaderPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'config-reader.js');

  if (!fs.existsSync(configReaderPath)) {
    return { error: `config-reader.js not found at ${configReaderPath}` };
  }

  try {
    const configModule = await import(configReaderPath);
    if (typeof configModule.setAutomationRate !== 'function') {
      return { error: 'setAutomationRate function not found in config-reader.js' };
    }
    const state = configModule.setAutomationRate(args.rate, 'mcp-tool');
    return {
      success: true,
      rate: state.rate,
      set_at: state.set_at,
      set_by: state.set_by,
      description: RATE_DESCRIPTIONS[state.rate] ?? 'Unknown rate level.',
      message: `Automation rate set to '${state.rate}'. ${RATE_DESCRIPTIONS[state.rate] ?? ''}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to set automation rate: ${message}` };
  }
}

/**
 * Get the current automation rate state.
 * Dynamically imports config-reader.js so the live module is used.
 */
async function getAutomationRateHandler(_args: GetAutomationRateArgs): Promise<object | ErrorResult> {
  const configReaderPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'config-reader.js');

  if (!fs.existsSync(configReaderPath)) {
    return { error: `config-reader.js not found at ${configReaderPath}` };
  }

  try {
    const configModule = await import(configReaderPath);
    if (typeof configModule.getAutomationRateState !== 'function') {
      return { error: 'getAutomationRateState function not found in config-reader.js' };
    }
    const state = configModule.getAutomationRateState();

    return {
      rate: state.rate,
      set_at: state.set_at,
      set_by: state.set_by,
      description: RATE_DESCRIPTIONS[state.rate] ?? 'Unknown rate level.',
      levels: {
        none: RATE_DESCRIPTIONS.none,
        low: RATE_DESCRIPTIONS.low,
        medium: RATE_DESCRIPTIONS.medium,
        high: RATE_DESCRIPTIONS.high,
      },
      multiplier: state.rate === 'none' ? 'Infinity (blocks at enqueue)' : String(configModule.RATE_MULTIPLIERS?.[state.rate] ?? 1) + 'x',
      allowedWhenNone: state.rate === 'none' ? [
        'priority: cto or critical',
        'lane: persistent, gate, audit, alignment, revival, or automated',
        'source: force-spawn-tasks',
        'source: persistent-task-spawner',
        'source: stop-continue-hook',
        'source: session-queue-reaper',
        'source: sync-recycle',
        'metadata.persistentTaskId set',
      ] : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get automation rate: ${message}` };
  }
}

/**
 * Backward-compat: Enable or disable focus mode via the rate system.
 * enabled=true maps to rate='none', enabled=false maps to rate='low'.
 */
async function setFocusMode(args: SetFocusModeArgs): Promise<object | ErrorResult> {
  const rate = args.enabled ? 'none' : 'low';
  const result = await setAutomationRateHandler({ rate } as SetAutomationRateArgs);
  if ('error' in result) return result;
  return {
    ...result,
    // Also include focus-mode-shaped fields for backward compat
    enabled: args.enabled,
    enabledAt: (result as Record<string, unknown>).set_at,
    enabledBy: (result as Record<string, unknown>).set_by,
    message: args.enabled
      ? 'Focus mode ENABLED (automation rate set to none) — only CTO-directed tasks, persistent monitors, and revivals can spawn. DEPRECATED: use set_automation_rate instead.'
      : 'Focus mode DISABLED (automation rate set to low) — automations run at slow rates. DEPRECATED: use set_automation_rate instead.',
  };
}

/**
 * Backward-compat: Get the current focus mode state.
 * Maps automation rate to focus mode semantics.
 */
async function getFocusMode(_args: GetFocusModeArgs): Promise<object | ErrorResult> {
  const rateResult = await getAutomationRateHandler({} as GetAutomationRateArgs);
  if ('error' in rateResult) return rateResult;
  const rate = (rateResult as Record<string, unknown>).rate as string;
  const enabled = rate === 'none';
  return {
    enabled,
    enabledAt: (rateResult as Record<string, unknown>).set_at,
    enabledBy: (rateResult as Record<string, unknown>).set_by,
    description: enabled
      ? 'Focus mode is ACTIVE (automation rate: none) — only CTO-directed tasks, persistent monitors, and revivals can spawn. DEPRECATED: use get_automation_rate instead.'
      : `Focus mode is OFF (automation rate: ${rate}). DEPRECATED: use get_automation_rate instead.`,
    automationRate: rate,
    allowedSources: enabled ? [
      'priority: cto or critical',
      'lane: persistent, gate, audit, alignment, revival, or automated',
      'source: force-spawn-tasks',
      'source: persistent-task-spawner',
      'source: stop-continue-hook',
      'source: session-queue-reaper',
      'source: sync-recycle',
      'metadata.persistentTaskId set',
    ] : null,
  };
}

// ============================================================================
// Lockdown Mode Tool Implementations
// ============================================================================

const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');

function readAutomationConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(AUTOMATION_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeAutomationConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(AUTOMATION_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(AUTOMATION_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

async function setLockdownMode(args: SetLockdownModeArgs): Promise<object | ErrorResult> {
  // SECURITY: spawned sessions NEVER allowed to disable lockdown (hard guard).
  // This prevents a compromised or misbehaving agent from using the MCP tool
  // to remove its own constraints.
  if (!args.enabled && process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return {
      error: 'SECURITY: Spawned sessions cannot disable lockdown. '
        + 'CLAUDE_SPAWNED_SESSION=true — lockdown can only be disabled from an interactive CTO session.',
    };
  }

  // Disabling lockdown requires a valid HMAC-signed approval token (APPROVE BYPASS flow).
  if (!args.enabled) {
    const tokenModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'bypass-approval-token.js');
    let tokenResult: { valid: boolean; code?: string; request_id?: string; reason?: string };
    try {
      const mod = await import(tokenModulePath);
      tokenResult = mod.verifyAndConsumeApprovalToken(PROJECT_DIR);
    } catch (err) {
      return {
        error: `G001 FAIL-CLOSED: Could not load bypass-approval-token module: ${(err as Error).message}`,
      };
    }

    if (!tokenResult.valid) {
      return {
        error: [
          `Disabling lockdown requires CTO approval via APPROVE BYPASS flow.`,
          `Token check failed: ${tokenResult.reason || 'no valid token'}.`,
          ``,
          `To disable lockdown:`,
          `  1. Call mcp__deputy-cto__request_bypass with reason "Disable interactive session lockdown"`,
          `  2. CTO types "APPROVE BYPASS <code>" in chat (code returned by step 1)`,
          `  3. Call mcp__agent-tracker__set_lockdown_mode({ enabled: false }) again`,
          ``,
          `The agent cannot forge the 6-char code (server-generated, stored in deputy-cto.db) `,
          `or the HMAC signature (signed with .claude/protection-key).`,
        ].join('\n'),
      };
    }
  }

  // Token was valid (already consumed) OR we're enabling. Proceed with state change.
  const config = readAutomationConfig();
  if (args.enabled) {
    delete config.interactiveLockdownDisabled;
  } else {
    config.interactiveLockdownDisabled = true;
  }
  writeAutomationConfig(config);

  // Emit audit event to session-audit.log
  const auditEventName = args.enabled ? 'lockdown_enabled' : 'lockdown_disabled';
  try {
    const auditPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js');
    if (fs.existsSync(auditPath)) {
      import(auditPath).then((auditModule: { auditEvent?: (event: string, data?: object) => void }) => {
        if (typeof auditModule.auditEvent === 'function') {
          auditModule.auditEvent(auditEventName, { enabled: args.enabled });
        }
      }).catch(() => { /* non-fatal */ });
    }
  } catch {
    // Audit emission is non-fatal
  }

  return {
    success: true,
    lockdown_enabled: args.enabled,
    message: args.enabled
      ? 'Lockdown ENABLED — interactive sessions operate as deputy-CTO console. File-editing and code-modifying agents are blocked.'
      : 'Lockdown DISABLED — all tools available in interactive sessions. HMAC-verified CTO approval token was consumed. Re-enable with set_lockdown_mode({ enabled: true }).',
  };
}

function getLockdownMode(_args: GetLockdownModeArgs): object {
  const config = readAutomationConfig();
  const enabled = config.interactiveLockdownDisabled !== true;
  return {
    lockdown_enabled: enabled,
    message: enabled
      ? 'Lockdown is ENABLED — interactive sessions are restricted to read-only and management tools.'
      : 'Lockdown is DISABLED — interactive sessions have full tool access.',
  };
}

// ============================================================================
// Local Mode Tool Implementations
// ============================================================================

// Mirror of REMOTE_SERVERS from lib/shared-mcp-config.js (can't import ESM JS from compiled TS)
const REMOTE_SERVERS_LIST = [
  'github', 'cloudflare', 'supabase', 'vercel', 'render',
  'codecov', 'resend', 'elastic-logs', 'onepassword', 'secret-sync',
];

async function setLocalMode(args: SetLocalModeArgs): Promise<object> {
  // Spawned sessions cannot toggle local mode
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return {
      error: 'SECURITY: Spawned sessions cannot toggle local mode. '
        + 'CLAUDE_SPAWNED_SESSION=true — local mode can only be changed from an interactive CTO session.',
    };
  }

  // Disabling local mode (re-enabling remote servers) requires CTO APPROVE BYPASS
  if (!args.enabled) {
    const tokenModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'bypass-approval-token.js');
    let tokenResult: { valid: boolean; code?: string; request_id?: string; reason?: string };
    try {
      const mod = await import(tokenModulePath);
      tokenResult = mod.verifyAndConsumeApprovalToken(PROJECT_DIR);
    } catch (err) {
      return {
        error: `G001 FAIL-CLOSED: Could not load bypass-approval-token module: ${(err as Error).message}`,
      };
    }

    if (!tokenResult.valid) {
      return {
        error: [
          `Disabling local mode requires CTO approval via APPROVE BYPASS flow.`,
          `Token check failed: ${tokenResult.reason || 'no valid token'}.`,
          ``,
          `To disable local mode:`,
          `  1. Call mcp__deputy-cto__request_bypass with reason "Disable local prototyping mode"`,
          `  2. CTO types "APPROVE BYPASS <code>" in chat (code returned by step 1)`,
          `  3. Call mcp__agent-tracker__set_local_mode({ enabled: false }) again`,
          ``,
          `After disabling, run "npx gentyr sync" and restart Claude Code to restore remote MCP servers.`,
        ].join('\n'),
      };
    }
  }

  // Write the state file directly (no dynamic import needed -- simple JSON write)
  const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const state = { enabled: args.enabled, enabledAt: new Date().toISOString(), enabledBy: 'mcp-tool' };
  fs.writeFileSync(path.join(stateDir, 'local-mode.json'), JSON.stringify(state, null, 2));

  // Emit audit event
  try {
    const auditPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js');
    const auditMod = await import(auditPath);
    auditMod.auditEvent(args.enabled ? 'local_mode_enabled' : 'local_mode_disabled', {});
  } catch {
    // Audit emission is non-fatal
  }

  const action = args.enabled ? 'ENABLED' : 'DISABLED';
  const nextSteps = 'Run "npx gentyr sync" then restart Claude Code to update MCP servers.';

  return {
    success: true,
    local_mode_enabled: args.enabled,
    message: args.enabled
      ? `Local mode ${action} — remote servers will be excluded from .mcp.json. Credential checks and remote automation skipped. ${nextSteps}`
      : `Local mode ${action} — all servers will be restored. ${nextSteps}`,
    excluded_servers: args.enabled ? REMOTE_SERVERS_LIST : [],
    next_steps: nextSteps,
  };
}

function getLocalMode(): object {
  const statePath = path.join(PROJECT_DIR, '.claude', 'state', 'local-mode.json');
  let state = { enabled: false, enabledAt: null as string | null, enabledBy: null as string | null };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch { /* default to disabled */ }

  return {
    local_mode_enabled: state.enabled,
    enabledAt: state.enabledAt,
    enabledBy: state.enabledBy,
    excluded_servers: state.enabled ? REMOTE_SERVERS_LIST : [],
    description: state.enabled
      ? 'Local mode is ENABLED. Remote MCP servers are excluded. 1Password is not required. Run /local-mode or set_local_mode({ enabled: false }) to re-enable (requires CTO bypass).'
      : 'Local mode is DISABLED. All MCP servers are available.',
  };
}

// ============================================================================
// Automation Toggle Tool Implementations
// ============================================================================

const AUTONOMOUS_MODE_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');

const AUTOMATION_TOGGLE_DESCRIPTIONS: Record<string, { description: string; defaultEnabled: boolean }> = {
  userFeedbackEnabled:                { description: 'User feedback pipeline (staging change detection -> persona spawn)', defaultEnabled: false },
  demoValidationEnabled:              { description: '6-hour demo validation cycle', defaultEnabled: false },
  dailyFeedbackEnabled:               { description: 'Daily feedback runs (all personas)', defaultEnabled: false },
  stagingReactiveReviewEnabled:       { description: '4-stream staging reactive review', defaultEnabled: true },
  stagingHealthMonitorEnabled:        { description: 'Staging health checks', defaultEnabled: true },
  productionHealthMonitorEnabled:     { description: 'Production health checks', defaultEnabled: true },
  standaloneAntipatternHunterEnabled: { description: 'Anti-pattern detection', defaultEnabled: true },
  standaloneComplianceCheckerEnabled: { description: 'Compliance checking', defaultEnabled: true },
  lintCheckerEnabled:                 { description: 'Lint checking and auto-fixing', defaultEnabled: true },
  taskRunnerEnabled:                  { description: 'Task execution (processes pending TODO items)', defaultEnabled: true },
  claudeMdRefactorEnabled:            { description: 'CLAUDE.md auto-refactoring when oversized', defaultEnabled: true },
  productManagerEnabled:              { description: 'Product manager pipeline', defaultEnabled: false },
  abandonedWorktreeRescueEnabled:     { description: 'Abandoned worktree rescue', defaultEnabled: true },
  worktreeCleanupEnabled:             { description: 'Worktree cleanup (merged branches)', defaultEnabled: true },
  staleWorktreeReaperEnabled:         { description: 'Stale worktree reaper', defaultEnabled: true },
  staleTaskCleanupEnabled:            { description: 'Stale task cleanup', defaultEnabled: true },
  orphanProcessReaperEnabled:         { description: 'Orphan process reaper', defaultEnabled: true },
  staleWorkDetectorEnabled:           { description: 'Stale work detector', defaultEnabled: true },
  globalMonitorEnabled:               { description: 'Global deputy-CTO alignment monitor (always-on persistent session)', defaultEnabled: true },
};

function readAutonomousModeConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(AUTONOMOUS_MODE_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeAutonomousModeConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(AUTONOMOUS_MODE_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(AUTONOMOUS_MODE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function setAutomationToggle(args: SetAutomationToggleArgs): object {
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return {
      error: 'Spawned sessions cannot modify automation toggles. Only interactive CTO sessions can toggle automation features.',
    };
  }

  const config = readAutonomousModeConfig();
  config[args.feature] = args.enabled;
  writeAutonomousModeConfig(config);

  const meta = AUTOMATION_TOGGLE_DESCRIPTIONS[args.feature];
  return {
    success: true,
    feature: args.feature,
    enabled: args.enabled,
    description: meta?.description ?? args.feature,
    default_enabled: meta?.defaultEnabled ?? true,
    message: args.enabled
      ? `${args.feature} is now ENABLED. Takes effect on the next hourly-automation cycle.`
      : `${args.feature} is now DISABLED. Takes effect on the next hourly-automation cycle.`,
  };
}

function getAutomationToggles(_args: GetAutomationTogglesArgs): object {
  const config = readAutonomousModeConfig();

  const toggles = Object.entries(AUTOMATION_TOGGLE_DESCRIPTIONS).map(([key, meta]) => {
    const configValue = config[key];
    const effectiveEnabled = configValue !== false;

    return {
      feature: key,
      description: meta.description,
      enabled: effectiveEnabled,
      explicit_value: configValue === undefined ? null : configValue,
      default_enabled: meta.defaultEnabled,
    };
  });

  const enabledCount = toggles.filter(t => t.enabled).length;
  const disabledCount = toggles.filter(t => !t.enabled).length;

  return {
    automation_master_enabled: config.enabled !== false,
    toggles,
    summary: `${enabledCount} enabled, ${disabledCount} disabled (of ${toggles.length} features)`,
  };
}

// ============================================================================
// MCP Server Staging
// ============================================================================

/**
 * Stage a project-local MCP server for installation.
 *
 * Attempts direct write to .mcp.json. If the file is root-owned (EACCES),
 * stages to .claude/state/mcp-servers-pending.json for the next npx gentyr sync.
 * Rejects server names that collide with GENTYR template servers.
 */
async function stageMcpServer(args: StageMcpServerArgs): Promise<object> {
  const mcpJsonPath = path.join(PROJECT_DIR, '.mcp.json');
  const pendingPath = path.join(PROJECT_DIR, '.claude', 'state', 'mcp-servers-pending.json');

  // Resolve framework dir to read template server names
  const frameworkDir = resolveFrameworkDir(PROJECT_DIR);
  const gentyrNames = new Set<string>();
  if (frameworkDir) {
    try {
      const templatePath = path.join(frameworkDir, '.mcp.json.template');
      const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      for (const name of Object.keys(tpl.mcpServers || {})) {
        gentyrNames.add(name);
      }
    } catch { /* non-fatal — template may not be readable */ }
  }

  // Also exclude dynamic gentyr server names
  const collisionWarning = (frameworkDir && gentyrNames.size === 0)
    ? ' Warning: could not read GENTYR template — collision detection is degraded. If this name collides with a GENTYR server, it will be overwritten on the next sync.'
    : '';
  if (gentyrNames.has(args.name) || args.name === 'plugin-manager' || args.name.startsWith('plugin-')) {
    return {
      applied: false,
      pending: false,
      server_name: args.name,
      error: `Server name "${args.name}" collides with a GENTYR-managed server. Choose a different name.`,
    };
  }

  // Build clean config object (strip undefined fields)
  const config: Record<string, unknown> = {};
  if (args.config.command) config.command = args.config.command;
  if (args.config.args) config.args = args.config.args;
  if (args.config.env) config.env = args.config.env;
  if (args.config.type) config.type = args.config.type;
  if (args.config.url) config.url = args.config.url;

  // Try direct write
  try {
    let mcpConfig: Record<string, unknown> = { mcpServers: {} };
    if (fs.existsSync(mcpJsonPath)) {
      // Check writability first
      fs.accessSync(mcpJsonPath, fs.constants.W_OK);
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    }
    (mcpConfig.mcpServers as Record<string, unknown>)[args.name] = config;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    return {
      applied: true,
      pending: false,
      server_name: args.name,
      message: `Server "${args.name}" added to .mcp.json. Restart the Claude Code session for new MCP tools to appear.${collisionWarning}`,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      return {
        applied: false,
        pending: false,
        server_name: args.name,
        error: `Failed to write .mcp.json: ${(err as Error).message}`,
      };
    }
  }

  // EACCES — stage for next npx gentyr sync
  try {
    const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    let pending: { servers: Record<string, unknown>; stagedAt: string } = { servers: {}, stagedAt: '' };
    if (fs.existsSync(pendingPath)) {
      try {
        pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        if (!pending.servers) pending.servers = {};
      } catch { pending = { servers: {}, stagedAt: '' }; }
    }
    pending.servers[args.name] = config;
    pending.stagedAt = new Date().toISOString();
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
    return {
      applied: false,
      pending: true,
      server_name: args.name,
      message: `Server "${args.name}" staged for next \`npx gentyr sync\` (project is protected). Run sync and restart the Claude Code session for new MCP tools to appear.${collisionWarning}`,
    };
  } catch (stageErr: unknown) {
    return {
      applied: false,
      pending: false,
      server_name: args.name,
      error: `Failed to stage server: ${(stageErr as Error).message}`,
    };
  }
}

// ============================================================================
// Session Signal Tool Implementations
// ============================================================================

const SIGNAL_MODULE_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');

/**
 * Dynamically import the session-signals module from the project's hooks directory.
 * Uses dynamic import so the module resolves CLAUDE_PROJECT_DIR at call time.
 */
async function getSignalsModule(): Promise<{
  sendSignal: (opts: Record<string, unknown>) => object;
  broadcastSignal: (opts: Record<string, unknown>) => object[];
  readPendingSignals: (agentId: string, projectDir: string) => object[];
  getSignalLog: (opts: Record<string, unknown>) => object[];
  acknowledgeSignal: (signalId: string, projectDir: string) => boolean;
}> {
  if (!fs.existsSync(SIGNAL_MODULE_PATH)) {
    throw new Error(`session-signals.js not found at ${SIGNAL_MODULE_PATH}`);
  }
  return import(SIGNAL_MODULE_PATH) as ReturnType<typeof getSignalsModule>;
}

/**
 * Read all signal files for a given agent by status filter.
 * Used by get_session_signals to support 'pending', 'read', and 'all'.
 */
function readSignalFiles(agentId: string, status: 'pending' | 'read' | 'all'): object[] {
  const signalDir = path.join(PROJECT_DIR, '.claude', 'state', 'session-signals');
  if (!fs.existsSync(signalDir)) {
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(signalDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read signal directory: ${message}`);
  }

  const agentFiles = files.filter(f => f.startsWith(`${agentId}-`) && f.endsWith('.json'));
  const results: object[] = [];

  for (const filename of agentFiles) {
    const filePath = path.join(signalDir, filename);
    let signal: Record<string, unknown>;
    try {
      signal = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (status === 'pending' && signal.read_at !== null) continue;
    if (status === 'read' && signal.read_at === null) continue;

    results.push(signal);
  }

  // Sort by created_at ascending
  (results as Array<{ created_at: string }>).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return results;
}

// ============================================================================
// Summary Subscription Handlers
// ============================================================================

function getActivityDb(): Database.Database {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-activity.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_subscriptions (
      id TEXT PRIMARY KEY,
      subscriber_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      detail_level TEXT NOT NULL DEFAULT 'detailed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subscriber_agent_id, target_agent_id)
    )
  `);
  return db;
}

async function subscribeSessionSummaries(args: SubscribeSessionSummariesArgs): Promise<object | ErrorResult> {
  const subscriberId = process.env.CLAUDE_AGENT_ID || 'cto-session';
  const { target_agent_id, detail_level } = args;

  if (subscriberId === target_agent_id) {
    return { error: 'Cannot subscribe to your own summaries' };
  }

  let db: Database.Database | undefined;
  try {
    db = getActivityDb();
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      'INSERT INTO summary_subscriptions (id, subscriber_agent_id, target_agent_id, detail_level) VALUES (?, ?, ?, ?) ON CONFLICT(subscriber_agent_id, target_agent_id) DO UPDATE SET detail_level = excluded.detail_level'
    ).run(id, subscriberId, target_agent_id, detail_level ?? 'detailed');
    return { success: true, subscription_id: id, subscriber: subscriberId, target: target_agent_id, detail_level: detail_level ?? 'detailed' };
  } catch (err) {
    return { error: `Failed to subscribe: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

async function unsubscribeSessionSummaries(args: UnsubscribeSessionSummariesArgs): Promise<object | ErrorResult> {
  const subscriberId = process.env.CLAUDE_AGENT_ID || 'cto-session';
  let db: Database.Database | undefined;
  try {
    db = getActivityDb();
    const result = db.prepare(
      'DELETE FROM summary_subscriptions WHERE subscriber_agent_id = ? AND target_agent_id = ?'
    ).run(subscriberId, args.target_agent_id);
    return { success: true, deleted: result.changes > 0 };
  } catch (err) {
    return { error: `Failed to unsubscribe: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

async function listSummarySubscriptions(args: ListSummarySubscriptionsArgs): Promise<object | ErrorResult> {
  const agentId = args.agent_id || process.env.CLAUDE_AGENT_ID || 'cto-session';
  let db: Database.Database | undefined;
  try {
    db = getActivityDb();
    const subs = db.prepare(
      'SELECT target_agent_id, detail_level, created_at FROM summary_subscriptions WHERE subscriber_agent_id = ? ORDER BY created_at DESC'
    ).all(agentId) as Array<{ target_agent_id: string; detail_level: string; created_at: string }>;
    const subscribers = db.prepare(
      'SELECT subscriber_agent_id, detail_level, created_at FROM summary_subscriptions WHERE target_agent_id = ? ORDER BY created_at DESC'
    ).all(agentId) as Array<{ subscriber_agent_id: string; detail_level: string; created_at: string }>;
    return { agent_id: agentId, subscribed_to: subs, subscribed_by: subscribers };
  } catch (err) {
    return { error: `Failed to list subscriptions: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * Send a signal to a specific running session.
 */
async function sendSessionSignal(args: SendSessionSignalArgs): Promise<object | ErrorResult> {
  try {
    const mod = await getSignalsModule();

    // Resolve caller identity from environment (will be set if CTO or an agent)
    const fromAgentId = process.env.CLAUDE_AGENT_ID || 'cto-session';
    const fromAgentType = process.env.CLAUDE_AGENT_ID ? 'agent' : 'cto';

    const signal = mod.sendSignal({
      fromAgentId,
      fromAgentType,
      fromTaskTitle: 'MCP Tool Call',
      toAgentId: args.target,
      toAgentType: 'unknown',
      tier: args.tier,
      message: args.message,
      projectDir: PROJECT_DIR,
    });

    return { success: true, signal };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to send signal: ${message}` };
  }
}

/**
 * Broadcast a signal to all running sessions.
 */
async function broadcastSessionSignal(args: BroadcastSignalArgs): Promise<object | ErrorResult> {
  try {
    const mod = await getSignalsModule();

    const fromAgentId = process.env.CLAUDE_AGENT_ID || 'cto-session';
    const fromAgentType = process.env.CLAUDE_AGENT_ID ? 'agent' : 'cto';

    const signals = mod.broadcastSignal({
      fromAgentId,
      fromAgentType,
      fromTaskTitle: 'MCP Broadcast',
      tier: args.tier,
      message: args.message,
      excludeAgentIds: args.exclude_agent_ids || [],
      projectDir: PROJECT_DIR,
    });

    return { success: true, sent_count: (signals as object[]).length, signals };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to broadcast signal: ${message}` };
  }
}

/**
 * Get signals for a specific agent.
 */
function getSessionSignals(args: GetSessionSignalsArgs): object | ErrorResult {
  try {
    const signals = readSignalFiles(args.agent_id, args.status ?? 'all');
    return {
      agent_id: args.agent_id,
      status_filter: args.status ?? 'all',
      count: signals.length,
      signals,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get session signals: ${message}` };
  }
}

/**
 * Get the inter-agent communication log.
 */
async function getCommsLog(args: GetCommsLogArgs): Promise<object | ErrorResult> {
  try {
    const mod = await getSignalsModule();
    const entries = mod.getSignalLog({
      since: args.since,
      tier: args.tier,
      limit: args.limit ?? 50,
      projectDir: PROJECT_DIR,
    } as Record<string, unknown>);

    return {
      count: (entries as object[]).length,
      entries,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get comms log: ${message}` };
  }
}

/**
 * Acknowledge a signal.
 */
async function acknowledgeSessionSignal(args: AcknowledgeSignalArgs): Promise<object | ErrorResult> {
  try {
    const mod = await getSignalsModule();
    const found = mod.acknowledgeSignal(args.signal_id, PROJECT_DIR);
    if (!found) {
      return { success: false, reason: `Signal not found: ${args.signal_id}` };
    }
    return { success: true, signal_id: args.signal_id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to acknowledge signal: ${message}` };
  }
}

// ============================================================================
// WS5 Tool Implementations
// ============================================================================

/**
 * Peek at the live JSONL tail of a running agent session.
 * Extracts last tool calls, last assistant text, sub-agent spawns, and git commits.
 */
async function peekSession(args: PeekSessionArgs): Promise<object | ErrorResult> {
  // Resolve agent_id from either agent_id or queue_id
  let agentId = args.agent_id;

  if (!agentId && args.queue_id) {
    // Look up agent_id directly from the queue DB's agent_id column (set by spawnQueueItem)
    if (fs.existsSync(QUEUE_DB_PATH)) {
      let queueDb;
      try {
        queueDb = openReadonlyDb(QUEUE_DB_PATH);
        const row = queueDb.prepare('SELECT agent_id FROM queue_items WHERE id = ?').get(args.queue_id) as { agent_id: string | null } | undefined;
        if (!row) {
          return { error: `Queue item not found: ${args.queue_id}` };
        }
        if (row.agent_id) {
          agentId = row.agent_id;
        } else {
          return { error: `Queue item ${args.queue_id} has not been spawned yet (no agent_id)` };
        }
      } finally {
        try { queueDb?.close(); } catch { /* best-effort */ }
      }
    }
  }

  if (!agentId) {
    return { error: 'Must provide agent_id or a resolvable queue_id' };
  }

  // Find the session JSONL file — use findSessionFile(agentRecord) which handles
  // worktree session dirs; fall back to direct search when no tracker record exists
  const history = readHistory();
  const agentRecord = (history.agents ?? []).find((a: AgentRecord) => a.id === agentId);
  let sessionFile: string | null = null;
  if (agentRecord) {
    sessionFile = findSessionFile(agentRecord);
  } else {
    const sessionDir = getSessionDir(PROJECT_DIR);
    if (sessionDir) {
      sessionFile = findSessionFileByAgentId(sessionDir, agentId);
    }
  }
  if (!sessionFile) {
    return { error: `Session file not found for agent: ${agentId}` };
  }

  const depthBytes = (args.depth ?? 24) * 1024;
  const offsetBytes = args.offset ?? 0;
  let tailResult: { content: string; fileSize: number; windowStart: number; windowEnd: number };
  try {
    tailResult = readTailBytes(sessionFile, depthBytes, offsetBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read session file: ${message}` };
  }

  const entries = parseTailEntries(tailResult.content);

  // Extract activity signals
  const lastTools: Array<{ name: string; inputPreview: string }> = [];
  let lastText: string | null = null;
  let lastTimestamp: string | null = null;
  const spawnedAgents: string[] = [];
  const gitCommits: string[] = [];
  let alignmentFindings: string | null = null;
  let messageCount = 0;

  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      messageCount++;
      const content = entry.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;

      const texts = content.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text as string);
      if (texts.length > 0) {
        const joined = texts.join('\n');
        lastText = joined;
        // Check for alignment findings
        if (joined.toLowerCase().includes('alignment') || joined.toLowerCase().includes('user intent')) {
          alignmentFindings = joined;
        }
      }

      for (const block of content) {
        if ((block as any).type !== 'tool_use') continue;
        const toolName = (block as any).name ?? 'unknown';
        const input = (block as any).input;
        let inputStr = '';
        try {
          inputStr = (typeof input === 'string' ? input : JSON.stringify(input) ?? '').substring(0, 200);
        } catch { /* skip */ }

        lastTools.push({ name: toolName, inputPreview: inputStr });
        if (lastTools.length > 10) lastTools.shift();

        if (toolName === 'Agent' || toolName === 'Task') {
          const desc = (input as Record<string, unknown>)?.description;
          if (typeof desc === 'string') spawnedAgents.push(desc.substring(0, 120));
        }
        if (toolName === 'Bash') {
          const cmd = (input as Record<string, unknown>)?.command;
          if (typeof cmd === 'string' && cmd.includes('git commit')) {
            const m = cmd.match(/-m\s+"([^"]+)"/);
            gitCommits.push(m ? m[1] : 'git commit');
          }
        }
      }
    } else if (entry.type === 'human' || entry.type === 'user') {
      messageCount++;
    }
  }

  // Chronological activity feed (reuses extractActivity for structured view)
  const recentActivity = extractActivity(entries);

  // Compaction detection (zero-cost: checks already-parsed entries)
  const compactionDetected = detectCompactionInEntries(entries);

  // Optionally retrieve compaction context with backward scan
  let compaction: CompactionContext | null = null;
  if (compactionDetected && args.include_compaction_context) {
    compaction = mergeCompactionCounts(
      findCompactionContext(sessionFile, tailResult.fileSize - tailResult.windowStart, 4000),
      entries
    );
  }

  // Pagination: how far from end the next page starts
  const hasMore = tailResult.windowStart > 0;
  const nextOffset = hasMore ? (tailResult.fileSize - tailResult.windowStart) : null;

  return {
    agentId,
    sessionFile,
    messageCount,
    lastTools,
    lastText,
    lastTimestamp,
    spawnedAgents,
    gitCommits,
    alignmentFindings,
    recentActivity,
    compactionDetected,
    ...(compaction ? { compaction } : {}),
    // Pagination metadata
    fileSize: tailResult.fileSize,
    windowStart: tailResult.windowStart,
    windowEnd: tailResult.windowEnd,
    hasMore,
    ...(nextOffset !== null ? { nextOffset } : {}),
  };
}

// ============================================================================
// browse_session — message-indexed session browsing for CTO monitoring
// ============================================================================

interface BrowseMessage {
  index: number;
  type: 'assistant_text' | 'tool_call' | 'tool_result' | 'error' | 'compaction' | 'user' | 'system';
  timestamp: string | null;
  content?: string;
  tool?: string;
  input_preview?: string;
  result_preview?: string;
}

/**
 * Format a single non-assistant JSONL entry into a BrowseMessage.
 * Assistant entries are handled inline by browseSession() because they expand
 * into multiple messages (text + tool_use blocks).
 */
function formatBrowseMessage(entry: any, index: number): BrowseMessage | null {
  const ts = entry.timestamp ?? null;

  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return { index, type: 'compaction', timestamp: ts, content: `Context compacted (${entry.compactMetadata?.trigger ?? 'unknown'})` };
  }

  if (entry.type === 'tool_result') {
    let preview = '';
    if (typeof entry.content === 'string') {
      preview = entry.content.length > 500 ? entry.content.substring(0, 500) + '...' : entry.content;
    } else if (Array.isArray(entry.content)) {
      const textParts = entry.content.filter((c: any) => c.type === 'text' && c.text).map((c: any) => c.text);
      const joined = textParts.join('\n');
      preview = joined.length > 500 ? joined.substring(0, 500) + '...' : joined;
    }
    return { index, type: 'tool_result', timestamp: ts, result_preview: preview || undefined };
  }

  if (entry.type === 'user') {
    const text = typeof entry.message?.content === 'string'
      ? entry.message.content
      : Array.isArray(entry.message?.content)
        ? entry.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : '';
    if (text.length > 0) {
      return { index, type: 'user', timestamp: ts, content: text };
    }
  }

  return null;
}

async function browseSession(args: BrowseSessionArgs): Promise<object | ErrorResult> {
  const agentId = args.agent_id;
  if (!agentId) return { error: 'agent_id is required' };

  // Find session file (same pattern as peekSession)
  const history = readHistory();
  const agentRecord = (history.agents ?? []).find((a: AgentRecord) => a.id === agentId);
  let sessionFile: string | null = null;
  if (agentRecord) {
    sessionFile = findSessionFile(agentRecord);
  } else {
    const sessionDir = getSessionDir(PROJECT_DIR);
    if (sessionDir) {
      sessionFile = findSessionFileByAgentId(sessionDir, agentId);
    }
  }
  if (!sessionFile) return { error: `Session file not found for agent: ${agentId}` };

  // For files > 10MB, fall back to tail-based reading
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionFile);
  } catch (err) {
    return { error: `Session file no longer accessible: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (stat.size > 10 * 1024 * 1024) {
    return { error: `Session file too large for indexed browsing (${Math.round(stat.size / 1024 / 1024)}MB). Use peek_session with offset pagination instead.` };
  }

  // Read and parse all lines
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch (err) {
    return { error: `Failed to read session file: ${err instanceof Error ? err.message : String(err)}` };
  }
  const lines = content.split('\n').filter(l => l.trim());
  const totalMessages = lines.length;

  const pageSize = args.page_size ?? 20;
  let endIndex = totalMessages;
  if (args.before_index !== undefined) {
    endIndex = Math.min(args.before_index, totalMessages);
  }
  const startIndex = Math.max(0, endIndex - pageSize);

  const messages: BrowseMessage[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      // An assistant entry can produce multiple messages (text + tool_use blocks)
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const blocks = entry.message.content as any[];
        const ts = entry.timestamp ?? null;
        const texts = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text as string);
        if (texts.length > 0) {
          const joined = texts.join('\n');
          messages.push({ index: i, type: 'assistant_text', timestamp: ts, content: joined });
        }
        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;
          let inputStr = '';
          try {
            const input = block.input;
            inputStr = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
            if (inputStr.length > 300) inputStr = inputStr.substring(0, 300) + '...';
          } catch { /* */ }
          messages.push({ index: i, type: 'tool_call', timestamp: ts, tool: block.name ?? 'unknown', input_preview: inputStr });
        }
      } else {
        const msg = formatBrowseMessage(entry, i);
        if (msg) messages.push(msg);
      }
    } catch { /* skip malformed */ }
  }

  return {
    agent_id: agentId,
    total_messages: totalMessages,
    range: { start_index: startIndex, end_index: endIndex },
    messages,
    has_more: startIndex > 0,
  };
}

// ============================================================================
// /monitor state management
// ============================================================================

const MONITOR_STATE_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'monitor-active.json');
const MONITOR_COUNTER_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'monitor-reminder.count');

async function updateMonitorState(args: UpdateMonitorStateArgs): Promise<object | ErrorResult> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(MONITOR_STATE_FILE, 'utf8'));
  } catch { /* new file */ }

  const state = {
    startedAt: existing.startedAt ?? new Date().toISOString(),
    roundNumber: args.round_number,
    monitoredSessions: args.monitored_sessions,
    monitoredTaskIds: args.monitored_task_ids,
    monitoredPlanIds: args.monitored_plan_ids ?? [],
    currentStep: args.current_step,
    lastRoundAt: new Date().toISOString(),
  };

  const dir = path.dirname(MONITOR_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MONITOR_STATE_FILE, JSON.stringify(state, null, 2));
  return { success: true, state };
}

async function stopMonitoring(_args: StopMonitoringArgs): Promise<object | ErrorResult> {
  let removed = false;
  try { fs.unlinkSync(MONITOR_STATE_FILE); removed = true; } catch { /* already gone */ }
  try { fs.unlinkSync(MONITOR_COUNTER_FILE); } catch { /* already gone */ }
  return { success: true, removed };
}

/**
 * Get a summary of all currently running agent sessions, including last tool and elapsed time.
 */
async function getSessionActivitySummary(_args: GetSessionActivitySummaryArgs): Promise<object | ErrorResult> {
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { hasData: false, message: 'Session queue database not found' };
  }

  let db;
  try {
    db = openReadonlyDb(QUEUE_DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open session queue database: ${message}` };
  }

  interface RunningQueueRow {
    id: string;
    title: string;
    agent_type: string;
    pid: number | null;
    spawned_at: string | null;
    lane: string;
    agent_id: string | null;
  }

  let runningRows: RunningQueueRow[];
  try {
    runningRows = db.prepare("SELECT id, title, agent_type, pid, spawned_at, lane, agent_id FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all() as RunningQueueRow[];
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }

  const now = Date.now();
  const history = readHistory();

  const summary = runningRows.map(row => {
    const elapsedMs = row.spawned_at ? now - new Date(row.spawned_at).getTime() : 0;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    // Use agent_id directly from the queue row (set by spawnQueueItem)
    const agentId: string | null = row.agent_id ?? null;

    let lastTool: string | null = null;
    let lastActivity: string | null = null;
    let sessionId: string | null = null;
    let compacted = false;

    if (agentId) {
      // Use findSessionFile(agentRecord) which handles worktree session dirs;
      // fall back to direct search when no tracker record exists
      const agentRecord = (history.agents ?? []).find((a: AgentRecord) => a.id === agentId);
      let sessionFile: string | null = null;
      if (agentRecord) {
        sessionFile = findSessionFile(agentRecord);
      } else {
        const sessionDir = getSessionDir(PROJECT_DIR);
        if (sessionDir) {
          sessionFile = findSessionFileByAgentId(sessionDir, agentId);
        }
      }
      if (sessionFile) {
        sessionId = path.basename(sessionFile, '.jsonl');
        try {
          const entries = parseTailEntries(readTailBytes(sessionFile, 16384).content);
          compacted = detectCompactionInEntries(entries);
          for (const entry of entries) {
            if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  lastTool = block.name;
                  lastActivity = entry.timestamp ?? null;
                }
              }
            }
          }
        } catch { /* non-critical */ }
      }
    }

    // Determine worktree path (if any)
    let worktreePath: string | null = null;
    if (agentId) {
      const agentRecord = (history.agents ?? []).find((a: AgentRecord) => a.id === agentId);
      worktreePath = (agentRecord?.metadata?.worktreePath as string) ?? null;
    }

    // Read progress file for pipeline stage
    let pipelineStage: string | null = null;
    if (agentId) {
      const progressFile = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress', `${agentId}.json`);
      const resolvedSummaryProgress = fs.existsSync(progressFile) ? progressFile : fs.existsSync(progressFile + '.retired') ? progressFile + '.retired' : null;
      try {
        if (resolvedSummaryProgress) {
          const pf = JSON.parse(fs.readFileSync(resolvedSummaryProgress, 'utf8')) as {
            pipeline?: { currentStage?: string; progressPercent?: number };
          };
          if (pf.pipeline?.currentStage) {
            pipelineStage = `${pf.pipeline.currentStage} (${pf.pipeline.progressPercent ?? 0}%)`;
          }
        }
      } catch { /* non-critical */ }
    }

    return {
      queue_id: row.id,
      agent_id: agentId,
      session_id: sessionId,
      title: row.title,
      agent_type: row.agent_type,
      elapsed_minutes: elapsedMinutes,
      last_tool: lastTool,
      last_activity: lastActivity,
      worktree_path: worktreePath,
      pipeline_stage: pipelineStage,
      pid: row.pid,
      pid_alive: row.pid ? (() => { try { process.kill(row.pid!, 0); return true; } catch { return false; } })() : false,
      compacted,
    };
  });

  return { running_count: summary.length, sessions: summary };
}

/**
 * Search CTO (non-autonomous) sessions for a query string.
 * Filters out sessions with [Automation], [Task], or [AGENT:] markers in the first 2KB.
 */
function searchCtoSessions(args: SearchCtoSessionsArgs): object | ErrorResult {
  const sessionDir = getSessionDir(PROJECT_DIR);
  if (!sessionDir) {
    return { error: 'Session directory not found for this project' };
  }

  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read session directory: ${message}` };
  }

  const query = args.query.toLowerCase();
  const limit = args.limit ?? 10;
  const results: Array<{ session_id: string; excerpt: string; context_lines: string[] }> = [];

  for (const file of files) {
    if (results.length >= limit) break;
    const filePath = path.join(sessionDir, file);

    // Read first 2KB to check for automation markers
    let head: string;
    try {
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
        head = buf.toString('utf8', 0, bytesRead);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } catch {
      continue;
    }

    // Skip automated sessions
    if (head.includes('[Automation]') || head.includes('[Task]') || head.includes('[AGENT:')) {
      continue;
    }

    // Search the full file for the query
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lowerContent = content.toLowerCase();
    const matchIdx = lowerContent.indexOf(query);
    if (matchIdx === -1) continue;

    // Extract context around the match
    const start = Math.max(0, matchIdx - 100);
    const end = Math.min(content.length, matchIdx + query.length + 100);
    const excerpt = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');

    // Also get surrounding lines for context
    const lines = content.split('\n');
    const contextLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query)) {
        const ctxStart = Math.max(0, i - 1);
        const ctxEnd = Math.min(lines.length - 1, i + 2);
        for (let j = ctxStart; j <= ctxEnd; j++) {
          contextLines.push(lines[j].substring(0, 200));
        }
        break;
      }
    }

    results.push({
      session_id: file.replace('.jsonl', ''),
      excerpt: excerpt.substring(0, 400),
      context_lines: contextLines,
    });
  }

  return {
    query: args.query,
    total: results.length,
    results,
  };
}

/**
 * Suspend a running session by calling preemptForCtoTask from session-queue.js.
 */
async function suspendSession(args: SuspendSessionArgs): Promise<object | ErrorResult> {
  const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');

  if (!fs.existsSync(queueModulePath)) {
    return { error: `session-queue.js not found at ${queueModulePath}` };
  }

  if (!args.agent_id && !args.queue_id) {
    return { error: 'Must provide agent_id or queue_id to suspend' };
  }

  try {
    const queueModule = await import(queueModulePath);

    // Resolve queue_id from agent_id if needed
    let queueId = args.queue_id;
    if (!queueId && args.agent_id) {
      // Find the running queue item by matching agent tracker spawn time proximity
      if (fs.existsSync(QUEUE_DB_PATH)) {
        let db;
        try {
          db = openReadonlyDb(QUEUE_DB_PATH);
          const history = readHistory();
          const agentRecord = (history.agents ?? []).find(a => a.id === args.agent_id);
          if (agentRecord) {
            const agentTime = new Date(agentRecord.timestamp).getTime();
            interface RunningRow { id: string; spawned_at: string | null; }
            const runningRows = db.prepare("SELECT id, spawned_at FROM queue_items WHERE status = 'running'").all() as RunningRow[];
            const match = runningRows.find(r => {
              if (!r.spawned_at) return false;
              return Math.abs(new Date(r.spawned_at).getTime() - agentTime) < 60_000;
            });
            if (match) queueId = match.id;
          }
        } finally {
          try { db?.close(); } catch { /* best-effort */ }
        }
      }
    }

    if (!queueId) {
      return { error: `Could not resolve queue_id for agent: ${args.agent_id}` };
    }

    if (typeof queueModule.preemptForCtoTask !== 'function') {
      return { error: 'preemptForCtoTask function not found in session-queue.js' };
    }

    const result = queueModule.preemptForCtoTask({
      queueId,
      requeuePriority: args.requeue_priority ?? 'urgent',
    });

    return { success: true, queue_id: queueId, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to suspend session: ${message}` };
  }
}

/**
 * Kill a running, suspended, or spawning session. Does NOT re-enqueue.
 */
async function killSession(args: KillSessionArgs): Promise<object> {
  if (!args.queue_id && !args.agent_id) {
    return { error: 'Must provide queue_id or agent_id' };
  }
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { error: 'Session queue database not found' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(QUEUE_DB_PATH);
    db.pragma('busy_timeout = 3000');

    // Resolve queue_id from agent_id if needed
    let queueId = args.queue_id;
    if (!queueId && args.agent_id) {
      const history = readHistory();
      const agentRecord = (history.agents ?? []).find((a: { id: string; timestamp: string }) => a.id === args.agent_id);
      if (agentRecord) {
        const agentTime = new Date(agentRecord.timestamp).getTime();
        interface RunningRow { id: string; spawned_at: string | null; }
        const rows = db.prepare("SELECT id, spawned_at FROM queue_items WHERE status IN ('running', 'suspended', 'spawning')").all() as RunningRow[];
        const match = rows.find(r => r.spawned_at && Math.abs(new Date(r.spawned_at).getTime() - agentTime) < 60_000);
        if (match) queueId = match.id;
      }
    }
    if (!queueId) {
      return { error: `Could not resolve queue_id for: ${args.agent_id || args.queue_id}` };
    }

    interface QueueRow { id: string; status: string; pid: number | null; title: string | null; metadata: string | null; }
    const item = db.prepare('SELECT id, status, pid, title, metadata FROM queue_items WHERE id = ?').get(queueId) as QueueRow | undefined;
    if (!item) return { error: `Queue item not found: ${queueId}` };
    if (['completed', 'failed', 'cancelled'].includes(item.status)) {
      return { error: `Session already in terminal state: ${item.status}` };
    }

    // Kill the process
    let killed = false;
    if (item.pid) {
      try {
        process.kill(item.pid, 'SIGTERM');
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(item.pid!, 0); } catch { killed = true; break; }
        }
        if (!killed) {
          try { process.kill(item.pid, 'SIGKILL'); killed = true; } catch { killed = true; }
        }
      } catch { killed = true; }
    }

    db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(queueId);

    // Reset linked TODO task
    try {
      const metadata = item.metadata ? JSON.parse(item.metadata) : {};
      if (metadata.taskId) {
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
        if (fs.existsSync(todoDbPath)) {
          const todoDb = new Database(todoDbPath);
          todoDb.pragma('busy_timeout = 3000');
          todoDb.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'").run(metadata.taskId);
          todoDb.close();
        }
      }
    } catch { /* non-fatal */ }

    // Release shared resources
    try {
      const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');
      if (fs.existsSync(resourceLockPath)) {
        const resourceModule = await import(resourceLockPath);
        if (typeof resourceModule.releaseAllResources === 'function') {
          resourceModule.releaseAllResources(args.agent_id || queueId);
        }
      }
    } catch { /* non-fatal */ }

    // Audit + drain
    try {
      const auditPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js');
      if (fs.existsSync(auditPath)) {
        const auditModule = await import(auditPath);
        if (typeof auditModule.auditEvent === 'function') {
          auditModule.auditEvent('session_killed', { queue_id: queueId, pid: item.pid, reason: args.reason, title: item.title });
        }
      }
    } catch { /* non-fatal */ }
    try {
      const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');
      if (fs.existsSync(queueModulePath)) {
        const queueModule = await import(queueModulePath);
        if (typeof queueModule.drainQueue === 'function') queueModule.drainQueue();
      }
    } catch { /* non-fatal */ }

    return { success: true, queue_id: queueId, pid: item.pid, killed, reason: args.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to kill session: ${message}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Kill a session and re-enqueue from scratch (fresh spawn, not resume).
 */
async function restartSession(args: RestartSessionArgs): Promise<object> {
  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { error: 'Session queue database not found' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(QUEUE_DB_PATH);
    db.pragma('busy_timeout = 3000');

    interface FullQueueRow {
      id: string; status: string; pid: number | null; title: string | null;
      prompt: string | null; agent_type: string | null; hook_type: string | null;
      model: string | null; extra_env: string | null; metadata: string | null;
      project_dir: string | null; tag_context: string | null; source: string | null; lane: string | null;
    }
    const item = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(args.queue_id) as FullQueueRow | undefined;
    if (!item) return { error: `Queue item not found: ${args.queue_id}` };
    if (item.status === 'completed') return { error: 'Cannot restart a completed session' };

    // Kill if running
    let killed = false;
    if (item.pid && ['running', 'spawning'].includes(item.status)) {
      try {
        process.kill(item.pid, 'SIGTERM');
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(item.pid!, 0); } catch { killed = true; break; }
        }
        if (!killed) {
          try { process.kill(item.pid, 'SIGKILL'); killed = true; } catch { killed = true; }
        }
      } catch { killed = true; }
    }

    // Mark old item failed
    db.prepare("UPDATE queue_items SET status = 'failed', completed_at = datetime('now') WHERE id = ?").run(args.queue_id);

    // Reset linked TODO task
    try {
      const metadata = item.metadata ? JSON.parse(item.metadata) : {};
      if (metadata.taskId) {
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
        if (fs.existsSync(todoDbPath)) {
          const todoDb = new Database(todoDbPath);
          todoDb.pragma('busy_timeout = 3000');
          todoDb.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'").run(metadata.taskId);
          todoDb.close();
        }
      }
    } catch { /* non-fatal */ }

    db.close();
    db = undefined;

    // Re-enqueue from scratch
    const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');
    if (!fs.existsSync(queueModulePath)) return { error: 'session-queue.js not found' };
    const queueModule = await import(queueModulePath);
    const validPriorities = ['cto', 'critical', 'urgent', 'normal', 'low'];
    const priority = validPriorities.includes(args.priority ?? '') ? args.priority : 'urgent';

    const result = queueModule.enqueueSession({
      title: item.title || 'Restarted session',
      agentType: item.agent_type,
      hookType: item.hook_type,
      tagContext: item.tag_context || undefined,
      source: 'kill-restart',
      priority,
      lane: item.lane || 'standard',
      prompt: item.prompt,
      model: item.model || undefined,
      projectDir: item.project_dir || PROJECT_DIR,
      extraEnv: item.extra_env ? JSON.parse(item.extra_env) : undefined,
      metadata: item.metadata ? JSON.parse(item.metadata) : undefined,
    });

    // Audit
    try {
      const auditPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js');
      if (fs.existsSync(auditPath)) {
        const auditModule = await import(auditPath);
        if (typeof auditModule.auditEvent === 'function') {
          auditModule.auditEvent('session_restarted', { old_queue_id: args.queue_id, new_queue_id: result?.queueId, priority, title: item.title });
        }
      }
    } catch { /* non-fatal */ }

    return { success: true, killed_queue_id: args.queue_id, new_queue_id: result?.queueId, priority, killed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to restart session: ${message}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Reorder a queued item by changing its priority.
 */
function reorderQueue(args: ReorderQueueArgs): object | ErrorResult {
  const validPriorities = ['cto', 'critical', 'urgent', 'normal', 'low'];
  if (!validPriorities.includes(args.new_priority)) {
    return { error: `Invalid priority '${args.new_priority}'. Must be one of: ${validPriorities.join(', ')}` };
  }

  if (!fs.existsSync(QUEUE_DB_PATH)) {
    return { error: 'Session queue database not found. Queue may not be initialized yet.' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(QUEUE_DB_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open session queue database: ${message}` };
  }

  try {
    const item = db.prepare('SELECT id, status, priority, title FROM queue_items WHERE id = ?').get(args.queue_id) as { id: string; status: string; priority: string; title: string } | undefined;
    if (!item) {
      return { success: false, reason: `Queue item not found: ${args.queue_id}` };
    }
    if (item.status !== 'queued') {
      return { success: false, reason: `Cannot reorder item with status '${item.status}' — only 'queued' items can be reordered` };
    }

    const oldPriority = item.priority;
    db.prepare('UPDATE queue_items SET priority = ? WHERE id = ? AND status = ?').run(args.new_priority, args.queue_id, 'queued');

    return { success: true, id: args.queue_id, title: item.title, old_priority: oldPriority, new_priority: args.new_priority };
  } finally {
    try { db!.close(); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Shared Resource Registry Tools
// ============================================================================

/**
 * Acquire exclusive access to a shared resource.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function acquireSharedResource(args: AcquireSharedResourceArgs): Promise<object | ErrorResult> {
  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.acquireResource !== 'function') {
      return { error: 'acquireResource function not found in resource-lock.js' };
    }
    const agentId = process.env.CLAUDE_AGENT_ID || 'unknown';
    const queueId = process.env.CLAUDE_QUEUE_ID || process.env.CLAUDE_SESSION_ID || null;
    const result = mod.acquireResource(
      args.resource_id,
      agentId,
      queueId,
      args.title ?? null,
      { ttlMinutes: args.ttl_minutes },
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to acquire shared resource: ${message}` };
  }
}

/**
 * Release exclusive access to a shared resource.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function releaseSharedResource(args: ReleaseSharedResourceArgs): Promise<object | ErrorResult> {
  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.releaseResource !== 'function') {
      return { error: 'releaseResource function not found in resource-lock.js' };
    }
    const agentId = process.env.CLAUDE_AGENT_ID || 'unknown';
    const result = mod.releaseResource(args.resource_id, agentId);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to release shared resource: ${message}` };
  }
}

/**
 * Renew the TTL (heartbeat) on a resource lock held by this agent.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function renewSharedResource(args: RenewSharedResourceArgs): Promise<object | ErrorResult> {
  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.renewResource !== 'function') {
      return { error: 'renewResource function not found in resource-lock.js' };
    }
    const agentId = process.env.CLAUDE_AGENT_ID || 'unknown';
    const result = mod.renewResource(args.resource_id, agentId, args.ttl_minutes);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to renew shared resource: ${message}` };
  }
}

/**
 * Get the lock status of one or all shared resources.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function getSharedResourceStatus(args: GetSharedResourceStatusArgs): Promise<object | ErrorResult> {
  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.getResourceStatus !== 'function') {
      return { error: 'getResourceStatus function not found in resource-lock.js' };
    }
    // Pass undefined (not null) when omitted — getResourceStatus treats null/undefined as "all"
    const result = mod.getResourceStatus(args.resource_id ?? undefined);
    return Array.isArray(result) ? { resources: result } : result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get shared resource status: ${message}` };
  }
}

/**
 * Register a new shared resource in the resource registry.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function registerSharedResource(args: RegisterSharedResourceArgs): Promise<object | ErrorResult> {
  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.registerResource !== 'function') {
      return { error: 'registerResource function not found in resource-lock.js' };
    }
    const result = mod.registerResource(
      args.resource_id,
      args.description,
      args.default_ttl_minutes,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to register shared resource: ${message}` };
  }
}

/**
 * Force-release a shared resource lock regardless of who holds it.
 * Uses dynamic import so resource-lock.js resolves CLAUDE_PROJECT_DIR at call time.
 */
async function forceReleaseSharedResource(args: ForceReleaseSharedResourceArgs): Promise<object | ErrorResult> {
  // SECURITY: spawned sessions CANNOT force-release shared resources.
  // This prevents a compromised or misbehaving agent from releasing CTO-held locks
  // (e.g., the CTO dashboard display lock) to hijack the resource.
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return {
      error: 'SECURITY: Spawned sessions cannot force-release shared resources. '
        + 'force_release_shared_resource is a CTO-only override. '
        + 'Use acquire_shared_resource and wait in the queue.',
    };
  }

  const resourceLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'resource-lock.js');

  if (!fs.existsSync(resourceLockPath)) {
    return { error: `resource-lock.js not found at ${resourceLockPath}` };
  }

  try {
    const mod = await import(resourceLockPath);
    if (typeof mod.forceReleaseResource !== 'function') {
      return { error: 'forceReleaseResource function not found in resource-lock.js' };
    }
    const result = mod.forceReleaseResource(
      args.resource_id,
      args.reason ?? 'cto_override',
      { ctoOverride: true },
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to force-release shared resource: ${message}` };
  }
}

// ============================================================================
// Server Setup
// ============================================================================

// ============================================================================
// Interactive Monitor Launcher
// ============================================================================

/**
 * Open any agent session interactively in a visible Terminal.app window.
 * Supports 4 input modes: persistent task_id, session_id, queue_id, or agent_id.
 * Kills the headless process if still running, then resumes the session with full history.
 */
function launchInteractiveMonitor(args: LaunchInteractiveMonitorArgs): object {
  if (process.platform !== 'darwin') {
    return { error: 'launch_interactive_monitor requires macOS (Terminal.app + AppleScript)' };
  }

  if (!args.task_id && !args.session_id && !args.queue_id && !args.agent_id) {
    return { error: 'Provide one of: task_id, session_id, queue_id, or agent_id' };
  }

  // Resolve target project dir (cross-project support)
  const targetProjectDir = args.project_dir ? path.resolve(args.project_dir.replace(/^~/, os.homedir())) : PROJECT_DIR;
  const targetQueueDbPath = path.join(targetProjectDir, '.claude', 'state', 'session-queue.db');

  let sessionId: string | null = null;
  let resolvedAgentId: string | null = null;
  let killedPid: number | null = null;
  let title = 'Agent session';
  let persistentTaskId: string | null = null;

  const sessionDir = getSessionDir(targetProjectDir);

  // ── Mode 1: Direct session_id ──
  if (args.session_id) {
    sessionId = args.session_id.trim();
    // Verify the session file exists — check main dir first, then scan worktree dirs
    let sessionFileFound = false;
    if (sessionDir) {
      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) sessionFileFound = true;
    }
    if (!sessionFileFound) {
      const found = findSessionFileByIdAcrossProject(targetProjectDir, sessionId);
      if (!found) {
        return { error: `Session file not found: ${sessionId}.jsonl` };
      }
    }
  }

  // ── Mode 2: agent_id — find session file, kill process ──
  if (args.agent_id && !sessionId) {
    resolvedAgentId = args.agent_id.trim();
    // Search main session dir first, then scan all worktree dirs for this project
    if (sessionDir) {
      const sessionFile = findSessionFileByAgentId(sessionDir, resolvedAgentId);
      if (sessionFile) {
        sessionId = path.basename(sessionFile, '.jsonl');
      }
    }
    if (!sessionId) {
      const found = findSessionFileAcrossProject(targetProjectDir, resolvedAgentId);
      if (found) {
        sessionId = path.basename(found, '.jsonl');
      }
    }
    if (!sessionId) {
      return { error: `No session file found for agent_id '${resolvedAgentId}'` };
    }
    // Try to find and kill the running process from the queue
    if (fs.existsSync(targetQueueDbPath)) {
      let qDb;
      try {
        qDb = openReadonlyDb(targetQueueDbPath);
        const row = qDb.prepare("SELECT pid, title FROM queue_items WHERE agent_id = ? AND status = 'running'").get(resolvedAgentId) as { pid: number | null; title: string } | undefined;
        if (row) {
          title = row.title || title;
          if (row.pid) {
            try { process.kill(row.pid, 0); process.kill(row.pid, 'SIGTERM'); killedPid = row.pid; } catch { /* dead */ }
          }
        }
      } finally {
        try { qDb?.close(); } catch { /* best-effort */ }
      }
    }
  }

  // ── Mode 3: queue_id — look up agent_id and session from queue DB ──
  if (args.queue_id && !sessionId) {
    if (!fs.existsSync(targetQueueDbPath)) {
      return { error: 'Session queue database not found' };
    }
    let qDb;
    try {
      qDb = openReadonlyDb(targetQueueDbPath);
      const row = qDb.prepare("SELECT agent_id, pid, title, metadata FROM queue_items WHERE id = ?").get(args.queue_id.trim()) as { agent_id: string | null; pid: number | null; title: string; metadata: string | null } | undefined;
      if (!row) {
        return { error: `Queue item not found: ${args.queue_id}` };
      }
      title = row.title || title;
      resolvedAgentId = row.agent_id;
      // Extract persistentTaskId from metadata if present
      try {
        const meta = row.metadata ? JSON.parse(row.metadata) : {};
        if (meta.persistentTaskId) persistentTaskId = meta.persistentTaskId;
      } catch { /* ignore */ }
      // Find session file — search main dir, then worktree dirs
      if (resolvedAgentId && sessionDir) {
        const sessionFile = findSessionFileByAgentId(sessionDir, resolvedAgentId);
        if (sessionFile) {
          sessionId = path.basename(sessionFile, '.jsonl');
        }
      }
      if (!sessionId && resolvedAgentId) {
        const found = findSessionFileAcrossProject(targetProjectDir, resolvedAgentId);
        if (found) {
          sessionId = path.basename(found, '.jsonl');
        }
      }
      if (!sessionId) {
        return { error: `No session file found for queue item '${args.queue_id}' (agent: ${resolvedAgentId || 'not spawned'})` };
      }
      // Kill the process
      if (row.pid) {
        try { process.kill(row.pid, 0); process.kill(row.pid, 'SIGTERM'); killedPid = row.pid; } catch { /* dead */ }
      }
    } finally {
      try { qDb?.close(); } catch { /* best-effort */ }
    }
  }

  // ── Mode 4: task_id — persistent task monitor ──
  if (args.task_id && !sessionId) {
    const ptDbPath = path.join(targetProjectDir, '.claude', 'state', 'persistent-tasks.db');
    if (!fs.existsSync(ptDbPath)) {
      return { error: `persistent-tasks.db not found at ${targetProjectDir}` };
    }
    let ptDb;
    try {
      ptDb = openReadonlyDb(ptDbPath);
      const prefix = args.task_id.trim();
      const rows = ptDb.prepare(
        "SELECT id, title, status, prompt, monitor_pid, monitor_agent_id, metadata FROM persistent_tasks WHERE id LIKE ? || '%'"
      ).all(prefix) as Array<{ id: string; title: string; status: string; prompt: string; monitor_pid: number | null; monitor_agent_id: string | null; metadata: string | null }>;
      if (rows.length === 0) {
        return { error: `No persistent task found matching prefix '${prefix}'` };
      }
      if (rows.length > 1) {
        return { error: `Multiple tasks match prefix '${prefix}': ${rows.map(r => `${r.id.slice(0, 8)} (${r.title})`).join(', ')}` };
      }
      const task = rows[0];
      title = task.title;
      persistentTaskId = task.id;

      if (task.status !== 'active') {
        return { error: `Task '${task.title}' is ${task.status}, not active. Resume it first with mcp__persistent-task__resume_persistent_task.` };
      }

      // Find session file — search main dir, then worktree dirs
      if (task.monitor_agent_id) {
        resolvedAgentId = task.monitor_agent_id;
        if (sessionDir) {
          const sessionFile = findSessionFileByAgentId(sessionDir, task.monitor_agent_id);
          if (sessionFile) {
            sessionId = path.basename(sessionFile, '.jsonl');
          }
        }
        if (!sessionId) {
          const found = findSessionFileAcrossProject(targetProjectDir, task.monitor_agent_id);
          if (found) {
            sessionId = path.basename(found, '.jsonl');
          }
        }
      }
      // Kill headless monitor
      if (task.monitor_pid) {
        try { process.kill(task.monitor_pid, 0); process.kill(task.monitor_pid, 'SIGTERM'); killedPid = task.monitor_pid; } catch { /* dead */ }
      }
    } finally {
      try { ptDb?.close(); } catch { /* best-effort */ }
    }
  }

  // ── Build and launch ──

  const gitWrappersDir = path.join(targetProjectDir, '.claude', 'hooks', 'git-wrappers');
  const pathPrepend = fs.existsSync(gitWrappersDir) ? `\nexport PATH="${gitWrappersDir}:$PATH"` : '';

  const safeTitle = title.replace(/['"\\]/g, '');
  const scriptId = sessionId?.slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const scriptPath = `/tmp/gentyr-join-${scriptId}.sh`;

  // Persistent task env vars (if applicable)
  const ptEnv = persistentTaskId ? `
export GENTYR_PERSISTENT_TASK_ID="${persistentTaskId}"
export GENTYR_PERSISTENT_MONITOR="true"` : '';

  if (sessionId) {
    // Resume existing session
    const scriptContent = `#!/bin/bash
cd ${JSON.stringify(targetProjectDir)}

export GENTYR_INTERACTIVE_MONITOR="true"
export CLAUDE_AGENT_ID="${resolvedAgentId || ''}"
export CLAUDE_PROJECT_DIR=${JSON.stringify(targetProjectDir)}${ptEnv}${pathPrepend}

exec claude --resume ${sessionId}
`;
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  } else {
    // No session to resume — launch fresh (persistent task fallback)
    const newAgentId = `agent-${crypto.randomBytes(4).toString('hex')}-${Date.now().toString().slice(-5)}`;
    resolvedAgentId = newAgentId;
    const prompt = persistentTaskId
      ? `[Automation][persistent-monitor][AGENT:${newAgentId}] You are the interactive persistent task monitor for "${safeTitle}". Read your full task details: mcp__persistent-task__get_persistent_task({ id: "${persistentTaskId}", include_amendments: true, include_subtasks: true }). Then begin your monitoring loop. Persistent Task ID: ${persistentTaskId}`
      : `[Interactive session] ${safeTitle}`;

    const agentFlag = persistentTaskId ? '--agent persistent-monitor' : '';
    const scriptContent = `#!/bin/bash
cd ${JSON.stringify(targetProjectDir)}

export GENTYR_INTERACTIVE_MONITOR="true"
export CLAUDE_AGENT_ID="${newAgentId}"
export CLAUDE_PROJECT_DIR=${JSON.stringify(targetProjectDir)}${ptEnv}${pathPrepend}

exec claude ${agentFlag} ${JSON.stringify(prompt)}
`;
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  }

  // Launch via AppleScript
  try {
    execFileSync('osascript', ['-e',
      `tell application "Terminal"
  do script "${scriptPath}"
  activate
end tell`
    ], { timeout: 10000, stdio: 'pipe' });
  } catch (err) {
    return { error: `AppleScript failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const resumed = sessionId !== null;
  return {
    launched: true,
    resumed,
    sessionId: sessionId || undefined,
    agentId: resolvedAgentId,
    title,
    killedPid,
    message: resumed
      ? `Resumed session in Terminal.app for "${safeTitle}". Full conversation history is visible.`
      : `Fresh session launched in Terminal.app for "${safeTitle}".`,
  };
}

// ============================================================================
// CTO Bypass Request System
// ============================================================================

const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

function getBypassDb(): InstanceType<typeof Database> {
  const db = new Database(BYPASS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bypass_requests (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      agent_id TEXT,
      session_queue_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution_context TEXT,
      resolved_at TEXT,
      resolved_by TEXT DEFAULT 'cto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (task_type IN ('persistent', 'todo')),
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
    );
    CREATE INDEX IF NOT EXISTS idx_bypass_status ON bypass_requests(status);
    CREATE INDEX IF NOT EXISTS idx_bypass_task ON bypass_requests(task_type, task_id);
    CREATE TABLE IF NOT EXISTS blocking_queue (
      id TEXT PRIMARY KEY,
      bypass_request_id TEXT,
      source_task_type TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      persistent_task_id TEXT,
      plan_task_id TEXT,
      plan_id TEXT,
      plan_title TEXT,
      blocking_level TEXT NOT NULL DEFAULT 'task',
      impact_assessment TEXT,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      resolved_at TEXT,
      resolution_context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (blocking_level IN ('task', 'persistent_task', 'plan')),
      CHECK (status IN ('active', 'resolved', 'superseded'))
    );
    CREATE INDEX IF NOT EXISTS idx_blocking_queue_status ON blocking_queue(status);
  `);
  // CTO decisions table (unified approval system)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cto_decisions (
      id TEXT PRIMARY KEY,
      decision_type TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      verbatim_text TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_file_hash TEXT,
      hmac TEXT,
      status TEXT NOT NULL DEFAULT 'verified',
      consumed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (decision_type IN ('bypass_request', 'protected_action', 'lockdown_toggle', 'release_signoff', 'staging_override')),
      CHECK (status IN ('pending_verification', 'verified', 'rejected', 'consumed'))
    );
    CREATE INDEX IF NOT EXISTS idx_cto_decisions_lookup ON cto_decisions(decision_type, decision_id, status);
  `);
  // Migration: add columns if absent (non-fatal)
  try {
    const cols = db.prepare("PRAGMA table_info(bypass_requests)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'propagation_context')) {
      db.exec("ALTER TABLE bypass_requests ADD COLUMN propagation_context TEXT");
    }
    if (!cols.some(c => c.name === 'deputy_escalated')) {
      db.exec("ALTER TABLE bypass_requests ADD COLUMN deputy_escalated INTEGER DEFAULT 0");
    }
    if (!cols.some(c => c.name === 'escalation_reason')) {
      db.exec("ALTER TABLE bypass_requests ADD COLUMN escalation_reason TEXT");
    }
    if (!cols.some(c => c.name === 'escalation_urgency')) {
      db.exec("ALTER TABLE bypass_requests ADD COLUMN escalation_urgency TEXT");
    }
  } catch { /* best-effort migration */ }
  return db;
}

function generateBypassId(): string {
  return 'bypass-' + crypto.randomUUID().slice(0, 12);
}

async function submitBypassRequest(args: SubmitBypassRequestArgs): Promise<object | ErrorResult> {
  // Validate the task exists and get its title
  let taskTitle = '';

  if (args.task_type === 'persistent') {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (!fs.existsSync(ptDbPath)) {
      return { error: 'Persistent tasks database not found. No persistent tasks exist.' };
    }
    let ptDb: InstanceType<typeof Database> | undefined;
    try {
      ptDb = openReadonlyDb(ptDbPath);
      const task = ptDb.prepare('SELECT id, title, status FROM persistent_tasks WHERE id = ?').get(args.task_id) as { id: string; title: string; status: string } | undefined;
      if (!task) return { error: `Persistent task not found: ${args.task_id}` };
      if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
        return { error: `Persistent task is already in terminal state: ${task.status}` };
      }
      taskTitle = task.title;
    } finally {
      try { ptDb?.close(); } catch { /* best-effort */ }
    }
  } else {
    const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
    if (!fs.existsSync(todoDbPath)) {
      return { error: 'Todo database not found. No tasks exist.' };
    }
    let todoDb: InstanceType<typeof Database> | undefined;
    try {
      todoDb = openReadonlyDb(todoDbPath);
      const task = todoDb.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(args.task_id) as { id: string; title: string; status: string } | undefined;
      if (!task) return { error: `Todo task not found: ${args.task_id}` };
      if (task.status === 'completed') {
        return { error: 'Todo task is already completed.' };
      }
      taskTitle = task.title;
    } finally {
      try { todoDb?.close(); } catch { /* best-effort */ }
    }
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    // Check for existing pending request
    const existing = db.prepare(
      "SELECT id, summary FROM bypass_requests WHERE task_type = ? AND task_id = ? AND status = 'pending' LIMIT 1"
    ).get(args.task_type, args.task_id) as { id: string; summary: string } | undefined;

    if (existing) {
      return {
        error: `A bypass request already exists for this task (id: ${existing.id}). Wait for the CTO to resolve it.`,
        existing_request_id: existing.id,
        existing_summary: existing.summary,
      };
    }

    const requestId = generateBypassId();
    const agentId = process.env.CLAUDE_AGENT_ID || null;

    db.prepare(`
      INSERT INTO bypass_requests (id, task_type, task_id, task_title, agent_id, category, summary, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(requestId, args.task_type, args.task_id, taskTitle, agentId, args.category, args.summary, args.details || null);

    // Pause the task to block revival
    if (args.task_type === 'persistent') {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      let ptDb: InstanceType<typeof Database> | undefined;
      try {
        ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        const result = ptDb.prepare(
          "UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status IN ('active', 'draft')"
        ).run(args.task_id);

        if (result.changes > 0) {
          ptDb.prepare(
            "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'paused', ?, datetime('now'))"
          ).run(
            crypto.randomUUID(),
            args.task_id,
            JSON.stringify({ reason: 'cto_bypass_request', bypass_request_id: requestId }),
          );
        }
      } finally {
        try { ptDb?.close(); } catch { /* best-effort */ }
      }
    } else {
      // For todo tasks, reset to 'pending' so no agent picks it up
      const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
      let todoDb: InstanceType<typeof Database> | undefined;
      try {
        todoDb = new Database(todoDbPath);
        todoDb.pragma('busy_timeout = 3000');
        todoDb.prepare(
          "UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'"
        ).run(args.task_id);
      } finally {
        try { todoDb?.close(); } catch { /* best-effort */ }
      }
    }

    // Propagate pause to plan layer (if persistent task is linked to a plan)
    if (args.task_type === 'persistent') {
      let propagationContext: string | null = null;
      try {
        const pausePropagationPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'pause-propagation.js');
        const { propagatePauseToPlan } = await import(pausePropagationPath) as { propagatePauseToPlan: (taskId: string, reason: string | null, bypassId: string | null) => { propagated: boolean; blocking_level?: string; plan_auto_paused?: boolean; plan_task_id?: string; plan_id?: string; impact?: { blocked_tasks?: string[]; blocks_phase?: boolean; is_gate?: boolean; parallel_paths_available?: boolean }; blocking_queue_id?: string | null } };
        const result = propagatePauseToPlan(args.task_id, args.summary, requestId);
        if (result.propagated) {
          propagationContext = JSON.stringify({
            plan_task_id: result.plan_task_id,
            plan_id: result.plan_id,
            blocking_level: result.blocking_level,
            plan_auto_paused: result.plan_auto_paused,
            blocking_queue_id: result.blocking_queue_id,
          });
          // Store propagation context on the bypass request
          db.prepare('UPDATE bypass_requests SET propagation_context = ? WHERE id = ?')
            .run(propagationContext, requestId);
        }
      } catch { /* non-fatal — bypass request already submitted */ }
    }

    const isPersistent = args.task_type === 'persistent';
    const instructions = [
      'BYPASS REQUEST SUBMITTED SUCCESSFULLY.',
      '',
      'Your request for CTO authorization has been recorded. The CTO will see it',
      'at their next session start. You MUST now follow this exit protocol:',
      '',
      '1. STOP all work on this task immediately',
      '2. Call summarize_work with a summary that includes:',
      '   - What you accomplished before hitting the bypass point',
      '   - What specific action requires CTO authorization',
      '   - Any relevant context the CTO should know',
      '3. Exit gracefully — do NOT continue working or attempt workarounds',
      '',
      'The CTO may take hours or days to respond. When they decide, your task',
      'will be handled with their decision context included.',
      ...(isPersistent ? ['', '4. Your persistent task has been paused. It will NOT be auto-resumed until the CTO resolves this request.'] : []),
    ].join('\n');

    return {
      bypass_request_id: requestId,
      status: 'pending',
      task_title: taskTitle,
      task_type: args.task_type,
      instructions,
    };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

// ============================================================================
// CTO Decision System
// ============================================================================

function computeDecisionHmac(keyBase64: string, decisionType: string, decisionId: string, verbatimText: string, sessionId: string, fileHash: string): string {
  const keyBuffer = Buffer.from(keyBase64, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update([decisionType, decisionId, verbatimText, sessionId, fileHash, 'cto-decision'].join('|'))
    .digest('hex');
}

function consumeCtoDecision(db: InstanceType<typeof Database>, decisionType: string, decisionId: string): { id: string; verbatim_text: string; session_id: string } | null {
  const row = db.prepare(
    "SELECT * FROM cto_decisions WHERE decision_type = ? AND decision_id = ? AND status = 'verified' ORDER BY created_at DESC LIMIT 1"
  ).get(decisionType, decisionId) as { id: string; verbatim_text: string; session_id: string; session_file_hash: string; hmac: string } | undefined;
  if (!row) return null;

  // Verify HMAC before consuming
  const keyPath = path.join(PROJECT_DIR, '.claude', 'protection-key');
  try {
    const keyBase64 = fs.readFileSync(keyPath, 'utf-8').trim();
    const expected = computeDecisionHmac(keyBase64, decisionType, decisionId, row.verbatim_text, row.session_id, row.session_file_hash);
    const a = Buffer.from(row.hmac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      db.prepare("DELETE FROM cto_decisions WHERE id = ?").run(row.id);
      return null; // Forged
    }
  } catch {
    return null; // Protection key missing — fail-closed
  }

  db.prepare("UPDATE cto_decisions SET status = 'consumed', consumed_at = datetime('now') WHERE id = ?").run(row.id);
  return { id: row.id, verbatim_text: row.verbatim_text, session_id: row.session_id };
}

async function recordCtoDecision(args: RecordCtoDecisionArgs): Promise<object | ErrorResult> {
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return { error: 'BLOCKED: Only the CTO interactive session can record CTO decisions.' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    // Load cto-approval-proof.js for JSONL verification
    const proofModule = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'cto-approval-proof.js'));

    // Find current session JSONL
    const sessionId = args.session_id || process.env.CLAUDE_SESSION_ID || '';
    const jsonlResult = proofModule.findCurrentSessionJsonl(PROJECT_DIR);
    if (!jsonlResult || !jsonlResult.jsonlPath) {
      return { error: 'Cannot locate current session JSONL file. Ensure CLAUDE_SESSION_ID is set or session files exist.' };
    }

    // Snapshot JSONL (TOCTOU defense)
    const snapshotPath = path.join(PROJECT_DIR, '.claude', 'state', `cto-decision-snapshot-${Date.now()}.jsonl`);
    fs.copyFileSync(jsonlResult.jsonlPath, snapshotPath);

    try {
      // Verify verbatim quote exists in session (verifyQuoteInJsonl is async)
      const quoteResult = await proofModule.verifyQuoteInJsonl(snapshotPath, args.verbatim_text);
      if (!quoteResult || !quoteResult.found) {
        return { error: 'Verbatim text not found in session JSONL. The CTO must type the approval/rejection BEFORE you call this tool. Copy their EXACT words.' };
      }

      // Compute HMAC proof
      const fileHash = proofModule.computeFileHash(snapshotPath);
      const keyPath = path.join(PROJECT_DIR, '.claude', 'protection-key');
      let keyBase64: string;
      try {
        keyBase64 = fs.readFileSync(keyPath, 'utf-8').trim();
      } catch {
        return { error: 'G001 FAIL-CLOSED: Protection key missing at .claude/protection-key' };
      }

      const effectiveSessionId = jsonlResult.sessionId || sessionId;
      const hmac = computeDecisionHmac(keyBase64, args.decision_type, args.decision_id, args.verbatim_text, effectiveSessionId, fileHash);

      // Insert decision
      db = getBypassDb();
      const id = 'ctod-' + crypto.randomUUID().slice(0, 12);
      db.prepare(`INSERT INTO cto_decisions (id, decision_type, decision_id, verbatim_text, session_id, session_file_hash, hmac, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', datetime('now'))`).run(
        id, args.decision_type, args.decision_id, args.verbatim_text, effectiveSessionId, fileHash, hmac
      );

      return {
        id,
        status: 'verified',
        decision_type: args.decision_type,
        decision_id: args.decision_id,
        message: `CTO decision recorded and verified. JSONL quote found at line ${quoteResult.lineNumber}. You may now call the appropriate resolution tool (e.g., resolve_bypass_request).`,
      };
    } finally {
      try { fs.unlinkSync(snapshotPath); } catch { /* non-fatal */ }
    }
  } catch (err) {
    return { error: `Failed to record CTO decision: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

async function checkCtoDecision(args: CheckCtoDecisionArgs): Promise<object | ErrorResult> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();
    const query = args.decision_type
      ? "SELECT id, decision_type, decision_id, status, created_at, consumed_at FROM cto_decisions WHERE decision_id = ? AND decision_type = ? ORDER BY created_at DESC LIMIT 1"
      : "SELECT id, decision_type, decision_id, status, created_at, consumed_at FROM cto_decisions WHERE decision_id = ? ORDER BY created_at DESC LIMIT 1";
    const row = args.decision_type
      ? db.prepare(query).get(args.decision_id, args.decision_type)
      : db.prepare(query).get(args.decision_id);
    if (!row) {
      return { found: false, message: 'No CTO decision found for this ID.' };
    }
    return { found: true, ...(row as Record<string, unknown>) };
  } catch (err) {
    return { error: `Failed to check CTO decision: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Deputy-CTO Monitor Bypass Resolution System
// ============================================================================

/**
 * CTO-only deferred action servers/tools — the deputy monitor CANNOT approve these.
 */
const CTO_ONLY_DEFERRED_SERVERS = new Set(['release-ledger']);
const CTO_ONLY_DEFERRED_TOOLS = new Set([
  'set_lockdown_mode',
  'sign_off_release',
  'cancel_release',
  'record_cto_approval',
]);

/**
 * 3-layer identity verification for the Global Deputy-CTO Monitor.
 *
 * Layer 1: GENTYR_DEPUTY_CTO_MONITOR env var
 * Layer 2: CLAUDE_QUEUE_ID -> session-queue.db -> metadata.task_type === 'global_monitor'
 * Layer 3: metadata.persistentTaskId -> persistent-tasks.db -> metadata.task_type === 'global_monitor'
 *
 * All three layers must pass. Fail-closed on any error.
 */
function verifyGlobalMonitorIdentity(): { verified: boolean; error?: string } {
  // Layer 1: env var check
  if (process.env.GENTYR_DEPUTY_CTO_MONITOR !== 'true') {
    return { verified: false, error: 'BLOCKED: This tool is restricted to the Global Deputy-CTO Monitor session. GENTYR_DEPUTY_CTO_MONITOR env var is not set.' };
  }

  // Layer 2: queue item verification
  const queueId = process.env.CLAUDE_QUEUE_ID;
  if (!queueId) {
    return { verified: false, error: 'BLOCKED: No CLAUDE_QUEUE_ID — cannot verify session identity. Only the Global Monitor session can use this tool.' };
  }

  const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(queueDbPath)) {
    return { verified: false, error: 'BLOCKED: Session queue database not found — cannot verify identity.' };
  }

  let queueDb: InstanceType<typeof Database> | undefined;
  let queueMetadata: { task_type?: string; persistentTaskId?: string } | null = null;
  try {
    queueDb = openReadonlyDb(queueDbPath);
    const queueItem = queueDb.prepare(
      'SELECT metadata FROM queue_items WHERE id = ?'
    ).get(queueId) as { metadata: string | null } | undefined;

    if (!queueItem) {
      return { verified: false, error: `BLOCKED: Queue item ${queueId} not found in session-queue.db.` };
    }
    if (!queueItem.metadata) {
      return { verified: false, error: 'BLOCKED: Queue item has no metadata — cannot verify task_type.' };
    }

    try {
      queueMetadata = JSON.parse(queueItem.metadata) as { task_type?: string; persistentTaskId?: string };
    } catch {
      return { verified: false, error: 'BLOCKED: Queue item metadata is not valid JSON.' };
    }

    if (queueMetadata?.task_type !== 'global_monitor') {
      return { verified: false, error: `BLOCKED: Queue item task_type is "${queueMetadata?.task_type ?? 'undefined'}", expected "global_monitor". Only the Global Monitor can use this tool.` };
    }
  } catch (err) {
    return { verified: false, error: `BLOCKED: Failed to read session-queue.db: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { queueDb?.close(); } catch { /* best-effort */ }
  }

  // Layer 3: persistent task cross-check
  const persistentTaskId = queueMetadata?.persistentTaskId;
  if (!persistentTaskId) {
    return { verified: false, error: 'BLOCKED: Queue item metadata has no persistentTaskId — cannot cross-check identity.' };
  }

  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) {
    return { verified: false, error: 'BLOCKED: Persistent tasks database not found — cannot cross-check identity.' };
  }

  let ptDb: InstanceType<typeof Database> | undefined;
  try {
    ptDb = openReadonlyDb(ptDbPath);
    const ptTask = ptDb.prepare(
      'SELECT metadata FROM persistent_tasks WHERE id = ?'
    ).get(persistentTaskId) as { metadata: string | null } | undefined;

    if (!ptTask) {
      return { verified: false, error: `BLOCKED: Persistent task ${persistentTaskId} not found.` };
    }
    if (!ptTask.metadata) {
      return { verified: false, error: 'BLOCKED: Persistent task has no metadata — cannot verify task_type.' };
    }

    let ptMetadata: { task_type?: string };
    try {
      ptMetadata = JSON.parse(ptTask.metadata) as { task_type?: string };
    } catch {
      return { verified: false, error: 'BLOCKED: Persistent task metadata is not valid JSON.' };
    }

    if (ptMetadata.task_type !== 'global_monitor') {
      return { verified: false, error: `BLOCKED: Persistent task task_type is "${ptMetadata.task_type ?? 'undefined'}", expected "global_monitor". Only the Global Monitor can use this tool.` };
    }
  } catch (err) {
    return { verified: false, error: `BLOCKED: Failed to read persistent-tasks.db: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { ptDb?.close(); } catch { /* best-effort */ }
  }

  return { verified: true };
}

/**
 * Deputy-CTO Monitor: resolve a bypass request without CTO intervention.
 * Uses the same downstream logic as resolveBypassRequest but skips the CTO decision requirement.
 */
async function deputyResolveBypassRequest(args: DeputyResolveBypassRequestArgs): Promise<object | ErrorResult> {
  // Identity verification — 3-layer check
  const identity = verifyGlobalMonitorIdentity();
  if (!identity.verified) {
    return { error: identity.error! };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    // Add deputy_escalated column if not present (auto-migration)
    try {
      const cols = db.prepare("PRAGMA table_info(bypass_requests)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'deputy_escalated')) {
        db.exec("ALTER TABLE bypass_requests ADD COLUMN deputy_escalated INTEGER DEFAULT 0");
      }
      if (!cols.some(c => c.name === 'escalation_reason')) {
        db.exec("ALTER TABLE bypass_requests ADD COLUMN escalation_reason TEXT");
      }
    } catch { /* best-effort migration */ }

    const request = db.prepare(
      'SELECT id, task_type, task_id, task_title, status, category, summary FROM bypass_requests WHERE id = ?'
    ).get(args.request_id) as { id: string; task_type: string; task_id: string; task_title: string; status: string; category: string; summary: string } | undefined;

    if (!request) {
      return { error: `Bypass request not found: ${args.request_id}` };
    }
    if (request.status !== 'pending') {
      return { error: `Bypass request is already ${request.status}. Only pending requests can be resolved.` };
    }

    // Check if the underlying task still exists and is in a valid state
    if (request.task_type === 'persistent') {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        let ptDb2: InstanceType<typeof Database> | undefined;
        try {
          ptDb2 = openReadonlyDb(ptDbPath);
          const task = ptDb2.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(request.task_id) as { status: string } | undefined;
          if (!task) {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task no longer exists', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task no longer exists. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
          if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = ?, resolved_at = datetime('now') WHERE id = ?"
            ).run(`Auto-cancelled: task is ${task.status}`, request.id);
            return { error: `Task is already ${task.status}. Bypass request has been auto-cancelled.`, auto_cancelled: true };
          }
        } finally {
          try { ptDb2?.close(); } catch { /* best-effort */ }
        }
      }
    } else {
      const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
      if (fs.existsSync(todoDbPath)) {
        let todoDb: InstanceType<typeof Database> | undefined;
        try {
          todoDb = openReadonlyDb(todoDbPath);
          const task = todoDb.prepare('SELECT status FROM tasks WHERE id = ?').get(request.task_id) as { status: string } | undefined;
          if (!task) {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task no longer exists', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task no longer exists. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
          if (task.status === 'completed') {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task completed', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task is already completed. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
        } finally {
          try { todoDb?.close(); } catch { /* best-effort */ }
        }
      }
    }

    // Resolve the request — NO CTO decision required, deputy is the decision-maker
    const resolvedContext = `[Deputy-CTO Monitor Decision] ${args.reasoning}`;
    db.prepare(
      "UPDATE bypass_requests SET status = ?, resolution_context = ?, resolved_at = datetime('now'), resolved_by = 'deputy-cto-monitor' WHERE id = ?"
    ).run(args.decision, resolvedContext, request.id);

    // Handle approval — resume the task (same logic as resolveBypassRequest)
    if (args.decision === 'approved') {
      if (request.task_type === 'persistent') {
        const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
        if (fs.existsSync(ptDbPath)) {
          let ptDb2: InstanceType<typeof Database> | undefined;
          try {
            ptDb2 = new Database(ptDbPath);
            ptDb2.pragma('busy_timeout = 3000');
            const result = ptDb2.prepare(
              "UPDATE persistent_tasks SET status = 'active' WHERE id = ? AND status = 'paused'"
            ).run(request.task_id);

            if (result.changes > 0) {
              ptDb2.prepare(
                "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
              ).run(
                crypto.randomUUID(),
                request.task_id,
                JSON.stringify({ reason: 'deputy_bypass_approved', bypass_request_id: request.id }),
              );
            }
          } finally {
            try { ptDb2?.close(); } catch { /* best-effort */ }
          }

          // Enqueue a monitor revival via session-queue
          try {
            const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');
            if (fs.existsSync(queueModulePath)) {
              const revivalPromptPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'persistent-monitor-revival-prompt.js');
              if (fs.existsSync(revivalPromptPath)) {
                const ptDbR = openReadonlyDb(ptDbPath);
                const task = ptDbR.prepare('SELECT id, title, metadata, monitor_session_id FROM persistent_tasks WHERE id = ?').get(request.task_id) as { id: string; title: string; metadata: string | null; monitor_session_id: string | null } | undefined;
                ptDbR.close();

                if (task) {
                  const { buildPersistentMonitorRevivalPrompt } = await import(revivalPromptPath);
                  const revival = await buildPersistentMonitorRevivalPrompt(task, 'deputy_bypass_approved', PROJECT_DIR);
                  const queueModule = await import(queueModulePath);
                  queueModule.enqueueSession({
                    title: `[Persistent] Deputy bypass approved: ${task.title}`,
                    agentType: 'persistent-task-monitor',
                    hookType: 'persistent-task-monitor',
                    tagContext: 'persistent-monitor',
                    source: 'deputy-bypass-resolve',
                    prompt: revival.prompt,
                    priority: 'critical',
                    lane: 'persistent',
                    spawnType: task.monitor_session_id ? 'resume' : 'fresh',
                    resumeSessionId: task.monitor_session_id || undefined,
                    extraEnv: revival.extraEnv,
                    metadata: { ...revival.metadata, persistentTaskId: request.task_id },
                    agent: revival.agent,
                    ttlMs: 0,
                  });
                }
              }
            }
          } catch (err) {
            process.stderr.write(`[deputy-bypass-resolve] Failed to enqueue revival: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }

        // Back-propagate resume to plan layer
        try {
          const bypassRow = db.prepare('SELECT propagation_context FROM bypass_requests WHERE id = ?').get(args.request_id) as { propagation_context: string | null } | undefined;
          if (bypassRow?.propagation_context) {
            const ctx = JSON.parse(bypassRow.propagation_context) as { plan_task_id?: string; plan_id?: string };
            if (ctx.plan_task_id) {
              const pausePropagationPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'pause-propagation.js');
              const { propagateResumeToPlan } = await import(pausePropagationPath) as { propagateResumeToPlan: (taskId: string) => { propagated: boolean } };
              propagateResumeToPlan(request.task_id);
            }
          }
        } catch { /* back-propagation is non-fatal */ }

        return {
          resolved: true,
          request_id: request.id,
          decision: 'approved',
          resolved_by: 'deputy-cto-monitor',
          task_type: request.task_type,
          task_title: request.task_title,
          message: `Deputy-CTO Monitor approved bypass request. Persistent task "${request.task_title}" has been set to active and a monitor session is being revived.`,
        };
      } else {
        return {
          resolved: true,
          request_id: request.id,
          decision: 'approved',
          resolved_by: 'deputy-cto-monitor',
          task_type: request.task_type,
          task_title: request.task_title,
          message: `Deputy-CTO Monitor approved bypass request. Todo task "${request.task_title}" will be picked up by the next spawn cycle.`,
        };
      }
    }

    // Handle rejection
    return {
      resolved: true,
      request_id: request.id,
      decision: 'rejected',
      resolved_by: 'deputy-cto-monitor',
      task_type: request.task_type,
      task_title: request.task_title,
      message: request.task_type === 'persistent'
        ? `Deputy-CTO Monitor rejected bypass request. Persistent task "${request.task_title}" remains paused.`
        : `Deputy-CTO Monitor rejected bypass request. Todo task "${request.task_title}" remains pending.`,
    };
  } catch (err) {
    return { error: `Failed to resolve bypass request: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Deputy-CTO Monitor: approve a deferred protected action without CTO intervention.
 * Only allows actions on Tier 1 servers that are NOT in the CTO_ONLY set.
 */
async function deputyApproveDeferredAction(args: DeputyApproveDeferredActionArgs): Promise<object | ErrorResult> {
  // Identity verification — 3-layer check
  const identity = verifyGlobalMonitorIdentity();
  if (!identity.verified) {
    return { error: identity.error! };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    const action = db.prepare(
      'SELECT id, server, tool, args, args_hash, status, pending_hmac FROM deferred_actions WHERE id = ?'
    ).get(args.action_id) as { id: string; server: string; tool: string; args: string; args_hash: string; status: string; pending_hmac: string } | undefined;

    if (!action) {
      return { error: `Deferred action not found: ${args.action_id}` };
    }
    if (action.status !== 'pending') {
      return { error: `Deferred action is already ${action.status}. Only pending actions can be approved.` };
    }

    // CTO-only server check
    if (CTO_ONLY_DEFERRED_SERVERS.has(action.server)) {
      return {
        error: `BLOCKED: Actions on the "${action.server}" server require CTO approval. The deputy monitor cannot approve this action. Escalate to the CTO using deputy_escalate_to_cto.`,
      };
    }

    // CTO-only tool check
    if (CTO_ONLY_DEFERRED_TOOLS.has(action.tool)) {
      return {
        error: `BLOCKED: The tool "${action.tool}" requires CTO approval. The deputy monitor cannot approve this action. Escalate to the CTO using deputy_escalate_to_cto.`,
      };
    }

    // Tools with "staging" in the name are CTO-only
    if (action.tool.toLowerCase().includes('staging')) {
      return {
        error: `BLOCKED: Tools involving staging operations ("${action.tool}") require CTO approval. Escalate to the CTO using deputy_escalate_to_cto.`,
      };
    }

    // Execute the deferred action via the MCP daemon
    // We need to: mark approved -> execute -> mark completed/failed
    // Unlike the CTO flow, we don't use HMAC — the deputy's identity was verified by the 3-layer check above.
    // We still transition atomically: pending -> approved -> executing -> completed/failed

    // Mark as approved (set approved_by in execution_result context since the table doesn't have that column)
    const approvedTransition = db.prepare(
      "UPDATE deferred_actions SET status = 'approved', approved_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(action.id);
    if (approvedTransition.changes === 0) {
      return { error: 'Failed to approve action — it may have been approved by another process.' };
    }

    // Mark as executing (atomic transition prevents double-execution)
    const executingTransition = db.prepare(
      "UPDATE deferred_actions SET status = 'executing' WHERE id = ? AND status = 'approved'"
    ).run(action.id);
    if (executingTransition.changes === 0) {
      return { error: 'Failed to transition action to executing — it may have been picked up by another process.' };
    }

    // Parse args
    let parsedArgs: object;
    try {
      parsedArgs = typeof action.args === 'string' ? JSON.parse(action.args) : action.args;
    } catch {
      db.prepare(
        "UPDATE deferred_actions SET status = 'failed', execution_error = 'Failed to parse action arguments', executed_at = datetime('now') WHERE id = ?"
      ).run(action.id);
      return { error: 'Failed to parse deferred action arguments.' };
    }

    // Execute via MCP daemon
    try {
      const executorPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'deferred-action-executor.js');
      const { executeMcpTool, isTier1Server } = await import(executorPath);

      if (!isTier1Server(action.server)) {
        db.prepare(
          "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(`Server "${action.server}" is not a Tier 1 server. Only Tier 1 servers can be executed via deferred actions.`, action.id);
        return { error: `Server "${action.server}" is not a Tier 1 server. Deferred execution only supports Tier 1 (shared daemon) servers.` };
      }

      const result = await executeMcpTool(action.server, action.tool, parsedArgs);

      if (result.success) {
        db.prepare(
          "UPDATE deferred_actions SET status = 'completed', execution_result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify({ ...result.result, approved_by: 'deputy-cto-monitor', reasoning: args.reasoning }), action.id);
        return {
          approved: true,
          executed: true,
          action_id: action.id,
          server: action.server,
          tool: action.tool,
          approved_by: 'deputy-cto-monitor',
          result: result.result,
          message: `Deputy-CTO Monitor approved and executed deferred action: ${action.server}:${action.tool}`,
        };
      } else {
        db.prepare(
          "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(result.error, action.id);
        return {
          approved: true,
          executed: false,
          action_id: action.id,
          server: action.server,
          tool: action.tool,
          approved_by: 'deputy-cto-monitor',
          error: result.error,
          message: `Deputy-CTO Monitor approved the action but execution failed: ${result.error}`,
        };
      }
    } catch (err) {
      db.prepare(
        "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
      ).run((err instanceof Error ? err.message : String(err)), action.id);
      return { error: `Failed to execute deferred action: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { error: `Failed to approve deferred action: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Deputy-CTO Monitor: explicitly escalate a bypass request to the CTO.
 * Marks the request with deputy_escalated=true so the CTO session briefing highlights it.
 */
async function deputyEscalateToCto(args: DeputyEscalateToCtoArgs): Promise<object | ErrorResult> {
  // Identity verification — 3-layer check
  const identity = verifyGlobalMonitorIdentity();
  if (!identity.verified) {
    return { error: identity.error! };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    // Ensure migration columns exist
    try {
      const cols = db.prepare("PRAGMA table_info(bypass_requests)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'deputy_escalated')) {
        db.exec("ALTER TABLE bypass_requests ADD COLUMN deputy_escalated INTEGER DEFAULT 0");
      }
      if (!cols.some(c => c.name === 'escalation_reason')) {
        db.exec("ALTER TABLE bypass_requests ADD COLUMN escalation_reason TEXT");
      }
      if (!cols.some(c => c.name === 'escalation_urgency')) {
        db.exec("ALTER TABLE bypass_requests ADD COLUMN escalation_urgency TEXT");
      }
    } catch { /* best-effort migration */ }

    const request = db.prepare(
      'SELECT id, task_type, task_id, task_title, status, category, summary FROM bypass_requests WHERE id = ?'
    ).get(args.request_id) as { id: string; task_type: string; task_id: string; task_title: string; status: string; category: string; summary: string } | undefined;

    if (!request) {
      return { error: `Bypass request not found: ${args.request_id}` };
    }
    if (request.status !== 'pending') {
      return { error: `Bypass request is already ${request.status}. Only pending requests can be escalated.` };
    }

    // Mark as escalated by the deputy
    db.prepare(
      'UPDATE bypass_requests SET deputy_escalated = 1, escalation_reason = ?, escalation_urgency = ? WHERE id = ?'
    ).run(args.reason, args.urgency, request.id);

    return {
      escalated: true,
      request_id: request.id,
      task_type: request.task_type,
      task_title: request.task_title,
      urgency: args.urgency,
      message: `Bypass request for "${request.task_title}" has been escalated to the CTO (urgency: ${args.urgency}). The CTO will see this prominently in their next session briefing.`,
    };
  } catch (err) {
    return { error: `Failed to escalate bypass request: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

async function resolveBypassRequest(args: ResolveBypassRequestArgs): Promise<object | ErrorResult> {
  // Spawned sessions cannot resolve bypass requests — only the CTO interactive session can
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    return { error: 'BLOCKED: Only the CTO interactive session can resolve bypass requests. Spawned agents cannot approve or reject bypass requests.' };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    const request = db.prepare(
      'SELECT id, task_type, task_id, task_title, status, category, summary FROM bypass_requests WHERE id = ?'
    ).get(args.request_id) as { id: string; task_type: string; task_id: string; task_title: string; status: string; category: string; summary: string } | undefined;

    if (!request) {
      return { error: `Bypass request not found: ${args.request_id}` };
    }
    if (request.status !== 'pending') {
      return { error: `Bypass request is already ${request.status}. Only pending requests can be resolved.` };
    }

    // Require a verified CTO decision (natural-language proof)
    const ctoDecision = consumeCtoDecision(db, 'bypass_request', args.request_id);
    if (!ctoDecision) {
      return {
        error: 'CTO decision required. Before calling resolve_bypass_request, you MUST:\n' +
          '1. Present the bypass request to the CTO via AskUserQuestion\n' +
          '2. Wait for the CTO to type their approval/rejection\n' +
          '3. Call record_cto_decision({ decision_type: "bypass_request", decision_id: "' + args.request_id + '", verbatim_text: "<CTO exact words>" })\n' +
          '4. Then call resolve_bypass_request again.',
      };
    }

    // Use the CTO's verbatim text as the resolution context (override args.context)
    const resolvedContext = args.context || ctoDecision.verbatim_text;

    // Check if the underlying task still exists and is in a valid state
    if (request.task_type === 'persistent') {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        let ptDb: InstanceType<typeof Database> | undefined;
        try {
          ptDb = openReadonlyDb(ptDbPath);
          const task = ptDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(request.task_id) as { status: string } | undefined;
          if (!task) {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task no longer exists', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task no longer exists. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
          if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = ?, resolved_at = datetime('now') WHERE id = ?"
            ).run(`Auto-cancelled: task is ${task.status}`, request.id);
            return { error: `Task is already ${task.status}. Bypass request has been auto-cancelled.`, auto_cancelled: true };
          }
        } finally {
          try { ptDb?.close(); } catch { /* best-effort */ }
        }
      }
    } else {
      const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
      if (fs.existsSync(todoDbPath)) {
        let todoDb: InstanceType<typeof Database> | undefined;
        try {
          todoDb = openReadonlyDb(todoDbPath);
          const task = todoDb.prepare('SELECT status FROM tasks WHERE id = ?').get(request.task_id) as { status: string } | undefined;
          if (!task) {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task no longer exists', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task no longer exists. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
          if (task.status === 'completed') {
            db.prepare(
              "UPDATE bypass_requests SET status = 'cancelled', resolution_context = 'Auto-cancelled: task completed', resolved_at = datetime('now') WHERE id = ?"
            ).run(request.id);
            return { error: 'Task is already completed. Bypass request has been auto-cancelled.', auto_cancelled: true };
          }
        } finally {
          try { todoDb?.close(); } catch { /* best-effort */ }
        }
      }
    }

    // Resolve the request
    db.prepare(
      "UPDATE bypass_requests SET status = ?, resolution_context = ?, resolved_at = datetime('now'), resolved_by = 'cto' WHERE id = ?"
    ).run(args.decision, resolvedContext, request.id);

    // Handle approval — resume the task
    if (args.decision === 'approved') {
      if (request.task_type === 'persistent') {
        const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
        if (fs.existsSync(ptDbPath)) {
          let ptDb: InstanceType<typeof Database> | undefined;
          try {
            ptDb = new Database(ptDbPath);
            ptDb.pragma('busy_timeout = 3000');
            const result = ptDb.prepare(
              "UPDATE persistent_tasks SET status = 'active' WHERE id = ? AND status = 'paused'"
            ).run(request.task_id);

            if (result.changes > 0) {
              ptDb.prepare(
                "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
              ).run(
                crypto.randomUUID(),
                request.task_id,
                JSON.stringify({ reason: 'cto_bypass_approved', bypass_request_id: request.id }),
              );
            }
          } finally {
            try { ptDb?.close(); } catch { /* best-effort */ }
          }

          // Enqueue a monitor revival via session-queue
          try {
            const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');
            if (fs.existsSync(queueModulePath)) {
              const revivalPromptPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'persistent-monitor-revival-prompt.js');
              if (fs.existsSync(revivalPromptPath)) {
                // Read the task fresh for revival prompt
                const ptDbR = openReadonlyDb(ptDbPath);
                const task = ptDbR.prepare('SELECT id, title, metadata, monitor_session_id FROM persistent_tasks WHERE id = ?').get(request.task_id) as { id: string; title: string; metadata: string | null; monitor_session_id: string | null } | undefined;
                ptDbR.close();

                if (task) {
                  const { buildPersistentMonitorRevivalPrompt } = await import(revivalPromptPath);
                  const revival = await buildPersistentMonitorRevivalPrompt(task, 'cto_bypass_approved', PROJECT_DIR);
                  const queueModule = await import(queueModulePath);
                  queueModule.enqueueSession({
                    title: `[Persistent] Bypass approved: ${task.title}`,
                    agentType: 'persistent-task-monitor',
                    hookType: 'persistent-task-monitor',
                    tagContext: 'persistent-monitor',
                    source: 'bypass-request-resolve',
                    prompt: revival.prompt,
                    priority: 'critical',
                    lane: 'persistent',
                    spawnType: task.monitor_session_id ? 'resume' : 'fresh',
                    resumeSessionId: task.monitor_session_id || undefined,
                    extraEnv: revival.extraEnv,
                    metadata: { ...revival.metadata, persistentTaskId: request.task_id },
                    agent: revival.agent,
                    ttlMs: 0,
                  });
                }
              }
            }
          } catch (err) {
            // Non-fatal — task is active, normal revival paths will pick it up
            process.stderr.write(`[bypass-resolve] Failed to enqueue revival: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }

        // Back-propagate resume to plan layer
        try {
          const bypassRow = db.prepare('SELECT propagation_context FROM bypass_requests WHERE id = ?').get(args.request_id) as { propagation_context: string | null } | undefined;
          if (bypassRow?.propagation_context) {
            const ctx = JSON.parse(bypassRow.propagation_context) as { plan_task_id?: string; plan_id?: string; blocking_level?: string; plan_auto_paused?: boolean; blocking_queue_id?: string };
            if (ctx.plan_task_id) {
              const pausePropagationPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'pause-propagation.js');
              const { propagateResumeToPlan } = await import(pausePropagationPath) as { propagateResumeToPlan: (taskId: string) => { propagated: boolean; plan_resumed?: boolean; blocking_items_resolved?: number } };
              const resumeResult = propagateResumeToPlan(request.task_id);
              // Signal plan manager if alive
              if (resumeResult.propagated && ctx.plan_id) {
                try {
                  const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
                  if (fs.existsSync(plansDbPath)) {
                    const plansDb = new Database(plansDbPath, { readonly: true });
                    plansDb.pragma('busy_timeout = 3000');
                    const plan = plansDb.prepare('SELECT manager_agent_id FROM plans WHERE id = ?').get(ctx.plan_id) as { manager_agent_id: string | null } | undefined;
                    plansDb.close();
                    if (plan?.manager_agent_id) {
                      const signalsPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');
                      const { sendSignal } = await import(signalsPath) as { sendSignal: (opts: { fromAgentId: string; toAgentId: string; tier: string; message: string; projectDir: string }) => void };
                      sendSignal({
                        fromAgentId: process.env.CLAUDE_AGENT_ID || 'cto-session',
                        toAgentId: plan.manager_agent_id,
                        tier: 'instruction',
                        message: `[BLOCKING RESOLVED] Bypass request "${args.request_id}" for plan task has been ${args.decision}. CTO context: ${args.context}. Check plan status and spawn ready tasks.`,
                        projectDir: PROJECT_DIR,
                      });
                    }
                  }
                } catch { /* signal delivery is non-fatal */ }
              }
            }
          }
        } catch { /* back-propagation is non-fatal */ }

        return {
          resolved: true,
          request_id: request.id,
          decision: 'approved',
          task_type: request.task_type,
          task_title: request.task_title,
          message: `Bypass request approved. Persistent task "${request.task_title}" has been set to active and a monitor session is being revived with your instructions.`,
        };
      } else {
        // Todo task — it's already 'pending', bypass guard clears, normal spawning resumes
        return {
          resolved: true,
          request_id: request.id,
          decision: 'approved',
          task_type: request.task_type,
          task_title: request.task_title,
          message: `Bypass request approved. Todo task "${request.task_title}" will be picked up by the next spawn cycle with your approval context.`,
        };
      }
    }

    // Handle rejection — leave task paused/pending
    return {
      resolved: true,
      request_id: request.id,
      decision: 'rejected',
      task_type: request.task_type,
      task_title: request.task_title,
      message: request.task_type === 'persistent'
        ? `Bypass request rejected. Persistent task "${request.task_title}" remains paused. Use resume_persistent_task or cancel_persistent_task to manage it.`
        : `Bypass request rejected. Todo task "${request.task_title}" remains pending. The next spawn will include your rejection context so the agent can take an alternative approach.`,
    };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

async function listBypassRequests(args: ListBypassRequestsArgs): Promise<object | ErrorResult> {
  if (!fs.existsSync(BYPASS_DB_PATH)) {
    return { requests: [], total: 0 };
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    // Auto-cancel pending requests for tasks that no longer exist or are terminal
    const pending = db.prepare(
      "SELECT id, task_type, task_id FROM bypass_requests WHERE status = 'pending'"
    ).all() as Array<{ id: string; task_type: string; task_id: string }>;

    for (const req of pending) {
      let shouldCancel = false;
      let cancelReason = '';

      if (req.task_type === 'persistent') {
        const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
        if (!fs.existsSync(ptDbPath)) {
          shouldCancel = true;
          cancelReason = 'Persistent tasks DB not found';
        } else {
          let ptDb: InstanceType<typeof Database> | undefined;
          try {
            ptDb = openReadonlyDb(ptDbPath);
            const task = ptDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(req.task_id) as { status: string } | undefined;
            if (!task) { shouldCancel = true; cancelReason = 'Task deleted'; }
            else if (['completed', 'cancelled', 'failed'].includes(task.status)) {
              shouldCancel = true; cancelReason = `Task ${task.status}`;
            }
          } finally { try { ptDb?.close(); } catch { /* best-effort */ } }
        }
      } else {
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'todo.db');
        if (!fs.existsSync(todoDbPath)) {
          shouldCancel = true;
          cancelReason = 'Todo DB not found';
        } else {
          let todoDb: InstanceType<typeof Database> | undefined;
          try {
            todoDb = openReadonlyDb(todoDbPath);
            const task = todoDb.prepare('SELECT status FROM tasks WHERE id = ?').get(req.task_id) as { status: string } | undefined;
            if (!task) { shouldCancel = true; cancelReason = 'Task deleted'; }
            else if (task.status === 'completed') { shouldCancel = true; cancelReason = 'Task completed'; }
          } finally { try { todoDb?.close(); } catch { /* best-effort */ } }
        }
      }

      if (shouldCancel) {
        db.prepare(
          "UPDATE bypass_requests SET status = 'cancelled', resolution_context = ?, resolved_at = datetime('now') WHERE id = ?"
        ).run(`Auto-cancelled: ${cancelReason}`, req.id);
      }
    }

    // Query with filter
    const statusFilter = args.status === 'all' ? '' : "WHERE status = ?";
    const params: (string | number)[] = args.status === 'all' ? [] : [args.status];
    params.push(args.limit);

    const requests = db.prepare(
      `SELECT id, task_type, task_id, task_title, agent_id, category, summary, details, status, resolution_context, resolved_at, created_at FROM bypass_requests ${statusFilter} ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as Array<{
      id: string; task_type: string; task_id: string; task_title: string;
      agent_id: string | null; category: string; summary: string; details: string | null;
      status: string; resolution_context: string | null; resolved_at: string | null; created_at: string;
    }>;

    const total = (db.prepare(
      `SELECT COUNT(*) as cnt FROM bypass_requests ${statusFilter}`
    ).get(...(args.status === 'all' ? [] : [args.status])) as { cnt: number }).cnt;

    return { requests, total };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Blocking Queue Tools
// ============================================================================

async function listBlockingItems(args: ListBlockingItemsArgs): Promise<object | ErrorResult> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (args.status !== 'all') {
      conditions.push('status = ?');
      params.push(args.status);
    }

    if (args.plan_id) {
      conditions.push('plan_id = ?');
      params.push(args.plan_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(args.limit);

    const items = db.prepare(
      `SELECT id, bypass_request_id, source_task_type, source_task_id, persistent_task_id,
              plan_task_id, plan_id, plan_title, blocking_level, impact_assessment, summary,
              status, resolved_at, resolution_context, created_at
       FROM blocking_queue
       ${whereClause}
       ORDER BY
         CASE blocking_level WHEN 'plan' THEN 0 WHEN 'persistent_task' THEN 1 ELSE 2 END ASC,
         created_at ASC
       LIMIT ?`
    ).all(...params) as Array<{
      id: string; bypass_request_id: string | null; source_task_type: string; source_task_id: string;
      persistent_task_id: string | null; plan_task_id: string | null; plan_id: string | null;
      plan_title: string | null; blocking_level: string; impact_assessment: string | null;
      summary: string; status: string; resolved_at: string | null; resolution_context: string | null;
      created_at: string;
    }>;

    // Parse impact_assessment JSON if present
    const parsedItems = items.map(item => {
      let parsedImpact: unknown = null;
      if (item.impact_assessment) {
        try {
          parsedImpact = JSON.parse(item.impact_assessment);
        } catch {
          parsedImpact = item.impact_assessment;
        }
      }
      return { ...item, impact_assessment: parsedImpact };
    });

    return { items: parsedItems, total: parsedItems.length };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

async function resolveBlockingItem(args: ResolveBlockingItemArgs): Promise<object | ErrorResult> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    const existing = db.prepare(
      'SELECT id, status FROM blocking_queue WHERE id = ?'
    ).get(args.id) as { id: string; status: string } | undefined;

    if (!existing) {
      return { error: `Blocking queue item not found: ${args.id}` };
    }

    if (existing.status !== 'active') {
      return { error: `Blocking queue item is already in terminal state: ${existing.status}` };
    }

    db.prepare(
      "UPDATE blocking_queue SET status = 'resolved', resolved_at = datetime('now'), resolution_context = ? WHERE id = ?"
    ).run(args.resolution_context || null, args.id);

    const updated = db.prepare(
      `SELECT id, bypass_request_id, source_task_type, source_task_id, persistent_task_id,
              plan_task_id, plan_id, plan_title, blocking_level, impact_assessment, summary,
              status, resolved_at, resolution_context, created_at
       FROM blocking_queue WHERE id = ?`
    ).get(args.id) as {
      id: string; bypass_request_id: string | null; source_task_type: string; source_task_id: string;
      persistent_task_id: string | null; plan_task_id: string | null; plan_id: string | null;
      plan_title: string | null; blocking_level: string; impact_assessment: string | null;
      summary: string; status: string; resolved_at: string | null; resolution_context: string | null;
      created_at: string;
    };

    let parsedImpact: unknown = null;
    if (updated.impact_assessment) {
      try {
        parsedImpact = JSON.parse(updated.impact_assessment);
      } catch {
        parsedImpact = updated.impact_assessment;
      }
    }

    return { item: { ...updated, impact_assessment: parsedImpact }, resolved: true };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

async function getBlockingSummary(_args: GetBlockingSummaryArgs): Promise<object | ErrorResult> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = getBypassDb();

    const counts = db.prepare(
      "SELECT blocking_level, COUNT(*) as cnt FROM blocking_queue WHERE status = 'active' GROUP BY blocking_level"
    ).all() as Array<{ blocking_level: string; cnt: number }>;

    const byLevel: Record<string, number> = { plan: 0, persistent_task: 0, task: 0 };
    let total = 0;
    for (const row of counts) {
      byLevel[row.blocking_level] = row.cnt;
      total += row.cnt;
    }

    let oldestAgeMinutes: number | null = null;
    if (total > 0) {
      const oldest = db.prepare(
        "SELECT created_at FROM blocking_queue WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
      ).get() as { created_at: string } | undefined;

      if (oldest) {
        const ageMs = Date.now() - new Date(oldest.created_at + 'Z').getTime();
        oldestAgeMinutes = Math.floor(ageMs / 60000);
      }
    }

    return {
      total,
      by_level: byLevel,
      oldest_age_minutes: oldestAgeMinutes,
    };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Self-Compaction
// ============================================================================

type RequestSelfCompactArgs = import('./types.js').RequestSelfCompactArgs;

function requestSelfCompact(args: RequestSelfCompactArgs): object {
  const agentId = process.env.CLAUDE_AGENT_ID;
  const sessionId = process.env.CLAUDE_SESSION_ID;

  // Read compact tracker and record the request
  const trackerPath = path.join(PROJECT_DIR, '.claude', 'state', 'compact-tracker.json');
  let tracker: Record<string, unknown> = {};
  try {
    if (fs.existsSync(trackerPath)) {
      tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
    }
  } catch { /* start fresh */ }

  // Try to get current token count from the session JSONL
  let currentTokens: number | null = null;
  if (sessionId) {
    try {
      const projectPath = '-' + PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
      const sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        const stat = fs.statSync(sessionFile);
        const readSize = Math.min(16384, stat.size);
        const fd = fs.openSync(sessionFile, 'r');
        try {
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
          const tail = buf.toString('utf8');
          const lines = tail.split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
              const entry = JSON.parse(line);
              const usage = entry.message?.usage;
              if (usage && entry.type === 'assistant') {
                currentTokens = (usage.input_tokens || 0) +
                  (usage.cache_read_input_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0);
                break;
              }
            } catch { /* partial line */ }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch { /* non-fatal */ }
  }

  // Record the compact request
  const key = sessionId || agentId || 'unknown';
  tracker[key] = {
    compactRequested: true,
    requestedAt: new Date().toISOString(),
    requestedByAgent: agentId || null,
    requestReason: args.reason || 'agent-initiated',
    preCompactTokens: currentTokens,
  };

  try {
    fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
    const tmpPath = trackerPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(tracker, null, 2));
    fs.renameSync(tmpPath, trackerPath);
  } catch { /* non-fatal */ }

  const tokenStr = currentTokens ? ` (current context: ${Math.round(currentTokens / 1000)}K tokens)` : '';

  return {
    status: 'compaction_requested',
    currentTokens,
    instructions: `COMPACTION PROTOCOL INITIATED${tokenStr}.

Your session will be compacted after you exit. Follow these steps:
1. Call summarize_work with a summary of your current state, progress, and what needs to happen next
2. Exit gracefully (stop working)

The system will detect your session has stopped, run /compact on your dead session to compress the context, and revive you with your compacted context preserved. Do NOT attempt to run /compact yourself — it would kill your running session.

This is safe and automatic. Your work will not be lost.`,
  };
}

const tools: AnyToolHandler[] = [
  {
    name: 'list_spawned_agents',
    description: 'List all Claude agents spawned by hooks. Returns agent ID, type, description, timestamp, and prompt preview.',
    schema: ListSpawnedAgentsArgsSchema,
    handler: listAgents,
  },
  {
    name: 'get_agent_prompt',
    description: 'Get the full prompt that was given to a spawned agent',
    schema: GetAgentPromptArgsSchema,
    handler: getAgentPrompt,
  },
  {
    name: 'get_agent_session',
    description: 'Get the full session transcript for a spawned agent (if available). Sessions are stored in ~/.claude/projects/ as JSONL files.',
    schema: GetAgentSessionArgsSchema,
    handler: getAgentSession,
  },
  {
    name: 'get_agent_stats',
    description: 'Get statistics about spawned agents: totals by type, by hook, and time-based metrics',
    schema: GetAgentStatsArgsSchema,
    handler: getAgentStats,
  },
  // Concurrency & Force-Spawn Tools
  {
    name: 'get_concurrency_status',
    description: 'Get real-time concurrency status: running agent count, max allowed, available slots, and tracked running agents by type.',
    schema: GetConcurrencyStatusArgsSchema,
    handler: getConcurrencyStatus,
  },
  {
    name: 'force_spawn_tasks',
    description: 'Force-spawn all pending TODO tasks for the specified sections immediately, bypassing age filters, batch limits, cooldowns, and CTO activity gate. Bypasses the session queue — spawns immediately regardless of queue capacity or memory pressure. Use when CTO-priority work is blocked by queue congestion.',
    schema: ForceSpawnTasksArgsSchema,
    handler: forceSpawnTasks,
  },
  {
    name: 'force_triage_reports',
    description: 'Force-spawn a deputy-CTO triage agent to process all pending reports immediately, bypassing the hourly automation triage interval. Returns the spawned agent ID, PID, and session ID.',
    schema: ForceTriageReportsArgsSchema,
    handler: forceTriageReports,
  },
  {
    name: 'monitor_agents',
    description: 'Monitor specific agents by ID. Returns current status, PID liveness, linked task status, and elapsed time. Use for polling after force_spawn_tasks.',
    schema: MonitorAgentsArgsSchema,
    handler: monitorAgents,
  },
  // Session Browser Tools
  {
    name: 'list_sessions',
    description: 'List all Claude Code sessions for this project with optional hook metadata. Shows which sessions were spawned by hooks vs manual user sessions.',
    schema: ListSessionsArgsSchema,
    handler: listSessions,
  },
  {
    name: 'search_sessions',
    description: 'Search across all session content. Returns matching sessions with preview context. Useful for finding specific conversations or debugging.',
    schema: SearchSessionsArgsSchema,
    handler: searchSessions,
  },
  {
    name: 'get_session_summary',
    description: 'Get detailed summary of a specific session including message counts, tools used, duration estimate, and first user message.',
    schema: GetSessionSummaryArgsSchema,
    handler: getSessionSummary,
  },
  // Session Queue Tools
  {
    name: 'get_session_queue_status',
    description: 'Get the current session queue status: running items (with PID liveness), queued items, capacity info, memory pressure level, and 24h throughput stats. Check memoryPressure field when items are queued but not spawning.',
    schema: GetSessionQueueStatusArgsSchema,
    handler: getSessionQueueStatus,
  },
  {
    name: 'set_max_concurrent_sessions',
    description: 'Update the maximum number of concurrent sessions the queue will spawn (1-50). CTO-only: do NOT call this tool unless the CTO explicitly requests a concurrency change. Takes effect on the next drain cycle.',
    schema: SetMaxConcurrentSessionsArgsSchema,
    handler: setMaxConcurrentSessions,
  },
  {
    name: 'cancel_queued_session',
    description: 'Cancel a queued (not yet running) session queue item by its queue ID. Only works on items with status "queued" — cannot cancel running or suspended items. Use kill_session or suspend_session for running items.',
    schema: CancelQueuedSessionArgsSchema,
    handler: cancelQueuedSession,
  },
  {
    name: 'kill_session',
    description: 'Kill a running, suspended, or spawning session. Sends SIGTERM then SIGKILL if needed. Marks queue item completed and resets linked TODO task. Does NOT re-enqueue — use restart_session to kill and re-enqueue.',
    schema: KillSessionArgsSchema,
    handler: killSession,
  },
  {
    name: 'restart_session',
    description: 'Kill a session and re-enqueue it from scratch (fresh spawn, not resume). Works on running, suspended, spawning, queued, or failed items. Preserves the original prompt and config.',
    schema: RestartSessionArgsSchema,
    handler: restartSession,
  },
  {
    name: 'drain_session_queue',
    description: 'Trigger an immediate drain of the session queue, spawning queued items up to the concurrency limit. Returns memoryBlocked count if memory pressure prevented spawning. Useful after capacity becomes available.',
    schema: DrainSessionQueueArgsSchema,
    handler: drainSessionQueue,
  },
  {
    name: 'activate_queued_session',
    description: 'Instantly activate a queued session by promoting it to CTO priority and spawning it. If the queue is at capacity, the lowest-priority running session is suspended (SIGTSTP) to make room and automatically resumed when a slot frees up.',
    schema: ActivateQueuedSessionArgsSchema,
    handler: activateQueuedSession,
  },
  {
    name: 'set_reserved_slots',
    description: 'Reserve N concurrency slots exclusively for priority-eligible tasks (cto/critical priority, persistent lane, or children of persistent tasks). Non-priority tasks see maxConcurrent - reservedSlots as their effective cap. Use auto_restore_minutes to automatically reset to default_value after a specified duration. Set count=0 to disable reservation.',
    schema: SetReservedSlotsArgsSchema,
    handler: setReservedSlots,
  },
  {
    name: 'get_reserved_slots',
    description: 'Get the current reserved slots count and auto-restore schedule. Reserved slots are dedicated to priority-eligible tasks (cto/critical priority, persistent lane, or persistentTaskId children).',
    schema: GetReservedSlotsArgsSchema,
    handler: getReservedSlots,
  },
  {
    name: 'set_automation_rate',
    description: 'Set the automation rate level. Controls how fast automated agents spawn: none (blocks all automated spawns), low (5x slower, DEFAULT), medium (2x slower), high (baseline rates). Replaces focus mode — rate=none is equivalent to focus mode enabled. Use /automation-rate slash command for interactive toggle.',
    schema: SetAutomationRateArgsSchema,
    handler: setAutomationRateHandler,
  },
  {
    name: 'get_automation_rate',
    description: 'Get the current automation rate level, including when it was set and what each level means. Replaces get_focus_mode.',
    schema: GetAutomationRateArgsSchema,
    handler: getAutomationRateHandler,
  },
  {
    name: 'set_focus_mode',
    description: 'DEPRECATED — use set_automation_rate instead. Backward-compat alias: enabled=true maps to rate=none, enabled=false maps to rate=low.',
    schema: SetFocusModeArgsSchema,
    handler: setFocusMode,
  },
  {
    name: 'get_focus_mode',
    description: 'DEPRECATED — use get_automation_rate instead. Backward-compat alias that returns focus mode semantics derived from the automation rate.',
    schema: GetFocusModeArgsSchema,
    handler: getFocusMode,
  },
  {
    name: 'set_lockdown_mode',
    description: 'Enable or disable the interactive session lockdown. Enabling is unrestricted. Disabling requires a valid HMAC-signed approval token from the APPROVE BYPASS flow (CTO must physically type APPROVE BYPASS <code> in chat). Spawned sessions are blocked server-side.',
    schema: SetLockdownModeArgsSchema,
    handler: setLockdownMode,
  },
  {
    name: 'get_lockdown_mode',
    description: 'Get the current interactive session lockdown state.',
    schema: GetLockdownModeArgsSchema,
    handler: getLockdownMode,
  },
  // Local Mode Tools
  {
    name: 'set_local_mode',
    description: 'Enable or disable local prototyping mode. When enabled, remote MCP servers (GitHub, Cloudflare, Supabase, Vercel, Render, Codecov, Resend, Elastic, 1Password, Secret-Sync) are excluded from .mcp.json and credential-dependent automation is skipped. Enabling is unrestricted. Disabling requires CTO APPROVE BYPASS. Spawned sessions are blocked. After toggling, run "npx gentyr sync" and restart Claude Code.',
    schema: SetLocalModeArgsSchema,
    handler: setLocalMode,
  },
  {
    name: 'get_local_mode',
    description: 'Get the current local prototyping mode state, including which servers are excluded.',
    schema: GetLocalModeArgsSchema,
    handler: getLocalMode,
  },
  // Automation Toggle Tools
  {
    name: 'set_automation_toggle',
    description: 'Enable or disable a specific hourly automation feature. Reads/writes .claude/autonomous-mode.json. Changes take effect on the next automation cycle. Blocked for spawned sessions.',
    schema: SetAutomationToggleArgsSchema,
    handler: setAutomationToggle,
  },
  {
    name: 'get_automation_toggles',
    description: 'List all automation feature toggles with their current state, default state, and descriptions.',
    schema: GetAutomationTogglesArgsSchema,
    handler: getAutomationToggles,
  },
  // Project-Local MCP Server Tools
  {
    name: 'stage_mcp_server',
    description: 'Add a project-local MCP server. Writes directly to .mcp.json if writable, or stages to mcp-servers-pending.json for the next `npx gentyr sync` if the file is protected. Server names that collide with GENTYR template servers are rejected. After installation, restart the Claude Code session for new tools to appear.',
    schema: StageMcpServerArgsSchema,
    handler: stageMcpServer,
  },
  // User Prompt Index Tools
  {
    name: 'get_user_prompt',
    description: 'Look up a user prompt by UUID. Returns content, timestamp, session_id. Use "nearby" param to get N surrounding messages for context.',
    schema: GetUserPromptArgsSchema,
    handler: getUserPrompt,
  },
  {
    name: 'search_user_prompts',
    description: 'Search user prompts with FTS5 ranked search (default) or LIKE fallback. Returns UUID, timestamp, content_preview, relevance rank. Only indexes user/human messages.',
    schema: SearchUserPromptsArgsSchema,
    handler: searchUserPrompts,
  },
  {
    name: 'list_user_prompts',
    description: 'List recent user prompts. Optional session_id filter. Returns UUID, timestamp, content_preview. Only user/human messages are indexed.',
    schema: ListUserPromptsArgsSchema,
    handler: listUserPrompts,
  },
  // Summary Subscription Tools
  {
    name: 'subscribe_session_summaries',
    description: 'Subscribe to activity summaries from another running session. Three tiers: "short" (2-4 sentence summary), "detailed" (full summary + task context), "verbatim" (full summary + recent raw session messages for near-complete visibility). Summaries are delivered as signals every 5 minutes by the activity broadcaster.',
    schema: SubscribeSessionSummariesArgsSchema,
    handler: subscribeSessionSummaries,
  },
  {
    name: 'unsubscribe_session_summaries',
    description: 'Unsubscribe from activity summaries of another session.',
    schema: UnsubscribeSessionSummariesArgsSchema,
    handler: unsubscribeSessionSummaries,
  },
  {
    name: 'list_summary_subscriptions',
    description: 'List summary subscriptions for the caller (default) or a specific agent. Shows both subscribed-to (outgoing) and subscribed-by (incoming) relationships.',
    schema: ListSummarySubscriptionsArgsSchema,
    handler: listSummarySubscriptions,
  },
  // Inter-Agent Communication Tools
  {
    name: 'send_session_signal',
    description: 'Send a signal to a specific running agent session. Use tier "note" for FYI, "instruction" for Deputy-CTO urgent directives, "directive" for CTO mandatory overrides.',
    schema: SendSessionSignalArgsSchema,
    handler: sendSessionSignal,
  },
  {
    name: 'broadcast_signal',
    description: 'Send a signal to ALL currently running agent sessions (excluding gate-lane agents). Useful for coordination announcements or urgent instructions.',
    schema: BroadcastSignalArgsSchema,
    handler: broadcastSessionSignal,
  },
  {
    name: 'get_session_signals',
    description: 'Get signals for a specific agent session. Filter by status: pending (unread), read, or all.',
    schema: GetSessionSignalsArgsSchema,
    handler: getSessionSignals,
  },
  {
    name: 'get_comms_log',
    description: 'Get the inter-agent communication log. Optionally filter by since timestamp, tier, and limit results.',
    schema: GetCommsLogArgsSchema,
    handler: getCommsLog,
  },
  {
    name: 'acknowledge_signal',
    description: 'Mark a signal as acknowledged. Required after receiving an instruction or directive tier signal.',
    schema: AcknowledgeSignalArgsSchema,
    handler: acknowledgeSessionSignal,
  },
  // WS5 Session Introspection Tools
  {
    name: 'peek_session',
    description: 'Peek at a running agent session\'s JSONL. Returns summary fields (lastText: up to 1000 chars, lastTools: last 10 with 200-char input previews) plus a chronological recentActivity array with assistant text (1000 chars each), tool calls (500-char inputs), and tool results from the window. Provide agent_id or queue_id. If the summary fields feel incomplete or you need more context, increase depth (e.g. depth: 48) or page backward using nextOffset from the previous response. Pagination: offset: 0 (default, latest), then pass nextOffset to page backward. Returns hasMore/nextOffset for continuation. Set include_compaction_context: true for pre-compaction summaries.',
    schema: PeekSessionArgsSchema,
    handler: peekSession,
  },
  {
    name: 'browse_session',
    description: 'Browse a session\'s message history with indexed pagination. Returns numbered messages (assistant text, tool calls, tool results) that can be paged backward using before_index. Designed for CTO monitoring — shows raw session content with minimal processing. Use page_size to control how many messages per page (default 20). Omit before_index for latest messages; pass before_index from the response range.start_index to page backward.',
    schema: BrowseSessionArgsSchema,
    handler: browseSession,
  },
  {
    name: 'update_monitor_state',
    description: 'Update the /monitor monitoring state file. Called each round to track progress. The monitor-reminder hook reads this file to inject reminders.',
    schema: UpdateMonitorStateArgsSchema,
    handler: updateMonitorState,
  },
  {
    name: 'stop_monitoring',
    description: 'Stop /monitor monitoring. Removes the state file and counter file so the reminder hook stops firing.',
    schema: StopMonitoringArgsSchema,
    handler: stopMonitoring,
  },
  {
    name: 'get_session_activity_summary',
    description: 'Get a summary of all currently running agent sessions: elapsed time, last tool called, worktree path, and PID liveness.',
    schema: GetSessionActivitySummaryArgsSchema,
    handler: getSessionActivitySummary,
  },
  {
    name: 'search_cto_sessions',
    description: 'Search CTO (non-automated) session transcripts for a query string. Filters out sessions containing [Automation], [Task], or [AGENT:] markers. Returns matching excerpts with context.',
    schema: SearchCtoSessionsArgsSchema,
    handler: searchCtoSessions,
  },
  {
    name: 'suspend_session',
    description: 'Suspend a running agent session by preempting it for a CTO-priority task. The session is requeued at the specified priority. Provide agent_id or queue_id.',
    schema: SuspendSessionArgsSchema,
    handler: suspendSession,
  },
  {
    name: 'reorder_queue',
    description: 'Change the priority of a queued (not yet running) session queue item. Valid priorities: cto, critical, urgent, normal, low.',
    schema: ReorderQueueArgsSchema,
    handler: reorderQueue,
  },
  // Persistent Task Deep Inspection
  {
    name: 'inspect_persistent_task',
    description: 'Deep inspection of a persistent task. Returns task state, monitor JSONL excerpts (500 char tool inputs, 1000 char text), child session activity, amendments, progress files, and worktree git state. Single call replaces chaining get_persistent_task_summary + monitor_agents + peek_session. Returns verbatim assistant text excerpts suitable for direct quoting in monitoring reports. Use depth_kb: 32 for comprehensive analysis. Auto-includes compaction context (pre-compaction work summary) for the monitor session when compaction is detected.',
    schema: InspectPersistentTaskArgsSchema,
    handler: inspectPersistentTask,
  },
  // Shared Resource Registry Tools
  {
    name: 'acquire_shared_resource',
    description: 'Acquire exclusive access to a shared resource (e.g., "display", "chrome-bridge", "main-dev-server"). Returns { acquired: true } if the lock was granted immediately, or { acquired: false, position, holder, queue_entry_id } if the resource is held by another agent. The caller is automatically enqueued and will be promoted when the holder releases. Renew the lock every ~5 min with renew_shared_resource to prevent auto-expiry.',
    schema: AcquireSharedResourceArgsSchema,
    handler: acquireSharedResource,
  },
  {
    name: 'release_shared_resource',
    description: 'Release exclusive access to a shared resource held by this agent. Verifies the caller is the current lock holder. Automatically promotes the next waiter from the queue. Returns { released: true, next_holder } on success.',
    schema: ReleaseSharedResourceArgsSchema,
    handler: releaseSharedResource,
  },
  {
    name: 'renew_shared_resource',
    description: 'Renew the TTL (heartbeat) on a resource lock held by this agent. The lock holder must call this every ~5 minutes during long-running operations to prevent auto-expiry. Returns { renewed: true, expires_at }.',
    schema: RenewSharedResourceArgsSchema,
    handler: renewSharedResource,
  },
  {
    name: 'get_shared_resource_status',
    description: 'Get the lock status and waiting queue for a specific shared resource, or all registered resources if resource_id is omitted. Returns lock holder details (agent_id, title, acquired_at, expires_at) and ordered queue contents.',
    schema: GetSharedResourceStatusArgsSchema,
    handler: getSharedResourceStatus,
  },
  {
    name: 'register_shared_resource',
    description: 'Register a new resource in the shared resource registry, making it available for exclusive locking by agents. Idempotent — re-registering updates description and TTL. Built-in resources (display, chrome-bridge, main-dev-server) are pre-registered automatically.',
    schema: RegisterSharedResourceArgsSchema,
    handler: registerSharedResource,
  },
  {
    name: 'force_release_shared_resource',
    description: 'CTO-only override: Force-release a shared resource lock regardless of who holds it. Blocked for spawned sessions (CLAUDE_SPAWNED_SESSION=true). Use when the lock holder is dead or stuck and you need to unblock waiting agents immediately instead of waiting for TTL expiry. Also purges dead agents from the waiting queue before promoting the next live waiter. Returns the previous holder info and who was promoted next.',
    schema: ForceReleaseSharedResourceArgsSchema,
    handler: forceReleaseSharedResource,
  },
  // Interactive Session Launcher
  {
    name: 'launch_interactive_monitor',
    description: 'Open ANY agent session interactively in a Terminal.app window (macOS only). Kills the headless process, then resumes the session with full conversation history. The CTO can watch in real-time and type to intervene. Accepts 4 input modes: task_id (persistent task prefix — resolves to monitor session), session_id (direct Claude session UUID), queue_id (session queue item ID), or agent_id (agent tracker ID). Use get_session_queue_status to list running sessions and their IDs, or show_session_queue for a visual table.',
    schema: LaunchInteractiveMonitorArgsSchema,
    handler: launchInteractiveMonitor,
  },
  // CTO Bypass Request tools
  {
    name: 'submit_bypass_request',
    description: 'Submit a CTO bypass request to pause your task and request authorization. The CTO will see this in their next session briefing. After submitting, you MUST summarize your work and exit — do NOT continue working.',
    schema: SubmitBypassRequestArgsSchema,
    handler: submitBypassRequest,
  },
  {
    name: 'resolve_bypass_request',
    description: 'Approve or reject a pending CTO bypass request. On approval, persistent tasks are resumed and a monitor is revived with your instructions. On rejection, the task stays paused (persistent) or pending (todo).',
    schema: ResolveBypassRequestArgsSchema,
    handler: resolveBypassRequest,
  },
  {
    name: 'list_bypass_requests',
    description: 'List CTO bypass requests. Defaults to pending requests. Auto-cancels requests for tasks that no longer exist or are completed.',
    schema: ListBypassRequestsArgsSchema,
    handler: listBypassRequests,
  },
  // Blocking Queue tools
  {
    name: 'list_blocking_items',
    description: 'List items in the blocking queue — genuinely work-blocking issues distinct from informational reports. Sorted by blocking_level (plan > persistent_task > task), then by age. Defaults to active items.',
    schema: ListBlockingItemsArgsSchema,
    handler: listBlockingItems,
  },
  {
    name: 'resolve_blocking_item',
    description: 'Mark a blocking queue item as resolved. Returns the updated item.',
    schema: ResolveBlockingItemArgsSchema,
    handler: resolveBlockingItem,
  },
  {
    name: 'get_blocking_summary',
    description: 'Get a compact summary of active blocking queue items: total count, counts by blocking_level (plan/persistent_task/task), and age of the oldest active item. Fast — suitable for notification hooks.',
    schema: GetBlockingSummaryArgsSchema,
    handler: getBlockingSummary,
  },
  // Deferred protected action polling
  {
    name: 'check_deferred_action',
    description: 'Poll the status of a deferred protected action. Spawned agents call this every 30 seconds to wait for CTO approval. Returns status (pending/approved/executing/completed/failed/expired/cancelled), and when completed, the execution_result.',
    schema: CheckDeferredActionArgsSchema,
    handler: async (args: CheckDeferredActionArgs) => {
      try {
        const db = getBypassDb(); // deferred_actions is in the same DB
        const action = db.prepare(
          'SELECT id, server, tool, status, execution_result, execution_error, created_at, approved_at, executed_at FROM deferred_actions WHERE id = ?'
        ).get(args.action_id) as { id: string; server: string; tool: string; status: string; execution_result: string | null; execution_error: string | null; created_at: string; approved_at: string | null; executed_at: string | null } | undefined;
        if (!action) {
          return { error: `Deferred action not found: ${args.action_id}` };
        }
        return {
          id: action.id,
          server: action.server,
          tool: action.tool,
          status: action.status,
          execution_result: action.execution_result ? JSON.parse(action.execution_result) : null,
          execution_error: action.execution_error,
          created_at: action.created_at,
          approved_at: action.approved_at,
          executed_at: action.executed_at,
          hint: action.status === 'pending' ? 'Action awaiting CTO approval. Poll again in 30 seconds.' :
                action.status === 'completed' ? 'Action executed successfully. You may proceed with the result.' :
                action.status === 'failed' ? 'Action execution failed. Check execution_error for details.' :
                action.status === 'approved' ? 'CTO approved — action is being executed. Poll again in 10 seconds.' :
                action.status === 'executing' ? 'Action is currently executing. Poll again in 10 seconds.' :
                `Action is ${action.status}. No further polling needed.`,
        };
      } catch (err) {
        return { error: `Failed to check deferred action: ${(err as Error).message}` };
      }
    },
  },
  // CTO Decision System
  {
    name: 'record_cto_decision',
    description: 'Record a verified CTO decision. The CTO must have ALREADY typed their approval/rejection in chat. This tool verifies the verbatim text exists in the session JSONL (proving the CTO actually typed it), computes an HMAC proof, and stores the decision. Call this AFTER the CTO responds to AskUserQuestion, BEFORE calling resolve_bypass_request or other action tools.',
    schema: RecordCtoDecisionArgsSchema,
    handler: recordCtoDecision,
  },
  {
    name: 'check_cto_decision',
    description: 'Check the status of a CTO decision by decision_id. Returns whether a verified decision exists for a given bypass request, protected action, etc.',
    schema: CheckCtoDecisionArgsSchema,
    handler: checkCtoDecision,
  },
  // Deputy-CTO Monitor bypass resolution tools
  {
    name: 'deputy_resolve_bypass_request',
    description: 'RESTRICTED TO GLOBAL DEPUTY-CTO MONITOR ONLY. Approve or reject a pending bypass request without CTO intervention. Uses 3-layer identity verification (env var + queue DB + persistent task DB) to ensure only the Global Monitor session can call this. Same downstream effects as resolve_bypass_request (resumes tasks, revives monitors, propagates to plans). Does NOT require record_cto_decision — the deputy IS the decision-maker.',
    schema: DeputyResolveBypassRequestArgsSchema,
    handler: deputyResolveBypassRequest,
  },
  {
    name: 'deputy_approve_deferred_action',
    description: 'RESTRICTED TO GLOBAL DEPUTY-CTO MONITOR ONLY. Approve and immediately execute a pending deferred protected action. Blocked for CTO-only actions: release-ledger server, set_lockdown_mode, sign_off_release, cancel_release, record_cto_approval, and tools with "staging" in the name. Uses the MCP shared daemon for execution. 3-layer identity verification enforced.',
    schema: DeputyApproveDeferredActionArgsSchema,
    handler: deputyApproveDeferredAction,
  },
  {
    name: 'deputy_escalate_to_cto',
    description: 'RESTRICTED TO GLOBAL DEPUTY-CTO MONITOR ONLY. Explicitly mark a pending bypass request as requiring CTO attention. Sets deputy_escalated=true and escalation_reason on the request, so it shows prominently in the CTO session briefing. Use this when the request is outside the deputy\'s authority or judgment.',
    schema: DeputyEscalateToCtoArgsSchema,
    handler: deputyEscalateToCto,
  },
  // Self-compaction
  {
    name: 'request_self_compact',
    description: 'Request context compaction for your session. Call this when your context window is getting large (200K+ tokens) or when nudged by the context pressure hook. After calling, you MUST call summarize_work and exit. The system will compact your dead session and revive you with compressed context.',
    schema: RequestSelfCompactArgsSchema,
    handler: requestSelfCompact,
  },
];

const server = new McpServer({
  name: 'agent-tracker',
  version: '9.6.0',  // Deputy-CTO Monitor bypass resolution: deputy_resolve_bypass_request, deputy_approve_deferred_action, deputy_escalate_to_cto
  tools,
});

server.start();
