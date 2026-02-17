import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Types (shared with webview via postMessage)
// ============================================================================

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

// ============================================================================
// Internal types
// ============================================================================

interface CountResult { count: number }
interface TaskCountRow { section: string; status: string; count: number }
interface CompletedCountRow { section: string; count: number }

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

interface KeyRotationState {
  version: number;
  active_key_id: string | null;
  keys: Record<string, {
    accessToken?: string;
    subscriptionType: string;
    last_usage: { five_hour: number; seven_day: number } | null;
    status: 'active' | 'exhausted' | 'invalid' | 'expired';
  }>;
  rotation_log: { timestamp: number; event: string }[];
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

// ============================================================================
// Constants
// ============================================================================

const COOLDOWN_MINUTES = 55;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const REFRESH_INTERVAL_MS = 30_000;
const HOURS = 24;

const PROTECTED_FILES_RELATIVE = [
  '.claude/hooks/pre-commit-review.js',
  'eslint.config.js',
  '.husky/pre-commit',
];

const EMPTY_QUOTA: QuotaStatus = {
  five_hour: null,
  seven_day: null,
  extra_usage_enabled: false,
  error: null,
};

// ============================================================================
// DataService
// ============================================================================

export class DataService implements vscode.Disposable {
  private readonly _onDidUpdate = new vscode.EventEmitter<DashboardState>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private state: DashboardState | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private isRefreshing = false;

  private readonly projectDir: string;
  private readonly claudeDir: string;
  private readonly todoDB: string;
  private readonly deputyCtoDB: string;
  private readonly ctoReportsDB: string;
  private readonly autonomousConfigPath: string;
  private readonly automationStatePath: string;
  private readonly keyRotationPath: string;
  private readonly credentialsPath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.claudeDir = path.join(projectDir, '.claude');
    this.todoDB = path.join(this.claudeDir, 'todo.db');
    this.deputyCtoDB = path.join(this.claudeDir, 'deputy-cto.db');
    this.ctoReportsDB = path.join(this.claudeDir, 'cto-reports.db');
    this.autonomousConfigPath = path.join(this.claudeDir, 'autonomous-mode.json');
    this.automationStatePath = path.join(this.claudeDir, 'hourly-automation-state.json');
    this.keyRotationPath = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
    this.credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');

    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
  }

  getState(): DashboardState | null {
    return this.state;
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const [verifiedQuota, tokenUsage, sessions] = await Promise.all([
        this.getVerifiedQuota(),
        Promise.resolve(this.getTokenUsage()),
        Promise.resolve(this.getSessionMetrics()),
      ]);

      this.state = {
        generated_at: new Date().toISOString(),
        system_health: this.getSystemHealth(),
        autonomous_mode: this.getAutonomousModeStatus(),
        verified_quota: verifiedQuota,
        token_usage: tokenUsage,
        sessions,
        pending_items: this.getPendingItems(),
        tasks: this.getTaskMetrics(),
        deputy_cto: this.getDeputyCtoData(),
      };

      this._onDidUpdate.fire(this.state);
    } catch (err) {
      console.error('[GENTYR] Failed to refresh data:', err);
    } finally {
      this.isRefreshing = false;
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this._onDidUpdate.dispose();
  }

  // ========================================================================
  // Quota
  // ========================================================================

  private getCredentialToken(): string | null {
    const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    if (envToken) return envToken;

    if (process.platform === 'darwin') {
      try {
        const { execFileSync } = require('child_process');
        const { username } = os.userInfo();
        const raw = execFileSync('security', [
          'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
        ], { encoding: 'utf8', timeout: 3000 }).trim();
        const creds = JSON.parse(raw) as CredentialsFile;
        const token = this.extractToken(creds);
        if (token) return token;
      } catch (err) {
        console.warn('[GENTYR] Keychain credential read failed:', err instanceof Error ? err.message : String(err));
      }
    }

    try {
      if (fs.existsSync(this.credentialsPath)) {
        const creds = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8')) as CredentialsFile;
        const token = this.extractToken(creds);
        if (token) return token;
      }
    } catch (err) {
      console.warn('[GENTYR] Credentials file read failed:', err instanceof Error ? err.message : String(err));
    }

    return null;
  }

