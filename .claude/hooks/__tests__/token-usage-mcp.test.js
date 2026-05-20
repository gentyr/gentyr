/**
 * Tests for PR 4 — token-usage MCP query layer + /tokens slash command.
 *
 * Covers:
 *   - packages/mcp-servers/src/agent-tracker/token-usage-query.ts
 *     (queryTokenUsage, topTokenSessions, attributionHealth) via the built
 *     dist/ output. We seed a temp token-usage.db, point CLAUDE_PROJECT_DIR
 *     at the temp dir, and verify the SQL aggregates match expectations.
 *   - .claude/commands/tokens.md structure (frontmatter, examples, MCP
 *     tool references, formatters).
 *
 * Run: node --test .claude/hooks/__tests__/token-usage-mcp.test.js
 */

import { describe, it, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');
const QUERY_MODULE = path.join(ROOT, 'packages/mcp-servers/dist/agent-tracker/token-usage-query.js');

// ============================================================================
// Helpers: seed a minimal token-usage.db
// ============================================================================

function seedDb(dir) {
  const dbPath = path.join(dir, '.claude', 'state', 'token-usage.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_uuid TEXT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, message_uuid)
    );
    CREATE INDEX idx_usage_ts ON usage_events(ts);
    CREATE INDEX idx_usage_model ON usage_events(model);

    CREATE TABLE session_attribution (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      lane TEXT,
      agent_type TEXT,
      agent_id TEXT,
      queue_id TEXT,
      priority TEXT,
      category TEXT,
      task_id INTEGER,
      persistent_task_id INTEGER,
      plan_id TEXT,
      worktree_path TEXT,
      subprocess_tag TEXT,
      parent_session_id TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      ended_at INTEGER,
      attribution_status TEXT NOT NULL DEFAULT 'resolved',
      last_attempt_at INTEGER NOT NULL DEFAULT 0,
      work_category TEXT,
      spawn_origin TEXT,
      is_revival INTEGER NOT NULL DEFAULT 0,
      revived_by TEXT,
      revival_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE subprocess_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT NOT NULL,
      model TEXT,
      parent_session_id TEXT,
      child_session_id TEXT,
      pid INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER
    );
  `);

  const now = Date.now();
  const insertAttr = db.prepare(
    `INSERT INTO session_attribution
       (session_id, source, lane, agent_type, persistent_task_id, started_at, last_attempt_at, attribution_status,
        work_category, spawn_origin, is_revival, revived_by, revival_count, is_subagent, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO usage_events
       (session_id, message_uuid, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Session 1: hourly-automation:task_runner, Opus, 1M input / 100K output — original task-runner
  insertAttr.run('sess-1', 'hourly-automation:task_runner', 'automated', 'code-writer', null, now - 60_000, now, 'resolved',
    'task-runner', 'hourly-automation:task_runner', 0, null, 0, 0, null);
  insertEvent.run('sess-1', 'm1-1', now - 50_000, 'claude-opus-4-7', 1_000_000, 100_000, 0, 0, 15_000_000 + 7_500_000);

  // Session 2: interactive-cto, Sonnet, 500K input
  insertAttr.run('sess-2', 'interactive-cto', 'interactive', null, null, now - 90_000, now, 'resolved',
    'interactive-cto', 'interactive-cto', 0, null, 0, 0, null);
  insertEvent.run('sess-2', 'm2-1', now - 80_000, 'claude-sonnet-4-6', 500_000, 50_000, 0, 0, 1_500_000 + 750_000);

  // Session 3: subprocess:live-feed-daemon, Haiku, small
  insertAttr.run('sess-3', 'subprocess:live-feed-daemon', 'subprocess', null, null, now - 30_000, now, 'resolved',
    'subprocess-llm', 'subprocess:live-feed-daemon', 0, null, 0, 0, null);
  insertEvent.run('sess-3', 'm3-1', now - 20_000, 'claude-haiku-4-5', 10_000, 1_000, 0, 0, 8_000 + 4_000);

  // Session 4: pending attribution (should still aggregate under 'unknown' label)
  insertAttr.run('sess-4', 'unknown', null, null, null, now - 10_000, now - 1000, 'pending',
    'other', 'unknown', 0, null, 0, 0, null);
  insertEvent.run('sess-4', 'm4-1', now - 5_000, 'claude-haiku-4-5', 1_000, 100, 0, 0, 800 + 400);

  // Session 5: revived persistent-monitor — source is session-queue-reaper but
  // work_category is persistent-monitor (the kind of work) and spawn_origin
  // chases back to the original persistent-task-spawner.
  insertAttr.run('sess-5', 'session-queue-reaper', 'persistent', 'persistent-task-monitor', 42, now - 40_000, now, 'resolved',
    'persistent-monitor', 'persistent-task-spawner', 1, 'session-queue-reaper', 2, 0, null);

  // Compaction subagent of sess-1 (task-runner) — PR D roll-up should
  // attribute this cost back to task-runner instead of compaction-subagent.
  insertAttr.run('agent-acompact-cafef00d2', 'compaction-subagent', 'subagent', 'compaction',
    null, now - 25_000, now, 'resolved', 'compaction-subagent', 'compaction-subagent', 0, null, 0, 1, 'sess-1');
  insertEvent.run('agent-acompact-cafef00d2', 'mcompact-1', now - 22_000, 'claude-haiku-4-5', 200_000, 5_000, 0, 0, 200_000);
  insertEvent.run('sess-5', 'm5-1', now - 30_000, 'claude-opus-4-7', 800_000, 80_000, 0, 0, 12_000_000 + 6_000_000);

  // Untagged subprocess call (for attribution health)
  db.prepare(
    `INSERT INTO subprocess_calls (caller, model, started_at) VALUES ('untagged', 'haiku', ?)`
  ).run(now - 100_000);

  db.close();
  return dbPath;
}

// ============================================================================
// queryTokenUsage / topTokenSessions / attributionHealth
// ============================================================================

describe('token-usage-query (compiled MCP module)', () => {
  let tmpDir;
  let mod;

  before(async () => {
    // Verify the build is present
    assert.ok(fs.existsSync(QUERY_MODULE), `Build artifact missing: ${QUERY_MODULE} (run cd packages/mcp-servers && npm run build)`);
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-mcp-'));
    seedDb(tmpDir);
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    // Re-import for a fresh module-level DB_PATH binding
    mod = await import(`${QUERY_MODULE}?t=${Date.now()}`);
  });

  afterEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('groups by source with totals and pct_of_total', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'source', limit: 50 });
    assert.ok(result.total.tokens > 0, 'total tokens > 0');
    assert.ok(result.rows.length >= 3, `expected at least 3 source rows, got ${result.rows.length}`);

    const sources = result.rows.map(r => r.group_value);
    assert.ok(sources.includes('hourly-automation:task_runner'));
    assert.ok(sources.includes('interactive-cto'));
    assert.ok(sources.includes('subprocess:live-feed-daemon'));

    const sumPct = result.rows.reduce((acc, r) => acc + r.pct_of_total, 0);
    assert.ok(sumPct > 0.99 && sumPct < 1.01, `pct_of_total should sum to ~1, got ${sumPct}`);
  });

  it('rows are sorted by total_tokens desc', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'source', limit: 50 });
    for (let i = 1; i < result.rows.length; i++) {
      assert.ok(
        result.rows[i - 1].total_tokens >= result.rows[i].total_tokens,
        `row ${i - 1} (${result.rows[i - 1].total_tokens}) should >= row ${i} (${result.rows[i].total_tokens})`,
      );
    }
  });

  it('groups by lane', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'lane', limit: 50 });
    const lanes = result.rows.map(r => r.group_value);
    assert.ok(lanes.includes('automated'));
    assert.ok(lanes.includes('interactive'));
    assert.ok(lanes.includes('subprocess'));
  });

  it('groups by model', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'model', limit: 50 });
    const models = result.rows.map(r => r.group_value);
    assert.ok(models.includes('claude-opus-4-7'));
    assert.ok(models.includes('claude-sonnet-4-6'));
    assert.ok(models.includes('claude-haiku-4-5'));
  });

  it('filters by source substring', () => {
    const result = mod.queryTokenUsage({
      range: '24h',
      groupBy: 'source',
      filter: { source: 'hourly-automation' },
      limit: 50,
    });
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].group_value, 'hourly-automation:task_runner');
  });

  it('respects 1h range filtering', () => {
    // All seeded events are within last 90s, so 1h includes them all
    const r1 = mod.queryTokenUsage({ range: '1h', groupBy: 'source', limit: 50 });
    assert.ok(r1.total.tokens > 0);
  });

  it('returns empty when DB missing', async () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-empty-'));
    process.env.CLAUDE_PROJECT_DIR = tmp;
    try {
      const fresh = await import(`${QUERY_MODULE}?t=${Date.now()}-empty`);
      const result = fresh.queryTokenUsage({ range: '24h', groupBy: 'source', limit: 50 });
      assert.strictEqual(result.total.tokens, 0);
      assert.strictEqual(result.rows.length, 0);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('topTokenSessions returns hottest sessions ordered by tokens', () => {
    const result = mod.topTokenSessions('24h', 10);
    assert.ok(result.sessions.length >= 3);
    for (let i = 1; i < result.sessions.length; i++) {
      assert.ok(
        result.sessions[i - 1].total_tokens >= result.sessions[i].total_tokens,
      );
    }
    // First row should be sess-1 (the Opus session) with the highest count
    assert.strictEqual(result.sessions[0].session_id, 'sess-1');
    assert.ok(result.sessions[0].cost_usd > 0);
  });

  it('attributionHealth reports per-status counts and untagged subprocess count', () => {
    const health = mod.attributionHealth();
    assert.strictEqual(health.total, 6);
    assert.strictEqual(health.resolved, 5);
    assert.strictEqual(health.pending, 1);
    assert.strictEqual(health.untagged_subprocess_count, 1);
    assert.ok(health.db_exists);
    assert.ok(typeof health.pending_oldest_age_minutes === 'number');
  });

  // ==========================================================================
  // PR C — work_category / spawn_origin / revival_by groupings + revival summary
  // ==========================================================================

  it('groups by work_category (PR C default)', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'work_category', limit: 50 });
    const categories = result.rows.map(r => r.group_value);
    assert.ok(categories.includes('task-runner'), `expected task-runner in ${JSON.stringify(categories)}`);
    assert.ok(categories.includes('persistent-monitor'), `expected persistent-monitor (revived sess-5) in ${JSON.stringify(categories)}`);
    assert.ok(categories.includes('interactive-cto'));
    assert.ok(categories.includes('subprocess-llm'));
  });

  it('groups by spawn_origin — revived sess-5 attributes to the original spawner, not session-queue-reaper', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'spawn_origin', limit: 50 });
    const origins = result.rows.map(r => r.group_value);
    // sess-5 source is session-queue-reaper but spawn_origin is persistent-task-spawner.
    assert.ok(origins.includes('persistent-task-spawner'), `spawn_origin should chase to original — got ${JSON.stringify(origins)}`);
    assert.ok(!origins.includes('session-queue-reaper'), 'session-queue-reaper should NOT appear as a spawn_origin');
  });

  it('only_revivals filter restricts results to revived sessions', () => {
    const result = mod.queryTokenUsage({
      range: '24h', groupBy: 'work_category',
      filter: { only_revivals: true }, limit: 50,
    });
    // Only sess-5 is a revival; its work_category is persistent-monitor.
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].group_value, 'persistent-monitor');
  });

  it('only_originals filter excludes revived sessions', () => {
    const result = mod.queryTokenUsage({
      range: '24h', groupBy: 'work_category',
      filter: { only_originals: true }, limit: 50,
    });
    const categories = result.rows.map(r => r.group_value);
    assert.ok(!categories.includes('persistent-monitor'), 'persistent-monitor (revived only) should not appear with only_originals');
    assert.ok(categories.includes('task-runner'));
  });

  it('filter by work_category restricts to that category', () => {
    const result = mod.queryTokenUsage({
      range: '24h', groupBy: 'agent_type',
      filter: { work_category: 'persistent-monitor' }, limit: 50,
    });
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].group_value, 'persistent-task-monitor');
  });

  it('revivalCostSummary separates revived vs original spend and breaks down by revived_by', () => {
    const summary = mod.revivalCostSummary({ range: '24h' });
    // sess-5 is the only revival in seed (Opus, 880K tokens, ~$18 cost_micro)
    assert.ok(summary.totals.revival_tokens > 0, 'revival_tokens > 0');
    assert.ok(summary.totals.original_tokens > summary.totals.revival_tokens,
      `originals (${summary.totals.original_tokens}) should exceed revivals (${summary.totals.revival_tokens})`);
    assert.strictEqual(summary.totals.revival_sessions, 1);
    assert.ok(summary.totals.revival_pct_of_total > 0 && summary.totals.revival_pct_of_total < 1);

    // by_revived_by breakdown: session-queue-reaper accounts for the only revival
    assert.strictEqual(summary.by_revived_by.length, 1);
    assert.strictEqual(summary.by_revived_by[0].revived_by, 'session-queue-reaper');
    assert.strictEqual(summary.by_revived_by[0].sessions, 1);
    assert.ok(summary.by_revived_by[0].cost_usd > 0);
  });

  it('revivalCostSummary returns empty totals when DB missing', async () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-rcs-empty-'));
    process.env.CLAUDE_PROJECT_DIR = tmp;
    try {
      const fresh = await import(`${QUERY_MODULE}?t=${Date.now()}-rcs-empty`);
      const result = fresh.revivalCostSummary({ range: '24h' });
      assert.strictEqual(result.totals.revival_tokens, 0);
      assert.strictEqual(result.by_revived_by.length, 0);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('WORK_CATEGORY_DESCRIPTIONS includes every category produced by the live data', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'work_category', limit: 50 });
    for (const row of result.rows) {
      assert.ok(
        mod.WORK_CATEGORY_DESCRIPTIONS[row.group_value],
        `missing description for category in seed data: ${row.group_value}`,
      );
    }
  });

  // ==========================================================================
  // PR D — compaction roll-up
  // ==========================================================================

  it('without roll_up_compaction, compaction subagents appear as their own category', () => {
    const result = mod.queryTokenUsage({ range: '24h', groupBy: 'work_category', limit: 50 });
    const categories = result.rows.map(r => r.group_value);
    assert.ok(categories.includes('compaction-subagent'),
      `expected compaction-subagent in default view, got ${JSON.stringify(categories)}`);
    const compactionRow = result.rows.find(r => r.group_value === 'compaction-subagent');
    assert.strictEqual(compactionRow.sessions, 1);
    assert.strictEqual(compactionRow.total_tokens, 205_000);
  });

  it('roll_up_compaction=true attributes compaction cost to parent work_category', () => {
    const baseline = mod.queryTokenUsage({ range: '24h', groupBy: 'work_category', limit: 50 });
    const taskRunnerBaseline = baseline.rows.find(r => r.group_value === 'task-runner');
    assert.ok(taskRunnerBaseline, 'task-runner row should exist in baseline');

    const rolled = mod.queryTokenUsage({
      range: '24h', groupBy: 'work_category', limit: 50, rollUpCompaction: true,
    });
    const categories = rolled.rows.map(r => r.group_value);
    assert.ok(!categories.includes('compaction-subagent'),
      `compaction-subagent should be rolled away, got ${JSON.stringify(categories)}`);

    // task-runner should now include the 205K compaction tokens too.
    const taskRunnerRolled = rolled.rows.find(r => r.group_value === 'task-runner');
    assert.strictEqual(
      taskRunnerRolled.total_tokens,
      taskRunnerBaseline.total_tokens + 205_000,
      'task-runner total should include compaction cost after roll-up',
    );
  });

  it('roll_up_compaction is silently ignored when group_by is not work_category', () => {
    // When grouping by source, the rollup should not apply — compaction-subagent
    // still appears as its own source.
    const result = mod.queryTokenUsage({
      range: '24h', groupBy: 'source', limit: 50, rollUpCompaction: true,
    });
    const sources = result.rows.map(r => r.group_value);
    assert.ok(sources.includes('compaction-subagent'),
      'compaction-subagent should remain visible when group_by=source even with rollUpCompaction=true');
  });

  it('roll_up_compaction preserves the total token count', () => {
    const without = mod.queryTokenUsage({ range: '24h', groupBy: 'work_category', limit: 50 });
    const withRollup = mod.queryTokenUsage({
      range: '24h', groupBy: 'work_category', limit: 50, rollUpCompaction: true,
    });
    // The grand totals should be identical — rollup only relabels rows, not the sum.
    assert.strictEqual(withRollup.total.tokens, without.total.tokens);
    assert.strictEqual(withRollup.total.cost_usd, without.total.cost_usd);
  });
});

