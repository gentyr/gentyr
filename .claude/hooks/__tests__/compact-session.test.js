/**
 * Tests for lib/compact-session.js
 *
 * Covers:
 *   Fix 2 — compactRequested flag bypass in compactSessionIfNeeded():
 *     1. compactRequested:true causes function to enter compaction branch (reaches
 *        execFileSync) even when token count is below minTokens
 *     2. compactRequested:false returns null when tokens are below threshold
 *     3. Missing tracker file returns null when tokens are below threshold
 *
 *   Utility functions:
 *     4. readCompactTracker() returns {} when file is missing
 *     5. readCompactTracker() returns {} on corrupt JSON (fail-open)
 *     6. readCompactTracker() returns parsed object when file is valid
 *     7. recordCompactEvent() sets compactRequested:false on the recorded entry
 *     8. getTimeSinceLastCompact() returns Infinity for unknown session
 *
 * Strategy:
 *   - All tests that call compactSessionIfNeeded() use dynamic import() with
 *     CLAUDE_PROJECT_DIR pre-set so module-level TRACKER_PATH points to the
 *     test's temp directory.
 *   - Each describe group that needs a different CLAUDE_PROJECT_DIR gets its
 *     own dynamic import with a ?bust=<unique> cache-buster.
 *   - For the compactRequested:true test, we create a fake session JSONL under
 *     ~/.claude/projects/{encoded-tmpDir}/ because findSessionJsonl() always
 *     resolves paths relative to os.homedir().
 *
 * Run with: node --test .claude/hooks/__tests__/compact-session.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', 'lib', 'compact-session.js');
const MODULE_URL = new URL('../lib/compact-session.js', import.meta.url).href;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temp project directory and its .claude/state/ subdirectory.
 * Returns { projectDir, stateDir, cleanup }.
 */
function createTempProject(label) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `compact-test-${label}-`));
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  function cleanup() {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  return { projectDir, stateDir, cleanup };
}

/**
 * Compute the encoded project directory name as getSessionDir() does.
 * Returns the path under ~/.claude/projects/ that findSessionJsonl() will look in.
 */
function getEncodedSessionDir(projectDir) {
  const projectsBase = path.join(os.homedir(), '.claude', 'projects');
  const encoded = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(projectsBase, encoded);
}

/**
 * Create a minimal session JSONL file in the correct location so that
 * findSessionJsonl(sessionId, projectDir) returns a non-null path.
 *
 * The file contains one assistant message with a low token count so that
 * the token threshold alone does not trigger compaction.
 *
 * Returns the directory and file path created.
 */
function createFakeSessionJsonl(sessionId, projectDir, tokenCount = 50000) {
  const sessionDir = getEncodedSessionDir(projectDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
  const entry = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      usage: {
        input_tokens: tokenCount,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
    },
  };
  fs.writeFileSync(jsonlPath, JSON.stringify(entry) + '\n');

  return { sessionDir, jsonlPath };
}

/**
 * Write a compact tracker file.
 */
function writeTracker(stateDir, data) {
  const trackerPath = path.join(stateDir, 'compact-tracker.json');
  fs.writeFileSync(trackerPath, JSON.stringify(data, null, 2));
  return trackerPath;
}

// ============================================================================
// Test Group 1: Fix 2 — compactRequested flag bypass in compactSessionIfNeeded()
// ============================================================================

