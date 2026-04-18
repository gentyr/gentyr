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
    .describe('Filter by section (deprecated, use category_id instead)'),
  category_id: z.string()
    .optional()
    .describe('Filter by category ID'),
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
  section: z.enum(VALID_SECTIONS).optional()
    .describe('DEPRECATED: Use category_id instead. Kept for backward compatibility. Resolved to category via deprecated_section mapping.'),
  category_id: z.string().optional()
    .describe('Category ID for the task. Determines the agent workflow sequence. Takes precedence over section.'),
  title: z.string().describe('Task title (required)'),
  description: z.string().optional().describe('Detailed description'),
  assigned_by: z.string().optional().describe('Your agent name (required for restricted sections like DEPUTY-CTO)'),
  followup_enabled: z.boolean().optional().describe('Enable follow-up task on completion (forced true when assigned_by is deputy-cto)'),
  followup_section: z.enum(VALID_SECTIONS).optional().describe('Section for follow-up task (defaults to same section)'),
  followup_prompt: z.string().optional().describe('Custom follow-up prompt. For deputy-cto tasks, leave empty — auto-generated.'),
  priority: z.enum(TASK_PRIORITY).optional().default('normal')
    .describe('Task priority. "urgent" tasks bypass the 1-hour age filter and dispatch immediately.'),
  user_prompt_uuids: z.array(z.string()).optional()
    .describe('UUIDs of user prompts this task derives from. Auto-enables followup_enabled when non-empty.'),
  persistent_task_id: z.string().optional()
    .describe('UUID of the persistent task this sub-task belongs to. Set by persistent monitor sessions.'),
  strict_infra_guidance: z.boolean().optional().default(false)
    .describe('When true, the spawned agent receives strict MCP-only infrastructure instructions (use secret_run_command for builds, MCP tools for demos, no Bash for infrastructure operations).'),
  demo_involved: z.boolean().optional().default(false)
    .describe('Task involves demo scenarios — spawned agent receives demo validation instructions.'),
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
    .describe('Filter by section (deprecated, use category_id instead)'),
  category_id: z.string().optional()
    .describe('Filter by category ID'),
  limit: z.coerce.number().min(1).max(100).optional().default(20)
    .describe('Maximum entries to return (1-100, default 20)'),
  include_metrics: z.boolean().optional().default(true)
    .describe('Include 30-day rolling metrics'),
});

export const ListArchivedTasksArgsSchema = z.object({
  section: z.enum(VALID_SECTIONS).optional()
    .describe('Filter by section (deprecated, use category_id instead)'),
  category_id: z.string().optional()
    .describe('Filter by category ID'),
  limit: z.coerce.number().min(1).max(100).optional().default(20)
    .describe('Maximum tasks to return (1-100, default 20)'),
  hours: z.coerce.number().min(1).max(720).optional().default(24)
    .describe('Hours to look back (1-720, default 24)'),
});

// ============================================================================
// Category Schemas
// ============================================================================

export const CategorySequenceStepSchema = z.object({
  agent_type: z.string().describe('Agent type for this step (e.g., "investigator", "code-writer")'),
  label: z.string().describe('Human-readable label for this step'),
  optional: z.boolean().optional().default(false).describe('Whether this step can be skipped'),
});

export const ListCategoriesArgsSchema = z.object({
  include_deprecated: z.boolean().optional().default(true)
    .describe('Include categories that map to deprecated sections (default: true, shows all)'),
});

export const GetCategoryArgsSchema = z.object({
  id: z.string().describe('Category ID (slug)'),
});

export const CreateCategoryArgsSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Category ID must be lowercase alphanumeric with hyphens')
    .describe('Unique category slug (e.g., "quick-fix", "full-dev")'),
  name: z.string().min(1).describe('Display name'),
  description: z.string().optional().describe('Human-readable description'),
  sequence: z.array(CategorySequenceStepSchema).min(1)
    .describe('Ordered agent sequence for this category'),
  prompt_template: z.string().optional()
    .describe('Markdown prompt template with variable interpolation (${task.id}, ${task.title}, ${agent_sequence_numbered_list})'),
  model: z.enum(['opus', 'sonnet', 'haiku']).optional().default('sonnet')
    .describe('Model for the orchestrator session'),
  creator_restrictions: z.array(z.string()).optional()
    .describe('Allowed assigned_by values. Null/omitted = anyone can create tasks in this category.'),
  force_followup: z.boolean().optional().default(false)
    .describe('Auto-enable followup for all tasks in this category'),
  urgency_authorized: z.boolean().optional().default(true)
    .describe('Whether tasks in this category can be marked urgent'),
  is_default: z.boolean().optional().default(false)
    .describe('Set as default category (clears any existing default)'),
});

