/**
 * Mock / fixture data for the CTO dashboard.
 *
 * All values are hardcoded realistic data — no string replacement, no
 * placeholders.  Timestamps are computed relative to Date.now() so the
 * dashboard always looks fresh.
 *
 * Use these functions in place of the real data-reading utilities during
 * development and snapshot testing.
 */

import type {
  DashboardData,
  TokenUsage,
  QuotaStatus,
  VerifiedQuotaResult,
  AutonomousModeStatus,
  SessionMetrics,
  PendingItems,
  TriageMetrics,
  TaskMetrics,
  HookExecutions,
  AgentActivity,
  SystemHealth,
  UsageProjection,
  AutomationCooldowns,
  FeedbackPersonasData,
  PersonaReport,
  SatisfactionDistribution,
} from './utils/data-reader.js';
import type { TimelineEvent } from './components/TimelineItem.js';
import type { TrajectoryResult, UsageSnapshot } from './utils/trajectory.js';
import type { AutomatedInstancesData } from './utils/automated-instances.js';
import type { DeputyCtoData, TriagedReport, PendingQuestion } from './utils/deputy-cto-reader.js';
import type { TestingData } from './utils/testing-reader.js';
import type { DeploymentsData } from './utils/deployments-reader.js';
import type { InfraData } from './utils/infra-reader.js';
import type { LoggingData } from './utils/logging-reader.js';
import type { AccountOverviewData } from './utils/account-overview-reader.js';
import type { WorktreeData } from './utils/worktree-reader.js';
import type { ProductManagerData } from './utils/product-manager-reader.js';

// ============================================================================
// Deterministic PRNG (LCG — no Math.random())
// ============================================================================

/**
 * Advance the seed with a linear-congruential step and return a noise value
 * in [-1, 1].
 */
function lcgNoise(seed: number): { noise: number; nextSeed: number } {
  const nextSeed = ((seed * 1103515245 + 12345) & 0x7fffffff);
  const noise = (nextSeed / 0x7fffffff) * 2 - 1;
  return { noise, nextSeed };
}

// ============================================================================
// Waypoint interpolation
// ============================================================================

/**
 * Interpolate linearly between a set of [position (0–1), value (0–100)]
 * waypoints, adding small deterministic noise at each step.
 *
 * @param waypoints   Array of [t, v] tuples, t in [0,1], v in [0,100].
 * @param totalPoints Total number of output data points.
 * @param seed        Initial seed for the PRNG.
 * @param noiseAmp    Peak noise amplitude in percentage points (default 2.5).
 */
function interpolateWaypoints(
  waypoints: [number, number][],
  totalPoints: number,
  seed: number,
  noiseAmp = 2.5,
): number[] {
  const result: number[] = [];
  let currentSeed = seed;

  for (let i = 0; i < totalPoints; i++) {
    const t = i / (totalPoints - 1);

    // Find the two surrounding waypoints.
    let lo = waypoints[0];
    let hi = waypoints[waypoints.length - 1];

    for (let w = 0; w < waypoints.length - 1; w++) {
      if (t >= waypoints[w][0] && t <= waypoints[w + 1][0]) {
        lo = waypoints[w];
        hi = waypoints[w + 1];
        break;
      }
    }

    // Linear interpolation between the two waypoints.
    const span = hi[0] - lo[0];
    const localT = span > 0 ? (t - lo[0]) / span : 0;
    const interpolated = lo[1] + (hi[1] - lo[1]) * localT;

    // Add deterministic noise.
    const { noise, nextSeed } = lcgNoise(currentSeed);
    currentSeed = nextSeed;
    const value = interpolated + noise * noiseAmp;

    result.push(Math.max(0, Math.min(100, value)));
  }

  return result;
}

// ============================================================================
// Trajectory data (the most critical section — ~1019 snapshots)
// ============================================================================

export function getMockTrajectory(): TrajectoryResult {
  const now = Date.now();
  const TOTAL_POINTS = 1019;

  // Span from 24 hours ago to now (evenly spaced).
  const startMs = now - 24 * 60 * 60 * 1000;
  const stepMs = (now - startMs) / (TOTAL_POINTS - 1);

  // ---- 5-hour waypoints ----
  const fiveHourWaypoints: [number, number][] = [
    [0.00, 50], [0.03, 65], [0.07, 90], [0.10, 98], [0.12, 85], [0.15, 75],
    [0.18, 55], [0.22, 35], [0.25, 20], [0.28, 5],  [0.30, 0],  [0.33, 15],
    [0.36, 40], [0.40, 55], [0.44, 70], [0.47, 65], [0.50, 55], [0.53, 45],
    [0.56, 60], [0.58, 70], [0.60, 65], [0.63, 50], [0.65, 35], [0.67, 25],
    [0.70, 30], [0.73, 25], [0.76, 28], [0.80, 25], [0.85, 27], [0.90, 28],
    [0.95, 26], [1.00, 28],
  ];

  // ---- 7-day waypoints ----
  const sevenDayWaypoints: [number, number][] = [
    [0.00, 50], [0.05, 45], [0.10, 38], [0.15, 30], [0.20, 28], [0.25, 28],
    [0.30, 32], [0.35, 40], [0.40, 48], [0.45, 55], [0.50, 62], [0.55, 70],
    [0.60, 76], [0.65, 82], [0.70, 86], [0.75, 88], [0.80, 90], [0.85, 91],
    [0.90, 91], [0.95, 91], [1.00, 91],
  ];

  const fiveHourValues  = interpolateWaypoints(fiveHourWaypoints,  TOTAL_POINTS, 42);
  const sevenDayValues  = interpolateWaypoints(sevenDayWaypoints,  TOTAL_POINTS, 137);

  const snapshots: UsageSnapshot[] = fiveHourValues.map((fh, idx) => ({
    timestamp: new Date(startMs + idx * stepMs),
    fiveHour:  Math.round(fh * 10) / 10,
    sevenDay:  Math.round(sevenDayValues[idx] * 10) / 10,
  }));

  // Reset times.
  const fiveHourResetTime  = new Date(now + 101 * 60 * 1000);      // +101 minutes
  const sevenDayResetTime  = new Date(now + 111 * 60 * 60 * 1000); // +111 hours (4d 15h)

  return {
    snapshots,
    fiveHourProjectedAtReset:  31,
    sevenDayProjectedAtReset:  91,
    fiveHourResetTime,
    sevenDayResetTime,
    fiveHourTrendPerHour:  2.2,
    sevenDayTrendPerDay:   0.02,
    hasData: true,
  };
}

// ============================================================================
// Deputy CTO data
// ============================================================================

