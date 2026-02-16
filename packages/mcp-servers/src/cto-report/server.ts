#!/usr/bin/env node
/**
 * CTO Report MCP Server
 *
 * Provides comprehensive metrics and status reports for CTO oversight.
 * Aggregates data from session JSONL files, todo-db, deputy-cto, agent-reports
 * (database: cto-reports.db), and agent-tracker.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  GetReportArgsSchema,
  GetSessionMetricsArgsSchema,
  GetTaskMetricsArgsSchema,
  type GetReportArgs,
  type GetSessionMetricsArgs,
  type GetTaskMetricsArgs,
  type CTOReport,
  type TokenUsage,
  type AutonomousModeStatus,
  type QuotaStatus,
  type QuotaBucket,
  type SessionMetrics,
  type PendingItems,
  type TriageMetrics,
  type TaskMetrics,
  type SectionTaskCounts,
  type SessionMetricsResult,
  type TaskMetricsResult,
  type KeyRotationMetrics,
  type TrackedKeyInfo,
  type AggregateQuota,
  type AgentActivity,
  type HookExecutions,
  type SystemHealth,
  type UsageProjection,
  type AutomationCooldowns,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const DEPUTY_CTO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const AUTONOMOUS_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const KEY_ROTATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const COOLDOWN_MINUTES = 55;

// Protected files for system health check
const PROTECTED_FILES = [
  path.join(PROJECT_DIR, '.claude', 'hooks', 'pre-commit-review.js'),
  path.join(PROJECT_DIR, 'eslint.config.js'),
  path.join(PROJECT_DIR, '.husky', 'pre-commit'),
];

// Claude session directory - path format: ~/.claude/projects/-{project-path}
// Claude Code replaces all non-alphanumeric characters with hyphens
function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

// ============================================================================
// Quota Status (Anthropic API)
// ============================================================================

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at: string } | null;
  seven_day?: { utilization: number; resets_at: string } | null;
  extra_usage?: { is_enabled: boolean } | null;
}

function calculateHoursUntil(isoDate: string): number {
  const resetTime = new Date(isoDate).getTime();
  const now = Date.now();
  const hoursUntil = (resetTime - now) / (1000 * 60 * 60);
  return Math.max(0, Math.round(hoursUntil * 10) / 10);
}

function parseBucket(bucket: { utilization: number; resets_at: string } | null | undefined): QuotaBucket | null {
  if (!bucket) {return null;}
  return {
    utilization: bucket.utilization,
    resets_at: bucket.resets_at,
    resets_in_hours: calculateHoursUntil(bucket.resets_at),
  };
}

/**
 * Get an access token from available sources.
 * Checks rotation state first (project-level, accumulates keys from multiple accounts),
 * then falls back to credentials file (user-level, current session only).
 */
function getAccessToken(): string | null {
  // Source 1: Rotation state (project-level, has accumulated keys)
  if (fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8')) as KeyRotationState;
      if (state?.version === 1 && state.keys) {
        // Prefer the active key
        const activeToken = state.active_key_id ? state.keys[state.active_key_id]?.accessToken : undefined;
        if (activeToken) return activeToken;
        // Fall back to any key with a token (prefer active, then try any)
        let fallbackToken: string | null = null;
        for (const keyData of Object.values(state.keys)) {
          if (keyData.accessToken) {
            if (keyData.status === 'active') return keyData.accessToken;
            if (!fallbackToken) fallbackToken = keyData.accessToken;
          }
        }
        if (fallbackToken) return fallbackToken;
      }
    } catch {
      // Silently fall through to next source
    }
  }

  // Source 2: Credentials file (user-level, current session)
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
      if (creds.claudeAiOauth?.accessToken) {
        if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) {
          return null;
        }
        return creds.claudeAiOauth.accessToken;
      }
    } catch {
      // Silently return null
    }
  }

  return null;
}

