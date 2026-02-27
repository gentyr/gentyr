/**
 * Types for the TODO Database MCP Server
 */

import { z } from 'zod';
import { VALID_SECTIONS, TASK_STATUS, TASK_PRIORITY, type ValidSection, type TaskStatus, type TaskPriority } from '../shared/constants.js';

// Re-export for convenience
export { VALID_SECTIONS, TASK_STATUS, TASK_PRIORITY };
export type { ValidSection, TaskStatus, TaskPriority };
export { SECTION_CREATOR_RESTRICTIONS, FORCED_FOLLOWUP_CREATORS } from '../shared/constants.js';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const ListTasksArgsSchema = z.object({
  section: z.enum(VALID_SECTIONS)
    .optional()
    .describe('Filter by section (recommended: use your own section)'),
  status: z.enum(TASK_STATUS)
    .optional()
    .describe('Filter by status'),
  priority: z.enum(TASK_PRIORITY)
    .optional()
    .describe('Filter by priority'),
  limit: z.coerce.number()
    .optional()
    .default(50)
    .describe('Maximum tasks to return'),
});

export const GetTaskArgsSchema = z.object({
  id: z.string().describe('Task UUID'),
});

export const CreateTaskArgsSchema = z.object({
  section: z.enum(VALID_SECTIONS).describe('Section to create task in'),
  title: z.string().describe('Task title (required)'),
  description: z.string().optional().describe('Detailed description'),
  assigned_by: z.string().optional().describe('Your agent name (required for restricted sections like DEPUTY-CTO)'),
  followup_enabled: z.boolean().optional().describe('Enable follow-up task on completion (forced true when assigned_by is deputy-cto)'),
  followup_section: z.enum(VALID_SECTIONS).optional().describe('Section for follow-up task (defaults to same section)'),
  followup_prompt: z.string().optional().describe('Custom follow-up prompt. For deputy-cto tasks, leave empty — auto-generated.'),
  priority: z.enum(TASK_PRIORITY).optional().default('normal')
    .describe('Task priority. "urgent" tasks bypass the 1-hour age filter and dispatch immediately.'),
});

export const StartTaskArgsSchema = z.object({
  id: z.string().describe('Task UUID'),
});

export const CompleteTaskArgsSchema = z.object({
  id: z.string().describe('Task UUID'),
});

export const DeleteTaskArgsSchema = z.object({
  id: z.string().describe('Task UUID'),
});

export const GetSummaryArgsSchema = z.object({});

export const CleanupArgsSchema = z.object({});

export const GetSessionsForTaskArgsSchema = z.object({
  id: z.string().describe('Task UUID'),
});

export const BrowseSessionArgsSchema = z.object({
  session_id: z.string().describe('Session UUID from get_sessions_for_task or agent-tracker'),
  limit: z.coerce.number()
    .optional()
    .default(100)
    .describe('Maximum number of messages to return'),
});

export const GetCompletedSinceArgsSchema = z.object({
  hours: z.coerce.number()
    .min(1)
    .max(168)
    .default(24)
    .describe('Hours to look back (1-168, default 24)'),
});

export const SummarizeWorkArgsSchema = z.object({
  task_id: z.string().optional()
    .describe('Task UUID. Auto-resolved from CLAUDE_AGENT_ID env -> agent-tracker when omitted.'),
  summary: z.string().describe('Summary of what was accomplished'),
  success: z.boolean().describe('Whether the task was completed successfully'),
});

export const GetWorklogArgsSchema = z.object({
  hours: z.coerce.number().min(1).max(720).optional().default(24)
    .describe('Hours to look back (1-720, default 24)'),
  section: z.enum(VALID_SECTIONS).optional()
    .describe('Filter by section'),
  limit: z.coerce.number().min(1).max(100).optional().default(20)
    .describe('Maximum entries to return (1-100, default 20)'),
  include_metrics: z.boolean().optional().default(true)
    .describe('Include 30-day rolling metrics'),
});

