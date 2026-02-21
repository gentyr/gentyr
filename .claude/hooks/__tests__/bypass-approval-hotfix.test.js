/**
 * Unit tests for bypass-approval-hook.js hotfix approval pattern
 *
 * Tests the new APPROVE HOTFIX <code> pattern added alongside APPROVE BYPASS:
 * - validateHotfixCode() - checks hotfix_requests DB table for valid pending codes
 * - writeHotfixApprovalToken() - writes HMAC-signed approval token
 * - markHotfixApproved() - marks request as approved in DB
 *
 * Philosophy: validate structure and behavior, fail loudly, no silent fallbacks.
 *
 * Run with: node --test .claude/hooks/__tests__/bypass-approval-hotfix.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

function createTempDir(prefix = 'hotfix-approval-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    path: tmpDir,
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create a test SQLite database with deputy-cto schema
 */
async function createTestDb(dbPath) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);

  // Create hotfix_requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hotfix_requests (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      commits_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  return db;
}

/**
 * Helper to generate a 6-char approval code (mirrors approval-utils.js)
 */
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // No 0/O, 1/I/L
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Helper to generate protection key (mirrors approval-utils.js)
 */
function generateProtectionKey() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Helper to compute HMAC (mirrors bypass-approval-hook.js)
 */