async function getQuotaStatus(): Promise<QuotaStatus> {
  const emptyStatus: QuotaStatus = {
    five_hour: null,
    seven_day: null,
    extra_usage_enabled: false,
    error: null,
  };

  const accessToken = getAccessToken();
  if (!accessToken) {
    return { ...emptyStatus, error: 'No credentials found' };
  }

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (!response.ok) {
      return { ...emptyStatus, error: `API error: ${response.status}` };
    }

    const data = await response.json() as UsageApiResponse;

    return {
      five_hour: parseBucket(data.five_hour),
      seven_day: parseBucket(data.seven_day),
      extra_usage_enabled: data.extra_usage?.is_enabled ?? false,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...emptyStatus, error: `Fetch error: ${message}` };
  }
}

// ============================================================================
// Token Usage Calculation
// ============================================================================

interface SessionEntry {
  timestamp?: string;
  type?: string;
  message?: {
    content?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content?: string;
}

function getTokenUsage(hours: number): TokenUsage {
  const sessionDir = getSessionDir();
  const since = Date.now() - (hours * 60 * 60 * 1000);

  const totals: TokenUsage = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    total: 0,
  };

  if (!fs.existsSync(sessionDir)) {
    return totals;
  }

  const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(sessionDir, file);

    // Check file modification time first - skip files not modified in time range
    const stat = fs.statSync(filePath);
    if (stat.mtime.getTime() < since) {
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;

        // Check timestamp
        if (entry.timestamp) {
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime < since) {
            continue;
          }
        }

        // Extract usage
        const usage = entry.message?.usage;
        if (usage) {
          totals.input += usage.input_tokens || 0;
          totals.output += usage.output_tokens || 0;
          totals.cache_read += usage.cache_read_input_tokens || 0;
          totals.cache_creation += usage.cache_creation_input_tokens || 0;
        }
      } catch {
        // Skip malformed JSONL lines
      }
    }
  }

  totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;

  return totals;
}

// ============================================================================
// Autonomous Mode Status
// ============================================================================

function getAutonomousModeStatus(): AutonomousModeStatus {
  let enabled = false;

  // Get config
  if (fs.existsSync(AUTONOMOUS_CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(AUTONOMOUS_CONFIG_PATH, 'utf8')) as { enabled?: boolean };
    enabled = config.enabled === true;
  }

  // Get next run time
  let next_run_minutes: number | null = null;
  if (enabled && fs.existsSync(AUTOMATION_STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8')) as { lastRun?: number };
    const lastRun = state.lastRun || 0;
    const now = Date.now();
    const timeSinceLastRun = now - lastRun;
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

    if (timeSinceLastRun >= cooldownMs) {
      next_run_minutes = 0;
    } else {
      next_run_minutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
    }
  } else if (enabled) {
    next_run_minutes = 0; // First run
  }

  return { enabled, next_run_minutes };
}

// ============================================================================
// Session Metrics
// ============================================================================

/**
 * Parse task type from message content.
 * Supports formats:
 * - [Task][type-name] ... → extracts "type-name"
 * - [Task] ... → returns "unknown"
 */
function parseTaskType(messageContent: string): string | null {
  if (!messageContent.startsWith('[Task]')) {
    return null;
  }

  // Check for [Task][type] format
  const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
  if (typeMatch && typeMatch[1]) {
    return typeMatch[1];
  }

  // Legacy [Task] format without type
  return 'unknown';
}

function getSessionMetricsData(hours: number): SessionMetrics {
  const since = Date.now() - (hours * 60 * 60 * 1000);
  const sessionDir = getSessionDir();

  const metrics: SessionMetrics = {
    task_triggered: 0,
    user_triggered: 0,
    task_by_type: {},
  };

  if (!fs.existsSync(sessionDir)) {
    return metrics;
  }

  const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(sessionDir, file);

    // Check file modification time - only count recent sessions
    const stat = fs.statSync(filePath);
    if (stat.mtime.getTime() < since) {
      continue;
    }

    // Read file and detect task session by checking if first user message starts with [Task]
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    let taskType: string | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;

        // Look for first user message
        if (entry.type === 'human' || entry.type === 'user') {
          const messageContent = typeof entry.message?.content === 'string'
            ? entry.message.content
            : entry.content;

          if (messageContent) {
            taskType = parseTaskType(messageContent);
          }
          break; // Stop after first user message
        }
      } catch {
        // Skip malformed JSONL lines
      }
    }

    if (taskType !== null) {
      metrics.task_triggered++;
      metrics.task_by_type[taskType] = (metrics.task_by_type[taskType] || 0) + 1;
    } else {
      metrics.user_triggered++;
    }
  }

  return metrics;
}

