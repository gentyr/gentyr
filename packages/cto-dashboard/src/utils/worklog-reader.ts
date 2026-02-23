/**
 * Worklog reader — reads worklog entries from .claude/worklog.db
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';

export interface WorklogEntryData {
  id: string;
  task_id: string;
  section: string;
  title: string;
  summary: string;
  success: boolean;
  timestamp_completed: string;
  duration_assign_to_start_ms: number | null;
  duration_start_to_complete_ms: number | null;
  duration_assign_to_complete_ms: number | null;
  tokens_total: number | null;
  created_at: string;
}

export interface WorklogMetricsData {
  coverage_entries: number;
  coverage_completed_tasks: number;
  coverage_pct: number;
  success_rate_pct: number | null;
  avg_time_to_start_ms: number | null;
  avg_time_to_complete_from_start_ms: number | null;
  avg_time_to_complete_from_assign_ms: number | null;
  avg_tokens_per_task: number | null;
  cache_hit_pct: number | null;
}

export interface WorklogData {
  hasData: boolean;
  entries: WorklogEntryData[];
  metrics: WorklogMetricsData | null;
}

const EMPTY: WorklogData = {
  hasData: false,
  entries: [],
  metrics: null,
};

export function getWorklogData(limit = 10): WorklogData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'worklog.db');

  if (!fs.existsSync(dbPath)) {
    return EMPTY;
  }

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return EMPTY;
  }

  try {
    // Read recent entries
    interface WorklogRow {
      id: string;
      task_id: string;
      section: string;
      title: string;
      summary: string;
      success: number;
      timestamp_completed: string;
      duration_assign_to_start_ms: number | null;
      duration_start_to_complete_ms: number | null;
      duration_assign_to_complete_ms: number | null;
      tokens_total: number | null;
      created_at: string;
    }

    const rows = db.prepare(
      'SELECT id, task_id, section, title, summary, success, timestamp_completed, duration_assign_to_start_ms, duration_start_to_complete_ms, duration_assign_to_complete_ms, tokens_total, created_at FROM worklog_entries ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as WorklogRow[];

    if (rows.length === 0) {
      db.close();
      return EMPTY;
    }

    const entries: WorklogEntryData[] = rows.map(row => ({
      ...row,
      success: row.success === 1,
    }));

    // 30-day rolling metrics
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    interface MetricRow {
      total_entries: number;
      successful_entries: number;
      avg_assign_to_start: number | null;
      avg_start_to_complete: number | null;
      avg_assign_to_complete: number | null;
      avg_tokens: number | null;
      sum_cache_read: number | null;
      sum_input: number | null;
    }

    const metricRow = db.prepare(`
      SELECT
        COUNT(*) as total_entries,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_entries,
        AVG(duration_assign_to_start_ms) as avg_assign_to_start,
        AVG(duration_start_to_complete_ms) as avg_start_to_complete,
        AVG(duration_assign_to_complete_ms) as avg_assign_to_complete,
        AVG(tokens_total) as avg_tokens,
        SUM(tokens_cache_read) as sum_cache_read,
        SUM(tokens_input) as sum_input
      FROM worklog_entries
      WHERE created_at >= ?
    `).get(thirtyDaysAgo) as MetricRow;

    // Coverage: count completed tasks from todo.db for comparison
    let completedCount = 0;
    try {
      const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
      if (fs.existsSync(todoDbPath)) {
        const todoDb = openReadonlyDb(todoDbPath);
        const thirtyDaysAgoTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
        const countResult = todoDb.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_timestamp >= ?"
        ).get(thirtyDaysAgoTimestamp) as { count: number };
        completedCount = countResult.count;
        todoDb.close();
      }
    } catch {
      // Non-fatal
    }

    const cacheHitPct = metricRow.sum_input && metricRow.sum_cache_read
      ? Math.round((metricRow.sum_cache_read / (metricRow.sum_input + metricRow.sum_cache_read)) * 1000) / 10
      : null;

    // Success rate: successful worklog entries / total worklog entries
    const successRatePct = metricRow.total_entries > 0
      ? Math.round(((metricRow.successful_entries ?? 0) / metricRow.total_entries) * 1000) / 10
      : null;

    const metrics: WorklogMetricsData = {
      coverage_entries: metricRow.total_entries,
      coverage_completed_tasks: completedCount,
      coverage_pct: completedCount > 0 ? Math.min(100, Math.round((metricRow.total_entries / completedCount) * 1000) / 10) : 0,
      success_rate_pct: successRatePct,
      avg_time_to_start_ms: metricRow.avg_assign_to_start ? Math.round(metricRow.avg_assign_to_start) : null,
      avg_time_to_complete_from_start_ms: metricRow.avg_start_to_complete ? Math.round(metricRow.avg_start_to_complete) : null,
      avg_time_to_complete_from_assign_ms: metricRow.avg_assign_to_complete ? Math.round(metricRow.avg_assign_to_complete) : null,
      avg_tokens_per_task: metricRow.avg_tokens ? Math.round(metricRow.avg_tokens) : null,
      cache_hit_pct: cacheHitPct,
    };

    db.close();
    return { hasData: true, entries, metrics };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return EMPTY;
  }
}
