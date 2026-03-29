/**
 * Structural tests for session-queue.js enqueueSession() dedup logic.
 *
 * enqueueSession() has heavy side effects (opens SQLite, spawns processes) and
 * cannot be called in isolation in tests. We use source-code structural
 * verification instead — the same pattern used by worktree-hookspath-fix.test.js
 * and workstream-spawner.test.js.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-dedup.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_QUEUE_PATH = path.resolve(__dirname, '..', 'lib', 'session-queue.js');

// Read the source once for all tests
const sourceCode = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');

// ============================================================================
// Helper: extract the enqueueSession function body
// ============================================================================

/**
 * Extract the text of the enqueueSession export function.
 * We scan from "export function enqueueSession" to the first line that
 * begins a new top-level export/function at column 0 after the function.
 */
function getEnqueueSessionBody() {
  const start = sourceCode.indexOf('export function enqueueSession(');
  assert.ok(start >= 0, 'enqueueSession function must exist in session-queue.js');

  // Find the end: the next top-level export declaration
  const rest = sourceCode.slice(start);
  // Look for the next export or top-level function declaration after first line
  const nextExportMatch = rest.slice(30).search(/\nexport /);
  const end = nextExportMatch >= 0 ? start + 30 + nextExportMatch : sourceCode.length;
  return sourceCode.slice(start, end);
}

const enqueueBody = getEnqueueSessionBody();

// ============================================================================
// Test 1: Dedup check is present — uses json_extract with taskId
// ============================================================================

describe('session-queue.js enqueueSession() dedup — json_extract presence', () => {
  it('contains json_extract(metadata, $.taskId) inside enqueueSession', () => {
    assert.ok(
      enqueueBody.includes("json_extract(metadata, '$.taskId')"),
      'enqueueSession must contain json_extract(metadata, \'$.taskId\') for dedup check'
    );
  });
});

// ============================================================================
// Test 2: Dedup only fires when taskId is set — guard is present
// ============================================================================

describe('session-queue.js enqueueSession() dedup — taskId guard', () => {
  it('guards dedup check with if (spec.metadata?.taskId)', () => {
    assert.ok(
      enqueueBody.includes('spec.metadata?.taskId') || enqueueBody.includes("spec.metadata && spec.metadata.taskId"),
      'enqueueSession must guard dedup with spec.metadata?.taskId (or equivalent) so it only fires when taskId is set'
    );
  });
});

// ============================================================================
// Test 3: Dedup checks active statuses only
// ============================================================================

describe('session-queue.js enqueueSession() dedup — active statuses constraint', () => {
  it("dedup query constrains status to IN ('queued', 'running', 'spawning')", () => {
    assert.ok(
      enqueueBody.includes("IN ('queued', 'running', 'spawning')"),
      "enqueueSession dedup must check status IN ('queued', 'running', 'spawning') to avoid false positives from completed/failed items"
    );
  });
});

// ============================================================================
// Test 4: Dedup returns existing queueId
// ============================================================================

describe('session-queue.js enqueueSession() dedup — return shape', () => {
  it('returns { queueId: existing.id, position: 0, drained: { spawned: 0, atCapacity: false } } on dedup hit', () => {
    // Verify the return shape: queueId: existing.id
    assert.ok(
      enqueueBody.includes('queueId: existing.id'),
      'Must return queueId: existing.id on dedup hit'
    );
    // Verify position: 0
    assert.ok(
      enqueueBody.includes('position: 0'),
      'Must return position: 0 on dedup hit'
    );
    // Verify drained structure
    assert.ok(
      enqueueBody.includes('spawned: 0') && enqueueBody.includes('atCapacity: false'),
      'Must return drained: { spawned: 0, atCapacity: false } on dedup hit'
    );
  });
});

// ============================================================================
// Test 5: Dedup logs the skip
// ============================================================================

describe('session-queue.js enqueueSession() dedup — log message', () => {
  it("logs 'Dedup: task' when a duplicate is detected", () => {
    assert.ok(
      enqueueBody.includes('Dedup: task'),
      'Must log a "Dedup: task" message when skipping due to dedup'
    );
  });
});