// ============================================================================
// Pending Items
// ============================================================================

interface CountResult {
  count: number;
}

function getPendingItems(): PendingItems {
  const items: PendingItems = {
    cto_questions: 0,
    commit_rejections: 0,
    pending_triage: 0,
    commits_blocked: false,
  };

  // Check deputy-cto database
  if (fs.existsSync(DEPUTY_CTO_DB_PATH)) {
    const db = new Database(DEPUTY_CTO_DB_PATH, { readonly: true });

    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
    ).get() as CountResult | undefined;

    const rejections = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
    ).get() as CountResult | undefined;

    db.close();

    items.cto_questions = pending?.count || 0;
    items.commit_rejections = rejections?.count || 0;
  }

  // Check cto-reports database for pending triage (deputy-cto responsibility, not CTO)
  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    const db = new Database(CTO_REPORTS_DB_PATH, { readonly: true });

    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
    ).get() as CountResult | undefined;
    items.pending_triage = pending?.count || 0;

    db.close();
  }

  // G020: Block commits when ANY pending items exist (questions OR triage)
  items.commits_blocked = items.cto_questions > 0 || items.pending_triage > 0;

  return items;
}

// ============================================================================
// Triage Metrics
// ============================================================================

function getTriageMetrics(): TriageMetrics {
  const metrics: TriageMetrics = {
    pending: 0,
    in_progress: 0,
    self_handled_24h: 0,
    self_handled_7d: 0,
    escalated_24h: 0,
    escalated_7d: 0,
    dismissed_24h: 0,
    dismissed_7d: 0,
  };

  if (!fs.existsSync(CTO_REPORTS_DB_PATH)) {
    return metrics;
  }

  const db = new Database(CTO_REPORTS_DB_PATH, { readonly: true });
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const pending = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
  ).get() as CountResult | undefined;
  metrics.pending = pending?.count || 0;

  const inProgress = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'in_progress'"
  ).get() as CountResult | undefined;
  metrics.in_progress = inProgress?.count || 0;

  const selfHandled24h = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at >= ?"
  ).get(cutoff24h) as CountResult | undefined;
  metrics.self_handled_24h = selfHandled24h?.count || 0;

  const selfHandled7d = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at >= ?"
  ).get(cutoff7d) as CountResult | undefined;
  metrics.self_handled_7d = selfHandled7d?.count || 0;

  const escalated24h = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'escalated' AND triage_completed_at >= ?"
  ).get(cutoff24h) as CountResult | undefined;
  metrics.escalated_24h = escalated24h?.count || 0;

  const escalated7d = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'escalated' AND triage_completed_at >= ?"
  ).get(cutoff7d) as CountResult | undefined;
  metrics.escalated_7d = escalated7d?.count || 0;

  const dismissed24h = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at >= ?"
  ).get(cutoff24h) as CountResult | undefined;
  metrics.dismissed_24h = dismissed24h?.count || 0;

  const dismissed7d = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at >= ?"
  ).get(cutoff7d) as CountResult | undefined;
  metrics.dismissed_7d = dismissed7d?.count || 0;

  db.close();

  return metrics;
}

// ============================================================================
// Task Metrics
// ============================================================================

interface TaskCountRow {
  section: string;
  status: string;
  count: number;
}

interface CompletedCountRow {
  section: string;
  count: number;
}

