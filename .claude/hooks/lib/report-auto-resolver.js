/**
 * Report Auto-Resolver
 *
 * Auto-resolves pending CTO reports when PRs merge (by matching PR diffs
 * against report descriptions) and deduplicates accumulated reports.
 *
 * Runs from hourly-automation.js on a 2-minute cooldown.
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { callLLMStructured } from './llm-client.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');

// Lazy-load better-sqlite3 (same pattern as plan-merge-tracker.js)
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal: module will return null from all exports
}

// ============================================================================
// JSON Schemas for LLM
// ============================================================================

const RESOLVE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    resolved_reports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          report_id: { type: 'string', description: 'UUID of the report this PR resolves' },
          reason: { type: 'string', description: 'Brief explanation of how the PR fixes this issue' },
        },
        required: ['report_id', 'reason'],
      },
    },
    duplicate_groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keep_id: { type: 'string', description: 'UUID of the most informative report to keep' },
          duplicate_ids: { type: 'array', items: { type: 'string' }, description: 'UUIDs of duplicate reports to dismiss' },
          reason: { type: 'string', description: 'Why these reports are duplicates' },
        },
        required: ['keep_id', 'duplicate_ids', 'reason'],
      },
    },
  },
  required: ['resolved_reports', 'duplicate_groups'],
});

const DEDUP_ONLY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    duplicate_groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keep_id: { type: 'string', description: 'UUID of the most informative report to keep' },
          duplicate_ids: { type: 'array', items: { type: 'string' }, description: 'UUIDs of duplicate reports to dismiss' },
          reason: { type: 'string', description: 'Why these reports are duplicates' },
        },
        required: ['keep_id', 'duplicate_ids', 'reason'],
      },
    },
  },
  required: ['duplicate_groups'],
});

// ============================================================================
// System Prompts
// ============================================================================

const RESOLVE_SYSTEM_PROMPT = `You are a report triage assistant. You will be given:
1. A list of pending CTO reports (id, title, summary, category, priority).
2. A recently merged PR with its title, branch name, and diff.

Your job:
- Identify which pending reports (if any) are CLEARLY resolved by this PR.
- Be CONSERVATIVE: only mark a report resolved if the diff clearly and directly fixes the specific issue described in the report. When in doubt, leave it pending.
- Also identify any DUPLICATE reports in the pending list (same underlying issue reported multiple times). Keep the most informative one.

Return empty arrays if nothing matches. Do NOT hallucinate report IDs.`;

const DEDUP_SYSTEM_PROMPT = `You are a report deduplication assistant. You will be given a list of pending CTO reports (id, title, summary, category, priority).

Your job:
- Identify groups of reports that describe the SAME underlying issue.
- For each group, pick the most informative report to keep and list the others as duplicates.
- Be CONSERVATIVE: only group reports that are clearly about the same specific issue. Similar topics are NOT duplicates.

Return an empty array if no duplicates exist. Do NOT hallucinate report IDs.`;

// ============================================================================
// Database Helpers
// ============================================================================

/**
 * Get all pending (untriaged) reports, up to 20.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id: string, title: string, summary: string, category: string, priority: string, reporting_agent: string, created_at: string}>}
 */
function getPendingReports(db) {
  return db.prepare(
    `SELECT id, title, summary, category, priority, reporting_agent, created_at
     FROM reports
     WHERE triage_status = 'pending' AND triaged_at IS NULL
     ORDER BY created_timestamp DESC
     LIMIT 20`
  ).all();
}

// ============================================================================
// Git/GitHub Helpers
// ============================================================================

/**
 * Detect the base branch (preview if it exists, else main).
 * @param {Function} log
 * @returns {string}
 */
function detectBaseBranch(log) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
      cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe',
    });
    return 'preview';
  } catch {
    return 'main';
  }
}

/**
 * Get recently merged PRs since a given timestamp.
 * @param {string} baseBranch
 * @param {number} sinceTimestamp - epoch ms; 0 means fetch recent PRs regardless
 * @param {Function} log
 * @returns {Array<{number: number, title: string, mergedAt: string, headRefName: string}>}
 */
function getRecentlyMergedPRs(baseBranch, sinceTimestamp, log) {
  try {
    const raw = execFileSync(
      'gh', ['pr', 'list', '--state', 'merged', '--json', 'number,title,mergedAt,headRefName', '--limit', '10', '--base', baseBranch],
      { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }
    ).trim();
    const prs = JSON.parse(raw || '[]');

    // Filter to only PRs merged after sinceTimestamp
    if (sinceTimestamp > 0) {
      return prs.filter(pr => new Date(pr.mergedAt).getTime() > sinceTimestamp);
    }
    return prs;
  } catch (err) {
    log(`Report auto-resolve: failed to list merged PRs: ${err.message}`);
    return [];
  }
}

