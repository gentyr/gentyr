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
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListSpawnedAgentsArgsSchema,
  GetAgentPromptArgsSchema,
  GetAgentSessionArgsSchema,
  GetAgentStatsArgsSchema,
  GetConcurrencyStatusArgsSchema,
  ForceSpawnTasksArgsSchema,
  ListSessionsArgsSchema,
  SearchSessionsArgsSchema,
  GetSessionSummaryArgsSchema,
  AGENT_TYPES,
  type ListSpawnedAgentsArgs,
  type GetAgentPromptArgs,
  type GetAgentSessionArgs,
  type ListSessionsArgs,
  type SearchSessionsArgs,
  type GetSessionSummaryArgs,
  type GetConcurrencyStatusArgs,
  type ForceSpawnTasksArgs,
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
 * Find Claude session transcript for a given spawn
 */
function findSessionFile(agent: AgentRecord): string | null {
  if (!agent.projectDir) {return null;}

  try {
    // Claude stores sessions in ~/.claude/projects/-path-to-project/
    // Normalize path: replace / with - to get leading-dash format (e.g., "-home-user-project")
    const projectPath = agent.projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);

    if (!fs.existsSync(sessionDir)) {
      // Try alternative path format (without leading dash, for backwards compatibility)
      const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
      if (!fs.existsSync(altPath)) {return null;}
    }

    const actualDir = fs.existsSync(sessionDir)
      ? sessionDir
      : path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));

    // List all JSONL files and find one close to spawn time
    const files = fs.readdirSync(actualDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(actualDir, f),
        mtime: fs.statSync(path.join(actualDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {return null;}

    // Find session file created around spawn time (within 5 minutes)
    const spawnTime = new Date(agent.timestamp).getTime();
    const matchingFile = files.find(f => {
      const diff = Math.abs(f.mtime - spawnTime);
      return diff < 5 * 60 * 1000; // Within 5 minutes
    });

    return matchingFile ? matchingFile.path : files[0].path;
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
      if (agent.status === 'reaped') {
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
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
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
    const output = execFileSync('node', [
      scriptPath,
      '--sections', args.sections.join(','),
      '--project-dir', PROJECT_DIR,
      '--max-concurrent', String(args.maxConcurrent),
    ], {
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
];

const server = new McpServer({
  name: 'agent-tracker',
  version: '4.0.0',  // Added concurrency status + force-spawn tools
  tools,
});

server.start();