function getTaskMetricsData(hours: number): TaskMetrics {
  const metrics: TaskMetrics = {
    pending_total: 0,
    in_progress_total: 0,
    completed_total: 0,
    by_section: {},
    completed_24h: 0,
    completed_24h_by_section: {},
  };

  if (!fs.existsSync(TODO_DB_PATH)) {
    return metrics;
  }

  const db = new Database(TODO_DB_PATH, { readonly: true });

  // Get current task counts by section and status
  const tasks = db.prepare(`
    SELECT section, status, COUNT(*) as count
    FROM tasks
    GROUP BY section, status
  `).all() as TaskCountRow[];

  for (const row of tasks) {
    if (!metrics.by_section[row.section]) {
      metrics.by_section[row.section] = { pending: 0, in_progress: 0, completed: 0 };
    }
    (metrics.by_section[row.section] as SectionTaskCounts)[row.status as keyof SectionTaskCounts] = row.count;

    // Accumulate totals
    if (row.status === 'pending') {
      metrics.pending_total += row.count;
    } else if (row.status === 'in_progress') {
      metrics.in_progress_total += row.count;
    } else if (row.status === 'completed') {
      metrics.completed_total += row.count;
    }
  }

  // Get completed tasks within time range
  const since = Date.now() - (hours * 60 * 60 * 1000);
  const sinceTimestamp = Math.floor(since / 1000);

  const completed = db.prepare(`
    SELECT section, COUNT(*) as count
    FROM tasks
    WHERE status = 'completed' AND completed_timestamp >= ?
    GROUP BY section
  `).all(sinceTimestamp) as CompletedCountRow[];

  let total = 0;
  for (const row of completed) {
    metrics.completed_24h_by_section[row.section] = row.count;
    total += row.count;
  }
  metrics.completed_24h = total;

  db.close();

  return metrics;
}

// ============================================================================
// System Health
// ============================================================================

function getSystemHealth(): SystemHealth {
  let protectionStatus: 'protected' | 'unprotected' | 'unknown' = 'unknown';
  let allProtected = true;
  let anyExists = false;

  for (const file of PROTECTED_FILES) {
    if (fs.existsSync(file)) {
      anyExists = true;
      try {
        const stats = fs.statSync(file);
        if (stats.uid !== 0) {
          allProtected = false;
        }
      } catch {
        allProtected = false;
      }
    }
  }

  if (anyExists) {
    protectionStatus = allProtected ? 'protected' : 'unprotected';
  }

  return { protection_status: protectionStatus };
}

// ============================================================================
// Agent Activity
// ============================================================================

interface AgentHistoryEntry {
  id: string;
  type: string;
  hookType: string;
  timestamp: string;
}

interface AgentHistory {
  agents: AgentHistoryEntry[];
}

function getAgentActivity(): AgentActivity {
  const result: AgentActivity = {
    spawns_24h: 0,
    spawns_7d: 0,
    by_type: {},
  };

  if (!fs.existsSync(AGENT_TRACKER_PATH)) {
    return result;
  }

  const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
  const history = JSON.parse(content) as AgentHistory;

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

  for (const agent of history.agents || []) {
    const agentTime = new Date(agent.timestamp).getTime();

    if (agentTime >= cutoff7d) {
      result.spawns_7d++;

      if (agentTime >= cutoff24h) {
        result.spawns_24h++;
        result.by_type[agent.type] = (result.by_type[agent.type] || 0) + 1;
      }
    }
  }

  return result;
}

// ============================================================================
// Hook Executions
// ============================================================================

interface HookExecutionEntry {
  hookType: string;
  status: 'success' | 'failure' | 'skipped';
  timestamp: string;
  metadata?: { error?: string };
}

interface HookHistory {
  hookExecutions: HookExecutionEntry[];
}

