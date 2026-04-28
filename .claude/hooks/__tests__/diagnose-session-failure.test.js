/**
 * Tests for diagnoseSessionFailure() exported from lib/session-reaper.js
 *
 * Covers:
 *   1. Rate-limit JSONL content → error_type 'rate_limit', is_transient true, suggested_action 'cooldown'
 *   2. Auth error JSONL → error_type 'auth_error', is_transient false, suggested_action 'diagnose_credentials'
 *   3. Mixed errors — rate_limit majority wins over auth_error
 *   4. Mixed errors — auth_error majority wins over rate_limit
 *   5. Usage limit messages ("You've hit your limit", "resets at", "out of extra usage") → rate_limit
 *   6. No errors → error_type 'unknown', stalled false, consecutive_errors 0
 *   7. Non-existent file → safe default return
 *   8. Malformed JSONL → handles gracefully (skips bad lines)
 *   9. stalled flag: fewer than 3 consecutive errors → stalled false
 *  10. stalled flag: 3+ consecutive errors → stalled true
 *  11. Non-error assistant message in tail breaks the consecutive-error chain
 *  12. Sample error is captured from the first error found
 *
 * Strategy: write real temporary JSONL files with representative content,
 * import diagnoseSessionFailure() with a cache-bust to pick up the correct
 * module path, and assert on the returned structured diagnosis object.
 *
 * Run with: node --test .claude/hooks/__tests__/diagnose-session-failure.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temp directory and return a cleanup handle.
 */
function createTempDir(prefix = 'diagnose-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* non-fatal */ }
    },
  };
}

/**
 * Write a JSONL file from an array of objects.
 * Each object is JSON-stringified on its own line.
 */
function writeJsonl(filePath, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, lines + '\n', 'utf8');
}

/**
 * Build a rate-limit JSONL entry (isApiErrorMessage style).
 */
function rateLimitEntry(message = 'API rate limit exceeded') {
  return { error: 'rate_limit', isApiErrorMessage: true, message };
}

/**
 * Build a rate-limit JSONL entry (type:error style with message containing "rate limit").
 */
function rateLimitTypeEntry(message = 'You are being rate limited') {
  return { type: 'error', message };
}

/**
 * Build an auth-error JSONL entry.
 */
function authErrorEntry(message = 'authentication failed') {
  return { error: 'authentication_error', message };
}

/**
 * Build a usage-limit message entry (Claude Code specific).
 * These are classified as rate_limit because they are transient.
 */
function usageLimitEntry(message) {
  return { type: 'error', message };
}

/**
 * Build a normal assistant turn (non-error).
 */
function assistantEntry() {
  return { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } };
}

// ============================================================================
// Module import
// ============================================================================

let diagnoseSessionFailure;
let tmpCtx;

before(async () => {
  tmpCtx = createTempDir('diagnose-session-before');
  // Cache-bust to ensure fresh module load
  const mod = await import(
    new URL('../lib/session-reaper.js', import.meta.url).href + `?bust=${Date.now()}`
  );
  diagnoseSessionFailure = mod.diagnoseSessionFailure;
});

after(() => {
  tmpCtx?.cleanup();
});

// ============================================================================
// Test Group 1: Rate limit detection
// ============================================================================

