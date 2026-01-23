#!/usr/bin/env node
/**
 * GENTYR Dashboard MCP Server
 *
 * Provides a comprehensive activity dashboard showing all GENTYR system metrics,
 * agent spawns, hook executions, and Claude usage.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { McpServer, type ToolHandler } from '../shared/server.js';
import {
  GetDashboardArgsSchema,
  type GetDashboardArgs,
  type GentyrDashboard,
  type SystemHealth,
  type AgentActivity,
  type HookExecutions,
  type TaskPipeline,
  type CTOQueue,
  type Usage,
  type ApiKeys,
  type Compliance,
  type Sessions,
  type TokenUsage,
  type QuotaBucket,
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
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const KEY_ROTATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');
const COMPLIANCE_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'compliance-state.json');
const COMPLIANCE_LOG_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'compliance-log.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

const COOLDOWN_MINUTES = 55;

// Claude session directory
function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

// ============================================================================
// Helper: Safe JSON read
// ============================================================================

function safeReadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return defaultValue;
  }
}

// ============================================================================
// System Health
// ============================================================================

function getSystemHealth(): SystemHealth {
  let autonomousEnabled = false;
  let nextRunMinutes: number | null = null;

  // Read autonomous mode config
  const config = safeReadJson<{ enabled?: boolean }>(AUTONOMOUS_CONFIG_PATH, {});
  autonomousEnabled = config.enabled === true;

  // Get next run time from automation state
  if (autonomousEnabled) {
    const state = safeReadJson<{ lastRun?: number }>(AUTOMATION_STATE_PATH, {});
    const lastRun = state.lastRun || 0;
    const now = Date.now();
    const timeSinceLastRun = now - lastRun;
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

    if (timeSinceLastRun >= cooldownMs) {
      nextRunMinutes = 0;
    } else {
      nextRunMinutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
    }
  }

  // Check protection status
  let protectionStatus: 'protected' | 'unprotected' | 'unknown' = 'unknown';
  const protectedFiles = [
    path.join(PROJECT_DIR, '.claude', 'hooks', 'pre-commit-review.js'),
    path.join(PROJECT_DIR, 'eslint.config.js'),
    path.join(PROJECT_DIR, '.husky', 'pre-commit'),
  ];

  let allProtected = true;
  let anyExists = false;

  for (const file of protectedFiles) {
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

  // Get next scheduled automation task
  let nextAutomation: { task: string; in_minutes: number } | null = null;
  if (autonomousEnabled && nextRunMinutes !== null) {
    nextAutomation = {
      task: 'hourly-automation',
      in_minutes: nextRunMinutes,
    };
  }

  return {
    autonomous_mode: {
      enabled: autonomousEnabled,
      next_run_minutes: nextRunMinutes,
    },
    protection_status: protectionStatus,
    next_automation: nextAutomation,
  };
}

// ============================================================================
// Agent Activity
// ============================================================================

interface AgentHistoryEntry {
  id: string;
  type: string;
  hookType: string;
  description: string;
  timestamp: string;
}

interface AgentHistory {
  agents: AgentHistoryEntry[];
  stats: { totalSpawns: number };
}

function getAgentActivity(hours: number): AgentActivity {
  const history = safeReadJson<AgentHistory>(AGENT_TRACKER_PATH, {
    agents: [],
    stats: { totalSpawns: 0 },
  });

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

  let spawns24h = 0;
  let spawns7d = 0;
  const byType: Record<string, number> = {};
  const byHook: Record<string, number> = {};
  const recent: AgentActivity['recent'] = [];

  for (const agent of history.agents) {
    const agentTime = new Date(agent.timestamp).getTime();

    if (agentTime >= cutoff7d) {
      spawns7d++;

      if (agentTime >= cutoff24h) {
        spawns24h++;
        byType[agent.type] = (byType[agent.type] || 0) + 1;
        byHook[agent.hookType] = (byHook[agent.hookType] || 0) + 1;
      }
    }

    // Keep first 10 for recent list
    if (recent.length < 10) {
      recent.push({
        id: agent.id,
        type: agent.type,
        description: agent.description,
        timestamp: agent.timestamp,
      });
    }
  }

  return {
    total_spawns: history.stats.totalSpawns,
    spawns_24h: spawns24h,
    spawns_7d: spawns7d,
    by_type: byType,
    by_hook: byHook,
    recent,
  };
}

// ============================================================================
// Hook Executions
// ============================================================================

interface HookExecutionEntry {
  id: string;
  hookType: string;
  status: 'success' | 'failure' | 'skipped';
  timestamp: string;
  durationMs: number;
  metadata?: { error?: string };
}

interface HookHistory {
  hookExecutions: HookExecutionEntry[];
  stats: { totalHookExecutions: number };
}

function getHookExecutions(hours: number): HookExecutions {
  const history = safeReadJson<HookHistory>(AGENT_TRACKER_PATH, {
    hookExecutions: [],
    stats: { totalHookExecutions: 0 },
  });

  const executions = history.hookExecutions || [];
  const now = Date.now();
  const cutoff = now - hours * 60 * 60 * 1000;

  let total = 0;
  let successCount = 0;
  const byHook: HookExecutions['by_hook'] = {};
  const recentFailures: HookExecutions['recent_failures'] = [];

  for (const exec of executions) {
    const execTime = new Date(exec.timestamp).getTime();
    if (execTime < cutoff) continue;

    total++;
    if (exec.status === 'success') successCount++;

    // Aggregate by hook
    if (!byHook[exec.hookType]) {
      byHook[exec.hookType] = {
        total: 0,
        success: 0,
        failure: 0,
        skipped: 0,
        avgDurationMs: 0,
      };
    }
    const hookStats = byHook[exec.hookType];
    hookStats.total++;
    hookStats[exec.status]++;
    hookStats.avgDurationMs += exec.durationMs || 0;

    // Collect recent failures
    if (exec.status === 'failure' && recentFailures.length < 10) {
      recentFailures.push({
        hook: exec.hookType,
        error: exec.metadata?.error || 'Unknown error',
        timestamp: exec.timestamp,
      });
    }
  }

  // Calculate averages
  for (const hookName of Object.keys(byHook)) {
    const stats = byHook[hookName];
    if (stats.total > 0) {
      stats.avgDurationMs = Math.round(stats.avgDurationMs / stats.total);
    }
  }

  return {
    total_24h: total,
    success_rate: total > 0 ? Math.round((successCount / total) * 1000) / 10 : 100,
    by_hook: byHook,
    recent_failures: recentFailures,
  };
}

// ============================================================================
// Task Pipeline
// ============================================================================

interface CountResult {
  count: number;
}

interface TaskCountRow {
  section: string;
  status: string;
  count: number;
}

function getTaskPipeline(hours: number): TaskPipeline {
  const result: TaskPipeline = {
    pending: 0,
    in_progress: 0,
    completed_24h: 0,
    by_section: {},
    stale_tasks: 0,
  };

  if (!fs.existsSync(TODO_DB_PATH)) {
    return result;
  }

  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const now = Math.floor(Date.now() / 1000);
    const since = now - hours * 60 * 60;
    const staleThreshold = now - 30 * 60; // 30 minutes

    // Get task counts by section and status
    const tasks = db.prepare(`
      SELECT section, status, COUNT(*) as count
      FROM tasks
      GROUP BY section, status
    `).all() as TaskCountRow[];

    for (const row of tasks) {
      if (!result.by_section[row.section]) {
        result.by_section[row.section] = { pending: 0, in_progress: 0, completed: 0 };
      }
      result.by_section[row.section][row.status as keyof typeof result.by_section[string]] = row.count;

      if (row.status === 'pending') result.pending += row.count;
      if (row.status === 'in_progress') result.in_progress += row.count;
    }

    // Count completed in time range
    const completedResult = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'completed' AND completed_timestamp >= ?
    `).get(since) as CountResult | undefined;
    result.completed_24h = completedResult?.count || 0;

    // Count stale in_progress tasks
    const staleResult = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'in_progress' AND created_timestamp < ?
    `).get(staleThreshold) as CountResult | undefined;
    result.stale_tasks = staleResult?.count || 0;

    db.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gentyr-dashboard] Error reading todo db: ${message}\n`);
  }

  return result;
}

// ============================================================================
// CTO Queue
// ============================================================================

interface QuestionRow {
  title: string;
  type: string;
  created_at: string;
}

function getCTOQueue(): CTOQueue {
  const result: CTOQueue = {
    pending_questions: 0,
    pending_rejections: 0,
    pending_reports: 0,
    commits_blocked: false,
    recent_escalations: [],
  };

  // Check deputy-cto database
  if (fs.existsSync(DEPUTY_CTO_DB_PATH)) {
    try {
      const db = new Database(DEPUTY_CTO_DB_PATH, { readonly: true });

      const questions = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
      ).get() as CountResult | undefined;
      result.pending_questions = questions?.count || 0;

      const rejections = db.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
      ).get() as CountResult | undefined;
      result.pending_rejections = rejections?.count || 0;

      // Get recent escalations
      const escalations = db.prepare(`
        SELECT title, type, created_at FROM questions
        WHERE status = 'pending'
        ORDER BY created_at DESC
        LIMIT 5
      `).all() as QuestionRow[];

      result.recent_escalations = escalations.map(e => ({
        title: e.title,
        type: e.type,
        timestamp: e.created_at,
      }));

      db.close();
    } catch {
      // Database error - continue with defaults
    }
  }

  // Check cto-reports database for pending triage
  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    try {
      const db = new Database(CTO_REPORTS_DB_PATH, { readonly: true });
      const columns = db.pragma('table_info(reports)') as { name: string }[];
      const hasTriageStatus = columns.some(c => c.name === 'triage_status');

      if (hasTriageStatus) {
        const pending = db.prepare(
          "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
        ).get() as CountResult | undefined;
        result.pending_reports = pending?.count || 0;
      } else {
        const pending = db.prepare(
          "SELECT COUNT(*) as count FROM reports WHERE triaged_at IS NULL"
        ).get() as CountResult | undefined;
        result.pending_reports = pending?.count || 0;
      }

      db.close();
    } catch {
      // Database error - continue with defaults
    }
  }

  result.commits_blocked = result.pending_questions > 0 || result.pending_reports > 0;

  return result;
}

// ============================================================================
// Usage Metrics
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
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
}

function calculateHoursUntil(isoDate: string): number {
  const resetTime = new Date(isoDate).getTime();
  const now = Date.now();
  const hoursUntil = (resetTime - now) / (1000 * 60 * 60);
  return Math.max(0, Math.round(hoursUntil * 10) / 10);
}

function parseBucket(bucket: { utilization: number; resets_at: string } | null | undefined): QuotaBucket | null {
  if (!bucket) return null;
  return {
    utilization: bucket.utilization,
    resets_at: bucket.resets_at,
    resets_in_hours: calculateHoursUntil(bucket.resets_at),
  };
}

async function getQuotaStatus(): Promise<Usage['quota']> {
  const emptyStatus: Usage['quota'] = {
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    error: null,
  };

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return { ...emptyStatus, error: 'No credentials file' };
  }

  let accessToken: string;
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    if (!creds.claudeAiOauth?.accessToken) {
      return { ...emptyStatus, error: 'No OAuth token' };
    }
    if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) {
      return { ...emptyStatus, error: 'Token expired' };
    }
    ({ accessToken } = creds.claudeAiOauth);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...emptyStatus, error: `Credentials error: ${message}` };
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
      seven_day_sonnet: parseBucket(data.seven_day_sonnet),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...emptyStatus, error: `Fetch error: ${message}` };
  }
}

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
  const since = Date.now() - hours * 60 * 60 * 1000;

  const totals: TokenUsage = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  };

  if (!fs.existsSync(sessionDir)) {
    return totals;
  }

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry.timestamp) {
              const entryTime = new Date(entry.timestamp).getTime();
              if (entryTime < since) continue;
            }

            const usage = entry.message?.usage;
            if (usage) {
              totals.input += usage.input_tokens || 0;
              totals.output += usage.output_tokens || 0;
              totals.cache_read += usage.cache_read_input_tokens || 0;
              totals.cache_write += usage.cache_creation_input_tokens || 0;
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    totals.total = totals.input + totals.output + totals.cache_read + totals.cache_write;
  } catch {
    // Directory read error
  }

  return totals;
}

function getSessionCounts(hours: number): Usage['sessions_24h'] {
  const sessionDir = getSessionDir();
  const since = Date.now() - hours * 60 * 60 * 1000;

  const counts = { task: 0, user: 0, total: 0 };

  if (!fs.existsSync(sessionDir)) {
    return counts;
  }

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      counts.total++;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry.type === 'human' || entry.type === 'user') {
              const messageContent = typeof entry.message?.content === 'string'
                ? entry.message.content
                : entry.content;

              if (messageContent?.startsWith('[Task]')) {
                counts.task++;
              } else {
                counts.user++;
              }
              break;
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory read error
  }

  return counts;
}

async function getUsage(hours: number): Promise<Usage> {
  const quotaStatus = await getQuotaStatus();

  return {
    tokens_24h: getTokenUsage(hours),
    quota: quotaStatus,
    sessions_24h: getSessionCounts(hours),
  };
}

// ============================================================================
// API Keys
// ============================================================================

interface KeyRotationState {
  version: number;
  active_key_id: string | null;
  keys: Record<string, {
    status: 'active' | 'exhausted' | 'invalid' | 'expired';
    last_usage: {
      five_hour: number;
      seven_day: number;
    } | null;
  }>;
  rotation_log: Array<{
    timestamp: number;
    event: string;
  }>;
}

function getApiKeys(hours: number): ApiKeys | null {
  if (!fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8')) as KeyRotationState;
    if (!state || state.version !== 1) return null;

    const now = Date.now();
    const since = now - hours * 60 * 60 * 1000;

    let activeCount = 0;
    let exhaustedCount = 0;
    const keys: ApiKeys['keys'] = [];

    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status === 'active') activeCount++;
      if (keyData.status === 'exhausted') exhaustedCount++;

      keys.push({
        id: `${keyId.slice(0, 8)}...`,
        status: keyData.status,
        five_hour_pct: keyData.last_usage?.five_hour ?? null,
        seven_day_pct: keyData.last_usage?.seven_day ?? null,
      });
    }

    const rotationEvents = state.rotation_log.filter(
      e => e.timestamp >= since && e.event === 'key_switched'
    ).length;

    return {
      total: Object.keys(state.keys).length,
      active: activeCount,
      exhausted: exhaustedCount,
      rotation_events_24h: rotationEvents,
      keys,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Compliance
// ============================================================================

interface ComplianceState {
  globalSpecs?: { lastRun?: string };
  localSpecs?: { lastRun?: string };
}

interface ComplianceLog {
  dailySpawns?: Record<string, number>;
  history?: Array<{ mode: string; count: number; date: string }>;
}

function getCompliance(): Compliance | null {
  const state = safeReadJson<ComplianceState>(COMPLIANCE_STATE_PATH, {});
  const log = safeReadJson<ComplianceLog>(COMPLIANCE_LOG_PATH, {});

  const today = new Date().toISOString().slice(0, 10);
  let globalAgentsToday = 0;
  let localAgentsToday = 0;

  if (log.history) {
    for (const entry of log.history) {
      const entryDate = entry.date.slice(0, 10);
      if (entryDate === today) {
        if (entry.mode === 'global') globalAgentsToday += entry.count;
        if (entry.mode === 'local') localAgentsToday += entry.count;
      }
    }
  }

  const lastGlobalRun = state.globalSpecs?.lastRun;
  const lastLocalRun = state.localSpecs?.lastRun;
  const lastRun = lastGlobalRun || lastLocalRun || null;

  return {
    global_agents_today: globalAgentsToday,
    local_agents_today: localAgentsToday,
    last_run: lastRun,
    files_needing_check: 0, // Would require reading mapping file
  };
}

// ============================================================================
// Sessions
// ============================================================================

function getSessions(hours: number): Sessions {
  const sessionDir = getSessionDir();
  const since = Date.now() - hours * 60 * 60 * 1000;

  const result: Sessions = {
    task_triggered: 0,
    user_triggered: 0,
    by_task_type: {},
  };

  if (!fs.existsSync(sessionDir)) {
    return result;
  }

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry.type === 'human' || entry.type === 'user') {
              const messageContent = typeof entry.message?.content === 'string'
                ? entry.message.content
                : entry.content;

              if (messageContent?.startsWith('[Task]')) {
                result.task_triggered++;

                // Extract task type: [Task][type-name] -> type-name
                const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
                const taskType = typeMatch?.[1] || 'unknown';
                result.by_task_type[taskType] = (result.by_task_type[taskType] || 0) + 1;
              } else {
                result.user_triggered++;
              }
              break;
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory read error
  }

  return result;
}

// ============================================================================
// Main Dashboard Function
// ============================================================================

async function getDashboard(args: GetDashboardArgs): Promise<GentyrDashboard> {
  const hours = args.hours ?? 24;

  const [usage] = await Promise.all([
    getUsage(hours),
  ]);

  return {
    generated_at: new Date().toISOString(),
    hours,
    system_health: getSystemHealth(),
    agent_activity: getAgentActivity(hours),
    hook_executions: getHookExecutions(hours),
    task_pipeline: getTaskPipeline(hours),
    cto_queue: getCTOQueue(),
    usage,
    api_keys: getApiKeys(hours),
    compliance: getCompliance(),
    sessions: getSessions(hours),
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: ToolHandler[] = [
  {
    name: 'get_dashboard',
    description: 'Get comprehensive GENTYR activity dashboard with all system metrics, agent spawns, hook executions, and usage data.',
    schema: GetDashboardArgsSchema,
    handler: getDashboard,
  },
];

const server = new McpServer({
  name: 'gentyr-dashboard',
  version: '1.0.0',
  tools,
});

server.start();