function getHookExecutions(): HookExecutions {
  const result: HookExecutions = {
    total_24h: 0,
    success_rate: 100,
    by_hook: {},
    recent_failures: [],
  };

  if (!fs.existsSync(AGENT_TRACKER_PATH)) {
    return result;
  }

  const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
  const history = JSON.parse(content) as HookHistory;

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  let successCount = 0;

  for (const exec of history.hookExecutions || []) {
    const execTime = new Date(exec.timestamp).getTime();
    if (execTime < cutoff24h) continue;

    result.total_24h++;
    if (exec.status === 'success') successCount++;

    // Aggregate by hook
    if (!result.by_hook[exec.hookType]) {
      result.by_hook[exec.hookType] = { total: 0, success: 0, failure: 0 };
    }
    const stats = result.by_hook[exec.hookType];
    stats.total++;
    if (exec.status === 'success') stats.success++;
    if (exec.status === 'failure') stats.failure++;

    // Collect recent failures
    if (exec.status === 'failure' && result.recent_failures.length < 5) {
      result.recent_failures.push({
        hook: exec.hookType,
        error: exec.metadata?.error || 'Unknown error',
        timestamp: exec.timestamp,
      });
    }
  }

  if (result.total_24h > 0) {
    result.success_rate = Math.round((successCount / result.total_24h) * 100);
  }

  return result;
}

// ============================================================================
// Key Rotation Metrics
// ============================================================================

interface KeyRotationState {
  version: number;
  active_key_id: string | null;
  keys: Record<string, {
    accessToken?: string;
    subscriptionType: string;
    last_usage: {
      five_hour: number;
      seven_day: number;
    } | null;
    status: 'active' | 'exhausted' | 'invalid' | 'expired';
  }>;
  rotation_log: {
    timestamp: number;
    event: string;
  }[];
}

function getKeyRotationMetrics(hours: number): KeyRotationMetrics | null {
  if (!fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    return null;
  }

  const content = fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8');
  const state = JSON.parse(content) as KeyRotationState;

  if (!state || state.version !== 1 || typeof state.keys !== 'object') {
    throw new Error(`Invalid key rotation state file at ${KEY_ROTATION_STATE_PATH}`);
  }

  const now = Date.now();
  const since = now - (hours * 60 * 60 * 1000);

  // Only include active keys
  const keys: TrackedKeyInfo[] = [];
  let fiveHourSum = 0;
  let sevenDaySum = 0;
  let activeKeysWithData = 0;

  for (const [keyId, keyData] of Object.entries(state.keys)) {
    // Skip non-active keys
    if (keyData.status !== 'active') continue;

    const isCurrent = keyId === state.active_key_id;

    keys.push({
      key_id: `${keyId.slice(0, 8)}...`,
      subscription_type: keyData.subscriptionType || 'unknown',
      five_hour_pct: keyData.last_usage?.five_hour ?? null,
      seven_day_pct: keyData.last_usage?.seven_day ?? null,
      is_current: isCurrent,
    });

    // Accumulate for aggregate
    if (keyData.last_usage) {
      fiveHourSum += keyData.last_usage.five_hour ?? 0;
      sevenDaySum += keyData.last_usage.seven_day ?? 0;
      activeKeysWithData++;
    }
  }

  // Count rotation events in time range
  const rotationEvents24h = state.rotation_log.filter(
    entry => entry.timestamp >= since && entry.event === 'key_switched'
  ).length;

  // Compute aggregate (% of total capacity)
  const aggregate: AggregateQuota | null = activeKeysWithData > 0 ? {
    active_keys: activeKeysWithData,
    five_hour_pct: Math.round(fiveHourSum / activeKeysWithData),
    seven_day_pct: Math.round(sevenDaySum / activeKeysWithData),
  } : null;

  return {
    current_key_id: state.active_key_id ? `${state.active_key_id.slice(0, 8)}...` : null,
    active_keys: keys.length,
    keys,
    rotation_events_24h: rotationEvents24h,
    aggregate,
  };
}

// ============================================================================
// Usage Projection
// ============================================================================

const DEFAULT_COOLDOWNS: AutomationCooldowns = {
  hourly_tasks: 55,
  triage_check: 5,
  antipattern_hunter: 360,
  schema_mapper: 1440,
  lint_checker: 30,
  todo_maintenance: 15,
  task_runner: 60,
  triage_per_item: 60,
};

interface AutomationConfigFile {
  version: number;
  defaults?: Partial<AutomationCooldowns>;
  effective?: Partial<AutomationCooldowns>;
  adjustment?: {
    factor?: number;
    target_pct?: number;
    projected_at_reset?: number;
    constraining_metric?: '5h' | '7d';
    last_updated?: string;
  };
}

