/**
 * Types for the Agent Tracker MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const AGENT_TYPES = {
  TODO_PROCESSING: 'todo-processing',
  TODO_SYNTAX_FIX: 'todo-syntax-fix',
  COMPLIANCE_GLOBAL: 'compliance-global',
  COMPLIANCE_LOCAL: 'compliance-local',
  COMPLIANCE_MAPPING_FIX: 'compliance-mapping-fix',
  COMPLIANCE_MAPPING_REVIEW: 'compliance-mapping-review',
  TEST_FAILURE_JEST: 'test-failure-jest',
  TEST_FAILURE_VITEST: 'test-failure-vitest',
  TEST_FAILURE_PLAYWRIGHT: 'test-failure-playwright',
  ANTIPATTERN_HUNTER: 'antipattern-hunter',
  ANTIPATTERN_HUNTER_REPO: 'antipattern-hunter-repo',
  ANTIPATTERN_HUNTER_COMMIT: 'antipattern-hunter-commit',
  FEDERATION_MAPPER: 'federation-mapper',
  DEPUTY_CTO_REVIEW: 'deputy-cto-review',
  PLAN_EXECUTOR: 'plan-executor',
  CLAUDEMD_REFACTOR: 'claudemd-refactor',
  LINT_FIXER: 'lint-fixer',
} as const;

export type AgentType = typeof AGENT_TYPES[keyof typeof AGENT_TYPES];
export const AGENT_TYPE_VALUES = Object.values(AGENT_TYPES) as [string, ...string[]];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const ListSpawnedAgentsArgsSchema = z.object({
  type: z.enum(AGENT_TYPE_VALUES)
    .optional()
    .describe('Filter by agent type (e.g., "test-failure-jest", "todo-processing")'),
  hookType: z.string()
    .optional()
    .describe('Filter by hook type (e.g., "jest-reporter", "compliance-checker")'),
  since: z.string()
    .optional()
    .describe('Filter agents spawned after this ISO timestamp'),
  limit: z.number()
    .optional()
    .default(50)
    .describe('Maximum number of agents to return (default: 50)'),
});

export const GetAgentPromptArgsSchema = z.object({
  agentId: z.string().describe('The agent ID from list_spawned_agents'),
});

export const GetAgentSessionArgsSchema = z.object({
  agentId: z.string().describe('The agent ID from list_spawned_agents'),
  limit: z.number()
    .optional()
    .default(100)
    .describe('Maximum number of messages to return'),
});

export const GetAgentStatsArgsSchema = z.object({});

// ============================================================================
// Session Browser Schemas (Unified Session Browser)
// ============================================================================

export const SESSION_FILTER_VALUES = ['all', 'hook-spawned', 'manual'] as const;
export type SessionFilter = typeof SESSION_FILTER_VALUES[number];

export const SESSION_SORT_VALUES = ['newest', 'oldest', 'largest'] as const;
export type SessionSort = typeof SESSION_SORT_VALUES[number];

export const ListSessionsArgsSchema = z.object({
  limit: z.number()
    .optional()
    .default(50)
    .describe('Maximum number of sessions to return (default: 50)'),
  offset: z.number()
    .optional()
    .default(0)
    .describe('Number of sessions to skip for pagination'),
  filter: z.enum(SESSION_FILTER_VALUES)
    .optional()
    .default('all')
    .describe('Filter sessions: all, hook-spawned (only hook-triggered), or manual (user-initiated)'),
  hookType: z.string()
    .optional()
    .describe('Filter by specific hook type (e.g., "todo-maintenance")'),
  maxAgeDays: z.number()
    .optional()
    .default(30)
    .describe('Only include sessions from the last N days (default: 30). Set to 0 for all sessions.'),
  since: z.string()
    .optional()
    .describe('Filter sessions modified after this ISO timestamp (overrides maxAgeDays)'),
  before: z.string()
    .optional()
    .describe('Filter sessions modified before this ISO timestamp'),
  sortBy: z.enum(SESSION_SORT_VALUES)
    .optional()
    .default('newest')
    .describe('Sort order: newest (default), oldest, or largest'),
});

export const SearchSessionsArgsSchema = z.object({
  query: z.string()
    .min(1)
    .describe('Text to search for in session content'),
  limit: z.number()
    .optional()
    .default(20)
    .describe('Maximum number of sessions to return (default: 20)'),
  filter: z.enum(SESSION_FILTER_VALUES)
    .optional()
    .default('all')
    .describe('Filter sessions: all, hook-spawned, or manual'),
  hookType: z.string()
    .optional()
    .describe('Filter by specific hook type'),
  maxAgeDays: z.number()
    .optional()
    .default(30)
    .describe('Only search sessions from the last N days (default: 30). Set to 0 for all sessions.'),
  since: z.string()
    .optional()
    .describe('Filter sessions modified after this ISO timestamp (overrides maxAgeDays)'),
});

export const GetSessionSummaryArgsSchema = z.object({
  session_id: z.string()
    .describe('The session ID (filename without .jsonl extension)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type ListSpawnedAgentsArgs = z.infer<typeof ListSpawnedAgentsArgsSchema>;
export type GetAgentPromptArgs = z.infer<typeof GetAgentPromptArgsSchema>;
export type GetAgentSessionArgs = z.infer<typeof GetAgentSessionArgsSchema>;
export type GetAgentStatsArgs = z.infer<typeof GetAgentStatsArgsSchema>;

// Session Browser Types
export type ListSessionsArgs = z.infer<typeof ListSessionsArgsSchema>;
export type SearchSessionsArgs = z.infer<typeof SearchSessionsArgsSchema>;
export type GetSessionSummaryArgs = z.infer<typeof GetSessionSummaryArgsSchema>;

export interface AgentRecord {
  id: string;
  type: string;
  hookType: string;
  description: string;
  timestamp: string;
  prompt: string | null;
  projectDir: string;
  metadata?: Record<string, unknown>;
}

export interface AgentHistory {
  agents: AgentRecord[];
  stats: Record<string, unknown>;
}

export interface ListAgentItem {
  id: string;
  index: number;
  type: string;
  hookType: string;
  description: string;
  timestamp: string;
  promptPreview: string;
  hasSession: boolean;
}

export interface ListSpawnedAgentsResult {
  total: number;
  agents: ListAgentItem[];
  availableTypes: string[];
}

export interface GetAgentPromptResult {
  id: string;
  type: string;
  hookType: string;
  description: string;
  timestamp: string;
  prompt: string;
  promptLength: number;
  metadata: Record<string, unknown>;
}

export interface SessionMessage {
  type: string;
  role?: string;
  content?: string;
  toolCalls?: Array<{ name: string; id: string }>;
  toolId?: string;
  timestamp?: string | null;
}

export interface SessionSummary {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  totalMessages: number;
}

export interface FormattedSession {
  messageCount: number;
  summary: SessionSummary;
  messages: SessionMessage[];
  truncated?: boolean;
}

export interface GetAgentSessionResult {
  id: string;
  type: string;
  description: string;
  timestamp: string;
  sessionPath: string | null;
  session: FormattedSession | null;
  message?: string;
}

export interface AgentStats {
  totalSpawns: number;
  byType: Record<string, number>;
  byHookType: Record<string, number>;
  last24Hours: number;
  last7Days: number;
  oldestSpawn: string | null;
  newestSpawn: string | null;
}

export interface ErrorResult {
  error: string;
}

// ============================================================================
// Session Browser Interfaces
// ============================================================================

export interface HookInfo {
  agent_id: string;
  type: string;           // e.g., 'todo-processing'
  hook_type: string;      // e.g., 'todo-maintenance'
  description: string;
}

export interface SessionListItem {
  session_id: string;
  file_path: string;
  mtime: string;
  size_bytes: number;
  hook_info?: HookInfo;   // Present if session matched to hook spawn
}

export interface ListSessionsResult {
  total: number;
  sessions: SessionListItem[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface SearchMatch {
  line_number: number;
  content_preview: string;  // Truncated match context
  message_type: string;     // 'user' | 'assistant' | 'tool_result' | 'unknown'
}

export interface SearchResultItem {
  session_id: string;
  file_path: string;
  mtime: string;
  matches: SearchMatch[];
  hook_info?: HookInfo;
}

export interface SearchSessionsResult {
  query: string;
  total_sessions: number;
  total_matches: number;
  results: SearchResultItem[];
}

export interface SessionSummaryResult {
  session_id: string;
  file_path: string;
  mtime: string;
  size_bytes: number;
  message_counts: {
    user: number;
    assistant: number;
    tool_result: number;
    other: number;
  };
  tools_used: string[];        // List of unique tools called
  duration_estimate?: string;  // First to last timestamp
  hook_info?: HookInfo;
  first_user_message?: string; // Preview of what started the session
}
