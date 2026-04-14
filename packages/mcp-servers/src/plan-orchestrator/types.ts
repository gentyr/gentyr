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

export const TASK_STATUS = ['pending', 'blocked', 'ready', 'in_progress', 'completed', 'skipped'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const ENTITY_TYPES = ['plan', 'phase', 'task', 'substep'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const DEP_ENTITY_TYPES = ['phase', 'task'] as const;
export type DepEntityType = (typeof DEP_ENTITY_TYPES)[number];

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
  substeps: z.array(InlineSubstepSchema).optional(),
});

const InlinePhaseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
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
});

// Phase Management
export const AddPhaseArgsSchema = z.object({
  plan_id: z.string().describe('Plan UUID'),
  title: z.string().min(1).max(200).describe('Phase title'),
  description: z.string().optional().describe('Phase description'),
  blocked_by: z.array(z.string()).optional().describe('Phase IDs that must complete first'),
});

export const UpdatePhaseArgsSchema = z.object({
  phase_id: z.string().describe('Phase UUID'),
  title: z.string().min(1).max(200).optional().describe('New title'),
  status: z.enum(PHASE_STATUS).optional().describe('New status'),
});

// Task Management
export const AddPlanTaskArgsSchema = z.object({
  phase_id: z.string().describe('Phase UUID'),
  title: z.string().min(1).max(200).describe('Task title'),
  description: z.string().optional().describe('Task description'),
  agent_type: z.string().optional().describe('Agent type for spawning'),
  category_id: z.string().optional()
    .describe('Category ID for this task. Determines the agent workflow sequence when spawned.'),
  blocked_by: z.array(z.string()).optional().describe('Task IDs that must complete first'),
  create_todo: z.coerce.boolean().optional().default(false).describe('Also create a linked todo-db task'),
  todo_section: z.string().optional().default('GENERAL').describe('Section for todo-db task'),
  substeps: z.array(InlineSubstepSchema).optional().describe('Inline substeps'),
});

export const UpdateTaskProgressArgsSchema = z.object({
  task_id: z.string().describe('Plan task UUID'),
  status: z.enum(TASK_STATUS).optional().describe('New status'),
  pr_number: z.coerce.number().optional().describe('Associated PR number'),
  pr_merged: z.coerce.boolean().optional().describe('Whether PR has been merged'),
  branch_name: z.string().optional().describe('Git branch name'),
  persistent_task_id: z.string().optional().describe('Persistent task UUID executing this plan task — links the plan step to its persistent task'),
});

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
  persistent_task_id: string | null;
  category_id: string | null;
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
