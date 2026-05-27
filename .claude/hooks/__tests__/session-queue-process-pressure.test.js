/**
 * Tests for process-pressure integration into session-queue.js drainQueue().
 *
 * This is the structural test that locks down the gating: process-pressure
 * must be consulted alongside memory-pressure for both Tier 1 (audit/gate/
 * alignment lanes) and Tier 2 (standard capacity) spawn paths. Without these
 * gates, the 2026-05-27 deadlock recurs: spawn fires when 700+ node processes
 * already saturate the box and the spawnSync call ETIMEDOUTs.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-process-pressure.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_QUEUE_PATH = path.resolve(__dirname, '..', 'lib', 'session-queue.js');
const source = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');

describe('session-queue process-pressure integration', () => {
  it('imports shouldAllowSpawn from process-pressure with a distinct alias', () => {
    assert.match(source,
      /import \{ shouldAllowSpawn as shouldAllowSpawnProc \} from '\.\/process-pressure\.js'/,
      'must alias the process-pressure import so it does not collide with memory-pressure');
  });

  it('checks process-pressure in the Tier 1 drain path', () => {
    // Tier 1 lanes (audit/gate/alignment) must pass both pressure checks.
    // The check should appear AFTER the memory check (defense in depth).
    const tier1Block = source.match(/Memory pressure check for Tier 1[\s\S]{0,2500}?\/\/ Process pressure check for Tier 1[\s\S]{0,1500}?shouldAllowSpawnProc\(\{[\s\S]*?\}\)/);
    assert.ok(tier1Block, 'Tier 1 drain path must consult process-pressure after memory-pressure');
  });

  it('checks process-pressure in the Tier 2 drain path', () => {
    const tier2Block = source.match(/Memory pressure check for Tier 2[\s\S]{0,2500}?\/\/ Process pressure check for Tier 2[\s\S]{0,1500}?shouldAllowSpawnProc\(\{[\s\S]*?\}\)/);
    assert.ok(tier2Block, 'Tier 2 drain path must consult process-pressure after memory-pressure');
  });

  it('blocks Tier 1 spawn when process pressure denies, increments memoryBlocked counter', () => {
    // Tier 1 process block path should increment the same memoryBlocked
    // counter used by memory-pressure (saturation is saturation; one counter
    // keeps drain-summary auditing simple). The counter increment precedes
    // the log line — anchor the regex on the if-guard, not the log message.
    const tier1Block = source.match(/Process pressure check for Tier 1[\s\S]{0,1500}?if \(!procCheck\.allowed\) \{[\s\S]{0,800}?continue;\s*\}/);
    assert.ok(tier1Block, 'Tier 1 process block must exist with guard + continue');
    assert.match(tier1Block[0], /result\.memoryBlocked\+\+/);
    assert.match(tier1Block[0], /Process pressure blocked Tier 1/);
  });

  it('blocks Tier 2 spawn when process pressure denies', () => {
    // Capture the full Tier 2 process-pressure block (counter increment +
    // log + debugLog + continue). The counter increment precedes the log
    // line, so anchor the regex on the "if (!procCheck.allowed)" guard.
    const tier2Block = source.match(/Process pressure check for Tier 2[\s\S]{0,1500}?if \(!procCheck\.allowed\) \{[\s\S]{0,800}?continue;\s*\}/);
    assert.ok(tier2Block, 'Tier 2 process block must exist with guard + continue');
    assert.match(tier2Block[0], /result\.memoryBlocked\+\+/);
    assert.match(tier2Block[0], /Process pressure blocked \$\{item\.id\}/);
    assert.match(tier2Block[0], /debugLog\([^)]*'drain_process_blocked'/);
  });

  it('passes priority through to process-pressure check (so cto/critical bypass)', () => {
    // Critical: the priority value MUST be passed through so cto/critical
    // priorities pass the gate even at critical pressure. Without this,
    // persistent monitor revival (which uses critical) would be blocked.
    const allTier1Block = source.match(/Process pressure check for Tier 1[\s\S]{0,1500}?\}\)/);
    assert.ok(allTier1Block);
    assert.match(allTier1Block[0], /priority: item\.priority === 'cto' \|\| item\.priority === 'critical'/);

    const allTier2Block = source.match(/Process pressure check for Tier 2[\s\S]{0,1500}?\}\)/);
    assert.ok(allTier2Block);
    assert.match(allTier2Block[0], /priority: item\.priority/);
  });
});

describe('agent-tracker force_spawn_tasks ETIMEDOUT reaper callback', () => {
  it('shells out to --reap-orphans-aggressive on spawn timeout', () => {
    const agentTrackerPath = path.resolve(
      __dirname, '..', '..', '..',
      'packages', 'mcp-servers', 'src', 'agent-tracker', 'server.ts'
    );
    const src = fs.readFileSync(agentTrackerPath, 'utf8');
    // The ETIMEDOUT path must invoke the reaper before returning the error
    // so the next retry has a clean process table to work with.
    const timeoutBlock = src.match(/if \(isTimeout\) \{[\s\S]{0,3000}\}/);
    assert.ok(timeoutBlock, 'ETIMEDOUT branch must exist');
    assert.match(timeoutBlock[0], /--reap-orphans-aggressive/);
    assert.match(timeoutBlock[0], /timeout: 65000/,
      'reaper invocation must have a 65s timeout (60s reaper budget + 5s margin)');
    assert.match(timeoutBlock[0], /reapResult/);
  });

  it('embeds reaper outcome in the error message so callers see what happened', () => {
    const agentTrackerPath = path.resolve(
      __dirname, '..', '..', '..',
      'packages', 'mcp-servers', 'src', 'agent-tracker', 'server.ts'
    );
    const src = fs.readFileSync(agentTrackerPath, 'utf8');
    assert.match(src, /Aggressive orphan reaper killed/);
    assert.match(src, /Aggressive orphan reaper failed/);
  });
});
