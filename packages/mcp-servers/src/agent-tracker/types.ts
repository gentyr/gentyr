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
  SESSION_REVIVED: 'session-revived',
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
  limit: z.coerce.number()
    .optional()
    .default(50)
    .describe('Maximum number of agents to return (default: 50)'),
});

export const GetAgentPromptArgsSchema = z.object({
  agentId: z.string().describe('The agent ID from list_spawned_agents'),
});

export const GetAgentSessionArgsSchema = z.object({
  agentId: z.string().describe('The agent ID from list_spawned_agents'),
  limit: z.coerce.number()
    .optional()
    .default(100)
    .describe('Maximum number of messages to return'),
});

export const GetAgentStatsArgsSchema = z.object({});

export const GetConcurrencyStatusArgsSchema = z.object({});

export const ForceSpawnTasksArgsSchema = z.object({
  sections: z.array(z.string()).min(1)
    .describe('Sections to spawn tasks from (e.g., ["CODE-REVIEWER", "TEST-WRITER"])')
    .optional(),
  taskIds: z.array(z.string())
    .describe('Specific task IDs to spawn (overrides section-based selection)')
    .optional(),
}).refine(data => data.sections || data.taskIds, {
  message: 'Either sections or taskIds must be provided',
});

export const ForceTriageReportsArgsSchema = z.object({});

export const MonitorAgentsArgsSchema = z.object({
  agentIds: z.array(z.string()).min(1)
    .describe('Agent IDs to monitor (from force_spawn_tasks response)'),
});

export const GetSessionQueueStatusArgsSchema = z.object({});

export const SetMaxConcurrentSessionsArgsSchema = z.object({
  max: z.coerce.number().min(1).max(50)
    .describe('Maximum concurrent sessions allowed (1-50)'),
});

export const CancelQueuedSessionArgsSchema = z.object({
  queue_id: z.string().describe('Queue item ID to cancel'),
});

export const DrainSessionQueueArgsSchema = z.object({});

export const ActivateQueuedSessionArgsSchema = z.object({
  queue_id: z.string().describe('Queue ID of the queued item to activate immediately'),
});

export const SetReservedSlotsArgsSchema = z.object({
  count: z.coerce.number().min(0).max(10)
    .describe('Number of slots to reserve for persistent/CTO tasks (0-10). Set 0 to disable reservation.'),
  auto_restore_minutes: z.coerce.number().min(0).max(480).optional()
    .describe('Auto-restore to default_value after N minutes (0 = no auto-restore, max 8 hours)'),
  default_value: z.coerce.number().min(0).max(10).optional().default(0)
    .describe('Value to restore to when auto_restore_minutes elapses (default: 0)'),
});

export const GetReservedSlotsArgsSchema = z.object({});

export const SetFocusModeArgsSchema = z.object({
  enabled: z.boolean().describe('Enable (true) or disable (false) focus mode'),
});

export const GetFocusModeArgsSchema = z.object({});

export const SetLockdownModeArgsSchema = z.object({
  enabled: z.boolean().describe('Enable (true) or disable (false) the interactive session lockdown'),
  cto_bypass: z.boolean().optional()
    .describe('Required when disabling lockdown. WARNING: Only set to true if directly asked by the CTO.'),
});

export const GetLockdownModeArgsSchema = z.object({});

// ============================================================================
// Session Signal Schemas
// ============================================================================

const SIGNAL_TIER_VALUES = ['note', 'instruction', 'directive'] as const;

// ============================================================================
// Summary Subscription Schemas
// ============================================================================

const DETAIL_LEVEL_VALUES = ['short', 'detailed', 'verbatim'] as const;

export const SubscribeSessionSummariesArgsSchema = z.object({
  target_agent_id: z.string().describe('Agent ID of the session to subscribe to'),
  detail_level: z.enum(DETAIL_LEVEL_VALUES).default('detailed')
    .describe('Subscription tier: short (2-4 sentence summary), detailed (full summary + context), verbatim (full summary + recent raw session messages)'),
});

