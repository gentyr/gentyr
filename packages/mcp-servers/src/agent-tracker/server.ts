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
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { openReadonlyDb } from '../shared/readonly-db.js';
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
  GetUserPromptArgsSchema,
  SearchUserPromptsArgsSchema,
  ListUserPromptsArgsSchema,
  SendSessionSignalArgsSchema,
  BroadcastSignalArgsSchema,
  GetSessionSignalsArgsSchema,
  GetCommsLogArgsSchema,
  AcknowledgeSignalArgsSchema,
  PeekSessionArgsSchema,
  GetSessionActivitySummaryArgsSchema,
  SearchCtoSessionsArgsSchema,
  SuspendSessionArgsSchema,
  ReorderQueueArgsSchema,
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
  type SendSessionSignalArgs,
  type BroadcastSignalArgs,
  type GetSessionSignalsArgs,
  type GetCommsLogArgs,
  type AcknowledgeSignalArgs,
  type PeekSessionArgs,
  type GetSessionActivitySummaryArgs,
  type SearchCtoSessionsArgs,
  type SuspendSessionArgs,
  type ReorderQueueArgs,
  type ForceTriageReportsResult,
  type MonitorAgentsResult,
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
 * Read the last N bytes from a file, returning the content as UTF-8 string.
 */
