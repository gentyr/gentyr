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
] as const;

export type ValidSection = (typeof VALID_SECTIONS)[number];

// ============================================================================
// Task Status
// ============================================================================

export const TASK_STATUS = ['pending', 'in_progress', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];
