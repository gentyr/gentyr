/**
 * Token Usage Query Library (PR 4)
 *
 * Read-only query helpers over `.claude/state/token-usage.db` for the
 * `query_token_usage`, `top_token_sessions`, and `token_attribution_health`
 * MCP tools on the agent-tracker server. Pure SQL — no MCP-server dependencies.
 *
 * The DB schema is owned by the token-usage-collector daemon (PR 1). This
 * module assumes the DB exists; missing-DB cases return empty/zero shapes.
 */

import path from 'path';
import fs from 'fs';
import { openReadonlyDb } from '../shared/readonly-db.js';
import type Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'token-usage.db');

export type RangeKey = '1h' | '24h' | '7d' | '30d' | 'all';

function rangeStartMs(range: RangeKey): number {
  const now = Date.now();
  switch (range) {
    case '1h': return now - 60 * 60 * 1000;
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    case 'all': return 0;
  }
}

export interface UsageRow {
  group_value: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  pct_of_total: number;
  top_model: string | null;
}

export interface UsageQueryResult {
  range: { start_ms: number; end_ms: number; range_key: RangeKey };
  total: {
    tokens: number;
    cost_usd: number;
    sessions: number;
    messages: number;
  };
  rows: UsageRow[];
  group_by: string;
}

const GROUP_BY_COL: Record<string, string> = {
  // PR B/C: stable kind-of-work dimensions (survive revival)
  work_category: "COALESCE(sa.work_category, 'other')",
  spawn_origin: "COALESCE(sa.spawn_origin, 'unknown')",
  revived_by: "COALESCE(sa.revived_by, 'not-a-revival')",
  // Legacy dimensions
  source: 'sa.source',
  lane: "COALESCE(sa.lane, 'unknown')",
  agent_type: "COALESCE(sa.agent_type, 'unknown')",
  model: 'ue.model',
  category: "COALESCE(sa.category, 'unknown')",
  day: "date(ue.ts / 1000, 'unixepoch')",
  persistent_task: "COALESCE(CAST(sa.persistent_task_id AS TEXT), 'none')",
  plan: "COALESCE(sa.plan_id, 'none')",
};

export interface QueryFilter {
  source?: string;
  work_category?: string;
  spawn_origin?: string;
  revived_by?: string;
  only_revivals?: boolean;
  only_originals?: boolean;
  model?: string;
  lane?: string;
  persistent_task_id?: number;
  plan_id?: string;
}

/**
 * Returns a usage breakdown grouped by the requested dimension within the
 * requested time range. Pulls from `usage_events JOIN session_attribution`
 * directly (not from `daily_rollup`) so non-day group_by dimensions work
 * within the same hour-grain window.
 */
