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
  TASK_RUNNER: 'task-runner',
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
    .describe('Sections to spawn tasks from (e.g., ["CODE-REVIEWER", "TEST-WRITER"]). Deprecated — use category_ids instead.')
    .optional(),
  category_ids: z.array(z.string()).min(1)
    .describe('Category IDs to spawn tasks from (e.g., ["standard", "test-suite"]). Preferred over sections.')
    .optional(),
  taskIds: z.array(z.string())
    .describe('Specific task IDs to spawn (overrides section-based or category-based selection)')
    .optional(),
}).refine(data => data.sections || data.category_ids || data.taskIds, {
  message: 'Either sections, category_ids, or taskIds must be provided',
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
  enabled: z.boolean().describe('Enable (true) or disable (false) focus mode. DEPRECATED — use set_automation_rate instead. Maps enabled=true to rate=none, enabled=false to rate=low.'),
});

export const GetFocusModeArgsSchema = z.object({});

// ============================================================================
// Automation Rate Schemas
// ============================================================================

export const AUTOMATION_RATE_VALUES = ['none', 'low', 'medium', 'high'] as const;
export type AutomationRate = typeof AUTOMATION_RATE_VALUES[number];

export const SetAutomationRateArgsSchema = z.object({
  rate: z.enum(AUTOMATION_RATE_VALUES)
    .describe('Automation rate level: none (blocks all automated spawns), low (5x slower, DEFAULT), medium (2x slower), high (baseline rates)'),
});

export const GetAutomationRateArgsSchema = z.object({});

export const SetLockdownModeArgsSchema = z.object({
  enabled: z.boolean().describe('Enable (true) or disable (false) the interactive session lockdown'),
});

export const GetLockdownModeArgsSchema = z.object({});

export const SetLocalModeArgsSchema = z.object({
  enabled: z.boolean().describe('Enable (true) or disable (false) local prototyping mode. When enabled, remote MCP servers are excluded from .mcp.json and credential-dependent automation is skipped.'),
});

export const GetLocalModeArgsSchema = z.object({});

export const SetDebateModeArgsSchema = z.object({
  enabled: z.boolean().describe('Enable (true) or disable (false) the investigator adversarial-debate flow. When disabled, debate-mode-guard.js denies any Task call that tries to spawn a defender/challenger/judge sub-agent.'),
});

export const GetDebateModeArgsSchema = z.object({});

// ============================================================================
// Automation Toggle Schemas
// ============================================================================

export const AUTOMATION_TOGGLE_KEYS = [
  'userFeedbackEnabled',
  'demoValidationEnabled',
  'dailyFeedbackEnabled',
  'stagingReactiveReviewEnabled',
  'stagingHealthMonitorEnabled',
  'productionHealthMonitorEnabled',
  'standaloneAntipatternHunterEnabled',
  'standaloneComplianceCheckerEnabled',
  'lintCheckerEnabled',
  'taskRunnerEnabled',
  'claudeMdRefactorEnabled',
  'productManagerEnabled',
  'abandonedWorktreeRescueEnabled',
  'worktreeCleanupEnabled',
  'staleWorktreeReaperEnabled',
  'staleTaskCleanupEnabled',
  'orphanProcessReaperEnabled',
  'staleWorkDetectorEnabled',
  'previewPromotionEnabled',
  'globalMonitorEnabled',
] as const;

export type AutomationToggleKey = typeof AUTOMATION_TOGGLE_KEYS[number];

export const SetAutomationToggleArgsSchema = z.object({
  feature: z.enum(AUTOMATION_TOGGLE_KEYS)
    .describe('The automation feature key to toggle'),
  enabled: z.boolean()
    .describe('Enable (true) or disable (false) this automation feature'),
});

export const GetAutomationTogglesArgsSchema = z.object({});

