/**
 * Tests for revival-daemon.js deferred revivalAttempted flag behavior.
 *
 * These tests cover:
 *   1. revivalAttempted IS set at all terminal points (no taskId, task completed,
 *      no session file, spawn success, spawn failure).
 *   2. revivalAttempted is NOT set when memory pressure blocks revival.
 *   3. Safety cap: 5 revival retries sets revivalAttempted permanently.
 *   4. revivalRetries is incremented on each actual revival attempt.
 *
 * The scanAndRevive() function cannot be imported in isolation (lazy-loaded modules,
 * live file-system state). We use source-code structural verification — the same
 * pattern used throughout this test suite (session-queue-dedup.test.js, etc.).
 *
 * Run with: node --test scripts/__tests__/revival-daemon.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REVIVAL_DAEMON_PATH = path.resolve(__dirname, '..', 'revival-daemon.js');

let sourceCode;

before(() => {
  sourceCode = fs.readFileSync(REVIVAL_DAEMON_PATH, 'utf8');
});

// ============================================================================
// Helper: extract the scanAndRevive function body
// ============================================================================

/**
 * Extract the full body of scanAndRevive() using brace matching.
 */
function getScanAndReviveBody() {
  const start = sourceCode.indexOf('function scanAndRevive()');
  assert.ok(start >= 0, 'scanAndRevive function must exist in revival-daemon.js');

  const openBrace = sourceCode.indexOf('{', start);
  let depth = 0;
  let pos = openBrace;
  while (pos < sourceCode.length) {
    if (sourceCode[pos] === '{') depth++;
    else if (sourceCode[pos] === '}') {
      depth--;
      if (depth === 0) break;
    }
    pos++;
  }
  return sourceCode.slice(start, pos + 1);
}

// ============================================================================
// Test Group 1: revivalAttempted IS set at all terminal points
// ============================================================================

describe('revival-daemon: revivalAttempted set at terminal points', () => {
  it('sets agent.revivalAttempted = true when no taskId is found', () => {
    const body = getScanAndReviveBody();
    const noTaskIdIndex = body.indexOf('No taskId');
    assert.ok(noTaskIdIndex >= 0, 'scanAndRevive must handle the no-taskId case');

    const afterNoTaskId = body.slice(noTaskIdIndex, noTaskIdIndex + 300);
    assert.ok(
      afterNoTaskId.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true when agent has no taskId'
    );
  });

  it('sets agent.revivalAttempted = true when task is already completed or missing', () => {
    const body = getScanAndReviveBody();
    const completedIndex = body.indexOf('already completed or missing');
    assert.ok(completedIndex >= 0, 'scanAndRevive must handle the task-completed/missing case');

    const afterCompleted = body.slice(completedIndex, completedIndex + 300);
    assert.ok(
      afterCompleted.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true when task is already completed or missing'
    );
  });

  it('sets agent.revivalAttempted = true when revival spawn succeeds', () => {
    const body = getScanAndReviveBody();
    // The if (spawnResumedSession(...)) success block must set revivalAttempted.
    // We verify by locating spawnResumedSession and then scanning forward to the
    // first agent.revivalAttempted = true assignment after it.
    const spawnCallIndex = body.indexOf('spawnResumedSession(sessionId');
    assert.ok(spawnCallIndex >= 0, 'Must have spawnResumedSession(sessionId...) call');

    // Look for revivalAttempted = true in the 400 chars after the spawn call
    // (the success branch sets it immediately after the call's closing paren)
    const afterSpawn = body.slice(spawnCallIndex, spawnCallIndex + 400);
    assert.ok(
      afterSpawn.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true in the block immediately after a successful spawnResumedSession'
    );
  });

  it('sets agent.revivalAttempted = true when revival spawn fails', () => {
    const body = getScanAndReviveBody();
    const spawnFailIndex = body.indexOf('Revival spawn failed');
    assert.ok(spawnFailIndex >= 0, 'scanAndRevive must handle the spawn-failure case');

    // Check surrounding code for revivalAttempted
    const surroundingFail = body.slice(Math.max(0, spawnFailIndex - 250), spawnFailIndex + 100);
    assert.ok(
      surroundingFail.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true when revival spawn fails'
    );
  });

  it('sets agent.revivalAttempted = true when no session file is found', () => {
    const body = getScanAndReviveBody();
    const noSessionIndex = body.indexOf('No session file found');
    assert.ok(noSessionIndex >= 0, 'scanAndRevive must handle the no-session-file case');

    const afterNoSession = body.slice(noSessionIndex, noSessionIndex + 200);
    assert.ok(
      afterNoSession.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true when no session file is found'
    );
  });

  it('does NOT set agent.revivalAttempted when memory pressure blocks revival', () => {
    const body = getScanAndReviveBody();
    // Memory block sets memoryBlocked=true and continues — revivalAttempted must NOT be set
    const memBlockedIndex = body.indexOf('agent.memoryBlocked = true');
    assert.ok(memBlockedIndex >= 0, 'Must have agent.memoryBlocked = true for memory pressure block');

    // Extract the memory-blocked branch body
    const surroundingMem = body.slice(Math.max(0, memBlockedIndex - 50), memBlockedIndex + 150);
    assert.ok(
      !surroundingMem.includes('agent.revivalAttempted = true'),
      'Must NOT set agent.revivalAttempted when memory pressure blocks revival (agent must remain retryable)'
    );
  });
});

