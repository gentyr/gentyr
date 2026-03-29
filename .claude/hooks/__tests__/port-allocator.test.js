/**
 * Tests for port-allocator.js
 *
 * Validates per-worktree port block allocation, idempotency, arithmetic,
 * release-and-reuse, limits, and corrupt-state recovery.
 *
 * Run with: node --test .claude/hooks/__tests__/port-allocator.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Setup: create a temp dir, point CLAUDE_PROJECT_DIR at it, then import
// ============================================================================

// We need STATE_PATH to be computed AFTER setting the env var, so we use
// a module-level temp dir created before importing the module under test.

let tmpDir;
let allocatePortBlock, releasePortBlock, getPortBlock;

before(async () => {
  // Create temp dir structure
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-allocator-test-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });

  // Set env var BEFORE dynamic import so STATE_PATH is computed correctly
  process.env.CLAUDE_PROJECT_DIR = tmpDir;

  // Dynamic import resolves STATE_PATH from env at module load time
  const mod = await import(
    // Use file URL to avoid Node caching issues with relative paths
    new URL(
      '../lib/port-allocator.js',
      import.meta.url
    ).href + `?bust=${Date.now()}`
  );
  allocatePortBlock = mod.allocatePortBlock;
  releasePortBlock = mod.releasePortBlock;
  getPortBlock = mod.getPortBlock;
});

// Helper: delete the state file so each test starts fresh
function resetState() {
  const stateFile = path.join(tmpDir, '.claude', 'state', 'port-allocations.json');
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
  // Also remove any .tmp artifact
  const tmpFile = stateFile + '.tmp';
  if (fs.existsSync(tmpFile)) {
    fs.unlinkSync(tmpFile);
  }
}

afterEach(() => {
  resetState();
});

// ============================================================================
// Test 1: Idempotency
// ============================================================================

describe('allocatePortBlock() idempotency', () => {
  it('returns the same block when called twice for the same path', () => {
    const path1 = '/worktrees/feature-abc';
    const first = allocatePortBlock(path1);
    const second = allocatePortBlock(path1);

    assert.strictEqual(first.basePort, second.basePort, 'basePort must be stable across calls');
    assert.strictEqual(first.webPort, second.webPort, 'webPort must be stable');
    assert.strictEqual(first.backendPort, second.backendPort, 'backendPort must be stable');
    assert.strictEqual(first.bridgePort, second.bridgePort, 'bridgePort must be stable');
  });
});

// ============================================================================
// Test 2: Sequential allocation — non-overlapping blocks
// ============================================================================

describe('allocatePortBlock() sequential allocation', () => {
  it('allocates non-overlapping blocks: first gets 3100, second gets 3200', () => {
    const pathA = '/worktrees/feature-a';
    const pathB = '/worktrees/feature-b';

    const blockA = allocatePortBlock(pathA);
    const blockB = allocatePortBlock(pathB);

    assert.strictEqual(blockA.basePort, 3100, 'First allocation must start at 3100');
    assert.strictEqual(blockB.basePort, 3200, 'Second allocation must start at 3200');

    // Verify blocks do not overlap (each spans basePort to basePort+2)
    assert.ok(
      blockB.basePort - blockA.basePort >= 3,
      'Port blocks must not overlap (need at least 3 ports separation)'
    );
  });
});

// ============================================================================
// Test 3: Port arithmetic
// ============================================================================

describe('allocatePortBlock() port arithmetic', () => {
  it('webPort === basePort, backendPort === basePort+1, bridgePort === basePort+2', () => {
    const block = allocatePortBlock('/worktrees/test-arithmetic');

    assert.strictEqual(block.webPort, block.basePort, 'webPort must equal basePort');
    assert.strictEqual(block.backendPort, block.basePort + 1, 'backendPort must be basePort+1');
    assert.strictEqual(block.bridgePort, block.basePort + 2, 'bridgePort must be basePort+2');
  });
});

// ============================================================================
// Test 4: Release frees the slot
// ============================================================================

describe('releasePortBlock() frees slot for reuse', () => {
  it('after releasing /path/a, the next allocation for /path/b reuses basePort 3100', () => {
    const pathA = '/worktrees/release-test-a';
    const pathB = '/worktrees/release-test-b';

    // Allocate A (slot 0 → 3100)
    const blockA = allocatePortBlock(pathA);
    assert.strictEqual(blockA.basePort, 3100, 'First allocation should get 3100');

    // Release A
    releasePortBlock(pathA);

    // Now allocate B — should reuse slot 0
    const blockB = allocatePortBlock(pathB);
    assert.strictEqual(blockB.basePort, 3100, 'After release, next allocation should reuse 3100');
  });
});

// ============================================================================
// Test 5: getPortBlock returns null for unknown path
// ============================================================================

describe('getPortBlock() for unknown path', () => {
  it('returns null when path was never allocated', () => {
    const result = getPortBlock('/worktrees/never-allocated');
    assert.strictEqual(result, null, 'getPortBlock must return null for unallocated path');
  });
});

// ============================================================================
// Test 6: getPortBlock returns the block for an allocated path
// ============================================================================

describe('getPortBlock() for allocated path', () => {
  it('returns correct block with proper arithmetic after allocation', () => {
    const worktreePath = '/worktrees/get-block-test';
    const allocated = allocatePortBlock(worktreePath);
    const retrieved = getPortBlock(worktreePath);

    assert.notStrictEqual(retrieved, null, 'getPortBlock must return a block for allocated path');
    assert.strictEqual(retrieved.basePort, allocated.basePort, 'basePort must match');
    assert.strictEqual(retrieved.webPort, retrieved.basePort, 'webPort === basePort');
    assert.strictEqual(retrieved.backendPort, retrieved.basePort + 1, 'backendPort === basePort+1');
    assert.strictEqual(retrieved.bridgePort, retrieved.basePort + 2, 'bridgePort === basePort+2');
  });
});

// ============================================================================
// Test 7: Max worktrees limit
// ============================================================================

describe('allocatePortBlock() max worktrees limit', () => {
  it('throws when all 50 slots are filled and a 51st is requested', () => {
    // Allocate all 50 slots
    for (let i = 0; i < 50; i++) {
      allocatePortBlock(`/worktrees/slot-${i}`);
    }

    // The 51st must throw
    assert.throws(
      () => allocatePortBlock('/worktrees/slot-overflow'),
      (err) => {
        assert.ok(
          err.message.includes('Port allocator: exceeded max 50 worktrees'),
          `Expected "Port allocator: exceeded max 50 worktrees", got: ${err.message}`
        );
        return true;
      },
      'Must throw when max worktrees exceeded'
    );
  });
});

// ============================================================================
// Test 8: Corrupt state file recovery
// ============================================================================

describe('allocatePortBlock() corrupt state file recovery', () => {
  it('starts fresh when state file contains malformed JSON', () => {
    const stateFile = path.join(tmpDir, '.claude', 'state', 'port-allocations.json');

    // Write malformed JSON
    fs.writeFileSync(stateFile, '{ this is not valid JSON !!!', 'utf8');

    // Should not throw — recovers to empty state
    let block;
    assert.doesNotThrow(() => {
      block = allocatePortBlock('/worktrees/after-corrupt');
    }, 'Must not throw on corrupt state file');

    // Should start from slot 0 (3100) since state is reset
    assert.strictEqual(block.basePort, 3100, 'After corrupt recovery, first slot must be 3100');
  });
});

// ============================================================================
// Test 9: Atomic write — .tmp file is cleaned up
// ============================================================================

describe('allocatePortBlock() atomic write', () => {
  it('.tmp file does not exist after allocation completes', () => {
    const stateFile = path.join(tmpDir, '.claude', 'state', 'port-allocations.json');
    const tmpFile = stateFile + '.tmp';

    allocatePortBlock('/worktrees/atomic-write-test');

    assert.ok(
      !fs.existsSync(tmpFile),
      '.tmp file must not exist after successful atomic write'
    );
    assert.ok(
      fs.existsSync(stateFile),
      'state file must exist after allocation'
    );
  });
});
