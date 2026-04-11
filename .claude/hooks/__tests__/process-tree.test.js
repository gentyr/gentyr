/**
 * Unit tests for process-tree.js
 *
 * Tests the three exported functions:
 *   - killProcessGroup(pid, signal)       — sends signal to -pid (process group)
 *   - killProcessGroupEscalated(pid)      — SIGTERM then SIGKILL with 5s wait
 *   - killProcessesInDirectory(dirPath)   — lsof + ps based directory kill
 *
 * Strategy: spawn real child processes (sleep / tail) to exercise the kill
 * paths. This validates behaviour without mocking process.kill(), which would
 * give false confidence for infrastructure this critical.
 *
 * Run with: node --test .claude/hooks/__tests__/process-tree.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROCESS_TREE_PATH = path.join(__dirname, '..', 'lib', 'process-tree.js');

// ============================================================================
// Module Import
// ============================================================================

let killProcessGroup, killProcessGroupEscalated, killProcessesInDirectory;

before(async () => {
  // Cache-bust to avoid stale module cache between test runs
  const mod = await import(PROCESS_TREE_PATH + `?bust=${Date.now()}`);
  killProcessGroup = mod.killProcessGroup;
  killProcessGroupEscalated = mod.killProcessGroupEscalated;
  killProcessesInDirectory = mod.killProcessesInDirectory;
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Spawn a detached long-lived process (sleep) and return its PID.
 * The spawned process is the leader of its own process group.
 */
function spawnSleepDetached(seconds = 60) {
  const proc = spawn('sleep', [String(seconds)], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return proc.pid;
}

/**
 * Spawn a detached tail -f on a file, returning the PID.
 */
function spawnTailDetached(filePath) {
  const proc = spawn('tail', ['-f', filePath], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return proc.pid;
}

/**
 * Check whether a PID is alive using a signal-0 probe.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Poll predicate() every pollMs until it returns true or maxMs elapses.
 * Returns true if the predicate succeeded within the time limit.
 */
async function waitFor(predicate, maxMs = 3000, pollMs = 50) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

// ============================================================================
// killProcessGroup() — input validation
// ============================================================================

describe('killProcessGroup() — input validation', () => {
  it('returns false for pid === 0', () => {
    assert.strictEqual(killProcessGroup(0), false);
  });

  it('returns false for negative pid', () => {
    assert.strictEqual(killProcessGroup(-1), false);
  });

  it('returns false for null', () => {
    assert.strictEqual(killProcessGroup(null), false);
  });

  it('returns false for undefined', () => {
    assert.strictEqual(killProcessGroup(undefined), false);
  });

  it('returns false for non-existent PID without throwing', () => {
    // 2147483647 is INT_MAX and is not a live PID
    const result = killProcessGroup(2147483647, 'SIGTERM');
    assert.strictEqual(result, false, 'Must return false for ESRCH, not throw');
  });
});

// ============================================================================
// killProcessGroup() — live process
// ============================================================================

describe('killProcessGroup() — terminates a live process group', () => {
  it('returns true and the process dies after SIGTERM', async () => {
    const pid = spawnSleepDetached(60);
    assert.ok(pid > 0, 'sleep must have a valid PID');
    assert.ok(isAlive(pid), 'sleep must be alive before kill');

    const result = killProcessGroup(pid, 'SIGTERM');

    assert.strictEqual(result, true, 'Must return true when signal is sent successfully');

    const died = await waitFor(() => !isAlive(pid), 3000);
    assert.ok(died, 'Process must die after SIGTERM to its process group');
  });
});

// ============================================================================
// killProcessGroupEscalated() — input validation (fast paths)
// ============================================================================

describe('killProcessGroupEscalated() — fast-path returns for invalid PIDs', () => {
  it('resolves without error for pid === 0', async () => {
    await assert.doesNotReject(() => killProcessGroupEscalated(0));
  });

  it('resolves without error for negative pid', async () => {
    await assert.doesNotReject(() => killProcessGroupEscalated(-5));
  });

  it('resolves without error for null', async () => {
    await assert.doesNotReject(() => killProcessGroupEscalated(null));
  });

  it('resolves without error for undefined', async () => {
    await assert.doesNotReject(() => killProcessGroupEscalated(undefined));
  });
});

// ============================================================================
// killProcessGroupEscalated() — terminates a live process
// ============================================================================

describe('killProcessGroupEscalated() — terminates a live process', () => {
  it('kills a live sleep process and resolves after process death', async () => {
    const pid = spawnSleepDetached(60);
    assert.ok(isAlive(pid), 'sleep must be alive before escalated kill');

    await killProcessGroupEscalated(pid);

    // After the promise resolves the process must be gone
    assert.ok(!isAlive(pid), 'Process must be dead after killProcessGroupEscalated() resolves');
  });
});

// ============================================================================
// killProcessesInDirectory() — empty / missing directory
// ============================================================================

describe('killProcessesInDirectory() — empty or missing directory', () => {
  it('returns { killed: [], errors: [] } for a directory with no open files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptree-empty-'));
    try {
      const result = killProcessesInDirectory(dir);
      assert.ok(Array.isArray(result.killed), 'killed must be an Array');
      assert.ok(Array.isArray(result.errors), 'errors must be an Array');
      assert.strictEqual(result.killed.length, 0);
      assert.strictEqual(result.errors.length, 0);
    } finally {
      try { rmSync(dir, { recursive: true }); } catch (_) {}
    }
  });

  it('returns { killed: [], errors: [] } for a non-existent path without throwing', () => {
    const result = killProcessesInDirectory('/tmp/ptree-nonexistent-xyz-99999');
    assert.ok(Array.isArray(result.killed), 'killed must be an Array');
    assert.ok(Array.isArray(result.errors), 'errors must be an Array');
  });
});

