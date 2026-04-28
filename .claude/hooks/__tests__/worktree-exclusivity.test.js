/**
 * Structural tests for the Bug #6 worktree exclusivity fix.
 *
 * Bug #6 defense is implemented in 4 layers:
 *   Layer 1 — enqueueSession() worktree dedup in session-queue.js
 *   Layer 2 — removeWorktree() session-queue guard in worktree-manager.js
 *   Layer 3 — PreToolUse hook in worktree-remove-guard.js
 *   Layer 4 — Rescue prompt hardening in hourly-automation.js
 *
 * These are structural tests that read source files and verify patterns/strings
 * exist. They do NOT instantiate databases or import modules with side effects.
 * The same pattern is used by session-queue-dedup.test.js.
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-exclusivity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Source file paths and content
// ============================================================================

const SESSION_QUEUE_PATH = path.resolve(__dirname, '..', 'lib', 'session-queue.js');
const WORKTREE_MANAGER_PATH = path.resolve(__dirname, '..', 'lib', 'worktree-manager.js');
const REMOVE_GUARD_PATH = path.resolve(__dirname, '..', 'worktree-remove-guard.js');
const HOURLY_AUTOMATION_PATH = path.resolve(__dirname, '..', 'hourly-automation.js');

const sessionQueueSrc = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');
const worktreeManagerSrc = fs.readFileSync(WORKTREE_MANAGER_PATH, 'utf8');
const removeGuardSrc = fs.readFileSync(REMOVE_GUARD_PATH, 'utf8');
const hourlyAutomationSrc = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');

// ============================================================================
// Helper: extract the enqueueSession function body
// (same pattern as session-queue-dedup.test.js)
// ============================================================================

function getEnqueueSessionBody() {
  const start = sessionQueueSrc.indexOf('export function enqueueSession(');
  assert.ok(start >= 0, 'enqueueSession function must exist in session-queue.js');
  const rest = sessionQueueSrc.slice(start);
  const nextExportMatch = rest.slice(30).search(/\nexport /);
  const end = nextExportMatch >= 0 ? start + 30 + nextExportMatch : sessionQueueSrc.length;
  return sessionQueueSrc.slice(start, end);
}

const enqueueBody = getEnqueueSessionBody();

// ============================================================================
// Helper: extract the removeWorktree function body
// ============================================================================

function getRemoveWorktreeBody() {
  const start = worktreeManagerSrc.indexOf('export function removeWorktree(');
  assert.ok(start >= 0, 'removeWorktree function must exist in worktree-manager.js');
  const rest = worktreeManagerSrc.slice(start);
  // Find the next top-level export after removeWorktree
  const nextExportMatch = rest.slice(30).search(/\nexport /);
  const end = nextExportMatch >= 0 ? start + 30 + nextExportMatch : worktreeManagerSrc.length;
  return worktreeManagerSrc.slice(start, end);
}

const removeWorktreeBody = getRemoveWorktreeBody();

// ============================================================================
// Helper: extract the cleanupMergedWorktrees function body
// ============================================================================

function getCleanupMergedWorktreesBody() {
  const start = worktreeManagerSrc.indexOf('export function cleanupMergedWorktrees(');
  assert.ok(start >= 0, 'cleanupMergedWorktrees function must exist in worktree-manager.js');
  const rest = worktreeManagerSrc.slice(start);
  const nextExportMatch = rest.slice(30).search(/\nexport /);
  const end = nextExportMatch >= 0 ? start + 30 + nextExportMatch : worktreeManagerSrc.length;
  return worktreeManagerSrc.slice(start, end);
}

const cleanupMergedBody = getCleanupMergedWorktreesBody();

// ============================================================================
// Helper: extract the rescueAbandonedWorktrees function body
// ============================================================================

function getRescueAbandonedWorktreesBody() {
  const start = hourlyAutomationSrc.indexOf('function rescueAbandonedWorktrees(');
  assert.ok(start >= 0, 'rescueAbandonedWorktrees function must exist in hourly-automation.js');
  // Find end by looking for next top-level function declaration
  const rest = hourlyAutomationSrc.slice(start);
  const nextFnMatch = rest.slice(30).search(/\nfunction /);
  const end = nextFnMatch >= 0 ? start + 30 + nextFnMatch : hourlyAutomationSrc.length;
  return hourlyAutomationSrc.slice(start, end);
}

const rescueBody = getRescueAbandonedWorktreesBody();

// ============================================================================
// LAYER 1: enqueueSession() worktree exclusivity dedup (session-queue.js)
// ============================================================================

describe('Layer 1 — enqueueSession() worktree exclusivity check (session-queue.js)', () => {

  it('contains a worktree exclusivity block comment', () => {
    assert.ok(
      enqueueBody.includes('Worktree exclusivity'),
      'enqueueSession must have a "Worktree exclusivity" comment block describing Bug #6 defense'
    );
  });

  it('queries queue_items for worktree_path = ? match', () => {
    assert.ok(
      enqueueBody.includes('worktree_path = ?'),
      'enqueueSession worktree exclusivity check must query "worktree_path = ?" in the SQL'
    );
  });

  it('queries queue_items for cwd = ? match', () => {
    assert.ok(
      enqueueBody.includes('cwd = ?'),
      'enqueueSession worktree exclusivity check must also match "cwd = ?" for sessions that use cwd instead of worktree_path'
    );
  });

  it('checks active statuses including suspended in the worktree exclusivity query', () => {
    assert.ok(
      enqueueBody.includes("IN ('queued', 'running', 'spawning', 'suspended')"),
      "enqueueSession worktree exclusivity query must constrain status IN ('queued', 'running', 'spawning', 'suspended')"
    );
  });

  it('returns blocked: worktree_exclusive when another session owns the worktree', () => {
    assert.ok(
      enqueueBody.includes("blocked: 'worktree_exclusive'"),
      "enqueueSession must return { blocked: 'worktree_exclusive' } when the worktree is in use"
    );
  });

  it('returns queueId: null when blocked by worktree exclusivity', () => {
    // The blocked return must include queueId: null
    const blockedReturnIdx = enqueueBody.indexOf("blocked: 'worktree_exclusive'");
    assert.ok(blockedReturnIdx >= 0, 'worktree_exclusive blocked return must exist');
    // Find the surrounding return statement
    const returnStart = enqueueBody.lastIndexOf('return {', blockedReturnIdx);
    assert.ok(returnStart >= 0, 'must be inside a return statement');
    const returnEnd = enqueueBody.indexOf('}', blockedReturnIdx);
    const returnExpr = enqueueBody.slice(returnStart, returnEnd + 1);
    assert.ok(
      returnExpr.includes('queueId: null'),
      'worktree_exclusive return must include queueId: null'
    );
  });

  it('includes conflictQueueId in the blocked return value', () => {
    assert.ok(
      enqueueBody.includes('conflictQueueId'),
      'enqueueSession must return conflictQueueId so callers can log which queue item owns the worktree'
    );
  });

  it('normalizes worktreePath by stripping trailing slashes', () => {
    assert.ok(
      enqueueBody.includes("spec.worktreePath.replace(/\\/+$/, '')") ||
      enqueueBody.includes("spec.worktreePath = spec.worktreePath.replace(/\\/+$/, '')"),
      'enqueueSession must strip trailing slashes from spec.worktreePath before the dedup check'
    );
  });

  it('normalizes cwd by stripping trailing slashes', () => {
    assert.ok(
      enqueueBody.includes("spec.cwd.replace(/\\/+$/, '')") ||
      enqueueBody.includes("spec.cwd = spec.cwd.replace(/\\/+$/, '')"),
      'enqueueSession must strip trailing slashes from spec.cwd before the dedup check'
    );
  });

  it('guards the worktree exclusivity check with a path presence check', () => {
    assert.ok(
      enqueueBody.includes('spec.worktreePath || spec.cwd'),
      'enqueueSession must only run the worktree exclusivity check when spec.worktreePath or spec.cwd is set'
    );
  });

  it('creates idx_queue_worktree index on queue_items for fast worktree lookups', () => {
    assert.ok(
      sessionQueueSrc.includes('idx_queue_worktree'),
      'session-queue.js must define an idx_queue_worktree index to support efficient worktree exclusivity queries'
    );
  });

  it('creates the idx_queue_worktree index with CREATE INDEX IF NOT EXISTS', () => {
    assert.ok(
      sessionQueueSrc.includes('CREATE INDEX IF NOT EXISTS idx_queue_worktree'),
      'idx_queue_worktree must be created with CREATE INDEX IF NOT EXISTS'
    );
  });
});

// ============================================================================
// LAYER 1 (continued): CLAUDE_QUEUE_ID injection in spawnQueueItem()
// ============================================================================

describe('Layer 1 (continued) — CLAUDE_QUEUE_ID injection in spawnQueueItem() (session-queue.js)', () => {

  it('injects CLAUDE_QUEUE_ID into the spawn environment', () => {
    assert.ok(
      sessionQueueSrc.includes('CLAUDE_QUEUE_ID = item.id') ||
      sessionQueueSrc.includes('CLAUDE_QUEUE_ID: item.id'),
      'spawnQueueItem must inject CLAUDE_QUEUE_ID = item.id so the spawned session can identify its own queue entry'
    );
  });

  it('has a comment explaining CLAUDE_QUEUE_ID purpose', () => {
    assert.ok(
      sessionQueueSrc.includes('CLAUDE_QUEUE_ID'),
      'CLAUDE_QUEUE_ID must be referenced in session-queue.js'
    );
  });
});

// ============================================================================
// LAYER 2: removeWorktree() session-queue guard (worktree-manager.js)
// ============================================================================

describe('Layer 2 — removeWorktree() session-queue guard (worktree-manager.js)', () => {

  it('removeWorktree accepts an options parameter', () => {
    assert.ok(
      removeWorktreeBody.includes('options = {}') ||
      removeWorktreeBody.includes('options={}'),
      'removeWorktree must accept an options parameter with a default empty object'
    );
  });

  it('removeWorktree supports options.force to bypass the guard', () => {
    assert.ok(
      removeWorktreeBody.includes('options.force'),
      'removeWorktree must support options.force to allow callers to bypass the session-queue safety guard'
    );
  });

  it('the guard is skipped when options.force is true', () => {
    assert.ok(
      removeWorktreeBody.includes('!options.force'),
      'removeWorktree session-queue guard must be wrapped in if (!options.force) so force: true bypasses it'
    );
  });

  it('queries session-queue.db for active sessions before removing', () => {
    assert.ok(
      removeWorktreeBody.includes('session-queue.db'),
      'removeWorktree must query session-queue.db to check for active sessions before removal'
    );
  });

  it('queries for running, queued, spawning, and suspended statuses', () => {
    assert.ok(
      removeWorktreeBody.includes("'running', 'queued', 'spawning', 'suspended'"),
      "removeWorktree must check all active statuses: 'running', 'queued', 'spawning', 'suspended'"
    );
  });

  it('throws an error containing BLOCKED when an active session is found', () => {
    assert.ok(
      removeWorktreeBody.includes('BLOCKED'),
      'removeWorktree must throw an error containing "BLOCKED" when an active session is using the worktree'
    );
  });

  it('includes a helpful message about force bypass in the BLOCKED error', () => {
    assert.ok(
      removeWorktreeBody.includes('force: true'),
      'The BLOCKED error message must mention "force: true" so callers know how to bypass'
    );
  });

  it('re-throws the BLOCKED error so callers receive it', () => {
    assert.ok(
      removeWorktreeBody.includes("err.message.includes('BLOCKED')"),
      "removeWorktree must re-throw errors containing 'BLOCKED' rather than swallowing them"
    );
  });

  it('has a PID-alive check to avoid blocking on stale DB entries', () => {
    assert.ok(
      removeWorktreeBody.includes('isPidAliveCheck') ||
      removeWorktreeBody.includes('pidAlive'),
      'removeWorktree must verify the session PID is alive before blocking removal (prevents stale DB entries from blocking)'
    );
  });

  it('isPidAliveCheck is defined in worktree-manager.js', () => {
    assert.ok(
      worktreeManagerSrc.includes('function isPidAliveCheck('),
      'isPidAliveCheck helper function must be defined in worktree-manager.js'
    );
  });

  it('isPidAliveCheck uses process.kill(pid, 0) for liveness check', () => {
    const isPidAliveIdx = worktreeManagerSrc.indexOf('function isPidAliveCheck(');
    assert.ok(isPidAliveIdx >= 0, 'isPidAliveCheck must exist');
    const fnBody = worktreeManagerSrc.slice(isPidAliveIdx, isPidAliveIdx + 200);
    assert.ok(
      fnBody.includes('process.kill(pid, 0)'),
      'isPidAliveCheck must use process.kill(pid, 0) — the standard zero-signal PID liveness test'
    );
  });

  it('cleanupMergedWorktrees passes force: true to removeWorktree', () => {
    assert.ok(
      cleanupMergedBody.includes("force: true") ||
      cleanupMergedBody.includes('{ force: true }'),
      "cleanupMergedWorktrees must pass { force: true } to removeWorktree since it already verified safety via session-queue + lsof"
    );
  });
});

// ============================================================================
// LAYER 3: PreToolUse hook — worktree-remove-guard.js
// ============================================================================

describe('Layer 3 — worktree-remove-guard.js PreToolUse hook existence', () => {

  it('worktree-remove-guard.js file exists', () => {
    assert.ok(
      fs.existsSync(REMOVE_GUARD_PATH),
      `worktree-remove-guard.js must exist at ${REMOVE_GUARD_PATH}`
    );
  });

  it('is a valid JS file (non-empty)', () => {
    assert.ok(
      removeGuardSrc.length > 100,
      'worktree-remove-guard.js must contain substantial content (>100 chars)'
    );
  });
});

describe('Layer 3 — worktree-remove-guard.js detects git worktree remove commands', () => {

  it('contains a function to detect git worktree remove commands', () => {
    assert.ok(
      removeGuardSrc.includes('git worktree remove') ||
      removeGuardSrc.includes("'worktree'") && removeGuardSrc.includes("'remove'"),
      'worktree-remove-guard.js must contain logic to detect "git worktree remove" commands'
    );
  });

  it('contains extractWorktreeRemovePath or equivalent function', () => {
    assert.ok(
      removeGuardSrc.includes('extractWorktreeRemovePath') ||
      removeGuardSrc.includes('worktreeRemovePath'),
      'worktree-remove-guard.js must have a function that extracts the worktree path from git commands'
    );
  });

  it('uses a tokenizer to parse shell commands', () => {
    assert.ok(
      removeGuardSrc.includes('tokenize'),
      'worktree-remove-guard.js must tokenize shell commands rather than naive string matching'
    );
  });

  it('only guards paths inside .claude/worktrees/', () => {
    assert.ok(
      removeGuardSrc.includes('.claude/worktrees/'),
      'worktree-remove-guard.js must only block removals of paths inside .claude/worktrees/'
    );
  });
});

describe('Layer 3 — worktree-remove-guard.js session ownership check', () => {

  it('reads CLAUDE_AGENT_ID from environment', () => {
    assert.ok(
      removeGuardSrc.includes('CLAUDE_AGENT_ID'),
      'worktree-remove-guard.js must read CLAUDE_AGENT_ID env var to identify the current session'
    );
  });

  it('reads CLAUDE_QUEUE_ID from environment', () => {
    assert.ok(
      removeGuardSrc.includes('CLAUDE_QUEUE_ID'),
      'worktree-remove-guard.js must read CLAUDE_QUEUE_ID env var to identify the current queue entry'
    );
  });

  it('queries session-queue.db for ownership', () => {
    assert.ok(
      removeGuardSrc.includes('session-queue.db'),
      'worktree-remove-guard.js must query session-queue.db to determine worktree ownership'
    );
  });

  it('checks worktree_path and cwd columns in the ownership query', () => {
    assert.ok(
      removeGuardSrc.includes('worktree_path') && removeGuardSrc.includes('cwd = ?'),
      'worktree-remove-guard.js must check both worktree_path and cwd columns in its queue query'
    );
  });

  it('allows self-cleanup (current session removing its own worktree)', () => {
    // The hook must allow when only the current session owns the worktree
    assert.ok(
      removeGuardSrc.includes('Only we own it') ||
      removeGuardSrc.includes('self-cleanup') ||
      removeGuardSrc.includes('ownEntry') || removeGuardSrc.includes('otherEntries'),
      'worktree-remove-guard.js must allow self-cleanup (agent removing its own worktree after merge)'
    );
  });

  it('emits a deny decision when another active session owns the worktree', () => {
    assert.ok(
      removeGuardSrc.includes("permissionDecision: 'deny'") || removeGuardSrc.includes('"permissionDecision": "deny"'),
      "worktree-remove-guard.js must output { permissionDecision: 'deny' } when another session owns the worktree"
    );
  });
});

describe('Layer 3 — worktree-remove-guard.js fail-open behavior', () => {

  it('uses fail-open (allow: true) when the DB module is unavailable', () => {
    assert.ok(
      removeGuardSrc.includes('return { allow: true }'),
      'worktree-remove-guard.js must fail-open (return allow: true) when better-sqlite3 is unavailable'
    );
  });

  it('uses fail-open on DB errors', () => {
    // There should be a catch block that returns allow: true
    assert.ok(
      removeGuardSrc.includes('DB error') ||
      (removeGuardSrc.includes('} catch') && removeGuardSrc.includes('allow: true')),
      'worktree-remove-guard.js must return allow: true in catch blocks (fail-open on errors)'
    );
  });

  it('uses fail-open when DB file does not exist', () => {
    assert.ok(
      removeGuardSrc.includes('No DB file') ||
      (removeGuardSrc.includes('existsSync') && removeGuardSrc.includes('allow: true')),
      'worktree-remove-guard.js must return allow: true when session-queue.db does not exist'
    );
  });

  it('fast-paths allow for non-Bash tool names', () => {
    assert.ok(
      removeGuardSrc.includes("toolName !== 'Bash'"),
      "worktree-remove-guard.js must immediately allow when the tool is not 'Bash'"
    );
  });

  it('fast-paths allow when command does not contain worktree', () => {
    assert.ok(
      removeGuardSrc.includes("command.includes('worktree')"),
      "worktree-remove-guard.js must fast-exit allow when command doesn't contain 'worktree'"
    );
  });

  it('fatal errors are caught and fail-open at the top level', () => {
    assert.ok(
      removeGuardSrc.includes('main().catch'),
      'worktree-remove-guard.js must catch top-level errors and fail-open'
    );
  });
});

// ============================================================================
// LAYER 4: Rescue prompt hardening (hourly-automation.js)
// ============================================================================

describe('Layer 4 — rescueAbandonedWorktrees() prompt hardening (hourly-automation.js)', () => {

  it("rescue prompt contains 'Do NOT remove the worktree'", () => {
    assert.ok(
      rescueBody.includes('Do NOT remove the worktree'),
      "The rescue project-manager prompt must explicitly say 'Do NOT remove the worktree directory' to prevent rescue agents from accidentally triggering Bug #6"
    );
  });

  it('rescue prompt explains that cleanup automation handles removal', () => {
    assert.ok(
      rescueBody.includes('cleanup automation will handle'),
      'The rescue prompt must explain that the cleanup automation handles worktree removal so rescue agents know why they must not do it'
    );
  });
});

describe('Layer 4 — rescueAbandonedWorktrees() pre-enqueue worktree dedup (hourly-automation.js)', () => {

  it('has a worktree dedup check before calling enqueueSession', () => {
    assert.ok(
      rescueBody.includes('worktree dedup') ||
      rescueBody.includes('session already exists for this worktree') ||
      rescueBody.includes('Rescue: skipping') && rescueBody.includes('session already exists'),
      'rescueAbandonedWorktrees must check the session-queue for an existing session before enqueuing, to avoid creating duplicate rescue agents'
    );
  });

  it('queries session-queue.db in the pre-enqueue dedup check', () => {
    // The rescue body should contain a second DB query for the dedup check
    assert.ok(
      rescueBody.includes('session-queue.db'),
      'rescueAbandonedWorktrees pre-enqueue dedup must query session-queue.db'
    );
  });

  it('checks worktree_path and cwd in the pre-enqueue dedup query', () => {
    assert.ok(
      rescueBody.includes('worktree_path = ?') || rescueBody.includes('worktree_path'),
      'rescueAbandonedWorktrees pre-enqueue dedup query must check worktree_path'
    );
  });

  it('normalizes the worktree path in the pre-enqueue dedup check', () => {
    assert.ok(
      rescueBody.includes(".replace(/\\/+$/, '')") ||
      rescueBody.includes('.replace'),
      'rescueAbandonedWorktrees must normalize worktree paths (strip trailing slashes) in the pre-enqueue dedup check'
    );
  });

  it('skips enqueue and logs when a duplicate session is found', () => {
    assert.ok(
      rescueBody.includes('continue') && rescueBody.includes('session already exists'),
      "rescueAbandonedWorktrees must skip rescue ('continue') and log when a session already exists for the worktree"
    );
  });

  it('dedup failure is non-fatal (does not abort rescue for other worktrees)', () => {
    assert.ok(
      rescueBody.includes('non-fatal') || rescueBody.includes('worktree dedup check failed'),
      'rescueAbandonedWorktrees worktree dedup check failure must be non-fatal (logged but not thrown)'
    );
  });
});
