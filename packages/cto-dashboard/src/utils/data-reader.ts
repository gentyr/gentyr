/**
 * Data reader utility - reads from all data sources
 * Adapted from cto-report MCP server logic
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { openReadonlyDb } from './readonly-db.js';
import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const DEPUTY_CTO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const USER_FEEDBACK_DB_PATH = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
const AUTONOMOUS_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const KEY_ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const COOLDOWN_MINUTES = 55;

const PROTECTED_FILES = [
  path.join(PROJECT_DIR, '.claude', 'hooks', 'pre-commit-review.js'),
  path.join(PROJECT_DIR, 'eslint.config.js'),
  path.join(PROJECT_DIR, '.husky', 'pre-commit'),
];

function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

// ============================================================================
// Types
// ============================================================================

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

export interface AutonomousModeStatus {
  enabled: boolean;
  interval_minutes: number;
  next_run_time: Date | null;
  seconds_until_next: number | null;
}

export interface AggregateQuota {
  active_keys: number;
  five_hour_pct: number;
  seven_day_pct: number;
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

export interface SessionMetrics {
  task_triggered: number;
  user_triggered: number;
  task_by_type: Record<string, number>;
}

export interface PendingItems {
  cto_questions: number;
  commit_rejections: number;
  pending_triage: number;
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
  pending_total: number;
  in_progress_total: number;
  completed_total: number;
  by_section: Record<string, SectionTaskCounts>;
  completed_24h: number;
  completed_24h_by_section: Record<string, number>;
}

export interface HookStats {
  total: number;
  success: number;
  failure: number;
  skipped: number;
}

export interface HookExecutions {
  total_24h: number;
  skipped_24h: number;
  success_rate: number;
  by_hook: Record<string, HookStats>;
  recent_failures: Array<{ hook: string; error: string; timestamp: string }>;
}

export interface AgentActivity {
  spawns_24h: number;
  spawns_7d: number;
  by_type: Record<string, number>;
}

export interface SystemHealth {
  protection_status: 'protected' | 'unprotected' | 'unknown';
}

export interface AutomationCooldowns {
  hourly_tasks: number;
  triage_check: number;
  antipattern_hunter: number;
  schema_mapper: number;
  lint_checker: number;
  todo_maintenance: number;
  task_runner: number;
  triage_per_item: number;
  preview_promotion: number;
  staging_promotion: number;
  staging_health_monitor: number;
  production_health_monitor: number;
  standalone_antipattern_hunter: number;
  standalone_compliance_checker: number;
  user_feedback: number;
  pre_commit_review: number;
  test_failure_reporter: number;
  compliance_checker_file: number;
  compliance_checker_spec: number;
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

export type AutomationTrigger = 'continuous' | 'commit' | 'prompt' | 'file-change';

export interface AutomationInfo {
  name: string;
  description: string;
  trigger: AutomationTrigger;
  default_interval_minutes: number | null;  // null for hook-triggered
  effective_interval_minutes: number | null;
  last_run: Date | null;
  next_run: Date | null;
  seconds_until_next: number | null;
}

export interface PersonaReport {
  id: string;
  title: string;
  priority: string;
  triage_status: string;
  created_at: string;
}

export interface SatisfactionDistribution {
  very_satisfied: number;
  satisfied: number;
  neutral: number;
  dissatisfied: number;
  very_dissatisfied: number;
}

export interface FeedbackPersonaSummary {
  name: string;
  consumption_mode: string;
  enabled: boolean;
  session_count: number;
  last_satisfaction: string | null;
  findings_count: number;
  recent_reports: PersonaReport[];
}

export interface FeedbackPersonasData {
  personas: FeedbackPersonaSummary[];
  total_sessions: number;
  total_findings: number;
  satisfaction_distribution: SatisfactionDistribution;
}

export interface DashboardData {
  generated_at: Date;
  hours: number;
  system_health: SystemHealth;
  autonomous_mode: AutonomousModeStatus;
  quota: QuotaStatus;
  verified_quota: VerifiedQuotaResult;
  token_usage: TokenUsage;
  usage_projection: UsageProjection;
  key_rotation: KeyRotationMetrics | null;
  automations: AutomationInfo[];
  agents: AgentActivity;
  hooks: HookExecutions;
  sessions: SessionMetrics;
  pending_items: PendingItems;
  triage: TriageMetrics;
  tasks: TaskMetrics;
  feedback_personas: FeedbackPersonasData;
}

// ============================================================================
// Internal interfaces
// ============================================================================

// G003: Zod schemas for external input validation
const CredentialsFileSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().optional(),
    expiresAt: z.number().optional(),
  }).optional(),
}).passthrough();

type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

const UsageBucketSchema = z.object({
  utilization: z.number(),
  resets_at: z.string(),
}).nullable().optional();

const UsageApiResponseSchema = z.object({
  five_hour: UsageBucketSchema,
  seven_day: UsageBucketSchema,
  extra_usage: z.object({ is_enabled: z.boolean() }).nullable().optional(),
}).passthrough();

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

interface CountResult {
  count: number;
}

interface TaskCountRow {
  section: string;
  status: string;
  count: number;
}

interface CompletedCountRow {
  section: string;
  count: number;
}

const AgentHistorySchema = z.object({
  agents: z.array(z.object({
    id: z.string(),
    type: z.string(),
    hookType: z.string(),
    timestamp: z.string(),
  }).passthrough()).default([]),
}).passthrough();

const HookHistorySchema = z.object({
  hookExecutions: z.array(z.object({
    hookType: z.string(),
    status: z.enum(['success', 'failure', 'skipped']),
    timestamp: z.string(),
    metadata: z.object({ error: z.string().optional() }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough();

const KeyRotationKeyDataSchema = z.object({
  accessToken: z.string().optional(),
  subscriptionType: z.string(),
  last_usage: z.object({
    five_hour: z.number(),
    seven_day: z.number(),
  }).nullable(),
  status: z.enum(['active', 'exhausted', 'invalid', 'expired']),
  account_uuid: z.string().nullable().optional(),
}).passthrough();

const KeyRotationStateSchema = z.object({
  version: z.number(),
  active_key_id: z.string().nullable(),
  keys: z.record(z.string(), KeyRotationKeyDataSchema),
  rotation_log: z.array(z.object({
    timestamp: z.number(),
    event: z.string(),
  })),
});

type KeyRotationState = z.infer<typeof KeyRotationStateSchema>;

const AutomationCooldownsPartialSchema = z.object({
  hourly_tasks: z.number().optional(),
  triage_check: z.number().optional(),
  antipattern_hunter: z.number().optional(),
  schema_mapper: z.number().optional(),
  lint_checker: z.number().optional(),
  todo_maintenance: z.number().optional(),
  task_runner: z.number().optional(),
  triage_per_item: z.number().optional(),
  preview_promotion: z.number().optional(),
  staging_promotion: z.number().optional(),
  staging_health_monitor: z.number().optional(),
  production_health_monitor: z.number().optional(),
  standalone_antipattern_hunter: z.number().optional(),
  standalone_compliance_checker: z.number().optional(),
  user_feedback: z.number().optional(),
  pre_commit_review: z.number().optional(),
  test_failure_reporter: z.number().optional(),
  compliance_checker_file: z.number().optional(),
  compliance_checker_spec: z.number().optional(),
}).passthrough();

const AutomationConfigFileSchema = z.object({
  version: z.number(),
  defaults: AutomationCooldownsPartialSchema.optional(),
  effective: AutomationCooldownsPartialSchema.optional(),
  adjustment: z.object({
    factor: z.number().optional(),
    target_pct: z.number().optional(),
    projected_at_reset: z.number().optional(),
    constraining_metric: z.enum(['5h', '7d']).optional(),
    last_updated: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

// ============================================================================
// Key ID Generation (matches api-key-watcher.js:89-98)
// ============================================================================

function generateKeyId(accessToken: string): string {
  const cleanToken = accessToken
    .replace(/^sk-ant-oat01-/, '')
    .replace(/^sk-ant-/, '');
  return crypto.createHash('sha256').update(cleanToken).digest('hex').substring(0, 16);
}

// ============================================================================
// Quota Status
// ============================================================================

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

/**
 * Extract a valid access token from a credentials JSON object.
 * Returns null if missing or expired.
 */