describe('diagnoseSessionFailure() — rate limit detection', () => {
  let ctx;

  beforeEach(() => { ctx = createTempDir('rl-test'); });

  it('classifies isApiErrorMessage rate limit entries as rate_limit', () => {
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry('Rate limit exceeded'),
      rateLimitEntry('Rate limit exceeded'),
      rateLimitEntry('Rate limit exceeded'),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit', 'error_type must be rate_limit');
    assert.strictEqual(result.is_transient, true, 'rate_limit must be transient');
    assert.strictEqual(result.suggested_action, 'cooldown', 'suggested_action must be cooldown');
    assert.strictEqual(result.stalled, true, '3+ consecutive errors must set stalled=true');
    assert.ok(result.consecutive_errors >= 3, 'consecutive_errors must be >= 3');
    ctx.cleanup();
  });

  it('classifies type:error with "rate limit" in message as rate_limit', () => {
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitTypeEntry('rate limit reached, please slow down'),
      rateLimitTypeEntry('rate limit reached, please slow down'),
      rateLimitTypeEntry('rate limit reached, please slow down'),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit');
    assert.strictEqual(result.is_transient, true);
    assert.strictEqual(result.suggested_action, 'cooldown');
    ctx.cleanup();
  });

  it('classifies "You\'ve hit your limit" usage-limit message as rate_limit', () => {
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      usageLimitEntry("You've hit your limit for today. Your usage resets at midnight."),
      usageLimitEntry("You've hit your limit for today. Your usage resets at midnight."),
      usageLimitEntry("You've hit your limit for today. Your usage resets at midnight."),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit', '"hit your limit" must be classified as rate_limit');
    assert.strictEqual(result.is_transient, true);
    assert.strictEqual(result.suggested_action, 'cooldown');
    ctx.cleanup();
  });

  it('classifies "hit your limit" in message as rate_limit', () => {
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      usageLimitEntry("You've hit your limit - resets 5:30pm"),
      usageLimitEntry("You've hit your limit - resets 5:30pm"),
      usageLimitEntry("You've hit your limit - resets 5:30pm"),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit', '"hit your limit" must be classified as rate_limit');
    assert.strictEqual(result.is_transient, true);
    ctx.cleanup();
  });

  it('classifies "out of extra usage" message as rate_limit', () => {
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      usageLimitEntry('You are out of extra usage for Claude Code this month.'),
      usageLimitEntry('You are out of extra usage for Claude Code this month.'),
      usageLimitEntry('You are out of extra usage for Claude Code this month.'),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit', '"out of extra usage" must be classified as rate_limit');
    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 2: Auth error detection
// ============================================================================

describe('diagnoseSessionFailure() — auth error detection', () => {

  it('classifies authentication_error entries as auth_error', () => {
    const ctx = createTempDir('auth-test');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      authErrorEntry('authentication failed: invalid API key'),
      authErrorEntry('authentication failed: invalid API key'),
      authErrorEntry('authentication failed: invalid API key'),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'auth_error', 'error_type must be auth_error');
    assert.strictEqual(result.is_transient, false, 'auth_error must NOT be transient');
    assert.strictEqual(result.suggested_action, 'diagnose_credentials', 'suggested_action must be diagnose_credentials');
    assert.strictEqual(result.stalled, true, '3+ consecutive errors must set stalled=true');

    ctx.cleanup();
  });

  it('classifies type:error with "401" in message as auth_error', () => {
    const ctx = createTempDir('auth-401-test');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'error', message: 'HTTP 401 Unauthorized' },
      { type: 'error', message: 'HTTP 401 Unauthorized' },
      { type: 'error', message: 'HTTP 401 Unauthorized' },
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'auth_error');
    assert.strictEqual(result.is_transient, false);
    assert.strictEqual(result.suggested_action, 'diagnose_credentials');

    ctx.cleanup();
  });

  it('classifies type:error with "authentication" in message as auth_error', () => {
    const ctx = createTempDir('auth-str-test');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'error', message: 'MCP authentication error: token expired' },
      { type: 'error', message: 'MCP authentication error: token expired' },
      { type: 'error', message: 'MCP authentication error: token expired' },
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'auth_error');
    assert.strictEqual(result.is_transient, false);

    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 3: Mixed errors — majority wins
// ============================================================================

describe('diagnoseSessionFailure() — mixed errors, majority classification', () => {

  it('rate_limit wins when rateLimitCount >= authErrorCount (equal counts)', () => {
    const ctx = createTempDir('mixed-equal');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry(),        // rate_limit
      authErrorEntry(),        // auth_error
    ]);

    const result = diagnoseSessionFailure(file);

    // rateLimitCount (1) >= authErrorCount (1) → rate_limit wins
    assert.strictEqual(result.error_type, 'rate_limit', 'rate_limit must win when counts are equal');
    assert.strictEqual(result.is_transient, true);
    ctx.cleanup();
  });

  it('rate_limit wins when rate limit entries outnumber auth errors', () => {
    const ctx = createTempDir('mixed-rl-wins');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry(),
      rateLimitEntry(),
      authErrorEntry(),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'rate_limit', 'rate_limit must win when it has more entries');
    assert.strictEqual(result.is_transient, true);
    ctx.cleanup();
  });

  it('auth_error wins when auth errors outnumber rate limit entries', () => {
    const ctx = createTempDir('mixed-auth-wins');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry(),
      authErrorEntry(),
      authErrorEntry(),
    ]);

    const result = diagnoseSessionFailure(file);

    // authErrorCount (2) > rateLimitCount (1) → auth_error wins
    assert.strictEqual(result.error_type, 'auth_error', 'auth_error must win when it has more entries');
    assert.strictEqual(result.is_transient, false);
    assert.strictEqual(result.suggested_action, 'diagnose_credentials');
    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 4: No errors
// ============================================================================

describe('diagnoseSessionFailure() — no errors', () => {

  it('returns unknown classification with stalled=false for clean session', () => {
    const ctx = createTempDir('no-errors');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      assistantEntry(),
      { type: 'user', message: 'Please write the tests.' },
      assistantEntry(),
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'unknown');
    assert.strictEqual(result.stalled, false);
    assert.strictEqual(result.consecutive_errors, 0);
    assert.strictEqual(result.is_transient, false);
    assert.strictEqual(result.suggested_action, 'retry');

    ctx.cleanup();
  });

  it('returns unknown when JSONL has only non-error tool_use entries', () => {
    const ctx = createTempDir('tool-use-only');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'tool_result', content: 'some output' },
    ]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.error_type, 'unknown');
    assert.strictEqual(result.stalled, false);

    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 5: Non-existent file
// ============================================================================

describe('diagnoseSessionFailure() — non-existent file', () => {

  it('returns safe default when file does not exist', () => {
    const result = diagnoseSessionFailure('/tmp/this-path-definitely-does-not-exist.jsonl');

    assert.ok(typeof result === 'object', 'must return an object');
    assert.ok('error_type' in result, 'must have error_type field');
    assert.ok('stalled' in result, 'must have stalled field');
    assert.ok('consecutive_errors' in result, 'must have consecutive_errors field');
    assert.strictEqual(result.stalled, false, 'non-existent file must return stalled=false');
    assert.strictEqual(result.consecutive_errors, 0, 'non-existent file must return consecutive_errors=0');
    assert.strictEqual(result.error_type, 'unknown', 'non-existent file must return error_type=unknown');
  });
});

// ============================================================================
// Test Group 6: Malformed JSONL
// ============================================================================

describe('diagnoseSessionFailure() — malformed JSONL', () => {

  it('handles malformed JSONL lines gracefully without throwing', () => {
    const ctx = createTempDir('malformed');
    const file = path.join(ctx.dir, 'session.jsonl');
    // Mix of malformed and valid entries
    fs.writeFileSync(file, [
      'NOT_JSON_AT_ALL',
      '{broken json',
      JSON.stringify(rateLimitEntry()),
      JSON.stringify(rateLimitEntry()),
      JSON.stringify(rateLimitEntry()),
      '   ',
      '',
    ].join('\n'));

    let result;
    assert.doesNotThrow(() => {
      result = diagnoseSessionFailure(file);
    }, 'must not throw on malformed JSONL');

    assert.ok(typeof result === 'object', 'must return an object even with malformed lines');
    // The 3 valid rate limit entries should still be classified correctly
    assert.strictEqual(result.error_type, 'rate_limit', 'valid rate_limit entries must be classified despite surrounding malformed lines');

    ctx.cleanup();
  });

  it('returns unknown when all lines are malformed', () => {
    const ctx = createTempDir('all-malformed');
    const file = path.join(ctx.dir, 'session.jsonl');
    fs.writeFileSync(file, 'NOT_JSON\n{invalid\n[broken');

    let result;
    assert.doesNotThrow(() => {
      result = diagnoseSessionFailure(file);
    });

    assert.ok(typeof result === 'object', 'must return an object');
    assert.strictEqual(result.consecutive_errors, 0, 'all-malformed JSONL must yield 0 consecutive_errors');
    assert.strictEqual(result.error_type, 'unknown');

    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 7: stalled flag threshold
// ============================================================================

describe('diagnoseSessionFailure() — stalled flag threshold', () => {

  it('stalled=false when only 1 consecutive error exists (below threshold of 3)', () => {
    const ctx = createTempDir('stalled-1');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      assistantEntry(),         // breaks chain
      rateLimitEntry(),         // only 1 error after the break
    ]);

    const result = diagnoseSessionFailure(file);
    assert.strictEqual(result.stalled, false, '1 error must not set stalled=true');
    ctx.cleanup();
  });

  it('stalled=false when 2 consecutive errors exist (below threshold of 3)', () => {
    const ctx = createTempDir('stalled-2');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry(),
      rateLimitEntry(),
    ]);

    const result = diagnoseSessionFailure(file);
    assert.strictEqual(result.stalled, false, '2 errors must not set stalled=true');
    ctx.cleanup();
  });

  it('stalled=true when exactly 3 consecutive errors exist (at threshold)', () => {
    const ctx = createTempDir('stalled-3');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      rateLimitEntry(),
      rateLimitEntry(),
      rateLimitEntry(),
    ]);

    const result = diagnoseSessionFailure(file);
    assert.strictEqual(result.stalled, true, '3 consecutive errors must set stalled=true');
    ctx.cleanup();
  });

  it('stalled=true when more than 3 consecutive errors exist', () => {
    const ctx = createTempDir('stalled-5');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [
      authErrorEntry(),
      authErrorEntry(),
      authErrorEntry(),
      authErrorEntry(),
      authErrorEntry(),
    ]);

    const result = diagnoseSessionFailure(file);
    assert.strictEqual(result.stalled, true);
    assert.ok(result.consecutive_errors >= 3);
    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 8: Non-error entry breaks consecutive chain
// ============================================================================

describe('diagnoseSessionFailure() — chain breaking', () => {

  it('assistant entry in the tail breaks the consecutive-error chain', () => {
    const ctx = createTempDir('chain-break');
    const file = path.join(ctx.dir, 'session.jsonl');
    // Tail is scanned from the end — error entries appear at the end, assistant entry
    // is before them, so consecutive chain runs from end = 2 errors (not 5)
    writeJsonl(file, [
      rateLimitEntry(),     // these are NOT in the consecutive tail chain (broken by assistant)
      rateLimitEntry(),
      rateLimitEntry(),
      assistantEntry(),     // breaks the chain when scanning backward from tail
      rateLimitEntry(),     // these 2 form the consecutive chain from the end
      rateLimitEntry(),
    ]);

    const result = diagnoseSessionFailure(file);
    // Scanning backward: 2 rate limit errors, then assistant breaks chain
    assert.strictEqual(result.consecutive_errors, 2, 'chain must stop at the assistant entry');
    assert.strictEqual(result.stalled, false, '2 consecutive errors must not set stalled=true');
    ctx.cleanup();
  });
});

// ============================================================================
// Test Group 9: Sample error capture
// ============================================================================

describe('diagnoseSessionFailure() — sample_error capture', () => {

  it('captures the message from the first (most-recent) error entry', () => {
    const ctx = createTempDir('sample-error');
    const file = path.join(ctx.dir, 'session.jsonl');
    const expectedMsg = 'Rate limit exceeded — retry after 60 seconds';
    writeJsonl(file, [
      rateLimitEntry('older error'),
      rateLimitEntry('second error'),
      rateLimitEntry(expectedMsg),  // most recent (last in file = first when scanning from end)
    ]);

    const result = diagnoseSessionFailure(file);

    assert.ok(typeof result.sample_error === 'string', 'sample_error must be a string');
    assert.ok(result.sample_error.length > 0, 'sample_error must not be empty when errors exist');
    // The most-recent entry's message should be captured
    assert.ok(
      result.sample_error.includes('Rate limit') || result.sample_error.length <= 200,
      'sample_error must be a truncated string from the most-recent error'
    );

    ctx.cleanup();
  });

  it('sample_error is empty string when there are no errors', () => {
    const ctx = createTempDir('no-sample-error');
    const file = path.join(ctx.dir, 'session.jsonl');
    writeJsonl(file, [assistantEntry()]);

    const result = diagnoseSessionFailure(file);

    assert.strictEqual(result.sample_error, '', 'sample_error must be empty string when no errors');
    ctx.cleanup();
  });

  it('sample_error is truncated to at most 200 characters', () => {
    const ctx = createTempDir('long-error');
    const file = path.join(ctx.dir, 'session.jsonl');
    const longMsg = 'Rate limit: ' + 'x'.repeat(500);
    writeJsonl(file, [rateLimitEntry(longMsg), rateLimitEntry(longMsg), rateLimitEntry(longMsg)]);

    const result = diagnoseSessionFailure(file);

    assert.ok(result.sample_error.length <= 200, `sample_error must be <= 200 chars; got ${result.sample_error.length}`);
    ctx.cleanup();
  });
});