function readTailBytes(filePath: string, bytes: number = 8192): string {
  const fd = fs.openSync(filePath, 'r');
  const stat = fs.fstatSync(fd);
  const start = Math.max(0, stat.size - bytes);
  const buf = Buffer.alloc(Math.min(bytes, stat.size));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
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
    const scriptArgs = [scriptPath, '--project-dir', PROJECT_DIR, '--max-concurrent', String(args.maxConcurrent)];
    if (args.taskIds) {
      scriptArgs.push('--task-ids', args.taskIds.join(','));
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
    });
  }

  const total = args.agentIds.length;
  const allComplete = completedCount >= total;
  const runningCount = total - completedCount;
  const summary = allComplete
    ? `All ${total} agent(s) complete`
    : `${completedCount}/${total} complete (${runningCount} still running)`;

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
function getSessionQueueStatus(_args: GetSessionQueueStatusArgs): object | ErrorResult {
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

    return {
      hasData: true,
      maxConcurrent,
      running: aliveRunning.length,
      availableSlots: Math.max(0, maxConcurrent - aliveRunning.length),
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
    // Look up agent_id from the queue DB via the queue item's associated session
    if (fs.existsSync(QUEUE_DB_PATH)) {
      let db;
      try {
        db = openReadonlyDb(QUEUE_DB_PATH);
        // The queue item doesn't directly store agent_id, but we can search
        // agent tracker history by correlating the queue item's spawn time
        const row = db.prepare('SELECT id, title, agent_type, spawned_at FROM queue_items WHERE id = ?').get(args.queue_id) as { id: string; title: string; agent_type: string; spawned_at: string | null } | undefined;
        if (!row) {
          return { error: `Queue item not found: ${args.queue_id}` };
        }
        // Attempt to find agent by matching agent type and recent spawn time
        const history = readHistory();
        const candidates = (history.agents ?? []).filter(a => {
          if (row.spawned_at) {
            const queueTime = new Date(row.spawned_at).getTime();
            const agentTime = new Date(a.timestamp).getTime();
            return Math.abs(queueTime - agentTime) < 60_000;
          }
          return false;
        });
        if (candidates.length > 0) agentId = candidates[0].id;
      } finally {
        try { db?.close(); } catch { /* best-effort */ }
      }
    }
  }

  if (!agentId) {
    return { error: 'Must provide agent_id or a resolvable queue_id' };
  }

  // Find the session JSONL file
  const sessionDir = getSessionDir(PROJECT_DIR);
  if (!sessionDir) {
    return { error: 'Session directory not found for this project' };
  }

  const sessionFile = findSessionFileByAgentId(sessionDir, agentId);
  if (!sessionFile) {
    return { error: `Session file not found for agent: ${agentId}` };
  }

  const depthBytes = (args.depth ?? 8) * 1024;
  let tailContent: string;
  try {
    tailContent = readTailBytes(sessionFile, depthBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read session file: ${message}` };
  }

  const entries = parseTailEntries(tailContent);

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
        lastText = texts.join('\n').substring(0, 300);
        // Check for alignment findings
        const joined = texts.join('\n');
        if (joined.toLowerCase().includes('alignment') || joined.toLowerCase().includes('user intent')) {
          alignmentFindings = joined.substring(0, 200);
        }
      }

      for (const block of content) {
        if ((block as any).type !== 'tool_use') continue;
        const toolName = (block as any).name ?? 'unknown';
        const input = (block as any).input;
        let inputStr = '';
        try {
          inputStr = (typeof input === 'string' ? input : JSON.stringify(input) ?? '').substring(0, 80);
        } catch { /* skip */ }

        lastTools.push({ name: toolName, inputPreview: inputStr });
        if (lastTools.length > 5) lastTools.shift();

        if (toolName === 'Agent' || toolName === 'Task') {
          const desc = (input as Record<string, unknown>)?.description;
          if (typeof desc === 'string') spawnedAgents.push(desc.substring(0, 60));
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
  };
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
  }

  let runningRows: RunningQueueRow[];
  try {
    runningRows = db.prepare("SELECT id, title, agent_type, pid, spawned_at, lane FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all() as RunningQueueRow[];
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }

  const now = Date.now();
  const sessionDir = getSessionDir(PROJECT_DIR);
  const history = readHistory();

  const summary = runningRows.map(row => {
    const elapsedMs = row.spawned_at ? now - new Date(row.spawned_at).getTime() : 0;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    // Attempt to resolve agent_id from tracker history by timestamp proximity
    let agentId: string | null = null;
    if (row.spawned_at) {
      const spawnTime = new Date(row.spawned_at).getTime();
      const candidate = (history.agents ?? []).find(a => {
        const aTime = new Date(a.timestamp).getTime();
        return Math.abs(spawnTime - aTime) < 60_000;
      });
      if (candidate) agentId = candidate.id;
    }

    let lastTool: string | null = null;
    let lastActivity: string | null = null;
    let sessionId: string | null = null;

    if (agentId && sessionDir) {
      const sessionFile = findSessionFileByAgentId(sessionDir, agentId);
      if (sessionFile) {
        sessionId = path.basename(sessionFile, '.jsonl');
        try {
          const tail = readTailBytes(sessionFile, 4096);
          const entries = parseTailEntries(tail);
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
      const agentRecord = (history.agents ?? []).find(a => a.id === agentId);
      worktreePath = (agentRecord?.metadata?.worktreePath as string) ?? null;
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
      pid: row.pid,
      pid_alive: row.pid ? (() => { try { process.kill(row.pid!, 0); return true; } catch { return false; } })() : false,
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
// Server Setup
// ============================================================================

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
    description: 'Force-spawn all pending TODO tasks for the specified sections immediately, bypassing age filters, batch limits, cooldowns, and CTO activity gate. Preserves concurrency guard and task tracking.',
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
    description: 'Get the current session queue status: running items (with PID liveness), queued items, capacity info, and 24h throughput stats.',
    schema: GetSessionQueueStatusArgsSchema,
    handler: getSessionQueueStatus,
  },
  {
    name: 'set_max_concurrent_sessions',
    description: 'Update the maximum number of concurrent sessions the queue will spawn (1-50). Takes effect immediately on the next drain cycle.',
    schema: SetMaxConcurrentSessionsArgsSchema,
    handler: setMaxConcurrentSessions,
  },
  {
    name: 'cancel_queued_session',
    description: 'Cancel a queued (not yet running) session queue item by its queue ID. Returns success/failure with reason.',
    schema: CancelQueuedSessionArgsSchema,
    handler: cancelQueuedSession,
  },
  {
    name: 'drain_session_queue',
    description: 'Trigger an immediate drain of the session queue, spawning queued items up to the concurrency limit. Useful after capacity becomes available.',
    schema: DrainSessionQueueArgsSchema,
    handler: drainSessionQueue,
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
    description: 'Peek at the live JSONL tail of a running agent session. Returns last tool calls, last assistant text, spawned sub-agents, git commits, and alignment findings. Provide agent_id or queue_id.',
    schema: PeekSessionArgsSchema,
    handler: peekSession,
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
];

const server = new McpServer({
  name: 'agent-tracker',
  version: '7.0.0',  // Added WS5 session introspection tools
  tools,
});

server.start();
