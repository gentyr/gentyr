/**
 * Tests for the token usage collector foundation (PR 1).
 *
 * Covers:
 *   - lib/token-pricing.js              — cost computation, formatting
 *   - lib/jsonl-usage-parser.js         — incremental JSONL scan, marker detection
 *   - scripts/token-usage-collector.js  — DB schema, attribution, rollup, scan cycle
 *
 * Uses Node's built-in test runner. Run with:
 *   node --test .claude/hooks/__tests__/token-usage-collector.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import {
  computeCostMicroUsd,
  formatCost,
  microToDollars,
  PRICING_MICRO_USD_PER_MTOK,
  _resetMissingModelCache,
} from '../lib/token-pricing.js';

import {
  encodeProjectPath,
  parseUsageEventsIncremental,
  findAgentMarker,
  findUsageTagInJsonl,
  isSpawnedSession,
  listSessionFiles,
  readSubagentMeta,
} from '../lib/jsonl-usage-parser.js';

import {
  openDb,
  resolveAttribution,
  rebuildDailyRollup,
  runScanCycle,
} from '../../../scripts/token-usage-collector.js';

// ============================================================================
// Pricing
// ============================================================================

describe('lib/token-pricing.js', () => {
  beforeEach(() => _resetMissingModelCache());

  it('computes Opus cost correctly', () => {
    const cost = computeCostMicroUsd('claude-opus-4-7', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    // 1M input @ $15/Mtok = 15_000_000 micro-USD
    assert.strictEqual(cost, 15_000_000);
  });

  it('computes Sonnet cost across all four token types', () => {
    const cost = computeCostMicroUsd('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
    });
    // 3M input + 15M output + 3.75M cache_write + 0.3M cache_read
    assert.strictEqual(cost, 3_000_000 + 15_000_000 + 3_750_000 + 300_000);
  });

  it('returns 0 for unknown model and warns once', () => {
    const warnings = [];
    const cost1 = computeCostMicroUsd('claude-unknown', {
      input_tokens: 1000, output_tokens: 1000, cache_creation_tokens: 0, cache_read_tokens: 0,
    }, (msg) => warnings.push(msg));
    const cost2 = computeCostMicroUsd('claude-unknown', {
      input_tokens: 1000, output_tokens: 1000, cache_creation_tokens: 0, cache_read_tokens: 0,
    }, (msg) => warnings.push(msg));
    assert.strictEqual(cost1, 0);
    assert.strictEqual(cost2, 0);
    assert.strictEqual(warnings.length, 1, 'warning should fire exactly once');
  });

  it('handles missing usage fields as zero', () => {
    const cost = computeCostMicroUsd('claude-haiku-4-5', {});
    assert.strictEqual(cost, 0);
  });

  it('formatCost renders dollar amounts', () => {
    assert.strictEqual(formatCost(0), '$0.00');
    assert.strictEqual(formatCost(12_345_678), '$12.35');
    assert.strictEqual(formatCost(1_234), '$0.0012');
    assert.strictEqual(formatCost(50), '$0.000050');
  });

  it('microToDollars converts to float', () => {
    assert.strictEqual(microToDollars(1_000_000), 1);
    assert.strictEqual(microToDollars(500_000), 0.5);
  });

  it('pricing table includes all current production models', () => {
    assert.ok(PRICING_MICRO_USD_PER_MTOK['claude-opus-4-7']);
    assert.ok(PRICING_MICRO_USD_PER_MTOK['claude-sonnet-4-6']);
    assert.ok(PRICING_MICRO_USD_PER_MTOK['claude-haiku-4-5']);
  });
});

// ============================================================================
// JSONL parser
// ============================================================================

describe('lib/jsonl-usage-parser.js', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-parser-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('encodeProjectPath replaces non-alphanumeric chars with dashes', () => {
    assert.strictEqual(encodeProjectPath('/Users/jonathantodd/git/gentyr'), '-Users-jonathantodd-git-gentyr');
    assert.strictEqual(encodeProjectPath('/home/user/project.foo'), '-home-user-project-foo');
  });

  it('parses an assistant message with usage', () => {
    const filePath = path.join(tmpDir, 'session.jsonl');
    const msg = JSON.stringify({
      type: 'assistant',
      uuid: 'msg-1',
      timestamp: '2026-05-19T10:00:00Z',
      message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 200,
        },
      },
    });
    fs.writeFileSync(filePath, msg + '\n');

    const { events, newOffset } = parseUsageEventsIncremental(filePath, 0);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].messageUuid, 'msg-1');
    assert.strictEqual(events[0].model, 'claude-opus-4-7');
    assert.strictEqual(events[0].input_tokens, 100);
    assert.strictEqual(events[0].output_tokens, 50);
    assert.strictEqual(events[0].cache_creation_tokens, 20);
    assert.strictEqual(events[0].cache_read_tokens, 200);
    assert.strictEqual(newOffset, msg.length + 1);
  });

  it('skips non-assistant entries and entries without usage', () => {
    const filePath = path.join(tmpDir, 'mixed.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-7' } }), // no usage
      JSON.stringify({ type: 'assistant', uuid: 'u', message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const { events } = parseUsageEventsIncremental(filePath, 0);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].messageUuid, 'u');
  });

  it('resumes from byte offset on second scan', () => {
    const filePath = path.join(tmpDir, 'resume.jsonl');
    const line1 = JSON.stringify({ type: 'assistant', uuid: 'a', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } });
    const line2 = JSON.stringify({ type: 'assistant', uuid: 'b', message: { model: 'm', usage: { input_tokens: 2, output_tokens: 2 } } });
    fs.writeFileSync(filePath, line1 + '\n');
    const r1 = parseUsageEventsIncremental(filePath, 0);
    assert.strictEqual(r1.events.length, 1);
    assert.strictEqual(r1.events[0].messageUuid, 'a');

    fs.appendFileSync(filePath, line2 + '\n');
    const r2 = parseUsageEventsIncremental(filePath, r1.newOffset);
    assert.strictEqual(r2.events.length, 1);
    assert.strictEqual(r2.events[0].messageUuid, 'b');
  });

  it('does not consume a partial trailing line', () => {
    const filePath = path.join(tmpDir, 'partial.jsonl');
    const completeLine = JSON.stringify({ type: 'assistant', uuid: 'a', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } });
    fs.writeFileSync(filePath, completeLine + '\n' + '{"type":"assistant","uuid":"b"'); // partial
    const r = parseUsageEventsIncremental(filePath, 0);
    assert.strictEqual(r.events.length, 1);
    // Offset stops after the first newline
    assert.strictEqual(r.newOffset, completeLine.length + 1);
  });

  it('findAgentMarker detects [AGENT:agent-xxx]', () => {
    const filePath = path.join(tmpDir, 'marked.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[Automation][Task][AGENT:agent-abc123] do work' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'm' } }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    assert.strictEqual(findAgentMarker(filePath), 'agent-abc123');
  });

  it('findAgentMarker returns null when no marker present', () => {
    const filePath = path.join(tmpDir, 'unmarked.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    assert.strictEqual(findAgentMarker(filePath), null);
  });

  it('findUsageTagInJsonl extracts CLAUDE_USAGE_TAG and CLAUDE_USAGE_PARENT', () => {
    const filePath = path.join(tmpDir, 'tagged.jsonl');
    const dump = JSON.stringify({
      type: 'system',
      message: { content: 'env: CLAUDE_USAGE_TAG="live-feed-daemon" CLAUDE_USAGE_PARENT="abc-def"' },
    });
    fs.writeFileSync(filePath, dump + '\n');
    const result = findUsageTagInJsonl(filePath);
    assert.strictEqual(result.tag, 'live-feed-daemon');
    assert.strictEqual(result.parentSessionId, 'abc-def');
  });

  it('isSpawnedSession detects CLAUDE_SPAWNED_SESSION=true', () => {
    const filePath = path.join(tmpDir, 'spawned.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'system', message: { content: 'CLAUDE_SPAWNED_SESSION=true' } }) + '\n');
    assert.strictEqual(isSpawnedSession(filePath), true);

    const filePath2 = path.join(tmpDir, 'interactive.jsonl');
    fs.writeFileSync(filePath2, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
    assert.strictEqual(isSpawnedSession(filePath2), false);
  });

  it('listSessionFiles discovers top-level and sub-agent JSONLs', () => {
    fs.mkdirSync(path.join(tmpDir, 'sess-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sess-1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tmpDir, 'sess-2.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tmpDir, 'sess-1', 'subagents', 'sub-a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tmpDir, 'sess-1', 'subagents', 'sub-a.meta.json'), '{}');

    const files = listSessionFiles(tmpDir);
    const top = files.filter(f => !f.isSubagent).map(f => f.sessionId).sort();
    const sub = files.filter(f => f.isSubagent);
    assert.deepStrictEqual(top, ['sess-1', 'sess-2']);
    assert.strictEqual(sub.length, 1);
    assert.strictEqual(sub[0].sessionId, 'sub-a');
    assert.strictEqual(sub[0].parentSessionId, 'sess-1');
  });

  it('readSubagentMeta returns null when meta.json is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'lone.jsonl'), '{}\n');
    const meta = readSubagentMeta(path.join(tmpDir, 'lone.jsonl'));
    assert.strictEqual(meta, null);
  });

  it('readSubagentMeta reads agent_type from sibling .meta.json', () => {
    fs.writeFileSync(path.join(tmpDir, 's.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tmpDir, 's.meta.json'), JSON.stringify({ agent_id: 'agent-x', agent_type: 'code-writer' }));
    const meta = readSubagentMeta(path.join(tmpDir, 's.jsonl'));
    assert.strictEqual(meta.agent_type, 'code-writer');
    assert.strictEqual(meta.agent_id, 'agent-x');
  });
});

// ============================================================================
// Collector — DB & attribution
// ============================================================================

describe('scripts/token-usage-collector.js', () => {
  let tmpDir;
  let dbPath;
  let sessionDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-collector-'));
    dbPath = path.join(tmpDir, 'token-usage.db');
    sessionDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('openDb creates the expected tables and indexes', () => {
    const db = openDb(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    db.close();
    for (const expected of ['usage_events', 'session_attribution', 'subprocess_calls', 'scan_offsets', 'daily_rollup']) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
  });

  it('resolveAttribution flags sub-agent sessions with parent', () => {
    const db = openDb(dbPath);
    const jsonl = path.join(tmpDir, 'sub.jsonl');
    fs.writeFileSync(jsonl, '{}\n');
    fs.writeFileSync(jsonl.replace('.jsonl', '.meta.json'), JSON.stringify({ agent_id: 'agent-x', agent_type: 'code-writer' }));

    const attr = resolveAttribution({
      sessionId: 'sub-1',
      jsonlPath: jsonl,
      isSubagent: true,
      parentSessionId: 'parent-1',
      tokenDb: db,
    });
    db.close();
    assert.strictEqual(attr.is_subagent, 1);
    assert.strictEqual(attr.source, 'subagent:code-writer');
    assert.strictEqual(attr.parent_session_id, 'parent-1');
    assert.strictEqual(attr.attribution_status, 'resolved');
  });

  it('resolveAttribution returns interactive-cto for non-spawned sessions without marker', () => {
    const db = openDb(dbPath);
    const jsonl = path.join(tmpDir, 'cto.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'user', message: { content: 'hello CTO' } }) + '\n');

    const attr = resolveAttribution({
      sessionId: 'cto-1',
      jsonlPath: jsonl,
      isSubagent: false,
      parentSessionId: null,
      tokenDb: db,
    });
    db.close();
    assert.strictEqual(attr.source, 'interactive-cto');
    assert.strictEqual(attr.lane, 'interactive');
    assert.strictEqual(attr.attribution_status, 'resolved');
  });

  it('resolveAttribution returns pending for spawned session without queue match', () => {
    const db = openDb(dbPath);
    const jsonl = path.join(tmpDir, 'spawned.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'system', message: { content: 'CLAUDE_SPAWNED_SESSION=true' } }) + '\n');

    const attr = resolveAttribution({
      sessionId: 'unknown-1',
      jsonlPath: jsonl,
      isSubagent: false,
      parentSessionId: null,
      tokenDb: db,
    });
    db.close();
    assert.strictEqual(attr.attribution_status, 'pending');
    assert.strictEqual(attr.source, 'unknown');
  });

  it('resolveAttribution maps subprocess_calls.child_session_id to subprocess:<caller>', () => {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO subprocess_calls (caller, model, parent_session_id, child_session_id, started_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('live-feed-daemon', 'claude-haiku-4-5', 'parent-1', 'child-xyz', Date.now());

    const jsonl = path.join(tmpDir, 'subproc.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'system', message: { content: 'CLAUDE_SPAWNED_SESSION=true' } }) + '\n');

    const attr = resolveAttribution({
      sessionId: 'child-xyz',
      jsonlPath: jsonl,
      isSubagent: false,
      parentSessionId: null,
      tokenDb: db,
    });
    db.close();
    assert.strictEqual(attr.source, 'subprocess:live-feed-daemon');
    assert.strictEqual(attr.subprocess_tag, 'live-feed-daemon');
    assert.strictEqual(attr.parent_session_id, 'parent-1');
  });

  it('rebuildDailyRollup aggregates by source/model for the day', () => {
    const db = openDb(dbPath);
    const today = new Date().toISOString().slice(0, 10);
    const todayStart = Date.parse(`${today}T12:00:00Z`);

    db.prepare(
      `INSERT INTO usage_events
       (session_id, message_uuid, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 'm1', todayStart, 'claude-haiku-4-5', 1000, 500, 0, 0, 4_000);

    db.prepare(
      `INSERT INTO usage_events
       (session_id, message_uuid, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 'm2', todayStart + 1000, 'claude-haiku-4-5', 2000, 1000, 0, 0, 8_000);

    db.prepare(
      `INSERT INTO session_attribution (session_id, source, attribution_status, last_attempt_at)
       VALUES (?, ?, 'resolved', ?)`
    ).run('s1', 'hourly-automation:task_runner', Date.now());

    rebuildDailyRollup(db, today);

    const rows = db.prepare('SELECT * FROM daily_rollup WHERE date = ?').all(today);
    db.close();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].source, 'hourly-automation:task_runner');
    assert.strictEqual(rows[0].model, 'claude-haiku-4-5');
    assert.strictEqual(rows[0].input_tokens, 3000);
    assert.strictEqual(rows[0].output_tokens, 1500);
    assert.strictEqual(rows[0].cost_micro_usd, 12_000);
    assert.strictEqual(rows[0].session_count, 1);
    assert.strictEqual(rows[0].message_count, 2);
  });

  it('rebuildDailyRollup tags rows with source="unknown" when no attribution', () => {
    const db = openDb(dbPath);
    const today = new Date().toISOString().slice(0, 10);
    const ts = Date.parse(`${today}T10:00:00Z`);
    db.prepare(
      `INSERT INTO usage_events
       (session_id, message_uuid, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('orphan', 'm1', ts, 'claude-sonnet-4-6', 100, 50, 0, 0, 1_050);

    rebuildDailyRollup(db, today);
    const rows = db.prepare('SELECT * FROM daily_rollup WHERE date = ?').all(today);
    db.close();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].source, 'unknown');
  });

  it('runScanCycle ingests events idempotently (UNIQUE constraint)', () => {
    // Build a fake project dir whose session dir matches encodeProjectPath
    const projectDir = path.join(tmpDir, 'fake-proj');
    fs.mkdirSync(projectDir);
    const realSessionDir = path.join(os.homedir(), '.claude', 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(realSessionDir, { recursive: true });

    try {
      const jsonl = path.join(realSessionDir, 'abc.jsonl');
      const line = JSON.stringify({
        type: 'assistant',
        uuid: 'msg-1',
        timestamp: new Date().toISOString(),
        message: { model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 50 } },
      });
      fs.writeFileSync(jsonl, line + '\n');

      const result1 = runScanCycle({ projectDir, dbPath });
      assert.strictEqual(result1.newEvents, 1);

      // Re-run; should not duplicate (offset is persisted)
      const result2 = runScanCycle({ projectDir, dbPath });
      assert.strictEqual(result2.newEvents, 0);

      const db = openDb(dbPath);
      const count = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n;
      const attr = db.prepare('SELECT source FROM session_attribution WHERE session_id = ?').get('abc');
      db.close();
      assert.strictEqual(count, 1);
      assert.strictEqual(attr.source, 'interactive-cto');
    } finally {
      try { fs.rmSync(realSessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