export function getMockDeputyCto(): DeputyCtoData {
  const now = Date.now();

  const untriaged: TriagedReport[] = [
    {
      id: 'rpt-a1b2c3',
      title: 'Hardcoded JWT secret detected in auth middleware',
      priority: 'critical',
      triage_status: 'pending',
      triage_outcome: null,
      created_at: new Date(now - 18 * 60 * 1000).toISOString(),
      triage_completed_at: null,
    },
    {
      id: 'rpt-d4e5f6',
      title: 'Missing RLS policy on user_sessions table',
      priority: 'high',
      triage_status: 'pending',
      triage_outcome: null,
      created_at: new Date(now - 47 * 60 * 1000).toISOString(),
      triage_completed_at: null,
    },
  ];

  const escalated: TriagedReport[] = [
    {
      id: 'rpt-g7h8i9',
      title: 'API rate-limiting bypass via header injection',
      priority: 'critical',
      triage_status: 'escalated',
      triage_outcome: 'Requires architectural change to gateway layer',
      created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 2.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-j1k2l3',
      title: 'CORS wildcard allowed on production endpoints',
      priority: 'high',
      triage_status: 'escalated',
      triage_outcome: 'Needs explicit origin allowlist from product team',
      created_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 4.8 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-m4n5o6',
      title: 'Service account has write access to all Supabase tables',
      priority: 'high',
      triage_status: 'escalated',
      triage_outcome: 'Principle of least privilege not enforced',
      created_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 6.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-p7q8r9',
      title: 'PII logged in request bodies under debug mode',
      priority: 'high',
      triage_status: 'escalated',
      triage_outcome: 'Debug flag still active in staging environment',
      created_at: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 8.8 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const recentlyTriaged: TriagedReport[] = [
    {
      id: 'rpt-s1t2u3',
      title: 'Unused env vars referencing deleted Render service',
      priority: 'low',
      triage_status: 'dismissed',
      triage_outcome: 'No security impact — cleanup task created',
      created_at: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 9.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-v4w5x6',
      title: 'Dependency audit: lodash 4.17.20 has prototype pollution CVE',
      priority: 'normal',
      triage_status: 'self_handled',
      triage_outcome: 'Bumped to 4.17.21 — no breaking changes',
      created_at: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 11.8 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-y7z8a9',
      title: 'Spec G003 violation: Zod schema missing on /api/webhooks route',
      priority: 'high',
      triage_status: 'escalated',
      triage_outcome: 'Webhook handler parses raw JSON without validation',
      created_at: new Date(now - 14 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 13.9 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-b1c2d3',
      title: 'Antipattern detected: silent catch in payment processing flow',
      priority: 'critical',
      triage_status: 'escalated',
      triage_outcome: 'Payment errors swallowed — requires immediate fix',
      created_at: new Date(now - 16 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 15.7 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-e4f5g6',
      title: 'TypeScript strict mode disabled in packages/api',
      priority: 'normal',
      triage_status: 'self_handled',
      triage_outcome: 'Enabled strict — 14 type errors fixed by lint-fixer',
      created_at: new Date(now - 18 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 17.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-h7i8j9',
      title: 'Session token expiry not validated on WebSocket connection',
      priority: 'high',
      triage_status: 'escalated',
      triage_outcome: 'WS connections persist after OAuth token expiry',
      created_at: new Date(now - 20 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 19.8 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-k1l2m3',
      title: 'Missing index on foreign key: tasks.assigned_agent_id',
      priority: 'low',
      triage_status: 'dismissed',
      triage_outcome: 'Volume too low to warrant index — re-evaluate at 100k rows',
      created_at: new Date(now - 22 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 21.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'rpt-n4o5p6',
      title: 'Compliance check: G004 hardcoded credential in seed script',
      priority: 'normal',
      triage_status: 'self_handled',
      triage_outcome: 'Seed script updated to read from env — credential rotated',
      created_at: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
      triage_completed_at: new Date(now - 22.8 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const pendingQuestions: PendingQuestion[] = [
    {
      id: 'q-aa1bb2',
      type: 'architecture',
      title: 'Should the triage pipeline use a dedicated queue or stay in SQLite?',
      description: 'Current SQLite approach works but may not scale past ~10k reports/day. Redis Streams or Postgres LISTEN/NOTIFY are alternatives.',
      recommendation: 'Stay with SQLite for now — add a migration path at 5k reports/day threshold.',
      created_at: new Date(now - 25 * 60 * 1000).toISOString(),
    },
    {
      id: 'q-cc3dd4',
      type: 'security',
      title: 'Approve relaxing CSP to allow inline styles for chart tooltips?',
      description: 'Chart library requires inline styles for dynamic tooltip positioning. Nonce-based approach adds significant complexity.',
      recommendation: 'Reject — use CSS variables and data attributes instead of inline styles.',
      created_at: new Date(now - 52 * 60 * 1000).toISOString(),
    },
    {
      id: 'q-ee5ff6',
      type: 'compliance',
      title: 'G009 exemption request: skip pre-commit hook for auto-generated files?',
      description: 'Formatter generates ~200 files on each build. Pre-commit review on these adds 45s of latency.',
      recommendation: 'Grant exemption only for files in dist/ and .generated/ directories.',
      created_at: new Date(now - 1.5 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'q-gg7hh8',
      type: 'architecture',
      title: 'Which caching layer for the quota status API response?',
      description: 'Quota endpoint is called every 10 minutes per agent. With 15 instances, that is 90 req/hour against the Anthropic API.',
      recommendation: 'Cache at 5-minute TTL in memory — no external cache needed at current scale.',
      created_at: new Date(now - 2.2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'q-ii9jj0',
      type: 'security',
      title: 'Should oauth tokens be stored in Supabase Vault or OS keychain?',
      description: 'Supabase Vault is more portable. OS keychain is more secure on macOS but breaks Linux CI.',
      recommendation: 'Use Supabase Vault with envelope encryption — adds portability without sacrificing security.',
      created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    },
  ];

  return {
    hasData: true,
    untriaged,
    untriagedCount: 2,
    recentlyTriaged,
    escalated,
    selfHandled24h: 3,
    escalated24h: 4,
    dismissed24h: 2,
    pendingQuestions,
    pendingQuestionCount: 5,
    answeredQuestions: [],
  };
}

// ============================================================================
// Dashboard data (main metrics blob)
// ============================================================================

export function getMockDashboardData(): DashboardData {
  const now = Date.now();

  const defaultCooldowns: AutomationCooldowns = {
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

  // Effective cooldowns: roughly 80% slower (factor ~1.8 applied).
  const effectiveCooldowns: AutomationCooldowns = {
    hourly_tasks: 99,
    triage_check: 9,
    antipattern_hunter: 648,
    schema_mapper: 2592,
    lint_checker: 54,
    todo_maintenance: 27,
    task_runner: 108,
    triage_per_item: 108,
    preview_promotion: 648,
    staging_promotion: 2160,
    staging_health_monitor: 324,
    production_health_monitor: 108,
    standalone_antipattern_hunter: 324,
    standalone_compliance_checker: 108,
    user_feedback: 216,
    pre_commit_review: 9,
    test_failure_reporter: 216,
    compliance_checker_file: 10080,
    compliance_checker_spec: 10080,
  };

  const usageProjection: UsageProjection = {
    factor: 0.6,
    target_pct: 90,
    projected_at_reset_pct: 1.8,
    constraining_metric: '5h',
    last_updated: new Date(now - 8 * 60 * 1000).toISOString(),
    effective_cooldowns: effectiveCooldowns,
    default_cooldowns: defaultCooldowns,
  };

  const tokenUsage: TokenUsage = {
    input: 148320,
    output: 117950,
    cache_read: 142880,
    cache_creation: 31420,
    total: 440570,
  };

  const fiveHourResetAt = new Date(now + 101 * 60 * 1000).toISOString();
  const sevenDayResetAt = new Date(now + 111 * 60 * 60 * 1000).toISOString();

  const quota: QuotaStatus = {
    five_hour: {
      utilization: 35,
      resets_at: fiveHourResetAt,
      resets_in_hours: 1.7,
    },
    seven_day: {
      utilization: 88,
      resets_at: sevenDayResetAt,
      resets_in_hours: 111,
    },
    extra_usage_enabled: false,
    error: null,
  };

  const verifiedQuota: VerifiedQuotaResult = {
    keys: [
      {
        key_id: 'a3f8d21c...',
        subscription_type: 'claude_max',
        is_current: true,
        healthy: true,
        quota: {
          five_hour: {
            utilization: 35,
            resets_at: fiveHourResetAt,
            resets_in_hours: 1.7,
          },
          seven_day: {
            utilization: 88,
            resets_at: sevenDayResetAt,
            resets_in_hours: 111,
          },
          extra_usage_enabled: false,
          error: null,
        },
      },
      {
        key_id: 'b7c4e92f...',
        subscription_type: 'claude_max',
        is_current: false,
        healthy: false,
        quota: {
          five_hour: {
            utilization: 100,
            resets_at: fiveHourResetAt,
            resets_in_hours: 1.7,
          },
          seven_day: {
            utilization: 100,
            resets_at: sevenDayResetAt,
            resets_in_hours: 111,
          },
          extra_usage_enabled: false,
          error: null,
        },
      },
      {
        key_id: 'c9d5f13a...',
        subscription_type: 'claude_max',
        is_current: false,
        healthy: true,
        quota: {
          five_hour: {
            utilization: 12,
            resets_at: fiveHourResetAt,
            resets_in_hours: 1.7,
          },
          seven_day: {
            utilization: 45,
            resets_at: sevenDayResetAt,
            resets_in_hours: 111,
          },
          extra_usage_enabled: false,
          error: null,
        },
      },
    ],
    healthy_count: 2,
    total_attempted: 3,
    aggregate: quota,
    rotation_events_24h: 2,
  };

  const autonomousMode: AutonomousModeStatus = {
    enabled: true,
    interval_minutes: 50,
    next_run_time: new Date(now + 3.5 * 60 * 1000),
    seconds_until_next: 210,
  };

  const systemHealth: SystemHealth = {
    protection_status: 'protected',
  };

  const sessions: SessionMetrics = {
    task_triggered: 148,
    user_triggered: 34,
    task_by_type: {
      'antipattern-hunter': 18,
      'lint-fixer': 22,
      'task-runner-code-reviewer': 31,
      'task-runner-investigator': 14,
      'compliance-global': 12,
      'deputy-cto-review': 28,
      'staging-health-monitor': 9,
      'claudemd-refactor': 14,
    },
  };

  const pendingItems: PendingItems = {
    cto_questions: 5,
    commit_rejections: 1,
    pending_triage: 0,
    commits_blocked: true,
  };

  const triage: TriageMetrics = {
    pending: 0,
    in_progress: 0,
    self_handled_24h: 4,
    self_handled_7d: 19,
    escalated_24h: 14,
    escalated_7d: 47,
    dismissed_24h: 8,
    dismissed_7d: 31,
  };

  const tasks: TaskMetrics = {
    pending_total: 278,
    in_progress_total: 2,
    completed_total: 1843,
    completed_24h: 21,
    by_section: {
      backend: { pending: 64, in_progress: 1, completed: 412 },
      frontend: { pending: 48, in_progress: 0, completed: 338 },
      infrastructure: { pending: 37, in_progress: 1, completed: 219 },
      security: { pending: 52, in_progress: 0, completed: 287 },
      testing: { pending: 41, in_progress: 0, completed: 315 },
      documentation: { pending: 36, in_progress: 0, completed: 272 },
    },
    completed_24h_by_section: {
      backend: 7,
      frontend: 5,
      security: 4,
      testing: 3,
      infrastructure: 2,
    },
  };

  const hooks: HookExecutions = {
    total_24h: 447,
    skipped_24h: 44,
    success_rate: 99,
    by_hook: {
      PreCommit: { total: 183, success: 181, failure: 1, skipped: 1 },
      PostToolUse: { total: 142, success: 142, failure: 0, skipped: 0 },
      PreToolUse: { total: 89, success: 87, failure: 2, skipped: 0 },
      Notification: { total: 33, success: 33, failure: 0, skipped: 43 },
    },
    recent_failures: [
      {
        hook: 'PreCommit',
        error: 'ESLint: 3 errors in packages/api/src/routes/webhook.ts',
        timestamp: new Date(now - 42 * 60 * 1000).toISOString(),
      },
      {
        hook: 'PreToolUse',
        error: 'Zod validation failed: missing required field "schema_version"',
        timestamp: new Date(now - 2.1 * 60 * 60 * 1000).toISOString(),
      },
      {
        hook: 'PreToolUse',
        error: 'Tool call rejected: Write to protected path .claude/hooks/',
        timestamp: new Date(now - 5.3 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };

  const agents: AgentActivity = {
    spawns_24h: 41,
    spawns_7d: 218,
    by_type: {
      'antipattern-hunter': 7,
      'lint-fixer': 8,
      'task-runner-code-reviewer': 9,
      'task-runner-investigator': 5,
      'compliance-global': 4,
      'deputy-cto-review': 5,
      'staging-health-monitor': 2,
      'claudemd-refactor': 1,
    },
  };

  const guiReports: PersonaReport[] = [
    {
      id: 'fb-rpt-001',
      title: 'Login button unresponsive on mobile viewport',
      priority: 'high',
      triage_status: 'escalated',
      created_at: new Date(now - 2.1 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fb-rpt-002',
      title: 'Dashboard chart tooltip clips at edge of screen',
      priority: 'normal',
      triage_status: 'self_handled',
      created_at: new Date(now - 5.4 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fb-rpt-003',
      title: 'Missing loading spinner on settings page save',
      priority: 'low',
      triage_status: 'dismissed',
      created_at: new Date(now - 9.8 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const cliReports: PersonaReport[] = [
    {
      id: 'fb-rpt-004',
      title: 'Exit code 0 returned on validation failure',
      priority: 'critical',
      triage_status: 'escalated',
      created_at: new Date(now - 1.8 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fb-rpt-005',
      title: 'Help text missing for --format flag',
      priority: 'low',
      triage_status: 'pending',
      created_at: new Date(now - 6.2 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const apiReports: PersonaReport[] = [
    {
      id: 'fb-rpt-006',
      title: 'PUT /users returns 500 when email field is null',
      priority: 'high',
      triage_status: 'in_progress',
      created_at: new Date(now - 0.8 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fb-rpt-007',
      title: 'Rate limit header X-RateLimit-Reset uses wrong timezone',
      priority: 'normal',
      triage_status: 'self_handled',
      created_at: new Date(now - 4.3 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fb-rpt-008',
      title: 'Pagination cursor breaks on special characters in name',
      priority: 'high',
      triage_status: 'pending',
      created_at: new Date(now - 8.1 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const satisfactionDistribution: SatisfactionDistribution = {
    very_satisfied: 22,
    satisfied: 31,
    neutral: 18,
    dissatisfied: 9,
    very_dissatisfied: 4,
  };

  const feedbackPersonas: FeedbackPersonasData = {
    personas: [
      {
        name: 'GUI Developer',
        consumption_mode: 'gui',
        enabled: true,
        session_count: 28,
        last_satisfaction: 'satisfied',
        findings_count: 14,
        recent_reports: guiReports,
      },
      {
        name: 'CLI Power User',
        consumption_mode: 'cli',
        enabled: true,
        session_count: 19,
        last_satisfaction: 'very_satisfied',
        findings_count: 8,
        recent_reports: cliReports,
      },
      {
        name: 'API Integrator',
        consumption_mode: 'api',
        enabled: true,
        session_count: 22,
        last_satisfaction: 'neutral',
        findings_count: 11,
        recent_reports: apiReports,
      },
      {
        name: 'SDK Automation',
        consumption_mode: 'sdk',
        enabled: true,
        session_count: 15,
        last_satisfaction: 'satisfied',
        findings_count: 6,
        recent_reports: [],
      },
    ],
    total_sessions: 84,
    total_findings: 39,
    satisfaction_distribution: satisfactionDistribution,
  };

  return {
    generated_at: new Date(),
    hours: 24,
    system_health: systemHealth,
    autonomous_mode: autonomousMode,
    quota,
    verified_quota: verifiedQuota,
    token_usage: tokenUsage,
    usage_projection: usageProjection,
    key_rotation: {
      current_key_id: 'a3f8d21c...',
      active_keys: 3,
      keys: [
        {
          key_id: 'a3f8d21c...',
          subscription_type: 'claude_max',
          five_hour_pct: 35,
          seven_day_pct: 88,
          is_current: true,
        },
        {
          key_id: 'b7c4e92f...',
          subscription_type: 'claude_max',
          five_hour_pct: 100,
          seven_day_pct: 100,
          is_current: false,
        },
        {
          key_id: 'c9d5f13a...',
          subscription_type: 'claude_max',
          five_hour_pct: 12,
          seven_day_pct: 45,
          is_current: false,
        },
      ],
      rotation_events_24h: 2,
      aggregate: {
        active_keys: 3,
        five_hour_pct: 35,
        seven_day_pct: 88,
      },
    },
    automations: [
      {
        name: 'Triage Check',
        description: 'Check for pending reports to triage',
        trigger: 'continuous',
        default_interval_minutes: 5,
        effective_interval_minutes: 9,
        last_run: new Date(now - 4 * 60 * 1000),
        next_run: new Date(now + 5 * 60 * 1000),
        seconds_until_next: 300,
      },
      {
        name: 'Task Runner',
        description: 'Spawn agents for pending todo tasks',
        trigger: 'continuous',
        default_interval_minutes: 60,
        effective_interval_minutes: 108,
        last_run: new Date(now - 72 * 60 * 1000),
        next_run: new Date(now + 36 * 60 * 1000),
        seconds_until_next: 2160,
      },
      {
        name: 'Lint Check',
        description: 'Run lint fixer on codebase',
        trigger: 'continuous',
        default_interval_minutes: 30,
        effective_interval_minutes: 54,
        last_run: new Date(now - 38 * 60 * 1000),
        next_run: new Date(now + 16 * 60 * 1000),
        seconds_until_next: 960,
      },
      {
        name: 'Hourly Tasks',
        description: 'Plan executor and CLAUDE.md refactor',
        trigger: 'continuous',
        default_interval_minutes: 55,
        effective_interval_minutes: 99,
        last_run: new Date(now - 61 * 60 * 1000),
        next_run: new Date(now + 38 * 60 * 1000),
        seconds_until_next: 2280,
      },
      {
        name: 'Antipattern Hunter',
        description: 'Scan for spec violations',
        trigger: 'continuous',
        default_interval_minutes: 360,
        effective_interval_minutes: 648,
        last_run: null,
        next_run: null,
        seconds_until_next: null,
      },
      {
        name: 'Pre-Commit Review',
        description: 'Deputy CTO reviews commits',
        trigger: 'commit',
        default_interval_minutes: null,
        effective_interval_minutes: null,
        last_run: null,
        next_run: null,
        seconds_until_next: null,
      },
      {
        name: 'Compliance Checker',
        description: 'Verify spec-to-code mappings',
        trigger: 'file-change',
        default_interval_minutes: null,
        effective_interval_minutes: null,
        last_run: null,
        next_run: null,
        seconds_until_next: null,
      },
      {
        name: 'CTO Notification',
        description: 'Show status on each prompt',
        trigger: 'prompt',
        default_interval_minutes: null,
        effective_interval_minutes: null,
        last_run: null,
        next_run: null,
        seconds_until_next: null,
      },
    ],
    agents,
    hooks,
    sessions,
    pending_items: pendingItems,
    triage,
    tasks,
    feedback_personas: feedbackPersonas,
  };
}

// ============================================================================
// Timeline events
// ============================================================================

export function getMockTimelineEvents(): TimelineEvent[] {
  const now = Date.now();

  const events: TimelineEvent[] = [
    {
      type: 'session',
      timestamp: new Date(now - 3 * 60 * 1000),
      title: 'User session started — CTO dashboard review',
      subtitle: 'task-triggered via autonomous mode',
    },
    {
      type: 'hook',
      timestamp: new Date(now - 7 * 60 * 1000),
      title: 'PreCommit review passed — packages/api/src/auth/token.ts',
      subtitle: 'No violations detected by deputy-cto-review agent',
      status: 'success',
    },
    {
      type: 'report',
      timestamp: new Date(now - 14 * 60 * 1000),
      title: 'Hardcoded JWT secret detected in auth middleware',
      priority: 'critical',
      subtitle: 'Spec G004 violation — credential must be in env or Vault',
    },
    {
      type: 'task',
      timestamp: new Date(now - 21 * 60 * 1000),
      title: 'Completed: Add Zod validation to /api/webhooks route handler',
      subtitle: 'task-runner-code-reviewer — 8 files changed',
    },
    {
      type: 'question',
      timestamp: new Date(now - 28 * 60 * 1000),
      title: 'Should oauth tokens be stored in Supabase Vault or OS keychain?',
      priority: 'high',
      subtitle: 'Awaiting CTO decision',
    },
    {
      type: 'hook',
      timestamp: new Date(now - 36 * 60 * 1000),
      title: 'PostToolUse: Write blocked — attempt to modify .claude/hooks/',
      priority: 'critical',
      subtitle: 'Protected path enforcement triggered',
      status: 'blocked',
    },
    {
      type: 'report',
      timestamp: new Date(now - 44 * 60 * 1000),
      title: 'Missing RLS policy on user_sessions table',
      priority: 'high',
      subtitle: 'Supabase row-level security gap — G003 compliance risk',
    },
    {
      type: 'session',
      timestamp: new Date(now - 52 * 60 * 1000),
      title: 'Lint fixer session — packages/frontend/src/components/',
      subtitle: '12 ESLint errors resolved across 5 files',
    },
    {
      type: 'task',
      timestamp: new Date(now - 61 * 60 * 1000),
      title: 'Started: Refactor CLAUDE.md to remove duplicate spec references',
      subtitle: 'claudemd-refactor agent',
    },
    {
      type: 'hook',
      timestamp: new Date(now - 71 * 60 * 1000),
      title: 'PreCommit: ESLint failure — 3 errors in webhook.ts',
      priority: 'normal',
      subtitle: 'Commit blocked — lint-fixer spawned automatically',
      status: 'failure',
    },
    {
      type: 'report',
      timestamp: new Date(now - 82 * 60 * 1000),
      title: 'Antipattern scan: silent catch in payment processing flow',
      priority: 'critical',
      subtitle: 'G001 violation — silent failure must be converted to loud failure',
    },
    {
      type: 'question',
      timestamp: new Date(now - 93 * 60 * 1000),
      title: 'Approve relaxing CSP to allow inline styles for chart tooltips?',
      priority: 'normal',
      subtitle: 'Architecture question — deputy CTO recommends rejection',
    },
    {
      type: 'session',
      timestamp: new Date(now - 105 * 60 * 1000),
      title: 'Staging health monitor — all checks passed',
      subtitle: 'staging-health-monitor agent — 6 services healthy',
    },
    {
      type: 'task',
      timestamp: new Date(now - 118 * 60 * 1000),
      title: 'Completed: Enable TypeScript strict mode in packages/api',
      subtitle: 'task-runner-code-reviewer — 14 type errors fixed',
    },
    {
      type: 'report',
      timestamp: new Date(now - 132 * 60 * 1000),
      title: 'CORS wildcard on production endpoints — policy violation',
      priority: 'high',
      subtitle: 'Escalated to CTO for explicit origin allowlist decision',
    },
    {
      type: 'hook',
      timestamp: new Date(now - 148 * 60 * 1000),
      title: 'Compliance check triggered — 3 files changed in packages/auth/',
      subtitle: 'compliance-global agent: all G001–G011 specs verified',
      status: 'success',
    },
    {
      type: 'question',
      timestamp: new Date(now - 163 * 60 * 1000),
      title: 'Should the triage pipeline use a dedicated queue or stay in SQLite?',
      priority: 'normal',
      subtitle: 'Scale threshold discussion — recommendation: stay SQLite until 5k/day',
    },
    {
      type: 'session',
      timestamp: new Date(now - 179 * 60 * 1000),
      title: 'Investigator session — tracing API latency spike in production',
      subtitle: 'task-runner-investigator — root cause: N+1 query in reports endpoint',
    },
    {
      type: 'task',
      timestamp: new Date(now - 197 * 60 * 1000),
      title: 'Completed: Rotate leaked service account credential',
      subtitle: 'security task — Supabase service role key revoked and replaced',
    },
    {
      type: 'report',
      timestamp: new Date(now - 214 * 60 * 1000),
      title: 'Dependency audit: lodash prototype pollution CVE resolved',
      priority: 'normal',
      subtitle: 'Self-handled by deputy CTO — bumped to 4.17.21',
    },
  ];

  return events;
}

// ============================================================================
// Automated instances
// ============================================================================

export function getMockAutomatedInstances(): AutomatedInstancesData {
  return {
    instances: [
      // --- Event-triggered (4) ---
      {
        type: 'Pre-Commit Hook',
        runs24h: 18,
        untilNext: 'on commit',
        freqAdj: '+80% slower',
        trigger: 'commit',
      },
      {
        type: 'Test Suite',
        runs24h: 5,
        untilNext: 'on failure',
        freqAdj: '+80% slower',
        trigger: 'failure',
      },
      {
        type: 'Compliance (Hook)',
        runs24h: 11,
        untilNext: 'on change',
        freqAdj: 'baseline',
        trigger: 'file-change',
      },
      {
        type: 'Todo Maintenance',
        runs24h: 7,
        untilNext: 'on change',
        freqAdj: '+80% slower',
        trigger: 'file-change',
      },
      // --- Scheduled (11) ---
      {
        type: 'Triage Check',
        runs24h: 0,
        untilNext: '5m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Lint Checker',
        runs24h: 9,
        untilNext: '16m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'CLAUDE.md Refactor',
        runs24h: 3,
        untilNext: '38m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Task Runner',
        runs24h: 8,
        untilNext: '36m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Production Health',
        runs24h: 14,
        untilNext: '52m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Compliance (Sched.)',
        runs24h: 4,
        untilNext: '1h12m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'User Feedback',
        runs24h: 2,
        untilNext: '1h48m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Antipattern Hunter',
        runs24h: 3,
        untilNext: '3h24m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Staging Health',
        runs24h: 7,
        untilNext: '2h9m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Preview Promotion',
        runs24h: 1,
        untilNext: '5h18m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
      {
        type: 'Staging Promotion',
        runs24h: 0,
        untilNext: '18h42m',
        freqAdj: '+80% slower',
        trigger: 'scheduled',
      },
    ],
    usageTarget: 90,
    currentProjected: 2,
    adjustingDirection: 'stable',
    hasData: true,
    tokensByType: {
      'Task Runner':         85_420_000,
      'Pre-Commit Hook':     61_880_000,
      'Antipattern Hunter':  48_350_000,
      'Lint Checker':        37_720_000,
      'Compliance (Hook)':   29_140_000,
      'Compliance (Sched.)': 22_680_000,
      'Production Health':   18_530_000,
      'CLAUDE.md Refactor':  14_290_000,
      'User Feedback':       11_750_000,
      'Staging Health':       8_490_000,
      'Test Suite':           5_870_000,
    },
  };
}

// ============================================================================
// Testing data
// ============================================================================

export function getMockTesting(): TestingData {
  const now = Date.now();

  return {
    hasData: true,
    failingSuites: [
      {
        name: 'packages/api/src/__tests__/webhooks.test.ts',
        since: new Date(now - 14 * 60 * 60 * 1000).toISOString(),
        fixAttempts: 5,
        lastAttempt: new Date(now - 38 * 60 * 1000).toISOString(),
        framework: 'vitest',
      },
      {
        name: 'packages/frontend/src/__tests__/auth/OAuth.test.tsx',
        since: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
        fixAttempts: 3,
        lastAttempt: new Date(now - 72 * 60 * 1000).toISOString(),
        framework: 'vitest',
      },
      {
        name: 'e2e/tests/checkout-flow.spec.ts',
        since: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
        fixAttempts: 2,
        lastAttempt: new Date(now - 2.1 * 60 * 60 * 1000).toISOString(),
        framework: 'playwright',
      },
      {
        name: 'packages/worker/src/__tests__/queue-processor.test.ts',
        since: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
        fixAttempts: 1,
        lastAttempt: new Date(now - 3.5 * 60 * 60 * 1000).toISOString(),
        framework: 'jest',
      },
      {
        name: 'packages/shared/src/__tests__/validators/schema.test.ts',
        since: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        fixAttempts: 0,
        lastAttempt: null,
        framework: 'vitest',
      },
    ],
    testAgentSpawns24h: 14,
    agentBreakdown24h: {
      jest: 2,
      vitest: 7,
      playwright: 3,
      testWriter: 2,
    },
    suitesFixedRecently: 3,
    uniqueFailureSignatures24h: 8,
    dailyTestActivity: [3, 5, 2, 7, 4, 9, 14],
    testActivityTimeseries: [
      0, 0, 1, 0, 2, 1, 0, 0, 3, 1, 0, 2,
      1, 0, 1, 2, 3, 1, 0, 2, 4, 2, 1, 3,
      2, 0, 1, 3, 5, 2, 1, 2, 3, 4, 2, 1,
      3, 5, 4, 2, 3, 4,
    ],
    codecov: {
      coveragePercent: 73.4,
      trend: [71.2, 71.8, 72.1, 72.5, 72.9, 73.1, 73.4],
    },
  };
}

// ============================================================================
// Deployments data
// ============================================================================

export function getMockDeployments(): DeploymentsData {
  const now = Date.now();

  const productionDeploys = [
    {
      service: 'gentyr-api',
      platform: 'render' as const,
      status: 'live',
      deployedAt: new Date(now - 22 * 60 * 1000).toISOString(),
      commitMessage: 'fix: resolve N+1 query in reports endpoint',
      commitSha: 'a3f8d21',
      url: 'https://api.gentyr.io',
      environment: 'production' as const,
    },
    {
      service: 'gentyr-api',
      platform: 'render' as const,
      status: 'live',
      deployedAt: new Date(now - 3.8 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'feat: add webhook signature verification middleware',
      commitSha: 'b7c4e92',
      url: 'https://api.gentyr.io',
      environment: 'production' as const,
    },
    {
      service: 'gentyr-web',
      platform: 'vercel' as const,
      status: 'ready',
      deployedAt: new Date(now - 5.2 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'feat: CTO dashboard trajectory graph improvements',
      commitSha: 'c9d5f13',
      url: 'https://gentyr.io',
      environment: 'production' as const,
    },
    {
      service: 'gentyr-web',
      platform: 'vercel' as const,
      status: 'ready',
      deployedAt: new Date(now - 8.7 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'chore: bump lodash to 4.17.21 — CVE fix',
      commitSha: 'd2e6a47',
      url: 'https://gentyr.io',
      environment: 'production' as const,
    },
    {
      service: 'gentyr-worker',
      platform: 'render' as const,
      status: 'live',
      deployedAt: new Date(now - 11.4 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'fix: queue processor crash on empty payload',
      commitSha: 'e8f9b61',
      url: undefined,
      environment: 'production' as const,
    },
  ];

  const previewDeploys = [
    {
      service: 'gentyr-web-preview',
      platform: 'vercel' as const,
      status: 'ready',
      deployedAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'feat: add OAuth2 flow',
      commitSha: 'b4e9f12',
      url: 'https://preview-auth-redesign.gentyr.io',
      environment: 'preview' as const,
    },
    {
      service: 'gentyr-api-preview',
      platform: 'render' as const,
      status: 'building',
      deployedAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'fix: resolve race condition in worker',
      commitSha: 'c7d3a45',
      url: 'https://api-preview-worker-fix.gentyr.io',
      environment: 'preview' as const,
    },
    {
      service: 'gentyr-web-preview',
      platform: 'vercel' as const,
      status: 'ready',
      deployedAt: new Date(now - 6.3 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'feat: dashboard settings panel',
      commitSha: 'e2f8b71',
      url: 'https://preview-settings.gentyr.io',
      environment: 'preview' as const,
    },
  ];

  const stagingDeploys = [
    {
      service: 'gentyr-api-staging',
      platform: 'render' as const,
      status: 'failed',
      deployedAt: new Date(now - 1.2 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'wip: experimental rate-limit redesign',
      commitSha: 'f1a2b34',
      url: 'https://api-staging.gentyr.io',
      environment: 'staging' as const,
    },
    {
      service: 'gentyr-web-staging',
      platform: 'vercel' as const,
      status: 'ready',
      deployedAt: new Date(now - 2.9 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'feat: inline styles replaced with CSS vars for CSP compat',
      commitSha: 'g3c4d56',
      url: 'https://staging.gentyr.io',
      environment: 'staging' as const,
    },
    {
      service: 'gentyr-api-staging',
      platform: 'render' as const,
      status: 'live',
      deployedAt: new Date(now - 7.1 * 60 * 60 * 1000).toISOString(),
      commitMessage: 'fix: RLS policy added to user_sessions table',
      commitSha: 'h5e6f78',
      url: 'https://api-staging.gentyr.io',
      environment: 'staging' as const,
    },
  ];

  const combined = [...productionDeploys, ...stagingDeploys, ...previewDeploys]
    .sort((a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime())
    .slice(0, 8);

  return {
    hasData: true,
    render: {
      services: [
        { name: 'gentyr-api', status: 'active', type: 'web_service', suspended: false, url: 'https://api.gentyr.io' },
        { name: 'gentyr-worker', status: 'active', type: 'background_worker', suspended: false },
      ],
      recentDeploys: [...productionDeploys.filter(d => d.platform === 'render'), ...stagingDeploys.filter(d => d.platform === 'render'), ...previewDeploys.filter(d => d.platform === 'render')],
    },
    vercel: {
      projects: [
        { name: 'gentyr-web', framework: 'nextjs' },
      ],
      recentDeploys: [...productionDeploys.filter(d => d.platform === 'vercel'), ...stagingDeploys.filter(d => d.platform === 'vercel'), ...previewDeploys.filter(d => d.platform === 'vercel')],
    },
    pipeline: {
      previewStatus: 'checked',
      stagingStatus: 'checked',
      lastPromotionAt: new Date(now - 5.2 * 60 * 60 * 1000).toISOString(),
      lastPreviewCheck: new Date(now - 25 * 60 * 1000).toISOString(),
      lastStagingCheck: new Date(now - 68 * 60 * 1000).toISOString(),
      localDevCount: 3,
      stagingFreezeActive: true,
    },
    combined,
    byEnvironment: {
      preview: previewDeploys,
      staging: stagingDeploys,
      production: productionDeploys,
    },
    stats: {
      totalDeploys24h: 8,
      successCount24h: 4,
      failedCount24h: 1,
    },
  };
}

// ============================================================================
// Infrastructure data
// ============================================================================

export function getMockInfra(): InfraData {
  const now = Date.now();

  return {
    hasData: true,
    render: {
      serviceCount: 2,
      suspendedCount: 0,
      available: true,
      lastDeployAt: new Date(now - 22 * 60 * 1000).toISOString(),
    },
    vercel: {
      projectCount: 1,
      errorDeploys: 2,
      buildingCount: 0,
      available: true,
    },
    supabase: {
      healthy: true,
      available: true,
    },
    elastic: {
      available: false,
      totalLogs1h: 0,
      errorCount1h: 0,
      warnCount1h: 0,
      topServices: [],
    },
    cloudflare: {
      status: 'active',
      nameServers: ['aurora.ns.cloudflare.com', 'leo.ns.cloudflare.com'],
      planName: 'Free Website',
      available: true,
    },
  };
}

// ============================================================================
// Logging data
// ============================================================================

export function getMockLogging(): LoggingData {
  // 24 hourly buckets — gradual ramp from midnight through the workday peak.
  const volumeTimeseries = [
    820, 640, 490, 420, 380, 410,      // 00:00–05:59  (quiet night)
    680, 1120, 1580, 1940, 2180, 2290, // 06:00–11:59  (morning ramp)
    2310, 2250, 2180, 2090, 1970, 1830,// 12:00–17:59  (afternoon plateau)
    1620, 1380, 1180, 980, 840, 710,   // 18:00–23:59  (evening wind-down)
  ];

  return {
    hasData: true,
    totalLogs1h: 2490,
    totalLogs24h: 44640,
    volumeTimeseries,
    byLevel: [
      { level: 'info',    count: 36820 },
      { level: 'warn',    count: 5490  },
      { level: 'error',   count: 1840  },
      { level: 'debug',   count: 490   },
    ],
    byService: [
      { service: 'api',        count: 18340 },
      { service: 'worker',     count: 11280 },
      { service: 'auth',       count: 7190  },
      { service: 'deployment', count: 4820  },
      { service: 'cron',       count: 3010  },
    ],
    bySource: [
      { source: 'request-handler',  count: 14920 },
      { source: 'queue-processor',  count: 9640  },
      { source: 'auth-middleware',  count: 6830  },
      { source: 'deploy-notifier',  count: 4120  },
      { source: 'scheduler',        count: 2890  },
    ],
    topErrors: [
      {
        message: 'ZodError: Required field "schema_version" missing in payload',
        service: 'api',
        count: 412,
      },
      {
        message: 'ETIMEDOUT: Connection timed out reaching Supabase replica',
        service: 'worker',
        count: 287,
      },
      {
        message: 'UnhandledPromiseRejection: Token verification failed — clock skew',
        service: 'auth',
        count: 194,
      },
      {
        message: 'RenderBuildError: Exit code 1 in packages/api Docker build step',
        service: 'deployment',
        count: 88,
      },
      {
        message: 'CronJobError: Payment reconciliation job exceeded 30s timeout',
        service: 'cron',
        count: 43,
      },
    ],
    topWarnings: [
      {
        message: 'Slow query detected: reports.find() took 2840ms (threshold 500ms)',
        service: 'api',
        count: 831,
      },
      {
        message: 'Rate limit approaching: 92% of Anthropic API quota consumed',
        service: 'worker',
        count: 614,
      },
      {
        message: 'Deprecated field "userId" still in use — migrate to "user_id"',
        service: 'api',
        count: 488,
      },
      {
        message: 'Session token within 5 minutes of expiry — refresh recommended',
        service: 'auth',
        count: 327,
      },
      {
        message: 'Cache miss rate elevated: 68% on report-metadata key prefix',
        service: 'worker',
        count: 219,
      },
    ],
    storage: {
      estimatedDailyGB: 0.021,
      estimatedMonthlyCost: 0.16,
      indexCount: 7,
    },
    sourceCoverage: [
      { source: 'api',        status: 'active',     description: 'Application API server logs' },
      { source: 'worker',     status: 'active',     description: 'Background job/worker logs' },
      { source: 'deployment', status: 'active',     description: 'Deploy event logs from Render/Vercel' },
      { source: 'ci-cd',      status: 'missing',    description: 'CI/CD pipeline logs (GitHub Actions)' },
      { source: 'testing',    status: 'low-volume', description: 'Test execution logs (Vitest/Playwright)' },
      { source: 'database',   status: 'missing',    description: 'Supabase/Postgres query logs' },
      { source: 'cdn',        status: 'missing',    description: 'Cloudflare access/WAF logs' },
      { source: 'auth',       status: 'active',     description: 'Authentication event logs' },
      { source: 'cron',       status: 'active',     description: 'Scheduled job execution logs' },
    ],
  };
}

// ============================================================================
// Account Overview data
// ============================================================================

export function getMockAccountOverview(): AccountOverviewData {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  return {
    hasData: true,
    activeKeyId: 'a3f8d21c...',
    totalRotations24h: 2,
    accounts: [
      {
        keyId: 'a3f8d21c...',
        status: 'active',
        isCurrent: true,
        subscriptionType: 'claude_max',
        email: 'dev@gentyr.io',
        expiresAt: new Date(now + 1 * DAY),
        addedAt: new Date(now - 5 * DAY),
        lastUsedAt: new Date(now - 12 * MIN),
        fiveHourPct: 35,
        sevenDayPct: 88,
        sevenDaySonnetPct: 17,
      },
      {
        keyId: 'b7c4e92f...',
        status: 'exhausted',
        isCurrent: false,
        subscriptionType: 'claude_max',
        email: 'ops@gentyr.io',
        expiresAt: new Date(now + 3 * DAY),
        addedAt: new Date(now - 3 * DAY),
        lastUsedAt: new Date(now - 4 * HOUR),
        fiveHourPct: 100,
        sevenDayPct: 100,
        sevenDaySonnetPct: 22,
      },
      {
        keyId: 'c9d5f13a...',
        status: 'active',
        isCurrent: false,
        subscriptionType: 'claude_max',
        email: 'backup@gentyr.io',
        expiresAt: new Date(now + 5 * DAY),
        addedAt: new Date(now - 1 * DAY),
        lastUsedAt: new Date(now - 2 * HOUR),
        fiveHourPct: 12,
        sevenDayPct: 45,
        sevenDaySonnetPct: 8,
      },
    ],
    events: [
      {
        timestamp: new Date(now - 38 * MIN),
        event: 'key_switched',
        keyId: 'a3f8d21c...',
        description: 'Account selected: dev@gentyr.io',
        usageSnapshot: { fiveHour: 35, sevenDay: 88 },
      },
      {
        timestamp: new Date(now - 1.2 * HOUR),
        event: 'key_exhausted',
        keyId: 'b7c4e92f...',
        description: 'Account fully depleted: ops@gentyr.io',
        usageSnapshot: { fiveHour: 100, sevenDay: 100 },
      },
      {
        timestamp: new Date(now - 2.5 * HOUR),
        event: 'account_nearly_depleted',
        keyId: 'b7c4e92f...',
        description: 'Account nearly depleted: ops@gentyr.io',
        usageSnapshot: { fiveHour: 96, sevenDay: 91 },
      },
      {
        timestamp: new Date(now - 4.1 * HOUR),
        event: 'key_switched',
        keyId: 'b7c4e92f...',
        description: 'Account selected: ops@gentyr.io',
        usageSnapshot: { fiveHour: 62, sevenDay: 91 },
      },
      {
        timestamp: new Date(now - 5.8 * HOUR),
        event: 'key_added',
        keyId: 'c9d5f13a...',
        description: 'New account added: backup@gentyr.io',
        usageSnapshot: null,
      },
      {
        timestamp: new Date(now - 8.3 * HOUR),
        event: 'account_quota_refreshed',
        keyId: 'a3f8d21c...',
        description: 'Account quota refreshed: dev@gentyr.io',
        usageSnapshot: null,
      },
      {
        timestamp: new Date(now - 11.7 * HOUR),
        event: 'key_switched',
        keyId: 'a3f8d21c...',
        description: 'Account selected: dev@gentyr.io',
        usageSnapshot: { fiveHour: 8, sevenDay: 72 },
      },
      {
        timestamp: new Date(now - 14.2 * HOUR),
        event: 'account_auth_failed',
        keyId: 'd2e6a47b...',
        description: 'Account can no longer auth: old@gentyr.io',
        usageSnapshot: null,
      },
    ],
  };
}

// ============================================================================
// Worktree data
// ============================================================================

export function getMockWorktrees(): WorktreeData {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  return {
    hasData: true,
    worktrees: [
      {
        branch: 'feature/auth-redesign',
        path: '/project/.claude/worktrees/feature-auth-redesign',
        head: 'a3f8d21',
        lastCommitAge: new Date(now - 2 * HOUR).toISOString(),
        lastCommitMessage: 'feat: add OAuth2 PKCE flow with session rotation',
        agent: { type: 'code-writer', status: 'running' },
        pipelineStage: 'local',
        isSystem: false,
        isMerged: false,
      },
      {
        branch: 'feature/api-refactor',
        path: '/project/.claude/worktrees/feature-api-refactor',
        head: 'b7c4e38',
        lastCommitAge: new Date(now - 5 * HOUR).toISOString(),
        lastCommitMessage: 'fix: resolve connection pool exhaustion',
        agent: { type: 'investigator', status: 'running' },
        pipelineStage: 'preview',
        isSystem: false,
        isMerged: true,
      },
      {
        branch: 'feature/dashboard-v2',
        path: '/project/.claude/worktrees/feature-dashboard-v2',
        head: 'c9d2f15',
        lastCommitAge: new Date(now - 1 * DAY).toISOString(),
        lastCommitMessage: 'feat: CTO dashboard worktree visualization',
        agent: null,
        pipelineStage: 'staging',
        isSystem: false,
        isMerged: true,
      },
      {
        branch: 'automation/preview-promo',
        path: '/project/.claude/worktrees/automation-preview-promo',
        head: 'd1e5a72',
        lastCommitAge: new Date(now - 3 * HOUR).toISOString(),
        lastCommitMessage: 'Merge branch feature/auth-redesign into preview',
        agent: null,
        pipelineStage: 'preview',
        isSystem: true,
        isMerged: false,
      },
      {
        branch: 'automation/staging-promo',
        path: '/project/.claude/worktrees/automation-staging-promo',
        head: 'e4f8b93',
        lastCommitAge: new Date(now - 1 * DAY).toISOString(),
        lastCommitMessage: 'Merge branch preview into staging',
        agent: null,
        pipelineStage: 'staging',
        isSystem: true,
        isMerged: false,
      },
    ],
    summary: { total: 5, active: 2, idle: 1, merged: 2, system: 2 },
  };
}

// ============================================================================
// Product Manager data
// ============================================================================

export function getMockProductManager(): ProductManagerData {
  return {
    hasData: true,
    status: 'in_progress',
    sections_populated: 4,
    total_sections: 6,
    sections: [
      { number: 1, title: 'Market Space & Players', populated: true },
      { number: 2, title: 'Buyer Personas', populated: true, entry_count: 4 },
      { number: 3, title: 'Competitor Differentiation', populated: true },
      { number: 4, title: 'Pricing Models', populated: true },
      { number: 5, title: 'Niche Strengths & Weaknesses', populated: false },
      { number: 6, title: 'User Sentiment', populated: false, entry_count: 0 },
    ],
    compliance: null,
    last_updated: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  };
}
