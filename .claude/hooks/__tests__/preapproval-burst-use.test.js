/**
 * Unit tests for pre-approved bypass burst-use logic in approval-utils.js
 *
 * Tests the Pass 2 (pre-approval) branch of checkApproval():
 * - First use: args-agnostic consumption, sets last_used_timestamp, decrements uses_remaining
 * - Burst window: subsequent uses within burst_window_ms succeed; uses after it are rejected
 * - Exhaustion: entry deleted when uses_remaining reaches 0
 * - Stale state: entries with uses_remaining <= 0 on entry are deleted and blocked
 * - HMAC: forged pending_hmac or approved_hmac entries are deleted and blocked (G001)
 * - Pass separation: standard approvals are not consumed by Pass 2; pending pre-approvals
 *   are not consumed
 *
 * Strategy: Import approval-utils.js once so that APPROVALS_PATH and PROTECTION_KEY_PATH
 * are resolved. Then read those exported constants and write test files directly to the
 * resolved paths (saving and restoring the real files around each test).
 *
 * Run with: node --test .claude/hooks/__tests__/preapproval-burst-use.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPROVAL_UTILS_PATH = path.resolve(__dirname, '..', 'lib', 'approval-utils.js');

// ============================================================================
// Import approval-utils once. The module resolves APPROVALS_PATH and
// PROTECTION_KEY_PATH at load time from CLAUDE_PROJECT_DIR (or __dirname fallback).
// Constants are on the default export object; named exports omit them.
// ============================================================================

const namedExports = await import(APPROVAL_UTILS_PATH);
const mod = namedExports.default;

const checkApproval = namedExports.checkApproval;
const APPROVALS_PATH = mod.APPROVALS_PATH;
const PROTECTION_KEY_PATH = mod.PROTECTION_KEY_PATH;

// ============================================================================
// Test key
// ============================================================================

const TEST_KEY = crypto.randomBytes(32).toString('base64');

function hmac(...fields) {
  const buf = Buffer.from(TEST_KEY, 'base64');
  return crypto.createHmac('sha256', buf).update(fields.join('|')).digest('hex');
}

// ============================================================================
// File-swap helpers
//
// We save/restore the real files around each test so the suite is non-destructive.
// The APPROVALS_PATH and PROTECTION_KEY_PATH are wherever approval-utils resolved them.
// ============================================================================

let savedApprovalsContent = null;
let savedKeyContent = null;
const LOCK_PATH = APPROVALS_PATH + '.lock';

function saveRealFiles() {
  savedApprovalsContent = fs.existsSync(APPROVALS_PATH)
    ? fs.readFileSync(APPROVALS_PATH, 'utf8')
    : null;
  savedKeyContent = fs.existsSync(PROTECTION_KEY_PATH)
    ? fs.readFileSync(PROTECTION_KEY_PATH, 'utf8')
    : null;
}

function restoreRealFiles() {
  // Always remove lock before restoring (may be left by a failed test)
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ok */ }

  if (savedApprovalsContent !== null) {
    fs.writeFileSync(APPROVALS_PATH, savedApprovalsContent);
  } else if (fs.existsSync(APPROVALS_PATH)) {
    fs.unlinkSync(APPROVALS_PATH);
  }

  if (savedKeyContent !== null) {
    fs.writeFileSync(PROTECTION_KEY_PATH, savedKeyContent);
  }
  // Do not delete the real key if it didn't exist before — protect-framework may
  // have created it. We only ever REPLACE it, never delete it.
}

function writeTestApprovals(entries) {
  const approvals = {};
  for (const e of entries) {
    approvals[e.code] = e;
  }
  const dir = path.dirname(APPROVALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify({ approvals }, null, 2));
}

function readTestApprovals() {
  if (!fs.existsSync(APPROVALS_PATH)) return { approvals: {} };
  return JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
}

function installTestKey() {
  const dir = path.dirname(PROTECTION_KEY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROTECTION_KEY_PATH, TEST_KEY + '\n');
}

function removeTestKey() {
  try { fs.unlinkSync(PROTECTION_KEY_PATH); } catch { /* ok */ }
}