function extractTokenFromCreds(creds: CredentialsFile): string | null {
  if (!creds.claudeAiOauth?.accessToken) return null;
  if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) return null;
  return creds.claudeAiOauth.accessToken;
}

/**
 * Get a credential token from non-rotation sources (env, keychain, creds file).
 * Sources 1-4 in priority order. Used by both getAccessToken() and collectAllKeys().
 */
function getCredentialToken(): string | null {
  // Source 1: Environment variable override
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) return envToken;

  // Source 2: macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const { username } = os.userInfo();
      const raw = execFileSync('security', [
        'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
      ], { encoding: 'utf8', timeout: 3000 }).trim();
      const creds = CredentialsFileSchema.parse(JSON.parse(raw));
      const token = extractTokenFromCreds(creds);
      if (token) return token;
    } catch {
      // Keychain entry not found or parse error — fall through
    }
  }

  // Source 3: CLAUDE_CONFIG_DIR override
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) {
    const configCredsPath = path.join(configDir, '.credentials.json');
    try {
      if (fs.existsSync(configCredsPath)) {
        const creds = CredentialsFileSchema.parse(JSON.parse(fs.readFileSync(configCredsPath, 'utf8')));
        const token = extractTokenFromCreds(creds);
        if (token) return token;
      }
    } catch {
      // Fall through
    }
  }

  // Source 4: Standard credentials file (~/.claude/.credentials.json)
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = CredentialsFileSchema.parse(JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')));
      const token = extractTokenFromCreds(creds);
      if (token) return token;
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * Get an access token from all available sources, in priority order:
 *   1-4. Credential sources (env, keychain, config dir, standard creds)
 *   5. api-key-rotation.json (user-level, active keys only)
 */
function getAccessToken(): string | null {
  const credToken = getCredentialToken();
  if (credToken) return credToken;

  // Source 5: Key rotation state (project-level, active keys only)
  if (fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    try {
      const state = KeyRotationStateSchema.parse(JSON.parse(fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8')));
      if (state?.version === 1 && state.keys) {
        const activeKeyData = state.active_key_id ? state.keys[state.active_key_id] : undefined;
        if (activeKeyData?.accessToken && activeKeyData.status === 'active') {
          return activeKeyData.accessToken;
        }
        for (const keyData of Object.values(state.keys)) {
          if (keyData.accessToken && keyData.status === 'active') {
            return keyData.accessToken;
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  return null;
}

const EMPTY_QUOTA: QuotaStatus = {
  five_hour: null,
  seven_day: null,
  extra_usage_enabled: false,
  error: null,
};

async function fetchQuotaForToken(accessToken: string): Promise<QuotaStatus> {
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'gentyr-dashboard/1.0.0',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (!response.ok) {
      return { ...EMPTY_QUOTA, error: `API error: ${response.status}` };
    }

    const data = UsageApiResponseSchema.parse(await response.json());

    return {
      five_hour: parseBucket(data.five_hour),
      seven_day: parseBucket(data.seven_day),
      extra_usage_enabled: data.extra_usage?.is_enabled ?? false,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...EMPTY_QUOTA, error: `Fetch error: ${message}` };
  }
}

export async function getQuotaStatus(): Promise<QuotaStatus> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return { ...EMPTY_QUOTA, error: 'No credentials found' };
  }
  return fetchQuotaForToken(accessToken);
}

// ============================================================================
// Per-Key Verified Quota
// ============================================================================

interface CollectedKey {
  key_id: string;
  access_token: string;
  subscription_type: string;
  is_current: boolean;
}

/**
 * Collect all unique keys from rotation state + credentials.
 * Keys are deduplicated by key ID (SHA256 hash of token).
 */
function collectAllKeys(): { keys: CollectedKey[]; rotationState: KeyRotationState | null } {
  const keyMap = new Map<string, CollectedKey>();
  let rotationState: KeyRotationState | null = null;

  // Source A: Key rotation state file — include active and exhausted keys
  // (exhausted keys may have recovered since the last watcher run)
  if (fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    try {
      const content = fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8');
      const state = KeyRotationStateSchema.parse(JSON.parse(content));
      if (state?.version === 1 && typeof state.keys === 'object') {
        rotationState = state;
        for (const [keyId, keyData] of Object.entries(state.keys)) {
          if (keyData.status === 'invalid' || keyData.status === 'expired') continue;
          if (!keyData.accessToken) continue;
          keyMap.set(keyId, {
            key_id: keyId,
            access_token: keyData.accessToken,
            subscription_type: keyData.subscriptionType || 'unknown',
            is_current: keyId === state.active_key_id,
          });
        }
      }
    } catch (err) {
      process.stderr.write(`[data-reader] Failed to parse key rotation state at ${KEY_ROTATION_STATE_PATH}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Source B: Current credentials (env, keychain, creds file)
  // Skip rotation state source (source 5 in getAccessToken) to avoid double-count —
  // we read those directly above. Check env, keychain, and creds file sources.
  const credToken = getCredentialToken();
  if (credToken) {
    const credKeyId = generateKeyId(credToken);
    if (!keyMap.has(credKeyId)) {
      keyMap.set(credKeyId, {
        key_id: credKeyId,
        access_token: credToken,
        subscription_type: 'unknown',
        is_current: !rotationState,
      });
    }
  }

  return { keys: Array.from(keyMap.values()), rotationState };
}

/**
 * Fetch quota for all keys in parallel, return verified results.
 * Only keys that successfully authenticate are counted as healthy.
 */
export async function getVerifiedQuota(hours: number): Promise<VerifiedQuotaResult> {
  const { keys, rotationState } = collectAllKeys();

  if (keys.length === 0) {
    return {
      keys: [],
      healthy_count: 0,
      total_attempted: 0,
      aggregate: { ...EMPTY_QUOTA, error: 'No keys found' },
      rotation_events_24h: 0,
    };
  }

  // Fetch quota for all keys in parallel
  const results = await Promise.all(
    keys.map(async (key): Promise<VerifiedKey> => {
      const quota = await fetchQuotaForToken(key.access_token);
      return {
        key_id: `${key.key_id.slice(0, 8)}...`,
        subscription_type: key.subscription_type,
        is_current: key.is_current,
        healthy: !quota.error,
        quota: quota.error ? null : quota,
      };
    })
  );

  const healthyKeys = results.filter(k => k.healthy && k.quota);

  // Aggregate: average utilization across healthy keys
  const aggregate = buildAggregate(healthyKeys);

  // Rotation events from state file
  let rotationEvents24h = 0;
  if (rotationState) {
    const since = Date.now() - (hours * 60 * 60 * 1000);
    rotationEvents24h = rotationState.rotation_log.filter(
      entry => entry.timestamp >= since && entry.event === 'key_switched'
    ).length;
  }

  return {
    keys: results,
    healthy_count: healthyKeys.length,
    total_attempted: keys.length,
    aggregate,
    rotation_events_24h: rotationEvents24h,
  };
}

function buildAggregate(healthyKeys: VerifiedKey[]): QuotaStatus {
  if (healthyKeys.length === 0) {
    return { ...EMPTY_QUOTA, error: 'No healthy keys' };
  }

  const avgBucket = (getBucket: (q: QuotaStatus) => QuotaBucket | null): QuotaBucket | null => {
    const buckets = healthyKeys
      .map(k => getBucket(k.quota!))
      .filter((b): b is QuotaBucket => b !== null);
    if (buckets.length === 0) return null;
    const avgUtil = Math.round(buckets.reduce((s, b) => s + b.utilization, 0) / buckets.length);
    // Use earliest reset time
    const earliest = buckets.reduce((a, b) =>
      new Date(a.resets_at).getTime() < new Date(b.resets_at).getTime() ? a : b
    );
    return {
      utilization: avgUtil,
      resets_at: earliest.resets_at,
      resets_in_hours: earliest.resets_in_hours,
    };
  };

  return {
    five_hour: avgBucket(q => q.five_hour),
    seven_day: avgBucket(q => q.seven_day),
    extra_usage_enabled: healthyKeys.some(k => k.quota!.extra_usage_enabled),
    error: null,
  };
}

// ============================================================================
// Token Usage
// ============================================================================

export function getTokenUsage(hours: number): TokenUsage {
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
    const stat = fs.statSync(filePath);
    if (stat.mtime.getTime() < since) continue;

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
          totals.cache_creation += usage.cache_creation_input_tokens || 0;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;

  return totals;
}

// ============================================================================
// Autonomous Mode Status
// ============================================================================

export function getAutonomousModeStatus(): AutonomousModeStatus {
  let enabled = false;

  if (fs.existsSync(AUTONOMOUS_CONFIG_PATH)) {
    const config = z.object({ enabled: z.boolean().optional() }).parse(JSON.parse(fs.readFileSync(AUTONOMOUS_CONFIG_PATH, 'utf8')));
    enabled = config.enabled === true;
  }

  let next_run_time: Date | null = null;
  let seconds_until_next: number | null = null;

  if (enabled && fs.existsSync(AUTOMATION_STATE_PATH)) {
    const state = z.object({ lastRun: z.number().optional() }).parse(JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8')));
    const lastRun = state.lastRun || 0;
    const now = Date.now();
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
    const nextRunMs = lastRun + cooldownMs;

    next_run_time = new Date(nextRunMs);
    seconds_until_next = Math.max(0, Math.floor((nextRunMs - now) / 1000));
  } else if (enabled) {
    // First run - ready now
    next_run_time = new Date();
    seconds_until_next = 0;
  }

  return {
    enabled,
    interval_minutes: COOLDOWN_MINUTES,
    next_run_time,
    seconds_until_next,
  };
}

// ============================================================================
// Session Metrics
// ============================================================================

function parseTaskType(messageContent: string): string | null {
  if (!messageContent.startsWith('[Task]')) return null;
  const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
  if (typeMatch && typeMatch[1]) return typeMatch[1];
  return 'unknown';
}

export function getSessionMetrics(hours: number): SessionMetrics {
  const since = Date.now() - (hours * 60 * 60 * 1000);
  const sessionDir = getSessionDir();

  const metrics: SessionMetrics = {
    task_triggered: 0,
    user_triggered: 0,
    task_by_type: {},
  };

  if (!fs.existsSync(sessionDir)) return metrics;

  const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtime.getTime() < since) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    let taskType: string | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type === 'human' || entry.type === 'user') {
          const messageContent = typeof entry.message?.content === 'string'
            ? entry.message.content
            : entry.content;

          if (messageContent) {
            taskType = parseTaskType(messageContent);
          }
          break;
        }
      } catch {
        // Skip malformed lines
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

export function getPendingItems(): PendingItems {
  const items: PendingItems = {
    cto_questions: 0,
    commit_rejections: 0,
    pending_triage: 0,
    commits_blocked: false,
  };

  if (fs.existsSync(DEPUTY_CTO_DB_PATH)) {
    const db = openReadonlyDb(DEPUTY_CTO_DB_PATH);
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

  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    const db = openReadonlyDb(CTO_REPORTS_DB_PATH);
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
    ).get() as CountResult | undefined;
    items.pending_triage = pending?.count || 0;
    db.close();
  }

  items.commits_blocked = items.cto_questions > 0 || items.pending_triage > 0;
  return items;
}

// ============================================================================
// Triage Metrics
// ============================================================================

export function getTriageMetrics(): TriageMetrics {
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

  if (!fs.existsSync(CTO_REPORTS_DB_PATH)) return metrics;

  const db = openReadonlyDb(CTO_REPORTS_DB_PATH);
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

export function getTaskMetrics(hours: number): TaskMetrics {
  const metrics: TaskMetrics = {
    pending_total: 0,
    in_progress_total: 0,
    completed_total: 0,
    by_section: {},
    completed_24h: 0,
    completed_24h_by_section: {},
  };

  if (!fs.existsSync(TODO_DB_PATH)) return metrics;

  const db = openReadonlyDb(TODO_DB_PATH);

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

    if (row.status === 'pending') metrics.pending_total += row.count;
    else if (row.status === 'in_progress') metrics.in_progress_total += row.count;
    else if (row.status === 'completed') metrics.completed_total += row.count;
  }

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

export function getSystemHealth(): SystemHealth {
  let protectionStatus: 'protected' | 'unprotected' | 'unknown' = 'unknown';
  let allProtected = true;
  let anyExists = false;

  for (const file of PROTECTED_FILES) {
    if (fs.existsSync(file)) {
      anyExists = true;
      try {
        const stats = fs.statSync(file);
        if (stats.uid !== 0) allProtected = false;
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

export function getAgentActivity(): AgentActivity {
  const result: AgentActivity = {
    spawns_24h: 0,
    spawns_7d: 0,
    by_type: {},
  };

  if (!fs.existsSync(AGENT_TRACKER_PATH)) return result;

  const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
  const history = AgentHistorySchema.parse(JSON.parse(content));

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

  for (const agent of history.agents) {
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

export function getHookExecutions(): HookExecutions {
  const result: HookExecutions = {
    total_24h: 0,
    skipped_24h: 0,
    success_rate: 100,
    by_hook: {},
    recent_failures: [],
  };

  if (!fs.existsSync(AGENT_TRACKER_PATH)) return result;

  const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
  const history = HookHistorySchema.parse(JSON.parse(content));

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  let successCount = 0;
  let skippedCount = 0;

  for (const exec of history.hookExecutions) {
    const execTime = new Date(exec.timestamp).getTime();
    if (execTime < cutoff24h) continue;

    result.total_24h++;
    if (exec.status === 'success') successCount++;
    else if (exec.status === 'skipped') skippedCount++;

    if (!result.by_hook[exec.hookType]) {
      result.by_hook[exec.hookType] = { total: 0, success: 0, failure: 0, skipped: 0 };
    }
    const stats = result.by_hook[exec.hookType];
    stats.total++;
    if (exec.status === 'success') stats.success++;
    else if (exec.status === 'failure') stats.failure++;
    else if (exec.status === 'skipped') stats.skipped++;

    if (exec.status === 'failure' && result.recent_failures.length < 5) {
      result.recent_failures.push({
        hook: exec.hookType,
        error: exec.metadata?.error || 'Unknown error',
        timestamp: exec.timestamp,
      });
    }
  }

  result.skipped_24h = skippedCount;
  // Calculate success rate excluding skipped executions
  const relevantTotal = result.total_24h - skippedCount;
  if (relevantTotal > 0) {
    result.success_rate = Math.round((successCount / relevantTotal) * 100);
  }

  return result;
}

// ============================================================================
// Key Rotation Metrics
// ============================================================================

export function getKeyRotationMetrics(hours: number): KeyRotationMetrics | null {
  if (!fs.existsSync(KEY_ROTATION_STATE_PATH)) return null;

  const content = fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8');
  const state = KeyRotationStateSchema.parse(JSON.parse(content));

  if (!state || state.version !== 1 || typeof state.keys !== 'object') {
    process.stderr.write(`[data-reader] Invalid key rotation state format at ${KEY_ROTATION_STATE_PATH}\n`);
    return null;
  }

  const now = Date.now();
  const since = now - (hours * 60 * 60 * 1000);

  const keys: TrackedKeyInfo[] = [];

  // Per-key display list (all active keys shown in dashboard key list)
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status !== 'active') continue;
    const isCurrent = keyId === state.active_key_id;

    keys.push({
      key_id: `${keyId.slice(0, 8)}...`,
      subscription_type: keyData.subscriptionType || 'unknown',
      five_hour_pct: keyData.last_usage?.five_hour ?? null,
      seven_day_pct: keyData.last_usage?.seven_day ?? null,
      is_current: isCurrent,
    });
  }

  // Group by account for aggregate calculation (dedup same-account tokens).
  // Matches the pattern in cto-notification-hook.js:getAggregateQuota().
  const accountMap = new Map<string, { fiveHour: number; sevenDay: number }>();
  for (const [, keyData] of Object.entries(state.keys)) {
    if (keyData.status !== 'active') continue;
    if (!keyData.last_usage) continue;
    const dedupeKey = keyData.account_uuid
      || `fp:${keyData.last_usage.five_hour}:${keyData.last_usage.seven_day}`;
    if (!accountMap.has(dedupeKey)) {
      accountMap.set(dedupeKey, {
        fiveHour: keyData.last_usage.five_hour ?? 0,
        sevenDay: keyData.last_usage.seven_day ?? 0,
      });
    }
  }
  const accounts = Array.from(accountMap.values());

  const rotationEvents24h = state.rotation_log.filter(
    entry => entry.timestamp >= since && entry.event === 'key_switched'
  ).length;

  const aggregate: AggregateQuota | null = accounts.length > 0 ? {
    active_keys: accounts.length,
    five_hour_pct: Math.round(accounts.reduce((s, a) => s + a.fiveHour, 0) / accounts.length),
    seven_day_pct: Math.round(accounts.reduce((s, a) => s + a.sevenDay, 0) / accounts.length),
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
  preview_promotion: 360,
  staging_promotion: 1200,
  staging_health_monitor: 180,
  production_health_monitor: 60,
  standalone_antipattern_hunter: 180,
  standalone_compliance_checker: 60,
  user_feedback: 120,
  pre_commit_review: 5,
  test_failure_reporter: 120,
  compliance_checker_file: 10080,
  compliance_checker_spec: 10080,
};

export function getUsageProjection(): UsageProjection {
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

  if (!fs.existsSync(AUTOMATION_CONFIG_PATH)) return result;

  const content = fs.readFileSync(AUTOMATION_CONFIG_PATH, 'utf8');
  const config = AutomationConfigFileSchema.parse(JSON.parse(content));

  if (!config || config.version !== 1) {
    process.stderr.write(`[data-reader] Invalid automation config format at ${AUTOMATION_CONFIG_PATH}\n`);
    return result;
  }

  if (config.defaults) {
    Object.assign(defaults, config.defaults);
    result.default_cooldowns = defaults;
  }

  if (config.effective) {
    Object.assign(effective, config.defaults || {}, config.effective);
    result.effective_cooldowns = effective;
  }

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
// Automations Info
// ============================================================================

const AutomationStateSchema = z.object({
  lastRun: z.number().optional(),
  lastClaudeMdRefactor: z.number().optional(),
  lastTriageCheck: z.number().optional(),
  lastTaskRunnerCheck: z.number().optional(),
  lastLintCheck: z.number().optional(),
}).passthrough();

type AutomationState = z.infer<typeof AutomationStateSchema>;

// Automation definitions with their state keys and defaults
const AUTOMATION_DEFINITIONS: Array<{
  name: string;
  description: string;
  trigger: AutomationTrigger;
  stateKey: keyof AutomationState | null;
  cooldownKey: keyof AutomationCooldowns | null;
  defaultMinutes: number | null;
}> = [
  // Continuous automations
  {
    name: 'Triage Check',
    description: 'Check for pending reports to triage',
    trigger: 'continuous',
    stateKey: 'lastTriageCheck',
    cooldownKey: 'triage_check',
    defaultMinutes: 5,
  },
  {
    name: 'Task Runner',
    description: 'Spawn agents for pending todo tasks',
    trigger: 'continuous',
    stateKey: 'lastTaskRunnerCheck',
    cooldownKey: 'task_runner',
    defaultMinutes: 15,
  },
  {
    name: 'Lint Check',
    description: 'Run lint fixer on codebase',
    trigger: 'continuous',
    stateKey: 'lastLintCheck',
    cooldownKey: 'lint_checker',
    defaultMinutes: 30,
  },
  {
    name: 'Hourly Tasks',
    description: 'Plan executor and CLAUDE.md refactor',
    trigger: 'continuous',
    stateKey: 'lastRun',
    cooldownKey: 'hourly_tasks',
    defaultMinutes: 55,
  },
  {
    name: 'Antipattern Hunter',
    description: 'Scan for spec violations',
    trigger: 'continuous',
    stateKey: null,  // Managed differently
    cooldownKey: 'antipattern_hunter',
    defaultMinutes: 360,
  },
  // Hook-triggered automations
  {
    name: 'Pre-Commit Review',
    description: 'Deputy CTO reviews commits',
    trigger: 'commit',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
  {
    name: 'Compliance Checker',
    description: 'Verify spec-to-code mappings',
    trigger: 'file-change',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
  {
    name: 'CTO Notification',
    description: 'Show status on each prompt',
    trigger: 'prompt',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
];

export function getAutomations(): AutomationInfo[] {
  const projection = getUsageProjection();
  const now = Date.now();

  // Read automation state
  let state: AutomationState = {};
  if (fs.existsSync(AUTOMATION_STATE_PATH)) {
    state = AutomationStateSchema.parse(JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8')));
  }

  return AUTOMATION_DEFINITIONS.map(def => {
    let defaultInterval = def.defaultMinutes;
    let effectiveInterval = def.defaultMinutes;
    let lastRun: Date | null = null;
    let nextRun: Date | null = null;
    let secondsUntilNext: number | null = null;

    // Get effective cooldown from projection if available
    if (def.cooldownKey) {
      defaultInterval = projection.default_cooldowns[def.cooldownKey] ?? def.defaultMinutes;
      effectiveInterval = projection.effective_cooldowns[def.cooldownKey] ?? defaultInterval;
    }

    // Get last run time from state
    if (def.stateKey && state[def.stateKey]) {
      lastRun = new Date(state[def.stateKey] as number);

      // Calculate next run if we have an interval
      if (effectiveInterval != null) {
        const nextRunMs = (state[def.stateKey] as number) + (effectiveInterval * 60 * 1000);
        nextRun = new Date(nextRunMs);
        secondsUntilNext = Math.max(0, Math.floor((nextRunMs - now) / 1000));
      }
    }

    return {
      name: def.name,
      description: def.description,
      trigger: def.trigger,
      default_interval_minutes: defaultInterval,
      effective_interval_minutes: effectiveInterval,
      last_run: lastRun,
      next_run: nextRun,
      seconds_until_next: secondsUntilNext,
    };
  });
}

// ============================================================================
// Feedback Personas
// ============================================================================

const EMPTY_SATISFACTION: SatisfactionDistribution = {
  very_satisfied: 0,
  satisfied: 0,
  neutral: 0,
  dissatisfied: 0,
  very_dissatisfied: 0,
};

export function getFeedbackPersonas(): FeedbackPersonasData {
  if (!fs.existsSync(USER_FEEDBACK_DB_PATH)) {
    return { personas: [], total_sessions: 0, total_findings: 0, satisfaction_distribution: { ...EMPTY_SATISFACTION } };
  }

  const db = openReadonlyDb(USER_FEEDBACK_DB_PATH);

  // Query personas with aggregated session data
  interface PersonaRow {
    name: string;
    consumption_mode: string;
    enabled: number;
    session_count: number;
    findings_count: number;
  }

  const personas = db.prepare(`
    SELECT p.name, p.consumption_mode, p.enabled,
           COUNT(fs.id) as session_count,
           COALESCE(SUM(fs.findings_count), 0) as findings_count
    FROM personas p
    LEFT JOIN feedback_sessions fs ON fs.persona_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all() as PersonaRow[];

  // Get latest satisfaction per persona
  const satisfactionMap = new Map<string, string>();
  interface SatisfactionRow { name: string; satisfaction_level: string }
  const satRows = db.prepare(`
    SELECT p.name, fs.satisfaction_level
    FROM personas p
    JOIN feedback_sessions fs ON fs.persona_id = p.id
    WHERE fs.satisfaction_level IS NOT NULL
    AND fs.completed_at = (
      SELECT MAX(fs2.completed_at) FROM feedback_sessions fs2
      WHERE fs2.persona_id = p.id AND fs2.satisfaction_level IS NOT NULL
    )
  `).all() as SatisfactionRow[];
  for (const row of satRows) {
    satisfactionMap.set(row.name, row.satisfaction_level);
  }

  // Aggregate satisfaction distribution across all sessions
  interface SatisfactionCountRow { satisfaction_level: string; count: number }
  const satDist: SatisfactionDistribution = { ...EMPTY_SATISFACTION };
  const satDistRows = db.prepare(`
    SELECT satisfaction_level, COUNT(*) as count
    FROM feedback_sessions
    WHERE satisfaction_level IS NOT NULL
    GROUP BY satisfaction_level
  `).all() as SatisfactionCountRow[];
  for (const row of satDistRows) {
    const key = row.satisfaction_level as keyof SatisfactionDistribution;
    if (key in satDist) {
      satDist[key] = row.count;
    }
  }

  db.close();

  // Query recent reports per persona from cto-reports.db
  const reportsMap = new Map<string, PersonaReport[]>();
  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    const reportsDb = openReadonlyDb(CTO_REPORTS_DB_PATH);
    interface ReportRow { id: string; title: string; priority: string; triage_status: string; created_at: string }
    for (const p of personas) {
      const agentName = `feedback-${p.name}`;
      const reports = reportsDb.prepare(`
        SELECT id, title, priority, triage_status, created_at
        FROM reports
        WHERE reporting_agent = ?
        ORDER BY created_timestamp DESC
        LIMIT 3
      `).all(agentName) as ReportRow[];
      if (reports.length > 0) {
        reportsMap.set(p.name, reports);
      }
    }
    reportsDb.close();
  }

  const result: FeedbackPersonaSummary[] = personas.map((p) => ({
    name: p.name,
    consumption_mode: p.consumption_mode,
    enabled: p.enabled === 1,
    session_count: p.session_count,
    last_satisfaction: satisfactionMap.get(p.name) ?? null,
    findings_count: p.findings_count,
    recent_reports: reportsMap.get(p.name) ?? [],
  }));

  return {
    personas: result,
    total_sessions: result.reduce((s, p) => s + p.session_count, 0),
    total_findings: result.reduce((s, p) => s + p.findings_count, 0),
    satisfaction_distribution: satDist,
  };
}

// ============================================================================
// Main Data Fetcher
// ============================================================================

export async function getDashboardData(hours: number = 24): Promise<DashboardData> {
  const tokenUsage = getTokenUsage(hours);
  const verifiedQuota = await getVerifiedQuota(hours);

  return {
    generated_at: new Date(),
    hours,
    system_health: getSystemHealth(),
    autonomous_mode: getAutonomousModeStatus(),
    quota: verifiedQuota.aggregate,
    verified_quota: verifiedQuota,
    token_usage: tokenUsage,
    usage_projection: getUsageProjection(),
    key_rotation: getKeyRotationMetrics(hours),
    automations: getAutomations(),
    agents: getAgentActivity(),
    hooks: getHookExecutions(),
    sessions: getSessionMetrics(hours),
    pending_items: getPendingItems(),
    triage: getTriageMetrics(),
    tasks: getTaskMetrics(hours),
    feedback_personas: getFeedbackPersonas(),
  };
}