// ============================================================================
// killProcessesInDirectory() — kills process with open files in directory
// ============================================================================

describe('killProcessesInDirectory() — kills process holding files open in directory', () => {
  it('kills a tail -f process and the result has at least one killed entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptree-kill-'));
    const targetFile = join(dir, 'held.txt');
    writeFileSync(targetFile, 'test data');

    const pid = spawnTailDetached(targetFile);
    assert.ok(pid > 0, 'tail must have a valid PID');

    // Give tail time to open the file descriptor
    await new Promise(r => setTimeout(r, 400));

    assert.ok(isAlive(pid), 'tail must be alive before killProcessesInDirectory()');

    try {
      const result = killProcessesInDirectory(dir);

      assert.ok(Array.isArray(result.killed), 'killed must be an Array');
      assert.ok(Array.isArray(result.errors), 'errors must be an Array');
      assert.ok(
        result.killed.length >= 1,
        `Expected at least 1 killed entry, got ${result.killed.length}`,
      );

      // Wait for the tail process to actually die
      const died = await waitFor(() => !isAlive(pid), 3000);
      assert.ok(died, 'tail process must die after killProcessesInDirectory()');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      try { rmSync(dir, { recursive: true }); } catch (_) {}
    }
  });
});

// ============================================================================
// killProcessesInDirectory() — result shape invariants
// ============================================================================

describe('killProcessesInDirectory() — result shape invariants', () => {
  it('always returns an object with killed (Array<number>) and errors (Array)', () => {
    // /tmp is real and has open files — good stress case without needing setup
    const result = killProcessesInDirectory(tmpdir());
    assert.ok(typeof result === 'object' && result !== null, 'Must return a non-null object');
    assert.ok(Array.isArray(result.killed), 'killed must be an Array');
    assert.ok(Array.isArray(result.errors), 'errors must be an Array');
    for (const entry of result.killed) {
      assert.strictEqual(typeof entry, 'number', `killed entry must be a number, got ${typeof entry}`);
      assert.ok(entry > 0, `killed entry must be positive, got ${entry}`);
    }
  });
});

// ============================================================================
// Source structure validation (static analysis)
// ============================================================================

describe('process-tree.js — source structure', () => {
  const code = readFileSync(PROCESS_TREE_PATH, 'utf8');

  it('exports killProcessGroup as a named export', () => {
    assert.match(code, /export function killProcessGroup/, 'Must have named export killProcessGroup');
  });

  it('exports killProcessGroupEscalated as a named export', () => {
    assert.match(code, /export async function killProcessGroupEscalated/, 'Must have named async export killProcessGroupEscalated');
  });

  it('exports killProcessesInDirectory as a named export', () => {
    assert.match(code, /export function killProcessesInDirectory/, 'Must have named export killProcessesInDirectory');
  });

  it('uses negative PID syntax for process group kill', () => {
    // The core invariant: process.kill(-pid, signal) targets the whole group
    assert.match(code, /process\.kill\(-pid/, 'Must use -pid (negative PID) for process group kill');
  });

  it('has SIGKILL escalation path in killProcessGroupEscalated', () => {
    assert.match(code, /SIGKILL/, 'killProcessGroupEscalated must include SIGKILL escalation');
  });

  it('uses lsof +D for directory-based process discovery', () => {
    assert.match(code, /lsof.*\+D|'\+D'/, 'killProcessesInDirectory must use lsof +D');
  });

  it('handles ESRCH gracefully (process already dead)', () => {
    assert.match(code, /ESRCH/, 'Must handle ESRCH (no such process) without throwing');
  });

  it('handles EPERM with fallback to lead PID kill', () => {
    assert.match(code, /EPERM/, 'Must handle EPERM permission errors');
  });
});