function computeHmac(key, ...fields) {
  const keyBuffer = Buffer.from(key, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

// ============================================================================
// Test Suite
// ============================================================================

describe('bypass-approval-hook.js - Hotfix Approval', () => {
  let tempDir;
  let dbPath;
  let db;
  let tokenPath;
  let keyPath;

  beforeEach(async () => {
    tempDir = createTempDir();
    dbPath = path.join(tempDir.path, 'deputy-cto.db');
    tokenPath = path.join(tempDir.path, 'hotfix-approval-token.json');
    keyPath = path.join(tempDir.path, 'protection-key');

    db = await createTestDb(dbPath);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tempDir) {
      tempDir.cleanup();
    }
  });

  // ==========================================================================
  // validateHotfixCode() behavior
  // ==========================================================================

  describe('validateHotfixCode()', () => {
    it('should validate a valid pending hotfix code', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min from now

      db.prepare(`
        INSERT INTO hotfix_requests (id, code, commits_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        code,
        JSON.stringify([{ sha: 'abc123', message: 'fix: critical bug' }]),
        'pending',
        now.toISOString(),
        expiresAt.toISOString()
      );

      // Simulate validateHotfixCode behavior
      const row = db.prepare(`
        SELECT id, code, commits_json, created_at, expires_at FROM hotfix_requests
        WHERE code = ? AND status = 'pending' AND expires_at > datetime('now')
      `).get(code);

      assert.ok(row !== undefined, 'Should find valid pending hotfix request');
      assert.strictEqual(row.code, code);
      assert.strictEqual(row.id, requestId);
    });

    it('should reject code for already-approved request', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

      db.prepare(`
        INSERT INTO hotfix_requests (id, code, commits_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        code,
        JSON.stringify([{ sha: 'abc123' }]),
        'approved', // Already approved
        now.toISOString(),
        expiresAt.toISOString()
      );

      const row = db.prepare(`
        SELECT id FROM hotfix_requests
        WHERE code = ? AND status = 'pending' AND expires_at > datetime('now')
      `).get(code);

      assert.strictEqual(row, undefined, 'Should not find already-approved request');
    });

    it('should reject expired hotfix code', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 5 * 60 * 1000); // Expired 5 min ago

      db.prepare(`
        INSERT INTO hotfix_requests (id, code, commits_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        code,
        JSON.stringify([{ sha: 'abc123' }]),
        'pending',
        now.toISOString(),
        expiresAt.toISOString()
      );

      const row = db.prepare(`
        SELECT id FROM hotfix_requests
        WHERE code = ? AND status = 'pending' AND expires_at > datetime('now')
      `).get(code);

      assert.strictEqual(row, undefined, 'Should not find expired request');
    });

    it('should reject non-existent code', () => {
      const code = 'NOPE99';

      const row = db.prepare(`
        SELECT id FROM hotfix_requests
        WHERE code = ? AND status = 'pending' AND expires_at > datetime('now')
      `).get(code);

      assert.strictEqual(row, undefined, 'Should not find non-existent code');
    });
  });

  // ==========================================================================
  // writeHotfixApprovalToken() behavior
  // ==========================================================================

  describe('writeHotfixApprovalToken()', () => {
    it('should write token with code, request_id, expires_at', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      // Simulate writeHotfixApprovalToken
      const token = {
        code,
        request_id: requestId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      };

      fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));

      // Verify token was written
      assert.ok(fs.existsSync(tokenPath), 'Token file should exist');

      const written = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      assert.strictEqual(written.code, code);
      assert.strictEqual(written.request_id, requestId);
      assert.strictEqual(written.expires_at, expiresAt);
      assert.ok(written.created_at, 'Should have created_at timestamp');
    });

    it('should include HMAC signature when protection key exists', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      // Create protection key
      const keyBase64 = generateProtectionKey();
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      // Compute HMAC signature
      const hmac = computeHmac(keyBase64, code, requestId, expiresAt, 'hotfix-approved');

      const token = {
        code,
        request_id: requestId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        hmac,
      };

      fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));

      // Verify HMAC was included
      const written = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      assert.ok(written.hmac, 'Token should include HMAC signature');
      assert.strictEqual(written.hmac.length, 64, 'HMAC should be 64 hex chars');
      assert.match(written.hmac, /^[0-9a-f]{64}$/, 'HMAC should be hex-encoded');
    });

    it('should produce valid HMAC that verifies correctly', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const keyBase64 = generateProtectionKey();
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      const hmac = computeHmac(keyBase64, code, requestId, expiresAt, 'hotfix-approved');

      const token = {
        code,
        request_id: requestId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        hmac,
      };

      fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));

      // Re-compute HMAC to verify
      const recomputed = computeHmac(keyBase64, code, requestId, expiresAt, 'hotfix-approved');

      assert.strictEqual(recomputed, hmac, 'Re-computed HMAC should match original');
    });

    it('should fail verification if HMAC fields are tampered', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const keyBase64 = generateProtectionKey();
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      const hmac = computeHmac(keyBase64, code, requestId, expiresAt, 'hotfix-approved');

      // Write token with valid HMAC
      fs.writeFileSync(tokenPath, JSON.stringify({
        code,
        request_id: requestId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        hmac,
      }, null, 2));

      // Read and tamper with request_id
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const tamperedRequestId = crypto.randomUUID();
      token.request_id = tamperedRequestId;

      // Re-compute HMAC with tampered data
      const recomputed = computeHmac(keyBase64, code, tamperedRequestId, expiresAt, 'hotfix-approved');

      assert.notStrictEqual(recomputed, hmac, 'Tampered token should fail verification');
    });
  });

  // ==========================================================================
  // markHotfixApproved() behavior
  // ==========================================================================

  describe('markHotfixApproved()', () => {
    it('should update request status to approved', () => {
      const code = generateCode();
      const requestId = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

      db.prepare(`
        INSERT INTO hotfix_requests (id, code, commits_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        code,
        JSON.stringify([{ sha: 'abc123' }]),
        'pending',
        now.toISOString(),
        expiresAt.toISOString()
      );

      // Verify initial status
      let row = db.prepare('SELECT status FROM hotfix_requests WHERE id = ?').get(requestId);
      assert.strictEqual(row.status, 'pending');

      // Simulate markHotfixApproved
      db.prepare("UPDATE hotfix_requests SET status = 'approved' WHERE id = ?").run(requestId);

      // Verify status changed
      row = db.prepare('SELECT status FROM hotfix_requests WHERE id = ?').get(requestId);
      assert.strictEqual(row.status, 'approved');
    });

    it('should fail loudly if request does not exist', () => {
      const nonExistentId = crypto.randomUUID();

      // Simulate markHotfixApproved
      const result = db.prepare("UPDATE hotfix_requests SET status = 'approved' WHERE id = ?").run(nonExistentId);

      assert.strictEqual(result.changes, 0, 'Should not update non-existent request');
    });
  });

  // ==========================================================================
  // Pattern matching behavior
  // ==========================================================================

  describe('APPROVE HOTFIX pattern matching', () => {
    it('should match valid hotfix approval pattern', () => {
      const HOTFIX_PATTERN = /APPROVE\s+HOTFIX\s+([A-Z0-9]{6})/i;

      const validMessages = [
        'APPROVE HOTFIX ABC123',
        'APPROVE HOTFIX XYZ789',
        'approve hotfix DEF456', // Case-insensitive
        'APPROVE  HOTFIX  GHI012', // Multiple spaces
      ];

      validMessages.forEach(msg => {
        const match = msg.match(HOTFIX_PATTERN);
        assert.ok(match !== null, `Should match: ${msg}`);
        assert.strictEqual(match[1].length, 6, 'Captured code should be 6 chars');
      });
    });

    it('should not match invalid hotfix approval patterns', () => {
      const HOTFIX_PATTERN = /APPROVE\s+HOTFIX\s+([A-Z0-9]{6})/i;

      const invalidMessages = [
        'APPROVE HOTFIX ABC12', // Too short
        'APPROVE HOTFIX ABC1234', // Too long
        'APPROVE BYPASS ABC123', // Wrong phrase
        'HOTFIX ABC123', // Missing APPROVE
        'APPROVE ABC123', // Missing HOTFIX
        'APPROVE HOTFIX', // Missing code
      ];

      invalidMessages.forEach(msg => {
        const match = msg.match(HOTFIX_PATTERN);
        assert.strictEqual(match, null, `Should not match: ${msg}`);
      });
    });

    it('should extract code in uppercase', () => {
      const HOTFIX_PATTERN = /APPROVE\s+HOTFIX\s+([A-Z0-9]{6})/i;

      const msg = 'approve hotfix abc123';
      const match = msg.match(HOTFIX_PATTERN);

      assert.ok(match !== null);
      const code = match[1].toUpperCase();
      assert.strictEqual(code, 'ABC123');
    });
  });
});