describe('compactSessionIfNeeded() — Fix 2: compactRequested flag bypass', () => {
  let ctx;
  let compactSessionIfNeeded;
  let sessionDir;

  const SESSION_ID = 'test-session-fix2-001';

  before(async () => {
    ctx = createTempProject('fix2');

    // Set env var BEFORE dynamic import so module-level TRACKER_PATH resolves correctly
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(MODULE_URL + `?bust=${Date.now()}-fix2`);
    compactSessionIfNeeded = mod.compactSessionIfNeeded;

    // Create the fake session JSONL so findSessionJsonl() returns non-null.
    // 50,000 tokens is well below the default 200,000 minTokens threshold.
    const result = createFakeSessionJsonl(SESSION_ID, ctx.projectDir, 50000);
    sessionDir = result.sessionDir;
  });

  after(() => {
    ctx?.cleanup();
    // Clean up the fake session directory under ~/.claude/projects/
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  });

  it('throws (enters compaction branch) when compactRequested:true, even at low token count', () => {
    // Write tracker with compactRequested: true for this session
    writeTracker(ctx.stateDir, {
      [SESSION_ID]: {
        compactRequested: true,
        lastCompactAt: new Date().toISOString(),
        compactCount: 0,
      },
    });

    // compactSessionIfNeeded() should pass the trigger guard (agentRequested=true),
    // acquire the lock, then call execFileSync('claude', ...) which throws because
    // 'claude' is not available in the test environment. This throw proves the function
    // reached line 319 (the compaction branch) rather than returning null at line 274.
    assert.throws(
      () => compactSessionIfNeeded(SESSION_ID, ctx.projectDir, { minTokens: 200000 }),
      (err) => {
        // execFileSync throws an error when the binary is not found or fails.
        // Any thrown error confirms the function entered the compaction branch.
        assert.ok(err instanceof Error, 'should throw an Error instance');
        return true;
      },
      'should throw because execFileSync("claude") fails — proving compaction was triggered',
    );
  });

  it('returns null when compactRequested:false and tokens are below threshold', () => {
    // Write tracker with compactRequested: false
    writeTracker(ctx.stateDir, {
      [SESSION_ID]: {
        compactRequested: false,
        lastCompactAt: new Date().toISOString(),
        compactCount: 1,
      },
    });

    // 50K tokens < 200K minTokens, not time-triggered, agentRequested=false → null
    const result = compactSessionIfNeeded(SESSION_ID, ctx.projectDir, {
      minTokens: 200000,
      maxMinutesSinceCompact: 30,
    });

    assert.strictEqual(result, null, 'should return null when no trigger condition is met');
  });

  it('returns null when tracker file is missing and tokens are below threshold', () => {
    // Ensure no tracker file exists
    const trackerPath = path.join(ctx.stateDir, 'compact-tracker.json');
    try { fs.unlinkSync(trackerPath); } catch { /* already gone */ }

    // readCompactTracker() returns {} → agentRequested=false; tokens are low → null
    const result = compactSessionIfNeeded(SESSION_ID, ctx.projectDir, {
      minTokens: 200000,
      maxMinutesSinceCompact: 30,
    });

    assert.strictEqual(result, null, 'should return null when tracker is missing and no trigger fires');
  });
});

// ============================================================================
// Test Group 2: readCompactTracker() behaviour
// ============================================================================

describe('readCompactTracker() — tracker file reading', () => {
  let ctx;
  let readCompactTracker;

  before(async () => {
    ctx = createTempProject('read-tracker');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(MODULE_URL + `?bust=${Date.now()}-read-tracker`);
    readCompactTracker = mod.readCompactTracker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns {} when tracker file does not exist', () => {
    // No file written — readCompactTracker should return empty object
    const result = readCompactTracker();
    assert.deepStrictEqual(result, {}, 'should return {} for missing file');
  });

  it('returns {} when tracker file contains corrupt JSON', () => {
    writeTracker(ctx.stateDir, null); // write valid first
    // Overwrite with garbage
    fs.writeFileSync(
      path.join(ctx.stateDir, 'compact-tracker.json'),
      '{ this is definitely not valid JSON !!! ][',
    );

    const result = readCompactTracker();
    assert.deepStrictEqual(result, {}, 'should return {} on JSON parse error (fail-open)');
  });

  it('returns the parsed object when the file is valid JSON', () => {
    const expected = {
      'session-abc': {
        compactRequested: true,
        lastCompactAt: '2026-01-01T00:00:00.000Z',
        compactCount: 3,
      },
    };
    writeTracker(ctx.stateDir, expected);

    const result = readCompactTracker();
    assert.deepStrictEqual(result, expected, 'should return parsed object for valid file');
  });
});

// ============================================================================
// Test Group 3: recordCompactEvent() sets compactRequested:false
// ============================================================================