export const UnsubscribeSessionSummariesArgsSchema = z.object({
  target_agent_id: z.string().describe('Agent ID of the session to unsubscribe from'),
});

export const ListSummarySubscriptionsArgsSchema = z.object({
  agent_id: z.string().optional().describe('Agent ID to list subscriptions for (defaults to caller)'),
});

export const SendSessionSignalArgsSchema = z.object({
  target: z.string().describe('Target agent ID to send the signal to'),
  message: z.string().min(1).describe('The message to send to the target agent'),
  tier: z.enum(SIGNAL_TIER_VALUES)
    .describe('Signal tier: note (FYI), instruction (Deputy-CTO urgent), directive (CTO mandatory)'),
});

export const BroadcastSignalArgsSchema = z.object({
  message: z.string().min(1).describe('The message to broadcast to all running agents'),
  tier: z.enum(SIGNAL_TIER_VALUES)
    .describe('Signal tier: note (FYI), instruction (Deputy-CTO urgent), directive (CTO mandatory)'),
  exclude_agent_ids: z.array(z.string())
    .optional()
    .describe('Agent IDs to exclude from the broadcast'),
});

export const GetSessionSignalsArgsSchema = z.object({
  agent_id: z.string().describe('The agent ID to get signals for'),
  status: z.enum(['pending', 'read', 'all'])
    .optional()
    .default('all')
    .describe('Filter by signal status: pending (unread), read, or all (default: all)'),
});

export const GetCommsLogArgsSchema = z.object({
  since: z.string()
    .optional()
    .describe('ISO timestamp — only return entries after this time'),
  tier: z.enum(SIGNAL_TIER_VALUES)
    .optional()
    .describe('Filter by signal tier'),
  limit: z.coerce.number()
    .optional()
    .default(50)
    .describe('Maximum number of log entries to return (default: 50)'),
});

export const AcknowledgeSignalArgsSchema = z.object({
  signal_id: z.string().describe('The signal ID to acknowledge (from the signal object)'),
});

// ============================================================================
// User Prompt Index Schemas
// ============================================================================

export const GetUserPromptArgsSchema = z.object({
  uuid: z.string().describe('UUID of the user prompt to retrieve'),
  nearby: z.coerce.number()
    .optional()
    .describe('Number of surrounding messages (all types) to include for context'),
});

export const SearchUserPromptsArgsSchema = z.object({
  query: z.string().min(1).describe('Search query text'),
  limit: z.coerce.number()
    .optional()
    .default(20)
    .describe('Maximum number of results (default: 20)'),
  maxAgeDays: z.coerce.number()
    .optional()
    .describe('Only search prompts from the last N days'),
  since: z.string()
    .optional()
    .describe('Filter prompts after this ISO timestamp (overrides maxAgeDays)'),
  use_fts: z.boolean()
    .optional()
    .default(true)
    .describe('Use FTS5 ranked search (default: true). Set false for LIKE fallback.'),
});

export const ListUserPromptsArgsSchema = z.object({
  session_id: z.string()
    .optional()
    .describe('Filter by session ID'),
  limit: z.coerce.number()
    .optional()
    .default(50)
    .describe('Maximum number of prompts to return (default: 50)'),
  maxAgeDays: z.coerce.number()
    .optional()
    .describe('Only include prompts from the last N days'),
});

// ============================================================================
// Session Browser Schemas (Unified Session Browser)
// ============================================================================

export const SESSION_FILTER_VALUES = ['all', 'hook-spawned', 'manual'] as const;
export type SessionFilter = typeof SESSION_FILTER_VALUES[number];

export const SESSION_SORT_VALUES = ['newest', 'oldest', 'largest'] as const;
export type SessionSort = typeof SESSION_SORT_VALUES[number];