export function queryTokenUsage({
  range,
  groupBy,
  filter = {},
  limit,
  rollUpCompaction = false,
}: {
  range: RangeKey;
  groupBy: string;
  filter?: QueryFilter;
  limit: number;
  rollUpCompaction?: boolean;
}): UsageQueryResult {
  const startMs = rangeStartMs(range);
  const endMs = Date.now();
  const empty: UsageQueryResult = {
    range: { start_ms: startMs, end_ms: endMs, range_key: range },
    total: { tokens: 0, cost_usd: 0, sessions: 0, messages: 0 },
    rows: [],
    group_by: groupBy,
  };
  if (!fs.existsSync(DB_PATH)) return empty;

  // PR D — compaction roll-up: when grouping by work_category, replace
  // `compaction-subagent` rows with their parent session's work_category so
  // /compact cost is attributed to the work that triggered it (the long-
  // running persistent-monitor / task-runner whose context window filled).
  // Only meaningful when group_by='work_category' — silently ignored otherwise.
  const enableRollup = rollUpCompaction === true && groupBy === 'work_category';
  const groupCol = enableRollup
    ? `CASE
         WHEN COALESCE(sa.work_category, 'other') = 'compaction-subagent'
              AND parent_sa.work_category IS NOT NULL
         THEN parent_sa.work_category
         ELSE COALESCE(sa.work_category, 'other')
       END`
    : (GROUP_BY_COL[groupBy] || GROUP_BY_COL.source);
  const joinClause = enableRollup
    ? `LEFT JOIN session_attribution parent_sa ON parent_sa.session_id = sa.parent_session_id`
    : '';
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = openReadonlyDb(DB_PATH);

    const whereClauses: string[] = ['ue.ts >= ?'];
    const params: (string | number)[] = [startMs];

    if (filter.source) { whereClauses.push("sa.source LIKE ?"); params.push(`%${filter.source}%`); }
    if (filter.work_category) { whereClauses.push('sa.work_category = ?'); params.push(filter.work_category); }
    if (filter.spawn_origin) { whereClauses.push('sa.spawn_origin = ?'); params.push(filter.spawn_origin); }
    if (filter.revived_by) { whereClauses.push('sa.revived_by = ?'); params.push(filter.revived_by); }
    if (filter.only_revivals) { whereClauses.push('sa.is_revival = 1'); }
    if (filter.only_originals) { whereClauses.push('sa.is_revival = 0'); }
    if (filter.model) { whereClauses.push('ue.model = ?'); params.push(filter.model); }
    if (filter.lane) { whereClauses.push('sa.lane = ?'); params.push(filter.lane); }
    if (filter.persistent_task_id) { whereClauses.push('sa.persistent_task_id = ?'); params.push(filter.persistent_task_id); }
    if (filter.plan_id) { whereClauses.push('sa.plan_id = ?'); params.push(filter.plan_id); }

    const where = `WHERE ${whereClauses.join(' AND ')}`;

    const totalRow = db.prepare(
      `SELECT
        COUNT(*) AS messages,
        COUNT(DISTINCT ue.session_id) AS sessions,
        COALESCE(SUM(ue.input_tokens + ue.output_tokens + ue.cache_creation_tokens + ue.cache_read_tokens), 0) AS total_tokens,
        COALESCE(SUM(ue.cost_micro_usd), 0) AS total_cost_micro
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       ${joinClause}
       ${where}`
    ).get(...params) as { messages: number; sessions: number; total_tokens: number; total_cost_micro: number };

    const rows = db.prepare(
      `SELECT
        ${groupCol} AS group_value,
        COUNT(DISTINCT ue.session_id) AS sessions,
        COUNT(*) AS messages,
        COALESCE(SUM(ue.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ue.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(ue.cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(ue.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(ue.input_tokens + ue.output_tokens + ue.cache_creation_tokens + ue.cache_read_tokens), 0) AS total_tokens,
        COALESCE(SUM(ue.cost_micro_usd), 0) AS cost_micro_usd
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       ${joinClause}
       ${where}
       GROUP BY group_value
       ORDER BY total_tokens DESC
       LIMIT ?`
    ).all(...params, limit) as Array<{
      group_value: string | null;
      sessions: number;
      messages: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      total_tokens: number;
      cost_micro_usd: number;
    }>;

    // Compute top model per group in a second pass (avoids correlated
    // subquery scope issues across SQLite versions).
    const modelStmt = db.prepare(
      `SELECT ue.model AS model,
              SUM(ue.input_tokens + ue.output_tokens) AS toks
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       ${joinClause}
       ${where}
         AND ${groupCol} = ?
       GROUP BY ue.model
       ORDER BY toks DESC
       LIMIT 1`
    );
    const topModelByGroup = new Map<string, string | null>();
    for (const r of rows) {
      const groupKey = r.group_value ?? 'unknown';
      try {
        const m = modelStmt.get(...params, groupKey) as { model: string | null } | undefined;
        topModelByGroup.set(groupKey, m?.model ?? null);
      } catch {
        topModelByGroup.set(groupKey, null);
      }
    }

    const totalTokens = totalRow.total_tokens || 0;
    const totalCostMicro = totalRow.total_cost_micro || 0;

    const mappedRows: UsageRow[] = rows.map((r) => {
      const groupKey = r.group_value ?? 'unknown';
      return {
        group_value: groupKey,
        sessions: r.sessions,
        messages: r.messages,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        cache_read_tokens: r.cache_read_tokens,
        total_tokens: r.total_tokens,
        cost_usd: r.cost_micro_usd / 1_000_000,
        pct_of_total: totalTokens > 0 ? r.total_tokens / totalTokens : 0,
        top_model: topModelByGroup.get(groupKey) ?? null,
      };
    });

    return {
      range: { start_ms: startMs, end_ms: endMs, range_key: range },
      total: {
        tokens: totalTokens,
        cost_usd: totalCostMicro / 1_000_000,
        sessions: totalRow.sessions || 0,
        messages: totalRow.messages || 0,
      },
      rows: mappedRows,
      group_by: groupBy,
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export interface TopSession {
  session_id: string;
  source: string;
  agent_type: string | null;
  total_tokens: number;
  cost_usd: number;
  duration_minutes: number;
  started_at: number | null;
  ended_at: number | null;
  messages: number;
}

export function topTokenSessions(range: RangeKey, limit: number): {
  range: { start_ms: number; end_ms: number };
  sessions: TopSession[];
} {
  const startMs = rangeStartMs(range);
  const endMs = Date.now();
  if (!fs.existsSync(DB_PATH)) return { range: { start_ms: startMs, end_ms: endMs }, sessions: [] };

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = openReadonlyDb(DB_PATH);
    const rows = db.prepare(
      `SELECT
        ue.session_id,
        COALESCE(sa.source, 'unknown') AS source,
        sa.agent_type,
        sa.started_at,
        sa.ended_at,
        COUNT(*) AS messages,
        COALESCE(SUM(ue.input_tokens + ue.output_tokens + ue.cache_creation_tokens + ue.cache_read_tokens), 0) AS total_tokens,
        COALESCE(SUM(ue.cost_micro_usd), 0) AS cost_micro_usd,
        MIN(ue.ts) AS first_ts,
        MAX(ue.ts) AS last_ts
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       WHERE ue.ts >= ?
       GROUP BY ue.session_id
       ORDER BY total_tokens DESC
       LIMIT ?`
    ).all(startMs, limit) as Array<{
      session_id: string;
      source: string;
      agent_type: string | null;
      started_at: number | null;
      ended_at: number | null;
      messages: number;
      total_tokens: number;
      cost_micro_usd: number;
      first_ts: number;
      last_ts: number;
    }>;

    const sessions: TopSession[] = rows.map((r) => {
      const start = r.started_at || r.first_ts;
      const end = r.ended_at || r.last_ts;
      const durationMin = start && end ? Math.max(0, (end - start) / 60000) : 0;
      return {
        session_id: r.session_id,
        source: r.source,
        agent_type: r.agent_type,
        total_tokens: r.total_tokens,
        cost_usd: r.cost_micro_usd / 1_000_000,
        duration_minutes: Math.round(durationMin * 10) / 10,
        started_at: r.started_at,
        ended_at: r.ended_at,
        messages: r.messages,
      };
    });

    return { range: { start_ms: startMs, end_ms: endMs }, sessions };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export interface AttributionHealth {
  resolved: number;
  pending: number;
  unknown: number;
  total: number;
  pending_oldest_age_minutes: number | null;
  untagged_subprocess_count: number;
  db_path: string;
  db_exists: boolean;
}

export function attributionHealth(): AttributionHealth {
  const empty: AttributionHealth = {
    resolved: 0,
    pending: 0,
    unknown: 0,
    total: 0,
    pending_oldest_age_minutes: null,
    untagged_subprocess_count: 0,
    db_path: DB_PATH,
    db_exists: false,
  };
  if (!fs.existsSync(DB_PATH)) return empty;

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = openReadonlyDb(DB_PATH);

    const statusRows = db.prepare(
      `SELECT attribution_status AS status, COUNT(*) AS n
       FROM session_attribution
       GROUP BY attribution_status`
    ).all() as Array<{ status: string; n: number }>;

    const counts: Record<string, number> = { resolved: 0, pending: 0, unknown: 0 };
    let total = 0;
    for (const r of statusRows) {
      total += r.n;
      if (r.status in counts) counts[r.status] = r.n;
    }

    const oldest = db.prepare(
      `SELECT MIN(last_attempt_at) AS oldest FROM session_attribution WHERE attribution_status = 'pending'`
    ).get() as { oldest: number | null };

    let untagged = 0;
    try {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM subprocess_calls WHERE caller = 'untagged'`
      ).get() as { n: number };
      untagged = r.n;
    } catch { /* table absent */ }

    const ageMin = oldest.oldest ? Math.max(0, (Date.now() - oldest.oldest) / 60000) : null;

    return {
      resolved: counts.resolved,
      pending: counts.pending,
      unknown: counts.unknown,
      total,
      pending_oldest_age_minutes: ageMin === null ? null : Math.round(ageMin),
      untagged_subprocess_count: untagged,
      db_path: DB_PATH,
      db_exists: true,
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * PR C — Revival cost summary. Returns the total token spend attributable
 * to revived sessions vs original spawns within a time range, plus a
 * by-`revived_by` breakdown showing which revival mechanisms cost the most.
 *
 * This is the answer to "how much are we spending on resurrection?"
 */
/**
 * One-line description for each work_category bucket — mirrors
 * WORK_CATEGORY_DESCRIPTIONS in `.claude/hooks/lib/work-category.js`. Kept
 * duplicated here because the agent-tracker TS server doesn't enable
 * `allowJs` and the descriptions are stable display-only text.
 */
export const WORK_CATEGORY_DESCRIPTIONS: Record<string, string> = Object.freeze({
  'plan-manager':           'Plan orchestrators (one persistent monitor per active plan)',
  'persistent-monitor':     'Long-running orchestrators for persistent tasks',
  'global-monitor':         'Always-on deputy-CTO alignment monitor',
  'universal-auditor':      'Independent task-completion verifier (audit lane)',
  'plan-auditor':           'Plan-task verification auditor (audit lane)',
  'authorization-auditor':  'CTO-authorization decision verifier (audit lane)',
  'task-runner':            'Standard work agents (code-writer, test-writer, etc.)',
  'demo-manager':           'Demo lifecycle, repair, and validation',
  'preview-promoter':       'Preview→staging promotion pipeline',
  'hotfix-promotion':       'Emergency hotfix promotion (staging→main)',
  'pr-reviewer':            'AI PR review on submission (gate lane)',
  'staging-reviewer':       'Reactive review of new staging commits',
  'security-auditor':       'OWASP code security review (weekly)',
  'feedback-agent':         'Persona-based product testing',
  'gate-agent':             'Haiku task-gate review (gate lane)',
  'antipattern-hunter':     'G001–G019 antipattern detection',
  'compliance-checker':     'Spec compliance checks',
  'deputy-cto':             'Report triage and delegation',
  'health-monitor':         'Production/staging health monitors',
  'lint-fixer':             'Automated lint repair',
  'claudemd-refactor':      'CLAUDE.md refactor agent',
  'federation-mapper':      'Federation schema mapper',
  'test-fixer':             'Test failure repair (Jest/Vitest/Playwright)',
  'todo-maintenance':       'TODO item processing',
  'compaction-subagent':    '/compact sub-process (Claude Code auto-compaction)',
  'agent-tool-subagent':    'Task tool sub-agents (user-alignment, investigator, code-writer, code-reviewer, test-writer, ...)',
  'interactive-cto':        'CTO interactive sessions',
  'subprocess-llm':         'Hook/daemon LLM subprocesses (broadcaster, live-feed, ...)',
  'other':                  'Unclassified sessions',
});

export interface RevivalCostSummary {
  range: { start_ms: number; end_ms: number; range_key: RangeKey };
  totals: {
    revival_tokens: number;
    revival_cost_usd: number;
    revival_sessions: number;
    original_tokens: number;
    original_cost_usd: number;
    original_sessions: number;
    revival_pct_of_total: number;
  };
  by_revived_by: Array<{
    revived_by: string;
    sessions: number;
    tokens: number;
    cost_usd: number;
    pct_of_revival_total: number;
  }>;
}

export function revivalCostSummary({ range, limit = 50 }: { range: RangeKey; limit?: number }): RevivalCostSummary {
  const startMs = rangeStartMs(range);
  const endMs = Date.now();
  const empty: RevivalCostSummary = {
    range: { start_ms: startMs, end_ms: endMs, range_key: range },
    totals: {
      revival_tokens: 0, revival_cost_usd: 0, revival_sessions: 0,
      original_tokens: 0, original_cost_usd: 0, original_sessions: 0,
      revival_pct_of_total: 0,
    },
    by_revived_by: [],
  };
  if (!fs.existsSync(DB_PATH)) return empty;

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = openReadonlyDb(DB_PATH);

    const totals = db.prepare(
      `SELECT
        COALESCE(sa.is_revival, 0) AS is_revival,
        COUNT(DISTINCT ue.session_id) AS sessions,
        COALESCE(SUM(ue.input_tokens + ue.output_tokens + ue.cache_creation_tokens + ue.cache_read_tokens), 0) AS tokens,
        COALESCE(SUM(ue.cost_micro_usd), 0) AS cost_micro
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       WHERE ue.ts >= ?
       GROUP BY is_revival`
    ).all(startMs) as Array<{ is_revival: number; sessions: number; tokens: number; cost_micro: number }>;

    let revival = { sessions: 0, tokens: 0, cost_micro: 0 };
    let original = { sessions: 0, tokens: 0, cost_micro: 0 };
    for (const r of totals) {
      if (r.is_revival === 1) revival = { sessions: r.sessions, tokens: r.tokens, cost_micro: r.cost_micro };
      else original = { sessions: r.sessions, tokens: r.tokens, cost_micro: r.cost_micro };
    }
    const total = revival.tokens + original.tokens;

    const byMechanism = db.prepare(
      `SELECT
        COALESCE(sa.revived_by, 'unknown') AS revived_by,
        COUNT(DISTINCT ue.session_id) AS sessions,
        COALESCE(SUM(ue.input_tokens + ue.output_tokens + ue.cache_creation_tokens + ue.cache_read_tokens), 0) AS tokens,
        COALESCE(SUM(ue.cost_micro_usd), 0) AS cost_micro
       FROM usage_events ue
       LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
       WHERE ue.ts >= ? AND sa.is_revival = 1
       GROUP BY revived_by
       ORDER BY tokens DESC
       LIMIT ?`
    ).all(startMs, limit) as Array<{ revived_by: string; sessions: number; tokens: number; cost_micro: number }>;

    return {
      range: { start_ms: startMs, end_ms: endMs, range_key: range },
      totals: {
        revival_tokens: revival.tokens,
        revival_cost_usd: revival.cost_micro / 1_000_000,
        revival_sessions: revival.sessions,
        original_tokens: original.tokens,
        original_cost_usd: original.cost_micro / 1_000_000,
        original_sessions: original.sessions,
        revival_pct_of_total: total > 0 ? revival.tokens / total : 0,
      },
      by_revived_by: byMechanism.map(r => ({
        revived_by: r.revived_by,
        sessions: r.sessions,
        tokens: r.tokens,
        cost_usd: r.cost_micro / 1_000_000,
        pct_of_revival_total: revival.tokens > 0 ? r.tokens / revival.tokens : 0,
      })),
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