describe('recordCompactEvent() — clears compactRequested flag', () => {
  let ctx;
  let recordCompactEvent;
  let readCompactTracker;

  before(async () => {
    ctx = createTempProject('record-compact');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(MODULE_URL + `?bust=${Date.now()}-record-compact`);
    recordCompactEvent = mod.recordCompactEvent;
    readCompactTracker = mod.readCompactTracker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('sets compactRequested:false on the recorded entry', () => {
    const sessionId = 'session-record-001';

    // Pre-seed the tracker with compactRequested:true and compactCount:0 to verify it gets cleared
    writeTracker(ctx.stateDir, {
      [sessionId]: {
        compactRequested: true,
        lastCompactAt: new Date(Date.now() - 60000).toISOString(),
        compactCount: 0,
      },
    });

    recordCompactEvent(sessionId, 250000);

    const tracker = readCompactTracker();
    const entry = tracker[sessionId];

    assert.ok(entry, 'entry should exist after recordCompactEvent');
    assert.strictEqual(entry.compactRequested, false, 'compactRequested should be false after recording');
    assert.strictEqual(typeof entry.lastCompactAt, 'string', 'lastCompactAt should be a string');
    assert.strictEqual(entry.lastCompactTokens, 250000, 'lastCompactTokens should match preTokens argument');
    assert.strictEqual(entry.compactCount, 1, 'compactCount should increment (was 0, now 1)');
  });

  it('creates a new entry with compactRequested:false when none existed before', () => {
    const sessionId = 'session-record-new';

    // No pre-existing entry
    const trackerPath = path.join(ctx.stateDir, 'compact-tracker.json');
    try { fs.unlinkSync(trackerPath); } catch { /* already gone */ }

    recordCompactEvent(sessionId, 180000);

    const tracker = readCompactTracker();
    const entry = tracker[sessionId];

    assert.ok(entry, 'entry should be created');
    assert.strictEqual(entry.compactRequested, false, 'compactRequested should be false on new entry');
    assert.strictEqual(entry.compactCount, 1, 'compactCount should start at 1');
    assert.strictEqual(entry.lastCompactTokens, 180000, 'lastCompactTokens should be set');
  });
});

// ============================================================================
// Test Group 4: getTimeSinceLastCompact()
// ============================================================================

describe('getTimeSinceLastCompact() — time since last compaction', () => {
  let ctx;
  let getTimeSinceLastCompact;
  let readCompactTracker;
  let writeCompactTracker;

  before(async () => {
    ctx = createTempProject('time-since');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(MODULE_URL + `?bust=${Date.now()}-time-since`);
    getTimeSinceLastCompact = mod.getTimeSinceLastCompact;
    readCompactTracker = mod.readCompactTracker;
    writeCompactTracker = mod.writeCompactTracker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns Infinity for a session that has never been compacted', () => {
    // No entry in tracker for this session
    const trackerPath = path.join(ctx.stateDir, 'compact-tracker.json');
    try { fs.unlinkSync(trackerPath); } catch { /* already gone */ }

    const result = getTimeSinceLastCompact('never-compacted-session');
    assert.strictEqual(result, Infinity, 'should return Infinity for unknown session');
  });

  it('returns Infinity for a session present in tracker but with no lastCompactAt', () => {
    writeTracker(ctx.stateDir, {
      'session-no-timestamp': {
        compactRequested: false,
        compactCount: 0,
        // no lastCompactAt
      },
    });

    const result = getTimeSinceLastCompact('session-no-timestamp');
    assert.strictEqual(result, Infinity, 'should return Infinity when lastCompactAt is absent');
  });

  it('returns a non-Infinity number for a recently compacted session', () => {
    const sessionId = 'session-recent-compact';
    const recentTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago

    writeTracker(ctx.stateDir, {
      [sessionId]: {
        lastCompactAt: recentTime,
        compactRequested: false,
        compactCount: 1,
      },
    });

    const result = getTimeSinceLastCompact(sessionId);

    assert.ok(result !== Infinity, 'should not be Infinity for a session with lastCompactAt');
    assert.ok(typeof result === 'number', 'result should be a number');
    assert.ok(result >= 0, 'elapsed time should be non-negative');
    assert.ok(result < 60000, 'elapsed time should be less than 60 seconds for a recently compacted session');
  });
});

// ============================================================================
// Test Group 5: compactSessionIfNeeded() returns null when session JSONL missing
// ============================================================================

describe('compactSessionIfNeeded() — returns null when session file not found', () => {
  let ctx;
  let compactSessionIfNeeded;

  before(async () => {
    ctx = createTempProject('no-session-file');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(MODULE_URL + `?bust=${Date.now()}-no-session-file`);
    compactSessionIfNeeded = mod.compactSessionIfNeeded;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns null when no session JSONL file exists, even with compactRequested:true', () => {
    const sessionId = 'session-no-jsonl';

    // Write compactRequested:true in the tracker — but no JSONL file exists
    writeTracker(ctx.stateDir, {
      [sessionId]: {
        compactRequested: true,
        lastCompactAt: new Date().toISOString(),
        compactCount: 0,
      },
    });

    // findSessionJsonl returns null → function returns null at line 254 (before Fix 2)
    const result = compactSessionIfNeeded(sessionId, ctx.projectDir, { minTokens: 200000 });
    assert.strictEqual(result, null, 'should return null when session JSONL file does not exist');
  });
});
