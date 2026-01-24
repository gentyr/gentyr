/**
 * Types for the CTO Report MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const GetReportArgsSchema = z.object({
  hours: z.number()
    .min(1)
    .max(168)
    .default(24)
    .describe('Hours to look back for metrics (1-168, default 24)'),
});

export const GetSessionMetricsArgsSchema = z.object({
  hours: z.number()
    .min(1)
    .max(168)
    .default(24)
    .describe('Hours to look back (1-168, default 24)'),
});

export const GetTaskMetricsArgsSchema = z.object({
  hours: z.number()
    .min(1)
    .max(168)
    .default(24)
    .describe('Hours to look back (1-168, default 24)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type GetReportArgs = z.infer<typeof GetReportArgsSchema>;
export type GetSessionMetricsArgs = z.infer<typeof GetSessionMetricsArgsSchema>;
export type GetTaskMetricsArgs = z.infer<typeof GetTaskMetricsArgsSchema>;

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

export interface QuotaBucket {
  utilization: number;
  resets_at: string;
  resets_in_hours: number;
}

export interface QuotaStatus {
  five_hour: QuotaBucket | null;
  seven_day: QuotaBucket | null;
  extra_usage_enabled: boolean;
  error: string | null;
}

export interface AggregateQuota {
  active_keys: number;
  five_hour_pct: number;
  seven_day_pct: number;
}

export interface AutonomousModeStatus {
  enabled: boolean;
  next_run_minutes: number | null;
}

export interface UsageMetrics {
  plan_type: 'pro' | 'max5' | 'max20' | 'api' | 'unknown';
  tokens_24h: TokenUsage;
  estimated_remaining_pct: number | null;
}

// ============================================================================
// Multi-Key Rotation Types
// ============================================================================

export interface KeyUsageData {
  five_hour: number;
  seven_day: number;
  checked_at: number;
}

export interface TrackedKeyInfo {
  key_id: string;
  subscription_type: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  is_current: boolean;
}

export interface KeyRotationMetrics {
  current_key_id: string | null;
  active_keys: number;
  keys: TrackedKeyInfo[];
  rotation_events_24h: number;
  aggregate: AggregateQuota | null;
}

export interface AgentActivity {
  spawns_24h: number;
  spawns_7d: number;
  by_type: Record<string, number>;
}

export interface HookStats {
  total: number;
  success: number;
  failure: number;
}

export interface HookExecutions {
  total_24h: number;
  success_rate: number;
  by_hook: Record<string, HookStats>;
  recent_failures: Array<{ hook: string; error: string; timestamp: string }>;
}

export interface SystemHealth {
  protection_status: 'protected' | 'unprotected' | 'unknown';
}

export interface AutomationCooldowns {
  hourly_tasks: number;
  triage_check: number;
  plan_executor: number;
  antipattern_hunter: number;
  schema_mapper: number;
  lint_checker: number;
  todo_maintenance: number;
  task_runner: number;
  triage_per_item: number;
}

export interface UsageProjection {
  factor: number;
  target_pct: number;
  projected_at_reset_pct: number | null;
  constraining_metric: '5h' | '7d' | null;
  last_updated: string | null;
  effective_cooldowns: AutomationCooldowns;
  default_cooldowns: AutomationCooldowns;
}

export interface SessionMetrics {
  task_triggered: number;
  user_triggered: number;
  /** Breakdown of task sessions by type (e.g., lint-fixer, deputy-cto-review, etc.) */
  task_by_type: Record<string, number>;
}

export interface PendingItems {
  cto_questions: number;
  commit_rejections: number;
  pending_triage: number;  // Reports awaiting deputy-cto triage (not for CTO attention)
  commits_blocked: boolean;
}

export interface TriageMetrics {
  pending: number;
  in_progress: number;
  self_handled_24h: number;
  self_handled_7d: number;
  escalated_24h: number;
  escalated_7d: number;
  dismissed_24h: number;
  dismissed_7d: number;
}

export interface SectionTaskCounts {
  pending: number;
  in_progress: number;
  completed: number;
}

export interface TaskMetrics {
  /** Summary totals across all sections */
  pending_total: number;
  in_progress_total: number;
  completed_total: number;
  /** Breakdown by section */
  by_section: Record<string, SectionTaskCounts>;
  /** Completed within time range */
  completed_24h: number;
  completed_24h_by_section: Record<string, number>;
}

export interface CTOReport {
  generated_at: string;
  hours: number;
  system_health: SystemHealth;
  autonomous_mode: AutonomousModeStatus;
  quota: QuotaStatus;
  usage: UsageMetrics;
  usage_projection: UsageProjection;
  key_rotation: KeyRotationMetrics | null;
  agents: AgentActivity;
  hooks: HookExecutions;
  sessions: SessionMetrics;
  pending_items: PendingItems;
  triage: TriageMetrics;
  tasks: TaskMetrics;
}

export interface SessionMetricsResult {
  hours: number;
  sessions: SessionMetrics;
}

export interface TaskMetricsResult {
  hours: number;
  tasks: TaskMetrics;
}

export interface ErrorResult {
  error: string;
}