export const ListSessionsArgsSchema = z.object({
  limit: z.coerce.number()
    .optional()
    .default(50)
    .describe('Maximum number of sessions to return (default: 50)'),
  offset: z.coerce.number()
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
  maxAgeDays: z.coerce.number()
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
  limit: z.coerce.number()
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
  maxAgeDays: z.coerce.number()
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
// WS5 Tool Schemas
// ============================================================================

export const PeekSessionArgsSchema = z.object({
  agent_id: z.string().optional().describe('Agent ID to peek'),
  queue_id: z.string().optional().describe('Queue ID to peek'),
  depth: z.number().optional().default(24).describe('KB of JSONL to read per page (default 24). Increase to 32-48 for comprehensive analysis.'),
  offset: z.number().min(0).optional().default(0).describe('Bytes from end of file to start reading. 0 = latest. Use next_offset from previous response to page backward.'),
  include_compaction_context: z.boolean().optional().default(false)
    .describe('Scan backward for compaction summaries when session has been compacted. Adds ~50ms for compacted sessions.'),
});
export type PeekSessionArgs = z.infer<typeof PeekSessionArgsSchema>;

export const BrowseSessionArgsSchema = z.object({
  agent_id: z.string().describe('Agent ID to browse'),
  page_size: z.number().min(5).max(50).optional().default(20).describe('Messages per page (default 20)'),
  before_index: z.number().min(0).optional().describe('Return messages before this index (for paging backward). Omit for latest.'),
});
export type BrowseSessionArgs = z.infer<typeof BrowseSessionArgsSchema>;

export const UpdateMonitorStateArgsSchema = z.object({
  round_number: z.number().describe('Current monitoring round number'),
  monitored_sessions: z.array(z.string()).describe('Agent IDs being monitored'),
  monitored_task_ids: z.array(z.string()).describe('Persistent task IDs being monitored'),
  current_step: z.string().describe('Current step: OVERVIEW, BROWSE, QUEUE, ASSESS, or SLEEP'),
});
export type UpdateMonitorStateArgs = z.infer<typeof UpdateMonitorStateArgsSchema>;

export const StopMonitoringArgsSchema = z.object({});
export type StopMonitoringArgs = z.infer<typeof StopMonitoringArgsSchema>;

export const GetSessionActivitySummaryArgsSchema = z.object({});
export type GetSessionActivitySummaryArgs = z.infer<typeof GetSessionActivitySummaryArgsSchema>;

export const SearchCtoSessionsArgsSchema = z.object({
  query: z.string().describe('Search query'),
  limit: z.number().optional().default(10).describe('Max results'),
});
export type SearchCtoSessionsArgs = z.infer<typeof SearchCtoSessionsArgsSchema>;

export const SuspendSessionArgsSchema = z.object({
  agent_id: z.string().optional().describe('Agent ID to suspend'),
  queue_id: z.string().optional().describe('Queue ID to suspend'),
  requeue_priority: z.string().optional().default('urgent').describe('Priority for resumed session'),
});
export type SuspendSessionArgs = z.infer<typeof SuspendSessionArgsSchema>;

export const KillSessionArgsSchema = z.object({
  queue_id: z.string().optional().describe('Queue ID of the session to kill'),
  agent_id: z.string().optional().describe('Agent ID of the session to kill'),
  reason: z.string().optional().default('manually killed by CTO').describe('Reason for killing'),
});
export type KillSessionArgs = z.infer<typeof KillSessionArgsSchema>;

export const RestartSessionArgsSchema = z.object({
  queue_id: z.string().describe('Queue ID of the session to restart'),
  priority: z.string().optional().default('urgent').describe('Priority for restarted session: cto, critical, urgent, normal, low'),
});
export type RestartSessionArgs = z.infer<typeof RestartSessionArgsSchema>;

export const ReorderQueueArgsSchema = z.object({
  queue_id: z.string().describe('Queue item ID'),
  new_priority: z.string().describe('New priority: cto, critical, urgent, normal, low'),
});
export type ReorderQueueArgs = z.infer<typeof ReorderQueueArgsSchema>;

// ============================================================================
// Persistent Task Inspection Schemas
// ============================================================================

// ============================================================================
// Shared Resource Registry Schemas
// ============================================================================

export const AcquireSharedResourceArgsSchema = z.object({
  resource_id: z.string().min(1)
    .describe('ID of the resource to lock (e.g., "display", "chrome-bridge", "main-dev-server")'),
  title: z.string().optional()
    .describe('Human-readable description of why the resource is being acquired (e.g., "Demo: checkout flow")'),
  ttl_minutes: z.coerce.number().min(1).max(480).optional()
    .describe('Lock TTL in minutes. Defaults to the resource registry value (usually 15 min). Max 8 hours.'),
});

export const ReleaseSharedResourceArgsSchema = z.object({
  resource_id: z.string().min(1)
    .describe('ID of the resource to release'),
});

export const RenewSharedResourceArgsSchema = z.object({
  resource_id: z.string().min(1)
    .describe('ID of the resource whose lock TTL to renew'),
  ttl_minutes: z.coerce.number().min(1).max(480).optional()
    .describe('New TTL from now in minutes. Defaults to the resource registry value.'),
});

export const GetSharedResourceStatusArgsSchema = z.object({
  resource_id: z.string().optional()
    .describe('ID of a specific resource to query. Omit to get status of ALL registered resources.'),
});

export const RegisterSharedResourceArgsSchema = z.object({
  resource_id: z.string().min(1)
    .describe('Unique resource identifier (e.g., "gpu-0", "redis-test-db")'),
  description: z.string().min(1)
    .describe('Human-readable description of what this resource represents'),
  default_ttl_minutes: z.coerce.number().min(1).max(480).optional().default(15)
    .describe('Default lock TTL in minutes when no TTL is specified at acquire time (default: 15)'),
});

export type AcquireSharedResourceArgs = z.infer<typeof AcquireSharedResourceArgsSchema>;
export type ReleaseSharedResourceArgs = z.infer<typeof ReleaseSharedResourceArgsSchema>;
export type RenewSharedResourceArgs = z.infer<typeof RenewSharedResourceArgsSchema>;
export type GetSharedResourceStatusArgs = z.infer<typeof GetSharedResourceStatusArgsSchema>;
export type RegisterSharedResourceArgs = z.infer<typeof RegisterSharedResourceArgsSchema>;

export const InspectPersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID (or prefix)'),
  depth_kb: z.coerce.number().min(1).max(256).optional().default(32)
    .describe('KB of JSONL tail to read for monitor session (children get half). Default: 32'),
  running_only: z.coerce.boolean().optional().default(false)
    .describe('If true, only include running child sessions in the response'),
  max_children: z.coerce.number().optional().default(10)
    .describe('Maximum number of child sessions to include JSONL excerpts for (default: 10)'),
});
export type InspectPersistentTaskArgs = z.infer<typeof InspectPersistentTaskArgsSchema>;

