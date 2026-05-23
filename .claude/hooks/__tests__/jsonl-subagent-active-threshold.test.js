/**
 * Tests for the decoupled sub-agent activity threshold in jsonl_stale_kill.
 *
 * Background: the original implementation used JSONL_STALE_MS (5 min) for BOTH the
 * parent stale-kill window AND the sub-agent activity check. Sub-agents doing
 * extended thinking or long-running MCP tool calls (test suites, demos, large
 * diffs) routinely go silent >5 min between JSONL writes, even while actively
 * working. The shared threshold misclassified them as inactive, and the parent
 * (legitimately blocked on Agent()) got killed mid-call.
 *
 * Fix: use a SEPARATE `jsonl_subagent_active_minutes` cooldown (default 30) for
 * the sub-agent activity check. Catches truly orphaned sub-agents without
 * false-positiving on legitimate long-running work.
 *
 * Run with: node --test .claude/hooks/__tests__/jsonl-subagent-active-threshold.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REAPER_PATH = path.resolve(__dirname, '..', 'lib', 'session-reaper.js');

let source;

before(() => {
  source = fs.readFileSync(REAPER_PATH, 'utf8');
});

describe('session-reaper.js — decoupled sub-agent activity threshold', () => {
  it('declares SUBAGENT_ACTIVE_MS via its own cooldown key', () => {
    assert.match(
      source,
      /const SUBAGENT_ACTIVE_MS = getCooldown\(['"]jsonl_subagent_active_minutes['"], 30\) \* 60 \* 1000/
    );
  });

  it('preserves the parent JSONL_STALE_MS at jsonl_stale_kill_minutes (default 5)', () => {
    assert.match(
      source,
      /const JSONL_STALE_MS = getCooldown\(['"]jsonl_stale_kill_minutes['"], 5\) \* 60 \* 1000/
    );
  });

  it('sub-agent activity check uses SUBAGENT_ACTIVE_MS, not JSONL_STALE_MS', () => {
    // Capture the body of the staleness block and confirm the sub-agent check
    // references SUBAGENT_ACTIVE_MS for the timestamp comparison.
    const staleBlockMatch = source.match(
      /const hasActiveSubagent = subFiles\.some\(f => \{[\s\S]*?\}\);/
    );
    assert.ok(staleBlockMatch, 'hasActiveSubagent block must exist');
    assert.match(staleBlockMatch[0], /\(now - subStat\.mtimeMs\) < SUBAGENT_ACTIVE_MS/);
    // Defensive: legacy code compared against JSONL_STALE_MS — make sure that
    // exact comparison is gone from this block.
    assert.doesNotMatch(
      staleBlockMatch[0],
      /\(now - subStat\.mtimeMs\) < JSONL_STALE_MS/
    );
  });

  it('subagent-active threshold is strictly greater than parent stale threshold by default', () => {
    // 30 min > 5 min — captured here as a regression guard for future config tweaks.
    const subagentMatch = source.match(/jsonl_subagent_active_minutes['"]?,\s*(\d+)/);
    const parentMatch = source.match(/jsonl_stale_kill_minutes['"]?,\s*(\d+)/);
    assert.ok(subagentMatch && parentMatch);
    const subagentMinutes = parseInt(subagentMatch[1], 10);
    const parentMinutes = parseInt(parentMatch[1], 10);
    assert.ok(
      subagentMinutes > parentMinutes,
      `subagent threshold (${subagentMinutes}m) must exceed parent stale threshold (${parentMinutes}m)`
    );
  });

  it('skips kill when sub-agent activity check returns true (continue statement)', () => {
    const idx = source.indexOf('const hasActiveSubagent');
    assert.ok(idx > 0);
    const block = source.slice(idx, idx + 600);
    // Confirm the continue is wired (parent waiting on active sub-agent — skip)
    assert.match(block, /if \(hasActiveSubagent\) continue/);
  });
});
