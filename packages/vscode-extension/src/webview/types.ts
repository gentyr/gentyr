// Mirror of DataService types for the webview side

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

export interface VerifiedKey {
  key_id: string;
  subscription_type: string;
  is_current: boolean;
  healthy: boolean;
  quota: QuotaStatus | null;
}

export interface VerifiedQuotaResult {
  keys: VerifiedKey[];
  healthy_count: number;
  total_attempted: number;
  aggregate: QuotaStatus;
  rotation_events_24h: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

export interface AutonomousModeStatus {
  enabled: boolean;
  interval_minutes: number;
  next_run_time: string | null;
  seconds_until_next: number | null;
}

export interface TaskMetrics {
  pending_total: number;
  in_progress_total: number;
  completed_total: number;
  by_section: Record<string, { pending: number; in_progress: number; completed: number }>;
  completed_24h: number;
}

export interface PendingItems {
  cto_questions: number;
  commit_rejections: number;
  pending_triage: number;
  commits_blocked: boolean;
}

export interface SessionMetrics {
  task_triggered: number;
  user_triggered: number;
}

export interface TriagedReport {
  id: string;
  title: string;
  priority: string;
  triage_status: string;
  triage_outcome: string | null;
  created_at: string;
  triage_completed_at: string | null;
}

export interface PendingQuestion {
  id: string;
  type: string;
  title: string;
  description: string;
  recommendation: string | null;
  created_at: string;
}

export interface DeputyCtoData {
  hasData: boolean;
  untriaged: TriagedReport[];
  untriagedCount: number;
  recentlyTriaged: TriagedReport[];
  escalated: TriagedReport[];
  selfHandled24h: number;
  escalated24h: number;
  dismissed24h: number;
  pendingQuestions: PendingQuestion[];
  pendingQuestionCount: number;
}

export interface SystemHealth {
  protection_status: 'protected' | 'unprotected' | 'unknown';
}

export interface DashboardState {
  generated_at: string;
  system_health: SystemHealth;
  autonomous_mode: AutonomousModeStatus;
  verified_quota: VerifiedQuotaResult;
  token_usage: TokenUsage;
  sessions: SessionMetrics;
  pending_items: PendingItems;
  tasks: TaskMetrics;
  deputy_cto: DeputyCtoData;
}
