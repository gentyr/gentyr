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
 */
export const VALID_SECTIONS = [
  'TEST-WRITER',
  'INVESTIGATOR & PLANNER',
  'CODE-REVIEWER',
  'PROJECT-MANAGER',
  'DEPUTY-CTO',
  'PRODUCT-MANAGER',
] as const;

export type ValidSection = (typeof VALID_SECTIONS)[number];

/**
 * Soft access control: sections that restrict which agents can create tasks.
 * Agents self-report identity via assigned_by. Not in list = no restriction.
 */
export const SECTION_CREATOR_RESTRICTIONS: Partial<Record<ValidSection, readonly string[]>> = {
  'DEPUTY-CTO': ['deputy-cto', 'cto', 'human', 'demo', 'pr-reviewer', 'system-followup'],
} as const;

/**
 * Creators whose tasks always have follow-up hooks enabled, regardless of section.
 */
export const FORCED_FOLLOWUP_CREATORS: readonly string[] = ['deputy-cto'] as const;

// ============================================================================
// Task Status
// ============================================================================

export const TASK_STATUS = ['pending', 'in_progress', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

// ============================================================================
// Task Priority
// ============================================================================

export const TASK_PRIORITY = ['normal', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITY)[number];
