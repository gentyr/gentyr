/**
 * Types for the Persistent Task MCP Server
 *
 * Manages long-running, amendment-driven, monitored tasks that the CTO
 * delegates to a persistent monitor session.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const PERSISTENT_TASK_STATUS = ['draft', 'active', 'paused', 'pending_audit', 'completed', 'cancelled', 'failed'] as const;
export type PersistentTaskStatus = (typeof PERSISTENT_TASK_STATUS)[number];

export const AMENDMENT_TYPES = ['addendum', 'correction', 'scope_change', 'priority_shift'] as const;
export type AmendmentType = (typeof AMENDMENT_TYPES)[number];

// ============================================================================
// Tool Schemas
// ============================================================================

export const CreatePersistentTaskArgsSchema = z.object({
  title: z.string().min(1).max(200).describe('Task title'),
  prompt: z.string().min(1).describe('Finalized high-specificity prompt for the monitor session'),
  original_input: z.string().optional().describe("CTO's raw input before refinement"),
  outcome_criteria: z.string().optional().describe("What 'done' looks like — measurable success criteria"),
  user_prompt_uuids: z.array(z.string()).optional().describe('UUIDs of user prompts this task derives from'),
  demo_involved: z.boolean().optional().default(false).describe('Whether this task involves demo scenarios. When true, the monitor receives specialized demo validation instructions.'),
  strict_infra_guidance: z.boolean().optional().default(false).describe('When true, the monitor and all child agents that touch infrastructure (builds, demos, dev servers, secrets) receive strict MCP-only infrastructure instructions. Opt-in — not all tasks need this level of enforcement.'),
  plan_task_id: z.string().optional().describe('Plan task UUID — links this persistent task to a plan task. When set, plan-persistent-sync.js auto-cascades completion back to the plan.'),
  plan_id: z.string().optional().describe('Plan UUID — the plan this persistent task belongs to. Used by persistent-task-briefing.js to inject plan context.'),
  is_plan_manager: z.boolean().optional().default(false).describe('When true, this persistent task is a plan manager — it spawns persistent tasks for plan steps instead of standalone child sessions.'),
  gate_success_criteria: z.string().optional()
    .describe('MEASURABLE outcome for audit gate. Falls back to outcome_criteria if not set. Example: "All demo scenarios pass with video recording"'),
  gate_verification_method: z.string().optional()
    .describe('EXECUTABLE verification steps for the auditor. Example: "Call verify_demo_completeness and assert complete: true"'),
});

export const ActivatePersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
});

export const GetPersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  include_amendments: z.coerce.boolean().optional().default(true).describe('Include amendments ordered by created_at ASC'),
  include_subtasks: z.coerce.boolean().optional().default(true).describe('Include linked sub-tasks with current status from todo.db'),
});

export const ListPersistentTasksArgsSchema = z.object({
  status: z.enum(PERSISTENT_TASK_STATUS).optional().describe('Filter by task status'),
  limit: z.coerce.number().optional().default(20).describe('Maximum tasks to return'),
});

export const AmendPersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  content: z.string().min(1).describe('Amendment content'),
  amendment_type: z.enum(AMENDMENT_TYPES).optional().default('addendum').describe('Type of amendment'),
});

export const AcknowledgeAmendmentArgsSchema = z.object({
  id: z.string().describe('Amendment UUID'),
});

export const PausePersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  reason: z.string().optional().describe('Reason for pausing'),
});

export const ResumePersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
});

export const CancelPersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  reason: z.string().optional().describe('Reason for cancellation'),
});

export const CompletePersistentTaskArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  summary: z.string().optional().describe('Summary of what was accomplished'),
  force_complete: z.boolean().optional().default(false)
    .describe('CTO bypass: skip audit gate. Only honored in interactive (non-spawned) sessions.'),
});

export const LinkSubtaskArgsSchema = z.object({
  persistent_task_id: z.string().describe('Persistent task UUID'),
  todo_task_id: z.string().describe('todo.db task UUID to link'),
});

export const GetPersistentTaskSummaryArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
});

// ============================================================================
// Audit Gate Schemas
// ============================================================================

export const UpdatePtGateArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  success_criteria: z.string().optional().describe('New success criteria'),
  verification_method: z.string().optional().describe('New verification method'),
  reset_to_draft: z.boolean().optional().default(false).describe('Reset gate to draft, requiring re-confirmation'),
});

export const ConfirmPtGateArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  alignment_session_id: z.string().optional().describe('Session ID of the user-alignment sub-agent that reviewed this gate'),
  refined_success_criteria: z.string().optional().describe('Refined criteria from alignment review'),
  refined_verification_method: z.string().optional().describe('Refined method from alignment review'),
});

export const CheckPtAuditArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
});

export const PtAuditPassArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  evidence: z.string().describe('Concrete evidence supporting the pass verdict'),
});

export const PtAuditFailArgsSchema = z.object({
  id: z.string().describe('Persistent task UUID'),
  failure_reason: z.string().describe('Specific reason verification failed'),
  evidence: z.string().describe('What was actually found vs what was expected'),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreatePersistentTaskArgs = z.infer<typeof CreatePersistentTaskArgsSchema>;
export type ActivatePersistentTaskArgs = z.infer<typeof ActivatePersistentTaskArgsSchema>;
export type GetPersistentTaskArgs = z.infer<typeof GetPersistentTaskArgsSchema>;
export type ListPersistentTasksArgs = z.infer<typeof ListPersistentTasksArgsSchema>;
export type AmendPersistentTaskArgs = z.infer<typeof AmendPersistentTaskArgsSchema>;
export type AcknowledgeAmendmentArgs = z.infer<typeof AcknowledgeAmendmentArgsSchema>;
export type PausePersistentTaskArgs = z.infer<typeof PausePersistentTaskArgsSchema>;
export type ResumePersistentTaskArgs = z.infer<typeof ResumePersistentTaskArgsSchema>;
export type CancelPersistentTaskArgs = z.infer<typeof CancelPersistentTaskArgsSchema>;
export type CompletePersistentTaskArgs = z.infer<typeof CompletePersistentTaskArgsSchema>;
export type LinkSubtaskArgs = z.infer<typeof LinkSubtaskArgsSchema>;
export type GetPersistentTaskSummaryArgs = z.infer<typeof GetPersistentTaskSummaryArgsSchema>;
export type UpdatePtGateArgs = z.infer<typeof UpdatePtGateArgsSchema>;
export type ConfirmPtGateArgs = z.infer<typeof ConfirmPtGateArgsSchema>;
export type CheckPtAuditArgs = z.infer<typeof CheckPtAuditArgsSchema>;
export type PtAuditPassArgs = z.infer<typeof PtAuditPassArgsSchema>;
export type PtAuditFailArgs = z.infer<typeof PtAuditFailArgsSchema>;

// ============================================================================
// Record Types (SQLite rows)
// ============================================================================

export interface PersistentTaskRecord {
  id: string;
  title: string;
  prompt: string;
  original_input: string | null;
  outcome_criteria: string | null;
  status: string;
  parent_todo_task_id: string | null;
  monitor_agent_id: string | null;
  monitor_pid: number | null;
  monitor_session_id: string | null;
  created_at: string;
  activated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  last_heartbeat: string | null;
  cycle_count: number;
  created_by: string;
  user_prompt_uuids: string | null;
  metadata: string | null;
  last_summary: string | null;
  gate_success_criteria: string | null;
  gate_verification_method: string | null;
  gate_status: string | null;
  gate_confirmed_at: string | null;
}

export interface AmendmentRecord {
  id: string;
  persistent_task_id: string;
  content: string;
  amendment_type: string;
  created_at: string;
  created_by: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
}

export interface SubTaskRecord {
  persistent_task_id: string;
  todo_task_id: string;
  linked_at: string;
  linked_by: string;
}

export interface EventRecord {
  id: string;
  persistent_task_id: string;
  event_type: string;
  details: string | null;
  created_at: string;
}

export interface ErrorResult {
  error: string;
}
