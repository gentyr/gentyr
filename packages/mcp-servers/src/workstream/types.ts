/**
 * Types for the Workstream Manager MCP Server
 *
 * Manages queue-level dependencies, priority reordering, and workstream
 * change history across the session queue and todo-db.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const DEP_STATUS = ['active', 'satisfied', 'removed', 'all'] as const;
export type DepStatus = (typeof DEP_STATUS)[number];

export const PRIORITY_LEVELS = ['critical', 'urgent', 'normal', 'low'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const CHANGE_TYPES = [
  'dependency_added',
  'dependency_removed',
  'dependency_satisfied',
  'priority_changed',
  'assessment_clear',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

// ============================================================================
// Tool Schemas
// ============================================================================

export const AddDependencyArgsSchema = z.object({
  blocked_task_id: z.string().min(1).describe('Task ID (from todo.db) that must wait'),
  blocker_task_id: z.string().min(1).describe('Task ID (from todo.db) that must complete first'),
  reasoning: z
    .string()
    .min(10)
    .describe('Explanation for this dependency (mandatory, min 10 chars)'),
});

export const RemoveDependencyArgsSchema = z.object({
  dependency_id: z.string().min(1).describe('Dependency ID to remove (dep-xxxx)'),
  reasoning: z
    .string()
    .min(10)
    .describe('Reason for removing this dependency (mandatory, min 10 chars)'),
});

export const ListDependenciesArgsSchema = z.object({
  task_id: z
    .string()
    .optional()
    .describe('Filter to dependencies for this task ID (blocked or blocker)'),
  status: z
    .enum(['active', 'satisfied', 'removed', 'all'])
    .optional()
    .default('active')
    .describe("Filter by status: 'active', 'satisfied', 'removed', or 'all'"),
});

export const GetQueueContextArgsSchema = z.object({});

export const ReorderItemArgsSchema = z.object({
  queue_id: z.string().min(1).describe('Queue item ID (sq-xxxx) to reorder'),
  new_priority: z
    .enum(['critical', 'urgent', 'normal', 'low'])
    .describe('New priority level'),
  reasoning: z
    .string()
    .min(10)
    .describe('Explanation for the priority change (mandatory, min 10 chars)'),
});

export const RecordAssessmentArgsSchema = z.object({
  task_id: z.string().min(1).describe('Task ID being assessed'),
  queue_id: z.string().optional().describe('Optional queue item ID if known'),
  reasoning: z
    .string()
    .min(10)
    .describe('Assessment rationale — what was checked and why it is clear (mandatory, min 10 chars)'),
});

export const GetChangeLogArgsSchema = z.object({
  since: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp — only return changes after this time'),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50).describe('Max records to return (default 50)'),
});

export const RegisterSupersessionArgsSchema = z.object({
  original_task_id: z.string().min(1).describe('Task ID being superseded'),
  superseding_task_id: z.string().min(1).describe('Task ID that supersedes the original'),
  reason: z.string().min(10).describe('Why this task supersedes the original (min 10 chars)'),
});

export const ListSupersessionsArgsSchema = z.object({
  task_id: z.string().optional().describe('Filter by task ID (matches both original and superseding)'),
  status: z.enum(['active', 'resolved']).optional().describe('Filter by status'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
});

// ============================================================================
// Inferred Arg Types
// ============================================================================

export type AddDependencyArgs = z.infer<typeof AddDependencyArgsSchema>;
export type RemoveDependencyArgs = z.infer<typeof RemoveDependencyArgsSchema>;
export type ListDependenciesArgs = z.infer<typeof ListDependenciesArgsSchema>;
export type GetQueueContextArgs = z.infer<typeof GetQueueContextArgsSchema>;
export type ReorderItemArgs = z.infer<typeof ReorderItemArgsSchema>;
export type RecordAssessmentArgs = z.infer<typeof RecordAssessmentArgsSchema>;
export type GetChangeLogArgs = z.infer<typeof GetChangeLogArgsSchema>;
export type RegisterSupersessionArgs = z.infer<typeof RegisterSupersessionArgsSchema>;
export type ListSupersessionsArgs = z.infer<typeof ListSupersessionsArgsSchema>;

// ============================================================================
// Database Record Types
// ============================================================================

export interface QueueDependencyRecord {
  id: string;
  blocked_queue_id: string | null;
  blocked_task_id: string;
  blocker_queue_id: string | null;
  blocker_task_id: string;
  status: string;
  created_by: string;
  reasoning: string;
  created_at: string;
  satisfied_at: string | null;
}

export interface WorkstreamChangeRecord {
  id: string;
  change_type: string;
  queue_id: string | null;
  task_id: string | null;
  details: string;
  reasoning: string;
  agent_id: string | null;
  created_at: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

export interface AddDependencyResult {
  dependency_id: string;
  blocked_task_id: string;
  blocker_task_id: string;
  status: string;
  message: string;
}

export interface RemoveDependencyResult {
  dependency_id: string;
  status: string;
  message: string;
}

export interface DependencyListItem {
  id: string;
  blocked_task_id: string;
  blocked_task_title: string | null;
  blocker_task_id: string;
  blocker_task_title: string | null;
  status: string;
  reasoning: string;
  created_at: string;
  satisfied_at: string | null;
}

export interface ListDependenciesResult {
  dependencies: DependencyListItem[];
  total: number;
}

export interface QueueItemContext {
  id: string;
  status: string;
  priority: string;
  title: string;
  agent_type: string;
  task_id: string | null;
  task_title: string | null;
  dependency_status: 'BLOCKED' | 'CLEAR' | 'PENDING' | null;
  blockers: string[];
  enqueued_at: string;
  spawned_at: string | null;
}

export interface GetQueueContextResult {
  running: QueueItemContext[];
  queued: QueueItemContext[];
  suspended: QueueItemContext[];
  active_dependencies: DependencyListItem[];
  summary: string;
}

export interface ReorderItemResult {
  queue_id: string;
  old_priority: string | null;
  new_priority: string;
  message: string;
}

export interface RecordAssessmentResult {
  change_id: string;
  task_id: string;
  message: string;
}

export interface ChangeLogItem {
  id: string;
  change_type: string;
  queue_id: string | null;
  task_id: string | null;
  task_title: string | null;
  details: string;
  reasoning: string;
  agent_id: string | null;
  created_at: string;
}

export interface GetChangeLogResult {
  changes: ChangeLogItem[];
  total: number;
}

export interface TaskSupersessionRecord {
  id: string;
  original_task_id: string;
  superseding_task_id: string;
  reason: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface RegisterSupersessionResult {
  id: string;
  original_task_id: string;
  superseding_task_id: string;
  status: string;
  immediate_resolution: boolean;
  message: string;
}

export interface RegisterSupersessionExistsResult {
  exists: true;
  id: string;
  status: string;
  message: string;
}

export interface ListSupersessionsResult {
  count: number;
  supersessions: TaskSupersessionRecord[];
}