// CTO Bypass Request Schemas
export const SubmitBypassRequestArgsSchema = z.object({
  task_type: z.enum(['persistent', 'todo'])
    .describe('Type of task: "persistent" for persistent tasks, "todo" for todo-db tasks'),
  task_id: z.string().min(1)
    .describe('The persistent task ID or todo task ID requiring CTO authorization'),
  category: z.enum(['destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'])
    .default('general')
    .describe('Category of bypass request'),
  summary: z.string().min(10).max(500)
    .describe('1-3 sentence explanation of what CTO authorization is needed for'),
  details: z.string().max(5000).optional()
    .describe('Extended context: what was attempted, options considered, file paths involved'),
});
export type SubmitBypassRequestArgs = z.infer<typeof SubmitBypassRequestArgsSchema>;

export const ResolveBypassRequestArgsSchema = z.object({
  request_id: z.string().min(1)
    .describe('Bypass request ID to resolve (from session briefing or list_bypass_requests)'),
  decision: z.enum(['approved', 'rejected'])
    .describe('CTO decision: approve or reject the bypass request'),
  context: z.string().min(1).max(5000)
    .describe('CTO instructions/context for the agent — included in the revival prompt (approved) or rejection notice (rejected)'),
});
export type ResolveBypassRequestArgs = z.infer<typeof ResolveBypassRequestArgsSchema>;

export const ListBypassRequestsArgsSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all'])
    .default('pending')
    .describe('Filter by status (default: pending)'),
  limit: z.coerce.number().min(1).max(100).optional().default(20)
    .describe('Maximum number of requests to return'),
});
export type ListBypassRequestsArgs = z.infer<typeof ListBypassRequestsArgsSchema>;

export const LaunchInteractiveMonitorArgsSchema = z.object({
  task_id: z.string().min(1).optional().describe('Persistent task UUID or prefix — resolves to the monitor session and kills the headless monitor'),
  session_id: z.string().min(1).optional().describe('Claude session UUID to resume directly in Terminal.app'),
  queue_id: z.string().min(1).optional().describe('Session queue item ID — resolves to agent_id, finds the session, kills the process'),
  agent_id: z.string().min(1).optional().describe('Agent ID — finds the session JSONL by agent marker, kills the process if running'),
  project_dir: z.string().min(1).optional().describe('Target project directory (e.g. ~/git/my-project) — use when monitoring agents from a different project than the current one'),
});
export type LaunchInteractiveMonitorArgs = z.infer<typeof LaunchInteractiveMonitorArgsSchema>;

// ============================================================================
// Type Definitions
// ============================================================================

export type ListSpawnedAgentsArgs = z.infer<typeof ListSpawnedAgentsArgsSchema>;
export type GetAgentPromptArgs = z.infer<typeof GetAgentPromptArgsSchema>;
export type GetAgentSessionArgs = z.infer<typeof GetAgentSessionArgsSchema>;
export type GetAgentStatsArgs = z.infer<typeof GetAgentStatsArgsSchema>;
export type GetConcurrencyStatusArgs = z.infer<typeof GetConcurrencyStatusArgsSchema>;
export type ForceSpawnTasksArgs = z.infer<typeof ForceSpawnTasksArgsSchema>;
export type ForceTriageReportsArgs = z.infer<typeof ForceTriageReportsArgsSchema>;
export type MonitorAgentsArgs = z.infer<typeof MonitorAgentsArgsSchema>;

// Session Browser Types
export type ListSessionsArgs = z.infer<typeof ListSessionsArgsSchema>;
export type SearchSessionsArgs = z.infer<typeof SearchSessionsArgsSchema>;
export type GetSessionSummaryArgs = z.infer<typeof GetSessionSummaryArgsSchema>;

// Session Queue Types
export type GetSessionQueueStatusArgs = z.infer<typeof GetSessionQueueStatusArgsSchema>;
export type SetMaxConcurrentSessionsArgs = z.infer<typeof SetMaxConcurrentSessionsArgsSchema>;
export type CancelQueuedSessionArgs = z.infer<typeof CancelQueuedSessionArgsSchema>;
export type DrainSessionQueueArgs = z.infer<typeof DrainSessionQueueArgsSchema>;
export type ActivateQueuedSessionArgs = z.infer<typeof ActivateQueuedSessionArgsSchema>;
export type SetReservedSlotsArgs = z.infer<typeof SetReservedSlotsArgsSchema>;
export type GetReservedSlotsArgs = z.infer<typeof GetReservedSlotsArgsSchema>;
export type SetFocusModeArgs = z.infer<typeof SetFocusModeArgsSchema>;
export type GetFocusModeArgs = z.infer<typeof GetFocusModeArgsSchema>;
export type SetLockdownModeArgs = z.infer<typeof SetLockdownModeArgsSchema>;
export type GetLockdownModeArgs = z.infer<typeof GetLockdownModeArgsSchema>;

// Session Signal Types
export type SendSessionSignalArgs = z.infer<typeof SendSessionSignalArgsSchema>;
export type BroadcastSignalArgs = z.infer<typeof BroadcastSignalArgsSchema>;
export type GetSessionSignalsArgs = z.infer<typeof GetSessionSignalsArgsSchema>;
export type GetCommsLogArgs = z.infer<typeof GetCommsLogArgsSchema>;
export type AcknowledgeSignalArgs = z.infer<typeof AcknowledgeSignalArgsSchema>;