export type SetAutomationToggleArgs = z.infer<typeof SetAutomationToggleArgsSchema>;
export type GetAutomationTogglesArgs = z.infer<typeof GetAutomationTogglesArgsSchema>;

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
  type: z.enum(['HOLD', 'UNBLOCK', 'SUPERSEDE_NOTICE']).optional()
    .describe('Structured signal subtype for machine-readable coordination'),
  metadata: z.record(z.unknown()).optional()
    .describe('Structured metadata for HOLD/UNBLOCK coordination (e.g., blocker_task_id, resolution)'),
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
  session_id: z.string().optional().describe('JSONL session UUID to peek directly (for interactive sessions that have no agent_id/queue_id)'),
  depth: z.number().optional().default(24).describe('KB of JSONL to read per page (default 24). Increase to 32-48 for comprehensive analysis.'),
  offset: z.number().min(0).optional().default(0).describe('Bytes from end of file to start reading. 0 = latest. Use next_offset from previous response to page backward.'),
  include_compaction_context: z.boolean().optional().default(false)
    .describe('Scan backward for compaction summaries when session has been compacted. Adds ~50ms for compacted sessions.'),
  subagent_id: z.string().optional()
    .describe('Peek a specific sub-agent JSONL instead of the parent session. Get available sub-agent IDs from the activeSubagents array in a parent peek.'),
});
export type PeekSessionArgs = z.infer<typeof PeekSessionArgsSchema>;

export const BrowseSessionArgsSchema = z.object({
  agent_id: z.string().optional().describe('Agent ID to browse'),
  session_id: z.string().optional().describe('JSONL session UUID to browse directly (for interactive sessions that have no agent_id)'),
  page_size: z.number().min(5).max(50).optional().default(20).describe('Messages per page (default 20)'),
  before_index: z.number().min(0).optional().describe('Return messages before this index (for paging backward). Omit for latest.'),
  subagent_id: z.string().optional()
    .describe('Browse a specific sub-agent JSONL instead of the parent session. Get available sub-agent IDs from the activeSubagents array in a parent peek_session call.'),
});
export type BrowseSessionArgs = z.infer<typeof BrowseSessionArgsSchema>;

