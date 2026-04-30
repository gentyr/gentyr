/**
 * Shared Constants for MCP Servers
 *
 * Single source of truth for constants used across multiple servers.
 * This ensures consistency between todo-db and other MCP servers.
 */

// ============================================================================
// TODO Sections
// ============================================================================

/**
 * Valid sections for tasks in the todo-db database.
 * These match the agent roles in the project.
 *
 * @deprecated Use category_id instead. Kept for backward-compat Zod schema validation.
 */
export const VALID_SECTIONS = [
  'TEST-WRITER',
  'INVESTIGATOR & PLANNER',
  'CODE-REVIEWER',
  'PROJECT-MANAGER',
  'DEPUTY-CTO',
  'PRODUCT-MANAGER',
  'DEMO-MANAGER',
  'WORKSTREAM-MANAGER',
] as const;

export type ValidSection = (typeof VALID_SECTIONS)[number];

/**
 * Soft access control: sections that restrict which agents can create tasks.
 * Agents self-report identity via assigned_by. Not in list = no restriction.
 *
 * @deprecated Creator restrictions are now defined per-category in task_categories.
 */
export const SECTION_CREATOR_RESTRICTIONS: Partial<Record<ValidSection, readonly string[]>> = {
  'DEPUTY-CTO': ['deputy-cto', 'cto', 'human', 'demo', 'pr-reviewer', 'system-followup', 'persistent-monitor'],
} as const;

/**
 * Creators whose tasks always have follow-up hooks enabled, regardless of section.
 */
export const FORCED_FOLLOWUP_CREATORS: readonly string[] = ['deputy-cto', 'product-manager', 'persistent-monitor'] as const;

// ============================================================================
// Task Status
// ============================================================================

export const TASK_STATUS = ['pending', 'pending_review', 'in_progress', 'pending_audit', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

/** Creators whose tasks bypass the gate and enter 'pending' directly. Non-trusted creators enter 'pending_review'. */
export const GATE_BYPASS_CREATORS: readonly string[] = ['deputy-cto', 'cto', 'human', 'pr-reviewer', 'system-followup', 'demo', 'self-heal-system'] as const;

/** Creators authorized to set priority: 'urgent'. Other creators are auto-downgraded to 'normal'. */
export const URGENCY_AUTHORIZED_CREATORS: readonly string[] = ['deputy-cto', 'cto', 'human', 'pr-reviewer', 'system-followup', 'demo', 'self-heal-system'] as const;

/** Categories exempt from audit gate enforcement. Tasks in these categories complete directly without independent audit. */
export const GATE_EXEMPT_CATEGORIES: readonly string[] = ['triage', 'project-management', 'workstream-management'] as const;

// ============================================================================
// Task Priority
// ============================================================================

export const TASK_PRIORITY = ['normal', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITY)[number];