/**
 * Get the diff for a specific PR, truncated to 8000 chars.
 * @param {number} prNumber
 * @param {Function} log
 * @returns {string|null}
 */
function getPRDiff(prNumber, log) {
  try {
    const diff = execFileSync(
      'gh', ['pr', 'diff', String(prNumber), '--patch'],
      { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe', timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    // Truncate to 8000 chars to fit in LLM context
    return diff.slice(0, 8000);
  } catch (err) {
    log(`Report auto-resolve: failed to get diff for PR #${prNumber}: ${err.message}`);
    return null;
  }
}

// ============================================================================
// LLM Resolution
// ============================================================================

/**
 * Build a report list string for the LLM prompt.
 * @param {Array<{id: string, title: string, summary: string, category: string, priority: string}>} reports
 * @returns {string}
 */
function formatReportsForPrompt(reports) {
  return reports.map(r =>
    `- ID: ${r.id}\n  Title: ${r.title}\n  Category: ${r.category} | Priority: ${r.priority}\n  Summary: ${(r.summary || '').slice(0, 500)}`
  ).join('\n\n');
}

/**
 * Resolve reports against a single merged PR.
 * Also performs opportunistic dedup on the same LLM call.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{number: number, title: string, mergedAt: string, headRefName: string}} pr
 * @param {Array<{id: string, title: string, summary: string, category: string, priority: string}>} pendingReports
 * @param {Function} log
 * @returns {Promise<{resolved: number, deduped: number}>}
 */
async function resolveByPR(db, pr, pendingReports, log) {
  const diff = getPRDiff(pr.number, log);
  if (!diff) return { resolved: 0, deduped: 0 };

  const reportList = formatReportsForPrompt(pendingReports);
  const pendingIds = new Set(pendingReports.map(r => r.id));

  const prompt = `## Pending Reports\n\n${reportList}\n\n## Merged PR #${pr.number}\n\nTitle: ${pr.title}\nBranch: ${pr.headRefName}\nMerged: ${pr.mergedAt}\n\n### Diff (truncated)\n\n${diff}`;

  const result = await callLLMStructured(prompt, RESOLVE_SYSTEM_PROMPT, RESOLVE_SCHEMA);
  if (!result) {
    log(`Report auto-resolve: LLM call failed for PR #${pr.number}`);
    return { resolved: 0, deduped: 0 };
  }

  const now = new Date().toISOString();
  let resolved = 0;
  let deduped = 0;

  const updateStmt = db.prepare(
    `UPDATE reports
     SET triage_status = ?,
         triage_completed_at = ?,
         triage_outcome = ?,
         triaged_at = ?,
         triage_action = 'auto-acknowledged',
         acknowledged_at = COALESCE(acknowledged_at, ?),
         read_at = COALESCE(read_at, ?)
     WHERE id = ? AND triage_status = 'pending'`
  );

  const applyUpdates = db.transaction(() => {
    // Apply resolved reports
    if (Array.isArray(result.resolved_reports)) {
      for (const item of result.resolved_reports) {
        if (!item.report_id || !pendingIds.has(item.report_id)) {
          log(`Report auto-resolve: skipping hallucinated ID ${item.report_id}`);
          continue;
        }
        const changes = updateStmt.run(
          'self_handled',
          now,
          `Auto-resolved by PR #${pr.number}: ${item.reason}`,
          now, now, now,
          item.report_id
        );
        if (changes.changes > 0) {
          resolved++;
          pendingIds.delete(item.report_id);
          log(`Report auto-resolve: resolved ${item.report_id} via PR #${pr.number}`);
        }
      }
    }

    // Apply dedup
    if (Array.isArray(result.duplicate_groups)) {
      for (const group of result.duplicate_groups) {
        if (!group.keep_id || !pendingIds.has(group.keep_id)) continue;
        if (!Array.isArray(group.duplicate_ids)) continue;

        for (const dupId of group.duplicate_ids) {
          if (!pendingIds.has(dupId)) {
            log(`Report auto-resolve: skipping hallucinated dedup ID ${dupId}`);
            continue;
          }
          if (dupId === group.keep_id) continue; // safety: don't dismiss the keeper

          const changes = updateStmt.run(
            'dismissed',
            now,
            `Duplicate of report ${group.keep_id}: ${group.reason}`,
            now, now, now,
            dupId
          );
          if (changes.changes > 0) {
            deduped++;
            pendingIds.delete(dupId);
            log(`Report auto-resolve: deduped ${dupId} (duplicate of ${group.keep_id})`);
          }
        }
      }
    }
  });

  applyUpdates();

  return { resolved, deduped };
}

/**
 * Standalone dedup pass (no PR context).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id: string, title: string, summary: string, category: string, priority: string}>} pendingReports
 * @param {Function} log
 * @returns {Promise<{deduped: number}>}
 */
async function dedupOnly(db, pendingReports, log) {
  if (pendingReports.length < 3) {
    // Not worth deduping fewer than 3 reports
    return { deduped: 0 };
  }

  const reportList = formatReportsForPrompt(pendingReports);
  const pendingIds = new Set(pendingReports.map(r => r.id));

  const prompt = `## Pending Reports\n\n${reportList}\n\nIdentify any duplicate groups among these reports.`;

  const result = await callLLMStructured(prompt, DEDUP_SYSTEM_PROMPT, DEDUP_ONLY_SCHEMA);
  if (!result) {
    log('Report dedup: LLM call failed');
    return { deduped: 0 };
  }

  const now = new Date().toISOString();
  let deduped = 0;

  const updateStmt = db.prepare(
    `UPDATE reports
     SET triage_status = ?,
         triage_completed_at = ?,
         triage_outcome = ?,
         triaged_at = ?,
         triage_action = 'auto-acknowledged',
         acknowledged_at = COALESCE(acknowledged_at, ?),
         read_at = COALESCE(read_at, ?)
     WHERE id = ? AND triage_status = 'pending'`
  );

  const applyUpdates = db.transaction(() => {
    if (!Array.isArray(result.duplicate_groups)) return;

    for (const group of result.duplicate_groups) {
      if (!group.keep_id || !pendingIds.has(group.keep_id)) continue;
      if (!Array.isArray(group.duplicate_ids)) continue;

      for (const dupId of group.duplicate_ids) {
        if (!pendingIds.has(dupId)) {
          log(`Report dedup: skipping hallucinated ID ${dupId}`);
          continue;
        }
        if (dupId === group.keep_id) continue;

        const changes = updateStmt.run(
          'dismissed',
          now,
          `Duplicate of report ${group.keep_id}: ${group.reason}`,
          now, now, now,
          dupId
        );
        if (changes.changes > 0) {
          deduped++;
          pendingIds.delete(dupId);
          log(`Report dedup: dismissed ${dupId} (duplicate of ${group.keep_id})`);
        }
      }
    }
  });

  applyUpdates();

  return { deduped };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run the full auto-resolve cycle: check recently merged PRs against pending reports,
 * resolve matches, and opportunistically dedup.
 *
 * @param {Function} log - Logging function
 * @param {number} lastMergedPRTimestamp - Epoch ms of the last processed PR merge time
 * @returns {Promise<{processedPRs: number, resolved: number, deduped: number, latestMergedAt: number}|null>}
 */
export async function runReportAutoResolve(log, lastMergedPRTimestamp) {
  if (!Database || !fs.existsSync(DB_PATH)) {
    return null;
  }

  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    log(`Report auto-resolve: failed to open DB: ${err.message}`);
    return null;
  }

  try {
    const pendingReports = getPendingReports(db);
    if (pendingReports.length === 0) {
      db.close();
      return null;
    }

    const baseBranch = detectBaseBranch(log);
    const mergedPRs = getRecentlyMergedPRs(baseBranch, lastMergedPRTimestamp, log);

    if (mergedPRs.length === 0) {
      db.close();
      return null;
    }

    let totalResolved = 0;
    let totalDeduped = 0;
    let latestMergedAt = lastMergedPRTimestamp;

    for (const pr of mergedPRs) {
      const mergedAtMs = new Date(pr.mergedAt).getTime();
      if (mergedAtMs > latestMergedAt) {
        latestMergedAt = mergedAtMs;
      }

      // Re-fetch pending reports after each PR (some may have been resolved)
      const currentPending = getPendingReports(db);
      if (currentPending.length === 0) break;

      const { resolved, deduped } = await resolveByPR(db, pr, currentPending, log);
      totalResolved += resolved;
      totalDeduped += deduped;
    }

    db.close();
    return {
      processedPRs: mergedPRs.length,
      resolved: totalResolved,
      deduped: totalDeduped,
      latestMergedAt,
    };
  } catch (err) {
    log(`Report auto-resolve: unexpected error: ${err.message}`);
    try { db.close(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Run a standalone dedup pass (no PR context needed).
 *
 * @param {Function} log - Logging function
 * @returns {Promise<{deduped: number}|null>}
 */
export async function runReportDedup(log) {
  if (!Database || !fs.existsSync(DB_PATH)) {
    return null;
  }

  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    log(`Report dedup: failed to open DB: ${err.message}`);
    return null;
  }

  try {
    const pendingReports = getPendingReports(db);
    if (pendingReports.length < 3) {
      db.close();
      return null;
    }

    const result = await dedupOnly(db, pendingReports, log);
    db.close();
    return result;
  } catch (err) {
    log(`Report dedup: unexpected error: ${err.message}`);
    try { db.close(); } catch { /* ignore */ }
    return null;
  }
}
