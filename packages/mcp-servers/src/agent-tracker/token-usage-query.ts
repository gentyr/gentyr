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
}: {
  range: RangeKey;
  groupBy: string;
  filter?: QueryFilter;
  limit: number;
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

  const groupCol = GROUP_BY_COL[groupBy] || GROUP_BY_COL.source;
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = openReadonlyDb(DB_PATH);

    const whereClauses: string[] = ['ue.ts >= ?'];
    const params: (string | number)[] = [startMs];

    if (filter.source) { whereClauses.push("sa.source LIKE ?"); params.push(`%${filter.source}%`); }
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