export const ListArchivedTasksArgsSchema = z.object({
  section: z.enum(VALID_SECTIONS).optional()
    .describe('Filter by section'),
  limit: z.coerce.number().min(1).max(100).optional().default(20)
    .describe('Maximum tasks to return (1-100, default 20)'),
  hours: z.coerce.number().min(1).max(720).optional().default(24)
    .describe('Hours to look back (1-720, default 24)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type ListTasksArgs = z.infer<typeof ListTasksArgsSchema>;
export type GetTaskArgs = z.infer<typeof GetTaskArgsSchema>;
export type CreateTaskArgs = z.infer<typeof CreateTaskArgsSchema>;
export type StartTaskArgs = z.infer<typeof StartTaskArgsSchema>;
export type CompleteTaskArgs = z.infer<typeof CompleteTaskArgsSchema>;
export type DeleteTaskArgs = z.infer<typeof DeleteTaskArgsSchema>;
export type GetSummaryArgs = z.infer<typeof GetSummaryArgsSchema>;
export type CleanupArgs = z.infer<typeof CleanupArgsSchema>;
export type GetSessionsForTaskArgs = z.infer<typeof GetSessionsForTaskArgsSchema>;
export type BrowseSessionArgs = z.infer<typeof BrowseSessionArgsSchema>;
export type GetCompletedSinceArgs = z.infer<typeof GetCompletedSinceArgsSchema>;
export type SummarizeWorkArgs = z.infer<typeof SummarizeWorkArgsSchema>;
export type GetWorklogArgs = z.infer<typeof GetWorklogArgsSchema>;
export type ListArchivedTasksArgs = z.infer<typeof ListArchivedTasksArgsSchema>;

export interface TaskRecord {
  id: string;
  section: ValidSection;
  status: TaskStatus;
  title: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_by: string | null;
  metadata: string | null;
  created_timestamp: number;
  completed_timestamp: number | null;
  followup_enabled: number;        // 0 or 1 (SQLite boolean)
  followup_section: string | null;
  followup_prompt: string | null;
  priority: string;                // 'normal' | 'urgent'
}

export interface TaskResponse {
  id: string;
  section: ValidSection;
  status: TaskStatus;
  title: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_by: string | null;
  followup_enabled: boolean;
  priority: TaskPriority;
}

export interface ListTasksResult {
  tasks: TaskResponse[];
  total: number;
}

export interface CreateTaskResult extends TaskResponse {
  warning?: string;
}

export interface StartTaskResult {
  id: string;
  status: 'in_progress';
  started_at: string;
}

export interface CompleteTaskResult {
  id: string;
  status: 'completed';
  completed_at: string;
  followup_task_id?: string;
}

export interface DeleteTaskResult {
  deleted: boolean;
  id: string;
  archived?: boolean;
}

export interface SectionStats {
  pending: number;
  in_progress: number;
  completed: number;
}

export interface SummaryResult {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  by_section: Record<string, SectionStats>;
}

export interface CleanupResult {
  stale_starts_cleared: number;
  old_completed_archived: number;
  completed_cap_archived: number;
  archived_pruned: number;
  message: string;
}

export interface CandidateSession {
  session_id: string;
  mtime: string;
  time_diff_minutes: number;
}

export interface GetSessionsForTaskResult {
  task_id: string;
  completed_at: string;
  candidate_sessions: CandidateSession[];
  note: string;
  error?: string;
}

export interface SessionMessage {
  type: string;
  content: string;
  tool_use_id?: string;
}

export interface BrowseSessionResult {
  session_id: string;
  message_count: number;
  messages_returned: number;
  messages: SessionMessage[];
}

export interface ErrorResult {
  error: string;
}

export interface CompletedSinceCount {
  section: string;
  count: number;
}

export interface GetCompletedSinceResult {
  hours: number;
  since: string;
  total: number;
  by_section: CompletedSinceCount[];
}

export interface WorklogEntry {
  id: string;
  task_id: string;
  session_id: string | null;
  agent_id: string | null;
  section: string;
  title: string;
  assigned_by: string | null;
  summary: string;
  success: boolean;
  timestamp_assigned: string | null;
  timestamp_started: string | null;
  timestamp_completed: string;
  duration_assign_to_start_ms: number | null;
  duration_start_to_complete_ms: number | null;
  duration_assign_to_complete_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  tokens_total: number | null;
  created_at: string;
}

export interface WorklogMetrics {
  coverage_entries: number;
  coverage_completed_tasks: number;
  coverage_pct: number;
  success_rate_pct: number | null;
  avg_time_to_start_ms: number | null;
  avg_time_to_complete_from_start_ms: number | null;
  avg_time_to_complete_from_assign_ms: number | null;
  avg_tokens_per_task: number | null;
  cache_hit_pct: number | null;
}

export interface SummarizeWorkResult {
  id: string;
  task_id: string;
  section: string;
  title: string;
  success: boolean;
  tokens_total: number | null;
  duration_assign_to_complete_ms: number | null;
}

export interface GetWorklogResult {
  entries: WorklogEntry[];
  metrics: WorklogMetrics | null;
  total: number;
}

export interface ArchivedTask {
  id: string;
  section: string;
  title: string;
  description: string | null;
  assigned_by: string | null;
  priority: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_timestamp: number;
  completed_timestamp: number | null;
  followup_enabled: number;
  followup_section: string | null;
  followup_prompt: string | null;
  archived_at: string;
  archived_timestamp: number;
}

export interface ListArchivedTasksResult {
  tasks: ArchivedTask[];
  total: number;
}
