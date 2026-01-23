/**
 * Types for the GENTYR Dashboard MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const GetDashboardArgsSchema = z.object({
  hours: z.number()
    .min(1)
    .max(168)
    .default(24)
    .describe('Hours to look back for metrics (1-168, default 24)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type GetDashboardArgs = z.infer<typeof GetDashboardArgsSchema>;

export interface SystemHealth {
  autonomous_mode: {
    enabled: boolean;
    next_run_minutes: number | null;
  };
  protection_status: 'protected' | 'unprotected' | 'unknown';
  next_automation: {
    task: string;
    in_minutes: number;
  } | null;
}

export interface AgentActivity {
  total_spawns: number;
  spawns_24h: number;
  spawns_7d: number;
  by_type: Record<string, number>;
  by_hook: Record<string, number>;
  recent: Array<{
    id: string;
    type: string;
    description: string;
    timestamp: string;
  }>;
}

export interface HookExecutionStats {
  total: number;
  success: number;
  failure: number;
  skipped: number;
  avgDurationMs: number;
}

export interface HookExecutions {
  total_24h: number;
  success_rate: number;
  by_hook: Record<string, HookExecutionStats>;
  recent_failures: Array<{
    hook: string;
    error: string;
    timestamp: string;
  }>;
}

export interface TaskPipeline {
  pending: number;
  in_progress: number;
  completed_24h: number;
  by_section: Record<string, {
    pending: number;
    in_progress: number;
    completed: number;
  }>;
  stale_tasks: number;
}

export interface CTOQueue {
  pending_questions: number;
  pending_rejections: number;
  pending_reports: number;
  commits_blocked: boolean;
  recent_escalations: Array<{
    title: string;
    type: string;
    timestamp: string;
  }>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface QuotaBucket {
  utilization: number;
  resets_at: string;
  resets_in_hours: number;
}

export interface Usage {
  tokens_24h: TokenUsage;
  quota: {
    five_hour: QuotaBucket | null;
    seven_day: QuotaBucket | null;
    seven_day_sonnet: QuotaBucket | null;
    error: string | null;
  };
  sessions_24h: {
    task: number;
    user: number;
    total: number;
  };
}

export interface ApiKeyInfo {
  id: string;
  status: 'active' | 'exhausted' | 'invalid' | 'expired';
  five_hour_pct: number | null;
  seven_day_pct: number | null;
}

export interface ApiKeys {
  total: number;
  active: number;
  exhausted: number;
  rotation_events_24h: number;
  keys: ApiKeyInfo[];
}

export interface Compliance {
  global_agents_today: number;
  local_agents_today: number;
  last_run: string | null;
  files_needing_check: number;
}

export interface Sessions {
  task_triggered: number;
  user_triggered: number;
  by_task_type: Record<string, number>;
}

export interface GentyrDashboard {
  generated_at: string;
  hours: number;

  system_health: SystemHealth;
  agent_activity: AgentActivity;
  hook_executions: HookExecutions;
  task_pipeline: TaskPipeline;
  cto_queue: CTOQueue;
  usage: Usage;
  api_keys: ApiKeys | null;
  compliance: Compliance | null;
  sessions: Sessions;
}

export interface ErrorResult {
  error: string;
}