  private extractToken(creds: CredentialsFile): string | null {
    if (!creds.claudeAiOauth?.accessToken) return null;
    if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) return null;
    return creds.claudeAiOauth.accessToken;
  }

  private generateKeyId(accessToken: string): string {
    const cleanToken = accessToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
    return crypto.createHash('sha256').update(cleanToken).digest('hex').substring(0, 16);
  }

  private collectAllKeys(): { keys: Array<{ key_id: string; access_token: string; subscription_type: string; is_current: boolean }>; rotationState: KeyRotationState | null } {
    const keyMap = new Map<string, { key_id: string; access_token: string; subscription_type: string; is_current: boolean }>();
    let rotationState: KeyRotationState | null = null;

    if (fs.existsSync(this.keyRotationPath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.keyRotationPath, 'utf8')) as KeyRotationState;
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
      } catch { /* fall through */ }
    }

    const credToken = this.getCredentialToken();
    if (credToken) {
      const credKeyId = this.generateKeyId(credToken);
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

  private async fetchQuotaForToken(accessToken: string): Promise<QuotaStatus> {
    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gentyr-vscode/0.1.0',
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
        },
      });
      if (!response.ok) return { ...EMPTY_QUOTA, error: `API error: ${response.status}` };
      const data = await response.json() as UsageApiResponse;
      const parseBucket = (b: { utilization: number; resets_at: string } | null | undefined): QuotaBucket | null => {
        if (!b) return null;
        const hoursUntil = Math.max(0, Math.round(((new Date(b.resets_at).getTime() - Date.now()) / 3_600_000) * 10) / 10);
        return { utilization: b.utilization, resets_at: b.resets_at, resets_in_hours: hoursUntil };
      };
      return {
        five_hour: parseBucket(data.five_hour),
        seven_day: parseBucket(data.seven_day),
        extra_usage_enabled: data.extra_usage?.is_enabled ?? false,
        error: null,
      };
    } catch (err) {
      return { ...EMPTY_QUOTA, error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getVerifiedQuota(): Promise<VerifiedQuotaResult> {
    const { keys, rotationState } = this.collectAllKeys();
    if (keys.length === 0) {
      return { keys: [], healthy_count: 0, total_attempted: 0, aggregate: { ...EMPTY_QUOTA, error: 'No keys found' }, rotation_events_24h: 0 };
    }

    const results = await Promise.all(
      keys.map(async (key): Promise<VerifiedKey> => {
        const quota = await this.fetchQuotaForToken(key.access_token);
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
    const aggregate = this.buildAggregate(healthyKeys);

    let rotationEvents24h = 0;
    if (rotationState) {
      const since = Date.now() - (HOURS * 60 * 60 * 1000);
      rotationEvents24h = rotationState.rotation_log.filter(
        entry => entry.timestamp >= since && entry.event === 'key_switched'
      ).length;
    }

    return { keys: results, healthy_count: healthyKeys.length, total_attempted: keys.length, aggregate, rotation_events_24h: rotationEvents24h };
  }

  private buildAggregate(healthyKeys: VerifiedKey[]): QuotaStatus {
    if (healthyKeys.length === 0) return { ...EMPTY_QUOTA, error: 'No healthy keys' };

    const avgBucket = (getBucket: (q: QuotaStatus) => QuotaBucket | null): QuotaBucket | null => {
      const buckets = healthyKeys.map(k => getBucket(k.quota!)).filter((b): b is QuotaBucket => b !== null);
      if (buckets.length === 0) return null;
      const avgUtil = Math.round(buckets.reduce((s, b) => s + b.utilization, 0) / buckets.length);
      const earliest = buckets.reduce((a, b) => new Date(a.resets_at).getTime() < new Date(b.resets_at).getTime() ? a : b);
      return { utilization: avgUtil, resets_at: earliest.resets_at, resets_in_hours: earliest.resets_in_hours };
    };

    return {
      five_hour: avgBucket(q => q.five_hour),
      seven_day: avgBucket(q => q.seven_day),
      extra_usage_enabled: healthyKeys.some(k => k.quota!.extra_usage_enabled),
      error: null,
    };
  }

  // ========================================================================
  // Token Usage
  // ========================================================================

  private getSessionDir(): string {
    const projectPath = this.projectDir.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
    return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
  }

  private getTokenUsage(): TokenUsage {
    const sessionDir = this.getSessionDir();
    const since = Date.now() - (HOURS * 60 * 60 * 1000);
    const totals: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };

    if (!fs.existsSync(sessionDir)) return totals;

    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          if (entry.timestamp && new Date(entry.timestamp).getTime() < since) continue;
          const usage = entry.message?.usage;
          if (usage) {
            totals.input += usage.input_tokens || 0;
            totals.output += usage.output_tokens || 0;
            totals.cache_read += usage.cache_read_input_tokens || 0;
            totals.cache_creation += usage.cache_creation_input_tokens || 0;
          }
        } catch { /* skip malformed */ }
      }
    }

    totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
    return totals;
  }

  // ========================================================================
  // Sessions
  // ========================================================================

  private getSessionMetrics(): SessionMetrics {
    const since = Date.now() - (HOURS * 60 * 60 * 1000);
    const sessionDir = this.getSessionDir();
    const metrics: SessionMetrics = { task_triggered: 0, user_triggered: 0 };

    if (!fs.existsSync(sessionDir)) return metrics;

    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      let isTask = false;
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          if (entry.type === 'human' || entry.type === 'user') {
            const msg = typeof entry.message?.content === 'string' ? entry.message.content : entry.content;
            if (msg?.startsWith('[Task]')) isTask = true;
            break;
          }
        } catch { /* skip */ }
      }
      if (isTask) metrics.task_triggered++;
      else metrics.user_triggered++;
    }

    return metrics;
  }

  // ========================================================================
  // Autonomous Mode
  // ========================================================================

  private getAutonomousModeStatus(): AutonomousModeStatus {
    let enabled = false;
    if (fs.existsSync(this.autonomousConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(this.autonomousConfigPath, 'utf8')) as { enabled?: boolean };
        enabled = config.enabled === true;
      } catch { /* fall through */ }
    }

    let next_run_time: string | null = null;
    let seconds_until_next: number | null = null;

    if (enabled && fs.existsSync(this.automationStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.automationStatePath, 'utf8')) as { lastRun?: number };
        const lastRun = state.lastRun || 0;
        const nextRunMs = lastRun + COOLDOWN_MINUTES * 60 * 1000;
        next_run_time = new Date(nextRunMs).toISOString();
        seconds_until_next = Math.max(0, Math.floor((nextRunMs - Date.now()) / 1000));
      } catch { /* fall through */ }
    } else if (enabled) {
      next_run_time = new Date().toISOString();
      seconds_until_next = 0;
    }

    return { enabled, interval_minutes: COOLDOWN_MINUTES, next_run_time, seconds_until_next };
  }

  // ========================================================================
  // System Health
  // ========================================================================

  private getSystemHealth(): SystemHealth {
    let allProtected = true;
    let anyExists = false;

    for (const relPath of PROTECTED_FILES_RELATIVE) {
      const filePath = path.join(this.projectDir, relPath);
      if (fs.existsSync(filePath)) {
        anyExists = true;
        try {
          const stats = fs.statSync(filePath);
          if (stats.uid !== 0) allProtected = false;
        } catch { allProtected = false; }
      }
    }

    return { protection_status: anyExists ? (allProtected ? 'protected' : 'unprotected') : 'unknown' };
  }

  // ========================================================================
  // Pending Items
  // ========================================================================

  private getPendingItems(): PendingItems {
    const items: PendingItems = { cto_questions: 0, commit_rejections: 0, pending_triage: 0, commits_blocked: false };

    if (fs.existsSync(this.deputyCtoDB)) {
      try {
        const db = new Database(this.deputyCtoDB, { readonly: true });
        const pending = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'").get() as CountResult | undefined;
        const rejections = db.prepare("SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'").get() as CountResult | undefined;
        db.close();
        items.cto_questions = pending?.count || 0;
        items.commit_rejections = rejections?.count || 0;
      } catch { /* db may not exist */ }
    }

    if (fs.existsSync(this.ctoReportsDB)) {
      try {
        const db = new Database(this.ctoReportsDB, { readonly: true });
        const pending = db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult | undefined;
        items.pending_triage = pending?.count || 0;
        db.close();
      } catch { /* db may not exist */ }
    }

    items.commits_blocked = items.cto_questions > 0 || items.pending_triage > 0;
    return items;
  }

  // ========================================================================
  // Tasks
  // ========================================================================

  private getTaskMetrics(): TaskMetrics {
    const metrics: TaskMetrics = { pending_total: 0, in_progress_total: 0, completed_total: 0, by_section: {}, completed_24h: 0 };

    if (!fs.existsSync(this.todoDB)) return metrics;

    try {
      const db = new Database(this.todoDB, { readonly: true });

      const tasks = db.prepare('SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status').all() as TaskCountRow[];
      for (const row of tasks) {
        if (!metrics.by_section[row.section]) {
          metrics.by_section[row.section] = { pending: 0, in_progress: 0, completed: 0 };
        }
        const section = metrics.by_section[row.section];
        if (row.status === 'pending') { section.pending = row.count; metrics.pending_total += row.count; }
        else if (row.status === 'in_progress') { section.in_progress = row.count; metrics.in_progress_total += row.count; }
        else if (row.status === 'completed') { section.completed = row.count; metrics.completed_total += row.count; }
      }

      const sinceTimestamp = Math.floor((Date.now() - HOURS * 60 * 60 * 1000) / 1000);
      const completed = db.prepare("SELECT section, COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_timestamp >= ? GROUP BY section").all(sinceTimestamp) as CompletedCountRow[];
      for (const row of completed) metrics.completed_24h += row.count;

      db.close();
    } catch { /* db may not exist */ }

    return metrics;
  }

  // ========================================================================
  // Deputy CTO
  // ========================================================================

  private getDeputyCtoData(): DeputyCtoData {
    const result: DeputyCtoData = {
      hasData: false,
      untriaged: [], untriagedCount: 0,
      recentlyTriaged: [], escalated: [],
      selfHandled24h: 0, escalated24h: 0, dismissed24h: 0,
      pendingQuestions: [], pendingQuestionCount: 0,
    };

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    if (fs.existsSync(this.ctoReportsDB)) {
      try {
        const db = new Database(this.ctoReportsDB, { readonly: true });

        result.untriaged = db.prepare(
          "SELECT id, title, priority, triage_status, created_at FROM reports WHERE triage_status = 'pending' ORDER BY created_timestamp DESC LIMIT 10"
        ).all() as TriagedReport[];

        const countRow = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'pending'").get() as { cnt: number } | undefined;
        result.untriagedCount = countRow?.cnt || 0;

        result.recentlyTriaged = db.prepare(
          "SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at FROM reports WHERE triage_status IN ('self_handled', 'escalated', 'dismissed') AND triage_completed_at >= ? ORDER BY triage_completed_at DESC LIMIT 8"
        ).all(cutoff24h) as TriagedReport[];

        result.escalated = db.prepare(
          "SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at FROM reports WHERE triage_status = 'escalated' ORDER BY triage_completed_at DESC LIMIT 5"
        ).all() as TriagedReport[];

        const sh = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at >= ?").get(cutoff24h) as { cnt: number } | undefined;
        result.selfHandled24h = sh?.cnt || 0;
        const esc = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'escalated' AND triage_completed_at >= ?").get(cutoff24h) as { cnt: number } | undefined;
        result.escalated24h = esc?.cnt || 0;
        const dis = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at >= ?").get(cutoff24h) as { cnt: number } | undefined;
        result.dismissed24h = dis?.cnt || 0;

        result.hasData = true;
        db.close();
      } catch { /* fall through */ }
    }

    if (fs.existsSync(this.deputyCtoDB)) {
      try {
        const db = new Database(this.deputyCtoDB, { readonly: true });

        result.pendingQuestions = db.prepare(
          "SELECT id, type, title, description, recommendation, created_at FROM questions WHERE status = 'pending' ORDER BY created_timestamp DESC LIMIT 10"
        ).all() as PendingQuestion[];

        const qCount = db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'pending'").get() as { cnt: number } | undefined;
        result.pendingQuestionCount = qCount?.cnt || 0;

        result.hasData = true;
        db.close();
      } catch { /* fall through */ }
    }

    return result;
  }
}