// ============================================================================
// Test Group 4: Safety cap — 5 retries sets revivalAttempted permanently
// ============================================================================

describe('revival-daemon: safety cap of 5 revival retries', () => {
  it('checks (agent.revivalRetries || 0) >= 5 to cap retries', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('>= 5'),
      'Safety cap check must use >= 5'
    );
    assert.ok(
      body.includes('agent.revivalRetries'),
      'Safety cap must read agent.revivalRetries'
    );
  });

  it('sets agent.revivalAttempted = true when the retry cap (>= 5) is hit', () => {
    const body = getScanAndReviveBody();
    const capIndex = body.indexOf('>= 5');
    assert.ok(capIndex >= 0, 'Retry cap check must exist');

    // The block around >= 5 must set revivalAttempted
    const surroundingCap = body.slice(Math.max(0, capIndex - 100), capIndex + 200);
    assert.ok(
      surroundingCap.includes('agent.revivalAttempted = true'),
      'Must set agent.revivalAttempted = true permanently when retry cap (5) is reached'
    );
  });

  it('increments revivalRetries using (agent.revivalRetries || 0) + 1 pattern', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('agent.revivalRetries || 0') && body.includes('+ 1'),
      'Must increment agent.revivalRetries via (agent.revivalRetries || 0) + 1'
    );
  });

  it('increments revivalRetries before checking terminal conditions', () => {
    const body = getScanAndReviveBody();
    const retryIncIndex = body.indexOf('agent.revivalRetries = (agent.revivalRetries || 0) + 1');
    const noTaskIdIndex = body.indexOf('No taskId');

    assert.ok(retryIncIndex >= 0, 'revivalRetries increment must exist');
    assert.ok(noTaskIdIndex >= 0, 'No taskId terminal point must exist');

    assert.ok(
      retryIncIndex < noTaskIdIndex,
      'revivalRetries must be incremented before terminal decisions are made'
    );
  });
});

// ============================================================================
// Test Group 5: Memory pressure handling does not set revivalAttempted
// ============================================================================

describe('revival-daemon: memory pressure block does not set revivalAttempted', () => {
  it('memory pressure block uses agent.memoryBlocked = true (not revivalAttempted)', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('agent.memoryBlocked = true'),
      'Memory pressure block must set agent.memoryBlocked = true to signal retry'
    );
  });

  it('memory pressure block is inside the shouldAllowSpawn check', () => {
    const body = getScanAndReviveBody();
    const shouldAllowIndex = body.indexOf('shouldAllowSpawn');
    const memBlockedIndex = body.indexOf('agent.memoryBlocked = true');

    assert.ok(shouldAllowIndex >= 0, 'shouldAllowSpawn call must exist');
    assert.ok(memBlockedIndex >= 0, 'agent.memoryBlocked = true must exist');

    assert.ok(
      shouldAllowIndex < memBlockedIndex,
      'shouldAllowSpawn check must come before agent.memoryBlocked = true'
    );
  });
});

// ============================================================================
// Test Group 6: Historical tracking map usage
// ============================================================================

describe('revival-daemon: revivalAttempted in-memory tracking map', () => {
  it('uses revivalAttempted.set() at terminal points alongside agent flag', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('revivalAttempted.set(agent.id, now)'),
      'Must call revivalAttempted.set(agent.id, now) alongside agent.revivalAttempted = true at terminal points'
    );
  });

  it('skips agents already in the revivalAttempted tracking map', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('revivalAttempted.has(agent.id)'),
      'Must skip agents that are already in the revivalAttempted tracking map'
    );
  });

  it('skips agents with agent.revivalAttempted flag set', () => {
    const body = getScanAndReviveBody();
    assert.ok(
      body.includes('agent.revivalAttempted'),
      'Must check agent.revivalAttempted flag directly (survives process restarts unlike the in-memory map)'
    );
  });
});
