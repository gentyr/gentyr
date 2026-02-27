/**
 * Unit tests for Deputy-CTO HMAC argsHash Fix
 *
 * Tests that HMAC verification includes argsHash in the signature computation.
 * This ensures that request arguments cannot be tampered with after the pending
 * request is created.
 *
 * Bug Fix: Previously, argsHash was missing from HMAC computation in
 * approveProtectedAction(), causing HMAC verification to fail when argsHash
 * was present in the request.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { createTempDir } from '../../__testUtils__/index.js';

describe('Deputy-CTO HMAC argsHash Verification', () => {
  let tempDir: ReturnType<typeof createTempDir>;
  let approvalsPath: string;
  let protectionKeyPath: string;

  beforeEach(() => {
    tempDir = createTempDir('deputy-cto-hmac-test');
    approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');
    protectionKeyPath = path.join(tempDir.path, '.claude', 'protection-key');
  });

  afterEach(() => {
    tempDir.cleanup();
  });

  // Helper functions that mirror server implementation

  function generateProtectionKey(): string {
    // Generate 32-byte key (same as protect-framework.sh)
    return crypto.randomBytes(32).toString('base64');
  }

  function computeHmac(key: string, ...fields: string[]): string {
    const keyBuffer = Buffer.from(key, 'base64');
    return crypto.createHmac('sha256', keyBuffer)
      .update(fields.join('|'))
      .digest('hex');
  }

  function loadApprovalsFile(): { approvals: Record<string, any> } {
    if (!fs.existsSync(approvalsPath)) {
      return { approvals: {} };
    }
    return JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
  }

  function saveApprovalsFile(data: { approvals: Record<string, any> }): void {
    const dir = path.dirname(approvalsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(approvalsPath, JSON.stringify(data, null, 2));
  }

  function loadProtectionKey(): string | null {
    if (!fs.existsSync(protectionKeyPath)) {
      return null;
    }
    return fs.readFileSync(protectionKeyPath, 'utf8').trim();
  }

  function saveProtectionKey(key: string): void {
    const dir = path.dirname(protectionKeyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(protectionKeyPath, key);
  }

  /**
   * Simulates approveProtectedAction() from deputy-cto server
   */
  function approveProtectedAction(args: { code: string }): {
    approved?: boolean;
    error?: string;
  } {
    const data = loadApprovalsFile();
    const code = args.code.toUpperCase();
    const request = data.approvals[code];

    if (!request) {
      return { error: `No pending request with code: ${code}` };
    }

    if (request.status === 'approved') {
      return { error: `Request ${code} has already been approved.` };
    }

    if (Date.now() > request.expires_timestamp) {
      delete data.approvals[code];
      saveApprovalsFile(data);
      return { error: `Request ${code} has expired.` };
    }

    // Only deputy-cto-approval mode requests can be approved
    if (request.approval_mode !== 'deputy-cto') {
      return {
        error: `Request ${code} requires CTO approval (mode: ${request.approval_mode || 'cto'}). Deputy-CTO cannot approve this action.`,
      };
    }

    // Verify pending_hmac with protection key
    // G001 Fail-Closed: pending_hmac is verified unconditionally when a protection key is
    // present. If the field is missing (undefined), the comparison against the expected hex
    // string fails correctly, blocking requests that were not created by the gate hook.
    const key = loadProtectionKey();
    if (key) {
      // FIX: Include argsHash in HMAC computation
      const expectedPendingHmac = computeHmac(
        key,
        code,
        request.server,
        request.tool,
        request.argsHash || '',
        String(request.expires_timestamp)
      );

      if (request.pending_hmac !== expectedPendingHmac) {
        // Forged or missing pending_hmac - delete it
        delete data.approvals[code];
        saveApprovalsFile(data);
        return { error: `FORGERY DETECTED: Invalid pending signature for ${code}. Request deleted.` };
      }
    } else if (request.pending_hmac) {
      // G001 Fail-Closed: Request has HMAC but we can't verify (key missing)
      return { error: `Cannot verify request signature for ${code} (protection key missing).` };
    } else {
      // G001 Fail-Closed: No protection key at all
      return { error: `Protection key missing. Cannot create HMAC-signed approval.` };
    }

    // Compute approved_hmac (FIX: Include argsHash)
    request.status = 'approved';
    request.approved_at = new Date().toISOString();
    request.approved_timestamp = Date.now();
    request.approved_hmac = computeHmac(
      key,
      code,
      request.server,
      request.tool,
      'approved',
      request.argsHash || '',
      String(request.expires_timestamp)
    );

    saveApprovalsFile(data);

    return {
      approved: true,
    };
  }

  // ============================================================================
  // HMAC argsHash Tests
  // ============================================================================

  describe('HMAC with argsHash', () => {
    it('should verify pending_hmac that includes argsHash', () => {
      // Setup
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'TEST01';
      const server = 'supabase';
      const tool = 'delete_table';
      const argsHash = 'abc123def456'; // Hash of tool arguments
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Create pending request with argsHash in HMAC
      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        argsHash,
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { table: 'users', cascade: true },
            argsHash,
            phrase: 'APPROVE DATABASE',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert
      expect(result.approved).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify approval was saved with approved_hmac
      const updated = loadApprovalsFile();
      expect(updated.approvals[code].status).toBe('approved');
      expect(updated.approvals[code].approved_hmac).toBeDefined();

      // Verify approved_hmac includes argsHash
      const expectedApprovedHmac = computeHmac(
        key,
        code,
        server,
        tool,
        'approved',
        argsHash,
        String(expiresTimestamp)
      );
      expect(updated.approvals[code].approved_hmac).toBe(expectedApprovedHmac);
    });

    it('should reject pending request with tampered argsHash', () => {
      // Setup
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'TAMP01';
      const server = 'supabase';
      const tool = 'delete_table';
      const originalArgsHash = 'abc123def456';
      const tamperedArgsHash = 'HACKED999999';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Create pending_hmac with original argsHash
      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        originalArgsHash,
        String(expiresTimestamp)
      );

      // But store tampered argsHash in request
      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { table: 'users', cascade: true },
            argsHash: tamperedArgsHash, // TAMPERED
            phrase: 'APPROVE DATABASE',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert - Should detect forgery
      expect(result.approved).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toContain('FORGERY DETECTED');

      // Verify forged request was deleted
      const updated = loadApprovalsFile();
      expect(updated.approvals[code]).toBeUndefined();
    });

    it('should handle missing argsHash in request (empty string)', () => {
      // Setup
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'NOARG1';
      const server = 'github';
      const tool = 'list_repos';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Create pending_hmac with empty argsHash (request.argsHash || '')
      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        '', // Empty argsHash
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: {},
            // No argsHash property (undefined)
            phrase: 'APPROVE GIT',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert
      expect(result.approved).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify approved_hmac uses empty string for missing argsHash
      const updated = loadApprovalsFile();
      const expectedApprovedHmac = computeHmac(
        key,
        code,
        server,
        tool,
        'approved',
        '', // Empty string for missing argsHash
        String(expiresTimestamp)
      );
      expect(updated.approvals[code].approved_hmac).toBe(expectedApprovedHmac);
    });

    it('should handle null argsHash in request (coerced to empty string)', () => {
      // Setup
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'NULL01';
      const server = 'render';
      const tool = 'list_services';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Create pending_hmac with empty argsHash
      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        '', // null || '' = ''
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: {},
            argsHash: null, // Explicitly null
            phrase: 'APPROVE INFRA',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert
      expect(result.approved).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should include argsHash in approved_hmac signature', () => {
      // Setup
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'APPR01';
      const server = 'supabase';
      const tool = 'update_table';
      const argsHash = 'xyz789abc123';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        argsHash,
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { table: 'products', set: { price: 99 } },
            argsHash,
            phrase: 'APPROVE DATABASE',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert
      expect(result.approved).toBe(true);

      // Verify approved_hmac signature
      const updated = loadApprovalsFile();
      const request = updated.approvals[code];

      // Manually compute what approved_hmac should be
      const expectedApprovedHmac = computeHmac(
        key,
        code,
        server,
        tool,
        'approved',
        argsHash, // CRITICAL: argsHash must be included
        String(expiresTimestamp)
      );

      expect(request.approved_hmac).toBe(expectedApprovedHmac);

      // Verify it's different from a HMAC without argsHash
      const hmacWithoutArgsHash = computeHmac(
        key,
        code,
        server,
        tool,
        'approved',
        String(expiresTimestamp) // Missing argsHash
      );

      expect(request.approved_hmac).not.toBe(hmacWithoutArgsHash);
    });

    it('should reject request when pending_hmac is entirely absent and protection key is present', () => {
      // This tests the exact HMAC bypass vulnerability that was fixed.
      //
      // Before fix: `if (key && request.pending_hmac)` — when pending_hmac is missing,
      // the short-circuit caused HMAC verification to be SKIPPED entirely, allowing an
      // attacker to inject a forged approval request with no HMAC at all.
      //
      // After fix: `if (key)` — unconditionally enters the verification block;
      // `undefined !== expectedHexString` evaluates to true, triggering FORGERY DETECTED.

      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'NOHMAC';
      const server = 'supabase';
      const tool = 'drop_database';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Attacker injects a request with NO pending_hmac (the bypass vector)
      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { database: 'production' },
            argsHash: 'attackerhash',
            phrase: 'APPROVE DATABASE',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            // pending_hmac intentionally omitted — the attack vector
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert — must be rejected as forgery, not approved
      expect(result.approved).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toContain('FORGERY DETECTED');

      // Verify the forged request was deleted from the approvals file
      const updated = loadApprovalsFile();
      expect(updated.approvals[code]).toBeUndefined();
    });

    it('should fail verification if pending_hmac was created without argsHash', () => {
      // This tests the bug scenario: old code created pending_hmac without argsHash,
      // but request has argsHash field. New code should detect mismatch.

      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'BUG001';
      const server = 'supabase';
      const tool = 'delete_table';
      const argsHash = 'valid123hash';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // OLD CODE: Created pending_hmac WITHOUT argsHash (the bug)
      const buggyPendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        // Missing argsHash!
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { table: 'users' },
            argsHash, // Request HAS argsHash
            phrase: 'APPROVE DATABASE',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: buggyPendingHmac, // HMAC missing argsHash
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act - NEW CODE tries to approve
      const result = approveProtectedAction({ code });

      // Assert - Should fail verification
      expect(result.approved).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toContain('FORGERY DETECTED');
    });
  });

  // ============================================================================
  // Backward Compatibility
  // ============================================================================

  describe('Backward compatibility', () => {
    it('should work with requests created before argsHash was added', () => {
      // Legacy requests might not have argsHash field at all
      const key = generateProtectionKey();
      saveProtectionKey(key);

      const code = 'LEG001';
      const server = 'github';
      const tool = 'merge_pr';
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Old pending_hmac without argsHash
      const pendingHmac = computeHmac(
        key,
        code,
        server,
        tool,
        '', // Empty argsHash (backward compatible)
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            code,
            server,
            tool,
            args: { pr_number: 123 },
            // No argsHash field (legacy request)
            phrase: 'APPROVE GIT',
            status: 'pending',
            approval_mode: 'deputy-cto',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(expiresTimestamp).toISOString(),
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
          },
        },
      };

      saveApprovalsFile(approvals);

      // Act
      const result = approveProtectedAction({ code });

      // Assert
      expect(result.approved).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