// ============================================================================
// Pre-approval fixture builder
// ============================================================================

/**
 * Build a pre-approval entry with HMAC fields computed against TEST_KEY.
 * All fields have sane defaults so callers only override what they care about.
 */
function makePreapproval({
  code = 'PRE001',
  server = 'test-server',
  tool = 'test-tool',
  status = 'approved',
  uses_remaining = 3,
  last_used_timestamp = null,
  burst_window_ms = 60000,
  expiresOffsetMs = 5 * 60 * 1000,
  pendingHmacOverride = undefined,
  approvedHmacOverride = undefined,
  omitApprovedHmac = false,
  omitPendingHmac = false,
} = {}) {
  const now = Date.now();
  const expires_timestamp = now + expiresOffsetMs;

  const pending_hmac = omitPendingHmac
    ? undefined
    : (pendingHmacOverride !== undefined
      ? pendingHmacOverride
      : hmac(code, server, tool, 'preapproval-pending', String(expires_timestamp)));

  const approved_hmac = omitApprovedHmac
    ? undefined
    : (approvedHmacOverride !== undefined
      ? approvedHmacOverride
      : hmac(code, server, tool, 'preapproval-activated', String(expires_timestamp)));

  return {
    code,
    server,
    tool,
    is_preapproval: true,
    status,
    approval_mode: 'cto',
    reason: 'bulk migration',
    max_uses: 3,
    uses_remaining,
    burst_window_ms,
    last_used_timestamp,
    created_at: new Date(now).toISOString(),
    created_timestamp: now,
    expires_at: new Date(expires_timestamp).toISOString(),
    expires_timestamp,
    ...(pending_hmac !== undefined && { pending_hmac }),
    ...(approved_hmac !== undefined && { approved_hmac }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('checkApproval() – pre-approval burst-use (Pass 2)', () => {
  beforeEach(() => {
    saveRealFiles();
    installTestKey();
  });

  afterEach(() => {
    restoreRealFiles();
  });

  // --------------------------------------------------------------------------
  // 1. Happy path: first use
  // --------------------------------------------------------------------------

  describe('first use (no prior last_used_timestamp)', () => {
    it('should return the pre-approval entry on first use', () => {
      const entry = makePreapproval({ code: 'FIRST1', uses_remaining: 2 });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', { some: 'arg' });

      assert.ok(result !== null, 'Should return the pre-approval on first use');
      assert.strictEqual(result.is_preapproval, true, 'Returned entry must be a pre-approval');
      assert.strictEqual(result.server, 'test-server');
      assert.strictEqual(result.tool, 'test-tool');
    });

    it('should decrement uses_remaining by 1 on first use', () => {
      const entry = makePreapproval({ code: 'DECR01', uses_remaining: 3 });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      // Entry still exists (uses_remaining went from 3 -> 2, not exhausted)
      assert.ok(data.approvals.DECR01, 'Entry should remain (not yet exhausted)');
      assert.strictEqual(data.approvals.DECR01.uses_remaining, 2,
        'uses_remaining should be decremented to 2');
    });

    it('should set last_used_timestamp on first use', () => {
      const before = Date.now();
      const entry = makePreapproval({
        code: 'LUTS01',
        uses_remaining: 3,
        last_used_timestamp: null,
      });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      const saved = data.approvals.LUTS01;
      assert.ok(saved, 'Entry should persist after first use');
      assert.ok(
        typeof saved.last_used_timestamp === 'number',
        'last_used_timestamp must be a number after first use'
      );
      assert.ok(
        saved.last_used_timestamp >= before,
        'last_used_timestamp must be >= the timestamp recorded before the call'
      );
    });

    it('should be args-agnostic (any args match a pre-approval)', () => {
      // Pre-approvals do NOT check argsHash — this is the key distinction from Pass 1
      const entry = makePreapproval({ code: 'ARGS01', uses_remaining: 3 });
      writeTestApprovals([entry]);

      // First call with one set of args
      const result1 = checkApproval('test-server', 'test-tool', { query: 'SELECT 1' });
      assert.ok(result1 !== null,
        'Pre-approval should match regardless of args variant A');

      // Reset to fresh entry for second call
      const entry2 = makePreapproval({ code: 'ARGS02', uses_remaining: 3 });
      writeTestApprovals([entry2]);

      const result2 = checkApproval('test-server', 'test-tool', { query: 'DROP TABLE users' });
      assert.ok(result2 !== null,
        'Pre-approval should match regardless of args variant B');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Burst window
  // --------------------------------------------------------------------------

  describe('burst window enforcement', () => {
    it('should allow a second use within the burst window', () => {
      // last_used_timestamp 10s ago, burst_window_ms=60s: still within window
      const recentUse = Date.now() - 10000;
      const entry = makePreapproval({
        code: 'BURST1',
        uses_remaining: 2,
        last_used_timestamp: recentUse,
        burst_window_ms: 60000,
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.ok(result !== null, 'Should allow second use within 60s burst window');
    });

    it('should block a use that arrives after the burst window has elapsed', () => {
      // last_used_timestamp 90s ago, burst_window_ms=60s: expired
      const staleUse = Date.now() - 90000;
      const entry = makePreapproval({
        code: 'BWEXP1',
        uses_remaining: 2,
        last_used_timestamp: staleUse,
        burst_window_ms: 60000,
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null, 'Should block use after burst window expiry');
    });

    it('should delete the pre-approval entry when the burst window expires', () => {
      const staleUse = Date.now() - 90000;
      const entry = makePreapproval({
        code: 'BWDEL1',
        uses_remaining: 2,
        last_used_timestamp: staleUse,
        burst_window_ms: 60000,
      });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.BWDEL1, undefined,
        'Burst-expired entry must be deleted from the approvals file');
    });

    it('should respect a custom burst_window_ms field (shorter than default)', () => {
      // 5-second custom window; last use 3s ago -> within window
      const recentUse = Date.now() - 3000;
      const entryOk = makePreapproval({
        code: 'CUST01',
        uses_remaining: 2,
        last_used_timestamp: recentUse,
        burst_window_ms: 5000,
      });
      writeTestApprovals([entryOk]);
      const result1 = checkApproval('test-server', 'test-tool', {});
      assert.ok(result1 !== null, 'Should allow use within custom 5s burst window');

      // 5-second custom window; last use 6s ago -> outside window
      const oldUse = Date.now() - 6000;
      const entryExpired = makePreapproval({
        code: 'CUST02',
        uses_remaining: 2,
        last_used_timestamp: oldUse,
        burst_window_ms: 5000,
      });
      writeTestApprovals([entryExpired]);
      const result2 = checkApproval('test-server', 'test-tool', {});
      assert.strictEqual(result2, null,
        'Should block use past custom 5s burst window');
    });

    it('should default to 60s burst window when burst_window_ms field is absent', () => {
      // 30s since last use, no burst_window_ms field -> defaults to 60000 -> still in window
      const entry = makePreapproval({
        code: 'DFLT01',
        uses_remaining: 2,
        last_used_timestamp: Date.now() - 30000,
      });
      delete entry.burst_window_ms; // Simulate missing field
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});
      assert.ok(result !== null,
        'Should allow use within default 60s window when burst_window_ms is absent');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Exhaustion
  // --------------------------------------------------------------------------

  describe('exhaustion', () => {
    it('should succeed on the last use (uses_remaining = 1)', () => {
      const entry = makePreapproval({ code: 'LAST01', uses_remaining: 1 });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.ok(result !== null, 'Last use should succeed and return the entry');
    });

    it('should delete the entry after the last use', () => {
      const entry = makePreapproval({ code: 'LDEL01', uses_remaining: 1 });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.LDEL01, undefined,
        'Entry must be deleted after the last use exhausts uses_remaining');
    });

    it('should block immediately when uses_remaining is already 0 on entry', () => {
      const entry = makePreapproval({ code: 'ZERO01', uses_remaining: 0 });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should block when uses_remaining is already 0 before the call');
    });

    it('should delete the entry when uses_remaining is 0 on entry', () => {
      const entry = makePreapproval({ code: 'ZDEL01', uses_remaining: 0 });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.ZDEL01, undefined,
        'Entry with uses_remaining=0 must be deleted to prevent accumulation');
    });

    it('should block when uses_remaining is negative', () => {
      const entry = makePreapproval({ code: 'NEG001', uses_remaining: -1 });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Negative uses_remaining must be treated as exhausted');
    });
  });

  // --------------------------------------------------------------------------
  // 4. HMAC forgery detection (G001 fail-closed)
  // --------------------------------------------------------------------------

  describe('HMAC forgery detection', () => {
    it('should reject a pre-approval with a forged pending_hmac', () => {
      const entry = makePreapproval({
        code: 'FORG01',
        uses_remaining: 3,
        pendingHmacOverride: 'deadbeef'.repeat(8),
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should block when pre-approval pending_hmac is forged');
    });

    it('should delete the entry when pending_hmac is forged', () => {
      const entry = makePreapproval({
        code: 'FDEL01',
        uses_remaining: 3,
        pendingHmacOverride: 'cafebabe'.repeat(8),
      });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.FDEL01, undefined,
        'Entry with forged pending_hmac must be deleted');
    });

    it('should reject a pre-approval with a forged approved_hmac', () => {
      const entry = makePreapproval({
        code: 'FAPPR1',
        uses_remaining: 3,
        approvedHmacOverride: 'baadf00d'.repeat(8),
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should block when pre-approval approved_hmac is forged');
    });

    it('should delete the entry when approved_hmac is forged', () => {
      const entry = makePreapproval({
        code: 'FADL01',
        uses_remaining: 3,
        approvedHmacOverride: '1234abcd'.repeat(8),
      });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.FADL01, undefined,
        'Entry with forged approved_hmac must be deleted');
    });

    it('should block (skip) a pre-approval that has HMAC fields but no protection key (G001)', () => {
      const entry = makePreapproval({ code: 'NOKEY1', uses_remaining: 3 });
      writeTestApprovals([entry]);

      // Remove the key so approval-utils cannot verify the HMAC
      removeTestKey();

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should fail-closed when HMAC fields are present but protection key is absent');
    });

    it('should preserve valid entries for other tools when a forged entry is detected', () => {
      const forged = makePreapproval({
        code: 'FMIX01',
        server: 'test-server',
        tool: 'test-tool',
        uses_remaining: 3,
        pendingHmacOverride: 'deadbeef'.repeat(8),
      });
      const valid = makePreapproval({
        code: 'VMIX01',
        server: 'test-server',
        tool: 'other-tool',
        uses_remaining: 2,
      });
      writeTestApprovals([forged, valid]);

      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.FMIX01, undefined,
        'Forged entry must be deleted');
      assert.ok(data.approvals.VMIX01,
        'Valid entry for a different tool must be preserved');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Pass separation
  // --------------------------------------------------------------------------

  describe('pass separation', () => {
    it('Pass 2 should NOT match entries without is_preapproval flag (standard approvals)', () => {
      // Standard approvals (is_preapproval absent) are handled by Pass 1.
      // Build a standard approval with correct HMAC and verify Pass 1 consumes it.
      const code = 'STD001';
      const argsHash = crypto.createHash('sha256').update(JSON.stringify({})).digest('hex');
      const expires_timestamp = Date.now() + 5 * 60 * 1000;

      const standardApproval = {
        code,
        server: 'test-server',
        tool: 'test-tool',
        args: {},
        argsHash,
        status: 'approved',
        // is_preapproval: intentionally absent
        created_timestamp: Date.now(),
        expires_timestamp,
        pending_hmac: hmac(code, 'test-server', 'test-tool', argsHash, String(expires_timestamp)),
        approved_hmac: hmac(code, 'test-server', 'test-tool', 'approved', argsHash, String(expires_timestamp)),
      };

      writeTestApprovals([standardApproval]);

      // Pass 1 must consume this
      const result = checkApproval('test-server', 'test-tool', {});
      assert.ok(result !== null, 'Standard approval must be consumed by Pass 1');
      assert.ok(!result.is_preapproval,
        'The consumed entry must not be flagged as a pre-approval');
    });

    it('Pass 2 should NOT consume pending (not yet activated) pre-approvals', () => {
      const entry = makePreapproval({
        code: 'PEND01',
        status: 'pending', // Requested but not yet activated by CTO
        uses_remaining: 3,
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Pending (not activated) pre-approval must not be consumed');
    });

    it('Pass 2 should skip expired pre-approvals', () => {
      const entry = makePreapproval({
        code: 'EXP001',
        uses_remaining: 3,
        expiresOffsetMs: -1000, // Already expired
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Expired pre-approval must not be consumed');
    });

    it('Pass 2 should skip pre-approvals for a different server', () => {
      const entry = makePreapproval({
        code: 'DIFF01',
        server: 'other-server',
        tool: 'test-tool',
        uses_remaining: 3,
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Pre-approval for a different server must not match');
    });

    it('Pass 2 should skip pre-approvals for a different tool', () => {
      const entry = makePreapproval({
        code: 'DIFFT1',
        server: 'test-server',
        tool: 'other-tool',
        uses_remaining: 3,
      });
      writeTestApprovals([entry]);

      const result = checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Pre-approval for a different tool must not match');
    });
  });

  // --------------------------------------------------------------------------
  // 6. File integrity after consumption
  // --------------------------------------------------------------------------

  describe('file integrity', () => {
    it('should leave the approvals file as valid JSON after a partial-use consumption', () => {
      const entry = makePreapproval({ code: 'JSON01', uses_remaining: 3 });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const raw = fs.readFileSync(APPROVALS_PATH, 'utf8');
      assert.doesNotThrow(
        () => JSON.parse(raw),
        'Approvals file must be valid JSON after partial-use consumption'
      );
      const parsed = JSON.parse(raw);
      assert.ok(parsed.approvals, 'Must retain the top-level "approvals" key');
      assert.strictEqual(parsed.approvals.JSON01.uses_remaining, 2,
        'uses_remaining must reflect the consumed use');
    });

    it('should leave the approvals file as valid JSON after last-use deletion', () => {
      const entry = makePreapproval({ code: 'JSON02', uses_remaining: 1 });
      writeTestApprovals([entry]);

      checkApproval('test-server', 'test-tool', {});

      const raw = fs.readFileSync(APPROVALS_PATH, 'utf8');
      assert.doesNotThrow(
        () => JSON.parse(raw),
        'Approvals file must be valid JSON after exhaustion deletion'
      );
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.approvals.JSON02, undefined,
        'Exhausted entry must be absent from the file');
    });

    it('should not corrupt an unrelated standard approval when deleting a burst-expired entry', () => {
      // Burst-expired pre-approval for test-server:test-tool
      const staleUse = Date.now() - 90000;
      const preapproval = makePreapproval({
        code: 'CEXP01',
        server: 'test-server',
        tool: 'test-tool',
        uses_remaining: 2,
        last_used_timestamp: staleUse,
        burst_window_ms: 60000,
      });

      // Valid standard approval for other-server:other-tool
      const stdCode = 'CSTD01';
      const argsHash = crypto.createHash('sha256').update(JSON.stringify({})).digest('hex');
      const stdExpires = Date.now() + 5 * 60 * 1000;
      const standardApproval = {
        code: stdCode,
        server: 'other-server',
        tool: 'other-tool',
        args: {},
        argsHash,
        status: 'approved',
        created_timestamp: Date.now(),
        expires_timestamp: stdExpires,
        pending_hmac: hmac(stdCode, 'other-server', 'other-tool', argsHash, String(stdExpires)),
        approved_hmoval: hmac(stdCode, 'other-server', 'other-tool', 'approved', argsHash, String(stdExpires)),
      };

      writeTestApprovals([preapproval, standardApproval]);

      // Trigger burst-window expiry on the pre-approval
      checkApproval('test-server', 'test-tool', {});

      const data = readTestApprovals();
      assert.strictEqual(data.approvals.CEXP01, undefined,
        'Burst-expired pre-approval entry must be deleted');
      assert.ok(data.approvals.CSTD01,
        'Unrelated standard approval must be preserved');
    });
  });
});