// ============================================================================
// /tokens slash command structure
// ============================================================================

describe('/tokens slash command', () => {
  const cmdPath = path.join(ROOT, '.claude/commands/tokens.md');
  const content = fs.readFileSync(cmdPath, 'utf8');

  it('has the HOOK:GENTYR frontmatter marker', () => {
    assert.ok(/^<!-- HOOK:GENTYR:tokens -->/.test(content));
  });

  it('references the three MCP tools', () => {
    assert.ok(content.includes('mcp__agent-tracker__query_token_usage'));
    assert.ok(content.includes('mcp__agent-tracker__top_token_sessions'));
    assert.ok(content.includes('mcp__agent-tracker__token_attribution_health'));
  });

  it('documents argument grammar with default range and group_by', () => {
    assert.ok(/range.*24h/.test(content));
    assert.ok(/by.*source/.test(content));
  });

  it('documents horizontal bar chart rendering with unicode blocks', () => {
    assert.ok(content.includes('█'), 'should mention filled block character');
    assert.ok(content.includes('░'), 'should mention empty block character');
    assert.ok(/bar width/i.test(content), 'should explain bar width formula');
  });

  it('documents formatters', () => {
    assert.ok(/formatTokens/.test(content));
    assert.ok(/formatCost/.test(content));
  });
});
