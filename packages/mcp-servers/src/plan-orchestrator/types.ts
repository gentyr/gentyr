/**
 * Types for the Plan Orchestrator MCP Server
 *
 * Manages plan lifecycle, phases, tasks, substeps, dependencies,
 * and cross-DB integration with todo.db.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const PLAN_STATUS = ['draft', 'active', 'paused', 'completed', 'archived', 'cancelled'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const PHASE_STATUS = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export type PhaseStatus = (typeof PHASE_STATUS)[number];

export const TASK_STATUS = ['pending', 'blocked', 'ready', 'in_progress', 'paused', 'pending_audit', 'completed', 'skipped'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const ENTITY_TYPES = ['plan', 'phase', 'task', 'substep'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const DEP_ENTITY_TYPES = ['phase', 'task'] as const;
export type DepEntityType = (typeof DEP_ENTITY_TYPES)[number];

export const SKIP_AUTHORIZATION = ['cto', 'blocked_external', 'superseded'] as const;
export type SkipAuthorization = (typeof SKIP_AUTHORIZATION)[number];

// ============================================================================
// Inline Creation Schemas (for bulk create_plan)
// ============================================================================

const InlineSubstepSchema = z.object({
  title: z.string().min(1).max(200),
});

const InlineTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  agent_type: z.string().optional(),
  verification_strategy: z.string().optional(),
  substeps: z.array(InlineSubstepSchema).optional(),
});

const InlinePhaseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  required: z.boolean().optional().default(true),
  gate: z.boolean().optional().default(false),
  tasks: z.array(InlineTaskSchema).optional(),
});

// ============================================================================
// Tool Schemas
// ============================================================================

// Plan Lifecycle
export const CreatePlanArgsSchema = z.object({
  title: z.string().min(1).max(200).describe('Plan title'),
  description: z.string().optional().describe('Plan description'),
  phases: z.array(InlinePhaseSchema).optional().describe('Inline phases with tasks and substeps'),
});

export const GetPlanArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
  include_substeps: z.coerce.boolean().optional().default(true).describe('Include substeps in response'),
});

export const ListPlansArgsSchema = z.object({
  status: z.enum(PLAN_STATUS).optional().describe('Filter by plan status'),
});

export const UpdatePlanStatusArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
  status: z.enum(PLAN_STATUS).describe('New plan status'),
  force_complete: z.boolean().optional().describe('Required when completing a plan that has skipped phases. Acknowledges that some phases were not executed.'),
  completion_note: z.string().optional().describe('Required with force_complete. Explanation for completing despite skipped phases.'),
}).refine(
  (data) => !data.force_complete || !!data.completion_note,
  { message: 'completion_note is required when force_complete is true' },
);

// Phase Management
export const AddPhaseArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
  title: z.string().min(1).max(200).describe('Phase title'),
  description: z.string().optional().describe('Phase description'),
  required: z.boolean().optional().default(true).describe('Whether this phase must have completed tasks for plan completion (default: true)'),
  gate: z.boolean().optional().default(false).describe('When true, tasks in this phase CANNOT be skipped — server-enforced verification gate'),
  blocked_by: z.array(z.string()).optional().describe('Phase IDs that must complete first'),
});

export const UpdatePhaseArgsSchema = z.object({
  phase_id: z.string().describe('Phase UUID'),
  title: z.string().min(1).max(200).optional().describe('New title'),
  status: z.enum(PHASE_STATUS).optional().describe('New status'),
  required: z.boolean().optional().describe('Whether this phase is required for plan completion'),
  gate: z.boolean().optional().describe('Whether tasks in this phase cannot be skipped (server-enforced gate)'),
});

// Task Management
export const AddPlanTaskArgsSchema = z.object({
  phase_id: z.string().describe('Phase UUID'),
  title: z.string().min(1).max(200).describe('Task title'),
  description: z.string().optional().describe('Task description'),
  agent_type: z.string().optional().describe('Agent type for spawning'),
  category_id: z.string().optional()
    .describe('Category ID for this task. Determines the agent workflow sequence when spawned.'),
  verification_strategy: z.string().optional()
    .describe('Concrete verification criteria for independent audit. E.g. "Run pytest and verify 250/250 pass", "Verify PR #N merged to preview", "Check generated/ has 250 directories". Tasks with this field require auditor approval before completing.'),
  blocked_by: z.array(z.string()).optional().describe('Task IDs that must complete first'),
  create_todo: z.coerce.boolean().optional().default(false).describe('Also create a linked todo-db task'),
  todo_section: z.string().optional().default('GENERAL').describe('Section for todo-db task'),
  substeps: z.array(InlineSubstepSchema).optional().describe('Inline substeps'),
});

export const UpdateTaskProgressArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID'),
  status: z.enum(TASK_STATUS).optional().describe('New status'),
  skip_reason: z.string().optional().describe('Required when status is "skipped". Explanation for why the task is being skipped.'),
  skip_authorization: z.enum(SKIP_AUTHORIZATION).optional().describe('Required when status is "skipped". Authorization level: cto (CTO directed), blocked_external (external dependency), superseded (replaced by another task).'),
  pr_number: z.coerce.number().optional().describe('Associated PR number'),
  pr_merged: z.coerce.boolean().optional().describe('Whether PR has been merged'),
  branch_name: z.string().optional().describe('Git branch name'),
  persistent_task_id: z.string().optional().describe('Persistent task UUID executing this plan task — links the plan step to its persistent task'),
  force_complete: z.boolean().optional()
    .describe('CTO bypass: skip audit gate and mark task directly completed. Only valid when status is "completed".'),
}).refine(
  (data) => {
    if (data.status === 'skipped') {
      return !!data.skip_reason && !!data.skip_authorization;
    }
    return true;
  },
  { message: 'skip_reason and skip_authorization are required when status is "skipped"' },
);

export const LinkTaskArgsSchema = z.object({
  plan_task_id: z.string().describe('Plan task UUID'),
  todo_task_id: z.string().describe('Existing todo-db task UUID'),
});

// Sub-Step Management
export const AddSubstepsArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID'),
  substeps: z.array(InlineSubstepSchema).min(1).describe('Substeps to add'),
});

export const CompleteSubstepArgsSchema = z.object({
  substep_id: z.string().describe('Substep UUID'),
});

// Dependency Management
export const AddDependencyArgsSchema = z.object({
  blocker_id: z.string().describe('ID of the blocking entity'),
  blocker_type: z.enum(DEP_ENTITY_TYPES).describe('Type of blocking entity'),
  blocked_id: z.string().describe('ID of the blocked entity'),
  blocked_type: z.enum(DEP_ENTITY_TYPES).describe('Type of blocked entity'),
});

export const GetSpawnReadyTasksArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
});

// Visualization
export const PlanDashboardArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
});

export const PlanTimelineArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
  hours: z.coerce.number().optional().default(24).describe('Hours of history to show'),
  entity_type: z.enum(ENTITY_TYPES).optional().describe('Filter by entity type'),
});

export const PlanAuditArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreatePlanArgs = z.infer<typeof CreatePlanArgsSchema>;
export type GetPlanArgs = z.infer<typeof GetPlanArgsSchema>;
export type ListPlansArgs = z.infer<typeof ListPlansArgsSchema>;
export type UpdatePlanStatusArgs = z.infer<typeof UpdatePlanStatusArgsSchema>;
export type AddPhaseArgs = z.infer<typeof AddPhaseArgsSchema>;
export type UpdatePhaseArgs = z.infer<typeof UpdatePhaseArgsSchema>;
export type AddPlanTaskArgs = z.infer<typeof AddPlanTaskArgsSchema>;
export type UpdateTaskProgressArgs = z.infer<typeof UpdateTaskProgressArgsSchema>;
export type LinkTaskArgs = z.infer<typeof LinkTaskArgsSchema>;
export type AddSubstepsArgs = z.infer<typeof AddSubstepsArgsSchema>;
export type CompleteSubstepArgs = z.infer<typeof CompleteSubstepArgsSchema>;
export type AddDependencyArgs = z.infer<typeof AddDependencyArgsSchema>;
export type GetSpawnReadyTasksArgs = z.infer<typeof GetSpawnReadyTasksArgsSchema>;
export type PlanDashboardArgs = z.infer<typeof PlanDashboardArgsSchema>;
export type PlanTimelineArgs = z.infer<typeof PlanTimelineArgsSchema>;
export type PlanAuditArgs = z.infer<typeof PlanAuditArgsSchema>;
export type CheckVerificationAuditArgs = z.infer<typeof CheckVerificationAuditArgsSchema>;
export type VerificationAuditPassArgs = z.infer<typeof VerificationAuditPassArgsSchema>;
export type VerificationAuditFailArgs = z.infer<typeof VerificationAuditFailArgsSchema>;

// ============================================================================
// Record Types (SQLite rows)
// ============================================================================

export interface PlanRecord {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  metadata: string | null;
  persistent_task_id: string | null;
  manager_agent_id: string | null;
  manager_pid: number | null;
  manager_session_id: string | null;
  last_heartbeat: string | null;
}

export interface PhaseRecord {
  id: string;
  plan_id: string;
  title: string;
  description: string | null;
  phase_order: number;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: string | null;
  required: number;
  gate: number;
}

export interface PlanTaskRecord {
  id: string;
  phase_id: string;
  plan_id: string;
  title: string;
  description: string | null;
  status: string;
  task_order: number;
  todo_task_id: string | null;
  pr_number: number | null;
  pr_merged: number | null;
  branch_name: string | null;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: string | null;
  verification_strategy: string | null;
  persistent_task_id: string | null;
  category_id: string | null;
}

export interface PlanAuditRecord {
  id: string;
  task_id: string;
  plan_id: string;
  verification_strategy: string;
  verdict: string | null;
  evidence: string | null;
  failure_reason: string | null;
  auditor_agent_id: string | null;
  requested_at: string;
  completed_at: string | null;
  attempt_number: number;
}

export interface SubstepRecord {
  id: string;
  task_id: string;
  title: string;
  completed: number;
  step_order: number;
  completed_at: string | null;
  created_at: string;
}

export interface DependencyRecord {
  id: string;
  blocker_type: string;
  blocker_id: string;
  blocked_type: string;
  blocked_id: string;
  created_at: string;
}

export interface StateChangeRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  changed_by: string | null;
}

// Sessions
export const PlanSessionsArgsSchema = z.object({
  plan_id: z.string().optional().describe('Plan UUID. If omitted, shows all active plans.'),
  hours: z.coerce.number().optional().default(24).describe('Hours of history'),
});
export type PlanSessionsArgs = z.infer<typeof PlanSessionsArgsSchema>;

// Verification Audit
export const CheckVerificationAuditArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID to check audit status for'),
});

export const VerificationAuditPassArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID'),
  evidence: z.string().describe('What was verified and what was found — must include concrete data (counts, file paths, test output)'),
});

export const VerificationAuditFailArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID'),
  failure_reason: z.string().describe('Why the verification failed'),
  evidence: z.string().optional().describe('What was found during verification'),
});

// Get plan blocking status
export const GetPlanBlockingStatusArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID to check blocking status for'),
});
export type GetPlanBlockingStatusArgs = z.infer<typeof GetPlanBlockingStatusArgsSchema>;

// Retry plan task
export const RetryPlanTaskArgsSchema = z.object({
  task_id: z.string().describe('Plan task ID to retry'),
  reason: z.string().describe('Why this task is being retried'),
});
export type RetryPlanTaskArgs = z.infer<typeof RetryPlanTaskArgsSchema>;

// Force-close plan
export const ForceClosePlanArgsSchema = z.object({
  plan_id: z.string().describe('Plan ID to force-close'),
  reason: z.string().describe('Reason for force-closing the plan'),
  cto_bypass: z.literal(true).describe(
    'WARNING: Only set to true if directly asked by the CTO. ' +
    'This cancels all running persistent tasks and sub-sessions under this plan and cannot be undone.'
  ),
});
export type ForceClosePlanArgs = z.infer<typeof ForceClosePlanArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}