export const UpdateMonitorStateArgsSchema = z.object({
  round_number: z.number().describe('Current monitoring round number'),
  monitored_sessions: z.array(z.string()).describe('Agent IDs being monitored'),
  monitored_task_ids: z.array(z.string()).describe('Persistent task IDs being monitored'),
  monitored_plan_ids: z.array(z.string()).optional().describe('Plan IDs being monitored'),
  current_step: z.string().describe('Current step: PLANS, PERSISTENT_TASKS, TASKS, BROWSE, QUEUE, ASSESS, or SLEEP'),
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

export const ForceReleaseSharedResourceArgsSchema = z.object({
  resource_id: z.string().min(1)
    .describe('ID of the resource to force-release (e.g., "display", "chrome-bridge")'),
  reason: z.string().optional()
    .describe('Reason for force-release (e.g., "holder agent dead", "CTO override"). Logged in audit trail.'),
});

export type AcquireSharedResourceArgs = z.infer<typeof AcquireSharedResourceArgsSchema>;
export type ReleaseSharedResourceArgs = z.infer<typeof ReleaseSharedResourceArgsSchema>;
export type RenewSharedResourceArgs = z.infer<typeof RenewSharedResourceArgsSchema>;
export type GetSharedResourceStatusArgs = z.infer<typeof GetSharedResourceStatusArgsSchema>;
export type RegisterSharedResourceArgs = z.infer<typeof RegisterSharedResourceArgsSchema>;
export type ForceReleaseSharedResourceArgs = z.infer<typeof ForceReleaseSharedResourceArgsSchema>;

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
  pause_duration_minutes: z.number().int().min(1).max(1440).optional()
    .describe('How long to pause before auto-resuming. Pauses ≤60 min auto-resume without CTO approval. Pauses >60 min require CTO approval (use only when genuinely blocked). Omit for indefinite pause (requires CTO approval).'),
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

// Blocking Queue Schemas
export const ListBlockingItemsArgsSchema = z.object({
  status: z.enum(['active', 'resolved', 'all']).optional().default('active')
    .describe('Filter by status. Default: active'),
  plan_id: z.string().optional()
    .describe('Filter by plan ID'),
  limit: z.number().optional().default(20)
    .describe('Max items to return'),
});

export const ResolveBlockingItemArgsSchema = z.object({
  id: z.string().describe('Blocking queue item ID'),
  resolution_context: z.string().optional()
    .describe('Context about the resolution'),
});

export const GetBlockingSummaryArgsSchema = z.object({});

export type ListBlockingItemsArgs = z.infer<typeof ListBlockingItemsArgsSchema>;
export type ResolveBlockingItemArgs = z.infer<typeof ResolveBlockingItemArgsSchema>;
export type GetBlockingSummaryArgs = z.infer<typeof GetBlockingSummaryArgsSchema>;

export const RepairMainTreeDriftArgsSchema = z.object({
  reason: z.string().min(1).max(500).optional()
    .describe('Why repair was requested (logged to audit + injected into the rescue prompt). E.g. "HMR broken — preview-watcher refusing to pull"'),
  force: z.boolean().default(false)
    .describe('If true, enqueue the rescue session even when no drift is detected. Rare; for manual cleanup.'),
  dry_run: z.boolean().default(false)
    .describe('If true, report what WOULD happen without enqueuing a session. Safe to call repeatedly for inspection.'),
});
export type RepairMainTreeDriftArgs = z.infer<typeof RepairMainTreeDriftArgsSchema>;

export const StageMcpServerArgsSchema = z.object({
  name: z.string().min(1).max(100).describe('Server name (e.g., "notion", "my-postgres"). Must not collide with a GENTYR template server name.'),
  config: z.object({
    command: z.string().optional().describe('Command to run (e.g., "npx", "node")'),
    args: z.array(z.string()).optional().describe('Arguments (e.g., ["-y", "@notionhq/notion-mcp-server"])'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables for the server'),
    type: z.string().optional().describe('Transport type (e.g., "http" for HTTP transport)'),
    url: z.string().optional().describe('URL for HTTP transport servers'),
  }).refine(c => !!(c.command || c.url), 'Must provide either command or url'),
});
export type StageMcpServerArgs = z.infer<typeof StageMcpServerArgsSchema>;

export const LaunchInteractiveMonitorArgsSchema = z.object({
  task_id: z.string().min(1).optional().describe('Persistent task UUID or prefix — resolves to the monitor session and kills the headless monitor'),
  session_id: z.string().min(1).optional().describe('Claude session UUID to resume directly in Terminal.app'),
  queue_id: z.string().min(1).optional().describe('Session queue item ID — resolves to agent_id, finds the session, kills the process'),
  agent_id: z.string().min(1).optional().describe('Agent ID — finds the session JSONL by agent marker, kills the process if running'),
  project_dir: z.string().min(1).optional().describe('Target project directory (e.g. ~/git/my-project) — use when monitoring agents from a different project than the current one'),
});
export type LaunchInteractiveMonitorArgs = z.infer<typeof LaunchInteractiveMonitorArgsSchema>;

export const RequestSelfCompactArgsSchema = z.object({
  reason: z.string().optional().describe('Why the agent is requesting compaction (for audit trail)'),
});
export type RequestSelfCompactArgs = z.infer<typeof RequestSelfCompactArgsSchema>;

export const CheckDeferredActionArgsSchema = z.object({
  action_id: z.string().min(1).describe('The deferred action ID returned by the protected-action-gate'),
});
export type CheckDeferredActionArgs = z.infer<typeof CheckDeferredActionArgsSchema>;

// ============================================================================
// CTO Decision System Schemas
// ============================================================================

export const CTO_DECISION_TYPES = [
  'bypass_request',
  'protected_action',
  'lockdown_toggle',
  'local_mode_toggle',
  'release_signoff',
  'staging_override',
  'deputy_bypass_resolution',
  'deputy_deferred_approval',
  'command_bypass',
  'demo_local',
  'deferred_action',
  'protected_action_gate',
  'audit_override',
  'hotfix_promotion',
] as const;

export const RecordCtoDecisionArgsSchema = z.object({
  decision_type: z.enum(CTO_DECISION_TYPES)
    .describe('Category of decision being recorded'),
  decision_id: z.string().min(1)
    .describe('ID of the thing being decided (bypass request ID, deferred action code, release ID, etc.)'),
  verbatim_text: z.string().min(5).max(2000)
    .describe('The CTO verbatim approval/rejection text — copied EXACTLY as they typed it'),
  session_id: z.string().optional()
    .describe('Current session ID (auto-detected from env if omitted)'),
});
export type RecordCtoDecisionArgs = z.infer<typeof RecordCtoDecisionArgsSchema>;

export const CheckCtoDecisionArgsSchema = z.object({
  decision_id: z.string().min(1).describe('The decision_id (bypass request ID, action code, etc.) to check'),
  decision_type: z.enum(CTO_DECISION_TYPES).optional().describe('Filter by decision type'),
});
export type CheckCtoDecisionArgs = z.infer<typeof CheckCtoDecisionArgsSchema>;

// ============================================================================
// CTO Decision Audit Verdict Schemas
// ============================================================================

export const CtoDecisionAuditPassArgsSchema = z.object({
  decision_id: z.string().min(1)
    .describe('The cto_decisions row ID to mark as audit_passed'),
  evidence: z.string().min(10)
    .describe('Concrete evidence supporting the audit pass verdict (min 10 chars)'),
});
export type CtoDecisionAuditPassArgs = z.infer<typeof CtoDecisionAuditPassArgsSchema>;

export const CtoDecisionAuditFailArgsSchema = z.object({
  decision_id: z.string().min(1)
    .describe('The cto_decisions row ID to mark as audit_failed'),
  failure_reason: z.string().min(10)
    .describe('Explanation of why the audit failed (min 10 chars)'),
  evidence: z.string().min(10)
    .describe('Concrete evidence supporting the audit fail verdict (min 10 chars)'),
});
export type CtoDecisionAuditFailArgs = z.infer<typeof CtoDecisionAuditFailArgsSchema>;

// ============================================================================
// Deputy-CTO Monitor Bypass Resolution Schemas
// ============================================================================

export const DeputyResolveBypassRequestArgsSchema = z.object({
  request_id: z.string().min(1)
    .describe('Bypass request ID to resolve'),
  decision: z.enum(['approved', 'rejected'])
    .describe('Deputy decision: approve or reject the bypass request'),
  reasoning: z.string().min(10)
    .describe('Deputy reasoning for the decision (min 10 chars for audit trail)'),
});
export type DeputyResolveBypassRequestArgs = z.infer<typeof DeputyResolveBypassRequestArgsSchema>;

export const DeputyApproveDeferredActionArgsSchema = z.object({
  action_id: z.string().min(1)
    .describe('Deferred action ID to approve'),
  reasoning: z.string().min(10)
    .describe('Deputy reasoning for approving this action (min 10 chars for audit trail)'),
});
export type DeputyApproveDeferredActionArgs = z.infer<typeof DeputyApproveDeferredActionArgsSchema>;

export const DeputyEscalateToCtoArgsSchema = z.object({
  request_id: z.string().min(1)
    .describe('Bypass request ID to escalate to the CTO'),
  reason: z.string().min(10)
    .describe('Explanation of why CTO intervention is required'),
  urgency: z.enum(['routine', 'important', 'critical'])
    .describe('Urgency level: routine (next briefing), important (notify soon), critical (immediate attention)'),
});
export type DeputyEscalateToCtoArgs = z.infer<typeof DeputyEscalateToCtoArgsSchema>;

// ============================================================================
// CTO Alignment Tracking Schemas
// ============================================================================

export const ALIGNMENT_GOAL_STATUSES = ['active', 'completed', 'archived', 'superseded'] as const;
export type AlignmentGoalStatus = (typeof ALIGNMENT_GOAL_STATUSES)[number];

export const ALIGNMENT_GOAL_ARCHIVE_REASONS = ['superseded', 'obsolete', 'completed'] as const;
export type AlignmentGoalArchiveReason = (typeof ALIGNMENT_GOAL_ARCHIVE_REASONS)[number];

export const ALIGNMENT_GOAL_SPEC_REVIEW_OUTCOMES = ['pending', 'specs_proposed', 'no_changes_needed'] as const;
export type AlignmentGoalSpecReviewOutcome = (typeof ALIGNMENT_GOAL_SPEC_REVIEW_OUTCOMES)[number];

export const RecordCtoAlignmentGoalArgsSchema = z.object({
  verbatim_text: z.string().min(10).max(2000)
    .describe('Verbatim substring copied EXACTLY from a CTO user prompt — must be a durable goal/specification statement, not an operational one-shot request'),
  short_title: z.string().min(1).max(200)
    .describe('Brief summary of the goal (1-200 chars) for listings and dashboards'),
  cto_session_id: z.string().optional()
    .describe('Session ID of the CTO session whose JSONL contains the verbatim text. If omitted, the active session is used. When user-alignment runs as a sub-agent, pass the parent CTO session ID; when spawned via a task linked to user prompts, pass the session ID those prompts came from.'),
});
export type RecordCtoAlignmentGoalArgs = z.infer<typeof RecordCtoAlignmentGoalArgsSchema>;

export const ListCtoAlignmentGoalsArgsSchema = z.object({
  status: z.enum([...ALIGNMENT_GOAL_STATUSES, 'all'] as const).optional()
    .describe("Filter by status (default 'active'). Pass 'all' to include every status."),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Max rows to return (default 50, max 200)'),
  include_evidence: z.boolean().optional()
    .describe('When true, includes last_assessment_evidence and verbatim_text in each row. Default false to keep responses small.'),
});
export type ListCtoAlignmentGoalsArgs = z.infer<typeof ListCtoAlignmentGoalsArgsSchema>;

export const GetCtoAlignmentGoalArgsSchema = z.object({
  goal_id: z.string().min(1).describe('The alignment goal ID (ag-...)'),
});
export type GetCtoAlignmentGoalArgs = z.infer<typeof GetCtoAlignmentGoalArgsSchema>;

export const UpdateCtoAlignmentGoalProgressArgsSchema = z.object({
  goal_id: z.string().min(1).describe('The alignment goal ID (ag-...) to update'),
  completion_percentage: z.number().int().min(0).max(100).optional()
    .describe('Current honest assessment of completion (0-100). Omit when only updating spec_review_outcome on an already-completed goal.'),
  evidence: z.object({
    summary: z.string().min(10).max(2000).describe('Plain-English explanation of how the percentage was determined'),
    files_checked: z.array(z.string()).optional().describe('Files examined for evidence'),
    prs_referenced: z.array(z.string()).optional().describe('PR URLs or numbers referenced'),
    notes: z.string().optional().describe('Additional notes'),
  }).optional().describe('Evidence backing the assessment. Required when completion_percentage is provided.'),
  spec_review_outcome: z.enum(ALIGNMENT_GOAL_SPEC_REVIEW_OUTCOMES).optional()
    .describe("Set the spec_review_outcome after a 100% goal has been reviewed against the specs system. Use 'specs_proposed' when create/edit/delete_spec calls were filed, 'no_changes_needed' when the existing specs already cover the goal."),
});
export type UpdateCtoAlignmentGoalProgressArgs = z.infer<typeof UpdateCtoAlignmentGoalProgressArgsSchema>;

export const ArchiveCtoAlignmentGoalArgsSchema = z.object({
  goal_id: z.string().min(1).describe('The alignment goal ID (ag-...) to archive'),
  reason: z.enum(ALIGNMENT_GOAL_ARCHIVE_REASONS)
    .describe("Why the goal is being archived. 'superseded' REQUIRES a verbatim_text proving the CTO changed direction; 'obsolete' for goals no longer relevant; 'completed' for explicit closeout."),
  verbatim_text: z.string().min(10).max(2000).optional()
    .describe("For reason='superseded': REQUIRED verbatim substring from a newer CTO prompt that contradicts or replaces this goal. Verified against the CTO session JSONL the same way as record_cto_alignment_goal."),
  cto_session_id: z.string().optional()
    .describe("Session ID of the CTO session containing the supersession quote (when reason='superseded')."),
});
export type ArchiveCtoAlignmentGoalArgs = z.infer<typeof ArchiveCtoAlignmentGoalArgsSchema>;

export interface AlignmentGoalRow {
  id: string;
  short_title: string;
  verbatim_text?: string;
  cto_session_id: string;
  cto_session_file_hash: string;
  cto_prompt_timestamp: string;
  cto_prompt_line_number: number | null;
  hmac: string;
  status: AlignmentGoalStatus;
  completion_percentage: number;
  last_assessment_at: string | null;
  last_assessment_evidence?: string | null;
  completed_at: string | null;
  spec_review_triggered_at: string | null;
  spec_review_outcome: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  archive_verbatim_text: string | null;
  archive_cto_session_id: string | null;
  recorded_by_agent: string | null;
  created_at: string;
}

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
export type SetAutomationRateArgs = z.infer<typeof SetAutomationRateArgsSchema>;
export type GetAutomationRateArgs = z.infer<typeof GetAutomationRateArgsSchema>;
export type SetLockdownModeArgs = z.infer<typeof SetLockdownModeArgsSchema>;
export type GetLockdownModeArgs = z.infer<typeof GetLockdownModeArgsSchema>;
export type SetLocalModeArgs = z.infer<typeof SetLocalModeArgsSchema>;
export type GetLocalModeArgs = z.infer<typeof GetLocalModeArgsSchema>;
export type SetDebateModeArgs = z.infer<typeof SetDebateModeArgsSchema>;
export type GetDebateModeArgs = z.infer<typeof GetDebateModeArgsSchema>;

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
  /**
   * Deprecated diagnostic — use get_session_queue_status for the
   * authoritative view. This tool counts every `claude` process via
   * pgrep, including monitors/auditors/automated lanes that are NOT
   * subject to the standard concurrency cap.
   */
  _deprecated?: {
    message: string;
    use_instead: string;
  };
  /**
   * Authoritative numbers from session-queue.db (the cap that is actually
   * enforced). Populated when the DB is reachable.
   */
  authoritative?: {
    queueMaxConcurrent: number;
    reservedSlots: number;
    standardRunning: number;
    standardAvailable: number;
    automatedRunning: number;
    persistentRunning: number;
    auditRunning: number;
    gateRunning: number;
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

// ============================================================================
// Token Usage Schemas (PR 4)
// ============================================================================

export const QueryTokenUsageArgsSchema = z.object({
  range: z.enum(['1h', '24h', '7d', '30d', 'all']).optional().default('24h')
    .describe('Time range to query'),
  // Default switched from `source` (legacy spawner code path) to
  // `work_category` (stable kind-of-work that survives revival). See
  // lib/work-category.js for the full category set and descriptions.
  group_by: z.enum([
    'work_category', 'agent_type', 'spawn_origin', 'revived_by', 'debate_role',
    'source', 'lane', 'model', 'category', 'day',
    'persistent_task', 'plan',
  ])
    .optional().default('work_category')
    .describe('Dimension to group results by. Default `work_category` (PR B/C) is the kind of work — survives revival. `spawn_origin` chases through revivals to the original spawner. `revived_by` shows resurrection cost only. `debate_role` splits investigator sub-agents by adversarial-debate role (defender / challenger / judge / not-a-debate). `source` is the legacy spawner code path (kept for backward-compat).'),
  filter_source: z.string().optional().describe('Substring match on source (e.g. "hourly-automation")'),
  filter_work_category: z.string().optional().describe('Exact match on work_category (e.g. "plan-manager")'),
  filter_spawn_origin: z.string().optional().describe('Exact match on spawn_origin (e.g. "plan-activation-spawner")'),
  filter_revived_by: z.string().optional().describe('Exact match on revived_by (e.g. "session-queue-reaper")'),
  filter_debate_role: z.enum(['defender', 'challenger', 'judge']).optional().describe('Restrict to a single adversarial-debate role'),
  only_debate: z.boolean().optional().describe('Restrict to adversarial-debate sub-agent rows only (debate_role IS NOT NULL)'),
  only_revivals: z.boolean().optional().describe('Restrict to revival rows only (is_revival=1)'),
  only_originals: z.boolean().optional().describe('Restrict to original-spawn rows only (is_revival=0)'),
  filter_model: z.string().optional().describe('Exact model id filter'),
  filter_lane: z.string().optional().describe('Lane filter (persistent / standard / automated / gate / audit / subagent / interactive / subprocess)'),
  filter_persistent_task_id: z.number().optional().describe('Persistent task id filter'),
  filter_plan_id: z.string().optional().describe('Plan id filter'),
  limit: z.number().min(1).max(200).optional().default(50)
    .describe('Maximum result rows'),
  include_category_descriptions: z.boolean().optional().default(true)
    .describe('Include WORK_CATEGORY_DESCRIPTIONS in the response (one-line explanation per category)'),
  roll_up_compaction: z.boolean().optional().default(false)
    .describe("PR D: when grouping by work_category, attribute compaction-subagent (`/compact` sub-process) cost to the parent session's work_category. Surfaces the true cost of the work that triggered compaction. Silently ignored unless group_by=work_category."),
});
export type QueryTokenUsageArgs = z.infer<typeof QueryTokenUsageArgsSchema>;

export const TopTokenSessionsArgsSchema = z.object({
  range: z.enum(['1h', '24h', '7d', '30d', 'all']).optional().default('24h'),
  limit: z.number().min(1).max(100).optional().default(20),
});
export type TopTokenSessionsArgs = z.infer<typeof TopTokenSessionsArgsSchema>;

export const TokenAttributionHealthArgsSchema = z.object({});
export type TokenAttributionHealthArgs = z.infer<typeof TokenAttributionHealthArgsSchema>;

export const RevivalCostSummaryArgsSchema = z.object({
  range: z.enum(['1h', '24h', '7d', '30d', 'all']).optional().default('24h')
    .describe('Time range to query'),
  limit: z.number().min(1).max(100).optional().default(50)
    .describe('Maximum revival-mechanism rows in by_revived_by breakdown'),
});
export type RevivalCostSummaryArgs = z.infer<typeof RevivalCostSummaryArgsSchema>;