// Summary Subscription Types
export type SubscribeSessionSummariesArgs = z.infer<typeof SubscribeSessionSummariesArgsSchema>;
export type UnsubscribeSessionSummariesArgs = z.infer<typeof UnsubscribeSessionSummariesArgsSchema>;
export type ListSummarySubscriptionsArgs = z.infer<typeof ListSummarySubscriptionsArgsSchema>;

// User Prompt Index Types
export type GetUserPromptArgs = z.infer<typeof GetUserPromptArgsSchema>;
export type SearchUserPromptsArgs = z.infer<typeof SearchUserPromptsArgsSchema>;
export type ListUserPromptsArgs = z.infer<typeof ListUserPromptsArgsSchema>;

// WS5 Types (already declared inline above with the schemas)

export interface UserPromptResult {
  uuid: string;
  session_id: string;
  timestamp: string;
  content: string;
  nearby_messages?: Array<{
    type: string;
    content: string;
    timestamp: string | null;
  }>;
}

export interface SearchUserPromptsResultItem {
  uuid: string;
  session_id: string;
  timestamp: string;
  content_preview: string;
  rank?: number;
}

export interface SearchUserPromptsResult {
  query: string;
  total: number;
  results: SearchUserPromptsResultItem[];
}

export interface ListUserPromptsResult {
  total: number;
  prompts: Array<{
    uuid: string;
    session_id: string;
    timestamp: string;
    content_preview: string;
  }>;
}

export interface AgentRecord {
  id: string;
  type: string;
  hookType: string;
  description: string;
  timestamp: string;
  prompt: string | null;
  projectDir: string;
  metadata?: Record<string, unknown>;
  pid?: number;
  status?: 'running' | 'completed' | 'reaped';
  sessionFile?: string;
  reapedAt?: string;
  reapReason?: string;
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
  pid?: number;
  status?: 'running' | 'completed' | 'reaped';
  reapedAt?: string;
  reapReason?: string;
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
  byStatus: Record<string, number>;
  totalReaped: number;
}

export interface ErrorResult {
  error: string;
}

export interface ConcurrencyStatusResult {
  running: number;
  maxConcurrent: number;
  available: number;
  trackedRunning: {
    byType: Record<string, number>;
  };
}

export interface ForceSpawnTasksResult {
  spawned: Array<{
    taskId: string;
    title: string;
    section: string;
    agent: string;
    agentId: string;
    pid: number;
  }>;
  skipped: Array<{
    taskId?: string;
    title?: string;
    section?: string;
    reason: string;
  }>;
  errors: Array<{
    taskId?: string;
    title?: string;
    message: string;
  }>;
}

export interface ForceTriageReportsResult {
  agentId: string | null;
  pid: number | null;
  sessionId: string | null;
  pendingReports: number;
  queueId?: string | null;  // Session queue ID (set when enqueued via session-queue)
  message?: string;
  error?: string;
  deduplicated?: boolean;  // G011: true when returning existing agent instead of spawning
}

export interface AgentProgress {
  currentStage: string | null;
  stageIndex: number;
  totalStages: number;
  progressPercent: number;
  stagesCompleted: string[];
  lastToolCall: string | null;
  lastToolAt: string | null;
  staleSinceMinutes: number | null;
}

export interface WorktreeGitState {
  branch: string | null;
  commitCount: number;
  lastCommitMessage: string | null;
  prUrl: string | null;
  prStatus: string | null;
  merged: boolean;
}

export interface MonitorAgentsResult {
  agents: Array<{
    agentId: string;
    status: 'running' | 'completed' | 'reaped' | 'unknown';
    pid: number | null;
    pidAlive: boolean;
    taskId: string | null;
    taskStatus: string | null;
    taskTitle: string | null;
    elapsedSeconds: number;
    section: string | null;
    progress: AgentProgress | null;
    worktreeGit: WorktreeGitState | null;
  }>;
  allComplete: boolean;
  summary: string;
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