function getUsageProjection(): UsageProjection {
  const defaults: AutomationCooldowns = { ...DEFAULT_COOLDOWNS };
  const effective: AutomationCooldowns = { ...DEFAULT_COOLDOWNS };

  const result: UsageProjection = {
    factor: 1.0,
    target_pct: 90,
    projected_at_reset_pct: null,
    constraining_metric: null,
    last_updated: null,
    effective_cooldowns: effective,
    default_cooldowns: defaults,
  };

  if (!fs.existsSync(AUTOMATION_CONFIG_PATH)) {
    return result;
  }

  const content = fs.readFileSync(AUTOMATION_CONFIG_PATH, 'utf8');
  const config = JSON.parse(content) as AutomationConfigFile;

  if (!config || config.version !== 1) {
    throw new Error(`Invalid automation config at ${AUTOMATION_CONFIG_PATH}`);
  }

  // Merge defaults from config
  if (config.defaults) {
    Object.assign(defaults, config.defaults);
    result.default_cooldowns = defaults;
  }

  // Merge effective (dynamically adjusted) values
  if (config.effective) {
    Object.assign(effective, config.defaults || {}, config.effective);
    result.effective_cooldowns = effective;
  }

  // Extract adjustment info
  if (config.adjustment) {
    result.factor = config.adjustment.factor ?? 1.0;
    result.target_pct = config.adjustment.target_pct ?? 90;
    result.projected_at_reset_pct = config.adjustment.projected_at_reset ?? null;
    result.constraining_metric = config.adjustment.constraining_metric ?? null;
    result.last_updated = config.adjustment.last_updated ?? null;
  }

  return result;
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function getReport(args: GetReportArgs): Promise<CTOReport> {
  const hours = args.hours ?? 24;
  const tokenUsage = getTokenUsage(hours);
  const quotaStatus = await getQuotaStatus();
  const keyRotation = getKeyRotationMetrics(hours);

  const report: CTOReport = {
    generated_at: new Date().toISOString(),
    hours,
    system_health: getSystemHealth(),
    autonomous_mode: getAutonomousModeStatus(),
    quota: quotaStatus,
    usage: {
      plan_type: 'unknown',
      tokens_24h: tokenUsage,
      estimated_remaining_pct: keyRotation?.aggregate?.seven_day_pct != null
        ? 100 - keyRotation.aggregate.seven_day_pct
        : quotaStatus.seven_day?.utilization
        ? 100 - quotaStatus.seven_day.utilization
        : null,
    },
    usage_projection: getUsageProjection(),
    key_rotation: keyRotation,
    agents: getAgentActivity(),
    hooks: getHookExecutions(),
    sessions: getSessionMetricsData(hours),
    pending_items: getPendingItems(),
    triage: getTriageMetrics(),
    tasks: getTaskMetricsData(hours),
  };

  return report;
}

function getSessionMetrics(args: GetSessionMetricsArgs): SessionMetricsResult {
  const hours = args.hours ?? 24;
  return {
    hours,
    sessions: getSessionMetricsData(hours),
  };
}

function getTaskMetrics(args: GetTaskMetricsArgs): TaskMetricsResult {
  const hours = args.hours ?? 24;
  return {
    hours,
    tasks: getTaskMetricsData(hours),
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'get_report',
    description: 'Generate comprehensive CTO report with token usage, session metrics, pending items, and task status.',
    schema: GetReportArgsSchema,
    handler: getReport,
  },
  {
    name: 'get_session_metrics',
    description: 'Get session metrics only: task-triggered vs user-triggered sessions within time range.',
    schema: GetSessionMetricsArgsSchema,
    handler: getSessionMetrics,
  },
  {
    name: 'get_task_metrics',
    description: 'Get task metrics only: counts by section/status and recently completed tasks.',
    schema: GetTaskMetricsArgsSchema,
    handler: getTaskMetrics,
  },
];

const server = new McpServer({
  name: 'cto-report',
  version: '1.0.0',
  tools,
});

server.start();