export const UpdateCategoryArgsSchema = z.object({
  id: z.string().describe('Category ID to update'),
  name: z.string().min(1).optional().describe('New display name'),
  description: z.string().optional().describe('New description'),
  sequence: z.array(CategorySequenceStepSchema).min(1).optional()
    .describe('New agent sequence'),
  prompt_template: z.string().nullable().optional()
    .describe('New prompt template (null to clear)'),
  model: z.enum(['opus', 'sonnet', 'haiku']).optional()
    .describe('New orchestrator model'),
  creator_restrictions: z.array(z.string()).nullable().optional()
    .describe('New creator restrictions (null to clear)'),
  force_followup: z.boolean().optional(),
  urgency_authorized: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export const DeleteCategoryArgsSchema = z.object({
  id: z.string().describe('Category ID to delete'),
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
export type ListCategoriesArgs = z.infer<typeof ListCategoriesArgsSchema>;
export type GetCategoryArgs = z.infer<typeof GetCategoryArgsSchema>;
export type CreateCategoryArgs = z.infer<typeof CreateCategoryArgsSchema>;
export type UpdateCategoryArgs = z.infer<typeof UpdateCategoryArgsSchema>;
export type DeleteCategoryArgs = z.infer<typeof DeleteCategoryArgsSchema>;

export interface TaskRecord {
  id: string;
  section: string | null;
  status: TaskStatus;
  title: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_by: string | null;
  metadata: string | null;
  created_timestamp: string;
  completed_timestamp: string | null;
  started_timestamp: string | null;
  followup_enabled: number;        // 0 or 1 (SQLite boolean)
  followup_section: string | null;
  followup_prompt: string | null;
  priority: string;                // 'normal' | 'urgent'
  user_prompt_uuids: string | null; // JSON string of UUID array
  persistent_task_id: string | null;
  strict_infra_guidance: number;    // 0 or 1 (SQLite boolean)
  demo_involved: number;            // 0 or 1 (SQLite boolean)
  category_id: string | null;
}

export interface TaskResponse {
  id: string;
  section: string | null;
  status: TaskStatus;
  title: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_by: string | null;
  followup_enabled: boolean;
  priority: TaskPriority;
  user_prompt_uuids: string[] | null;
  persistent_task_id: string | null;
  strict_infra_guidance: boolean;
  demo_involved: boolean;
  category_id: string | null;
  category_name: string | null;
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

export interface CategoryStats {
  name: string;
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
  by_category: Record<string, CategoryStats>;
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

export interface CompletedSinceCategoryCount {
  category_id: string;
  count: number;
}

export interface GetCompletedSinceResult {
  hours: number;
  since: string;
  total: number;
  by_section: CompletedSinceCount[];
  by_category: CompletedSinceCategoryCount[];
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
  section: string | null;
  title: string;
  description: string | null;
  assigned_by: string | null;
  priority: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_timestamp: string;
  completed_timestamp: string | null;
  followup_enabled: number;
  followup_section: string | null;
  followup_prompt: string | null;
  archived_at: string;
  archived_timestamp: string;
}

export interface ListArchivedTasksResult {
  tasks: ArchivedTask[];
  total: number;
}

export interface CategorySequenceStep {
  agent_type: string;
  label: string;
  optional: boolean;
}

export interface CategoryRecord {
  id: string;
  name: string;
  description: string | null;
  sequence: string;  // JSON string
  prompt_template: string | null;
  model: string;
  creator_restrictions: string | null;  // JSON string
  force_followup: number;
  urgency_authorized: number;
  is_default: number;
  deprecated_section: string | null;
  created_at: string;
  updated_at: string;
}

export interface CategoryResponse {
  id: string;
  name: string;
  description: string | null;
  sequence: CategorySequenceStep[];
  prompt_template: string | null;
  model: string;
  creator_restrictions: string[] | null;
  force_followup: boolean;
  urgency_authorized: boolean;
  is_default: boolean;
  deprecated_section: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListCategoriesResult {
  categories: CategoryResponse[];
  total: number;
}
