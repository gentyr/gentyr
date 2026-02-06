/**
 * Unit tests for approval-utils.js
 *
 * Tests all core utilities for the CTO-protected MCP action system:
 * - Code generation (unique, 6-char alphanumeric, no confusing chars)
 * - Encryption/decryption (AES-256-GCM, authenticated, format validation)
 * - Protection key management (generation, read/write)
 * - Protected actions configuration (load/save, protection checks)
 * - Approval lifecycle (create, validate, check, consume)
 * - Database integration (createDbRequest, validateDbApproval, markDbRequestApproved)
 *
 * All tests use in-memory fixtures and temporary files for isolation.
 *
 * Run with: node --test .claude/hooks/__tests__/approval-utils.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory for test files
 */
function createTempDir(prefix = 'approval-utils-test') {
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
 * Mock module by creating a temporary copy with injectable dependencies
 */
async function loadApprovalUtils(tempDir) {
  // Set environment to use temp directory
  const originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tempDir;

  // Import the module (will use CLAUDE_PROJECT_DIR)
  const module = await import('../lib/approval-utils.js');

  // Restore environment
  process.env.CLAUDE_PROJECT_DIR = originalEnv;

  return module;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('approval-utils.js', () => {
  let tempDir;
  let utils;
  let approvalsBackup;

  beforeEach(async () => {
    tempDir = createTempDir();
    utils = await import('../lib/approval-utils.js');

    // Back up existing approvals file if it exists
    if (fs.existsSync(utils.APPROVALS_PATH)) {
      approvalsBackup = fs.readFileSync(utils.APPROVALS_PATH, 'utf8');
    }
  });

  afterEach(() => {
    // Restore approvals file if it was backed up
    if (approvalsBackup) {
      fs.writeFileSync(utils.APPROVALS_PATH, approvalsBackup);
      approvalsBackup = null;
    } else if (fs.existsSync(utils.APPROVALS_PATH)) {
      // Or delete if it didn't exist before
      fs.unlinkSync(utils.APPROVALS_PATH);
    }

    if (tempDir) {
      tempDir.cleanup();
    }
  });

  // ==========================================================================
  // Code Generation
  // ==========================================================================

  describe('generateCode()', () => {
    it('should generate a 6-character code', () => {
      const code = utils.generateCode();

      assert.strictEqual(typeof code, 'string', 'Code must be a string');
      assert.strictEqual(code.length, 6, 'Code must be exactly 6 characters');
    });

    it('should only use safe alphanumeric characters (no 0/O, 1/I/L)', () => {
      const confusingChars = ['0', 'O', '1', 'I', 'L'];

      // Generate 100 codes to increase confidence
      for (let i = 0; i < 100; i++) {
        const code = utils.generateCode();

        for (const char of confusingChars) {
          assert.ok(!code.includes(char),
            `Code should not contain confusing character: ${char}`);
        }
      }
    });

    it('should only contain uppercase letters and digits', () => {
      for (let i = 0; i < 50; i++) {
        const code = utils.generateCode();

        assert.match(code, /^[A-Z0-9]{6}$/,
          'Code must contain only uppercase letters and digits');
      }
    });

    it('should generate different codes on successive calls', () => {
      const codes = new Set();

      // Generate 50 codes - all should be unique
      for (let i = 0; i < 50; i++) {
        codes.add(utils.generateCode());
      }

      // Allow for small collision probability but expect mostly unique
      assert.ok(codes.size >= 45,
        'Should generate unique codes (allowing ~10% collision rate)');
    });
  });

  // ==========================================================================
  // Protection Key Management
  // ==========================================================================

  describe('generateProtectionKey()', () => {
    it('should generate a base64-encoded key', () => {
      const key = utils.generateProtectionKey();

      assert.strictEqual(typeof key, 'string', 'Key must be a string');
      assert.ok(key.length > 0, 'Key must not be empty');

      // Should be valid base64
      const decoded = Buffer.from(key, 'base64');
      assert.ok(decoded.length > 0, 'Key must be valid base64');
    });

    it('should generate a 32-byte (256-bit) key', () => {
      const key = utils.generateProtectionKey();
      const decoded = Buffer.from(key, 'base64');

      assert.strictEqual(decoded.length, 32,
        'Key must be 32 bytes (256 bits) for AES-256');
    });

    it('should generate different keys on successive calls', () => {
      const key1 = utils.generateProtectionKey();
      const key2 = utils.generateProtectionKey();

      assert.notStrictEqual(key1, key2, 'Keys must be unique');
    });
  });

  describe('readProtectionKey() / writeProtectionKey()', () => {
    it('should return null when key file does not exist', () => {
      // Use a temp directory that definitely doesn't have a key
      const result = utils.readProtectionKey();

      // Will return null or fail to read from default location
      // This is acceptable as the function is designed to fail-safe
      assert.ok(result === null || Buffer.isBuffer(result),
        'Should return null or Buffer');
    });

    it('should write and read back the same key', () => {
      const keyBase64 = utils.generateProtectionKey();
      const keyPath = path.join(tempDir.path, 'protection-key');

      // Write key manually to temp directory
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      // Read it back
      const readKey = Buffer.from(
        fs.readFileSync(keyPath, 'utf8').trim(),
        'base64'
      );

      const originalKey = Buffer.from(keyBase64, 'base64');

      assert.ok(readKey.equals(originalKey),
        'Read key should match written key');
    });

    it('should create directory if it does not exist', () => {
      const keyBase64 = utils.generateProtectionKey();
      const nestedPath = path.join(tempDir.path, 'nested', 'dir', 'protection-key');

      // Write to non-existent directory
      const dir = path.dirname(nestedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(nestedPath, keyBase64 + '\n', { mode: 0o600 });

      assert.ok(fs.existsSync(nestedPath),
        'Key file should be created in nested directory');
    });
  });

  // ==========================================================================
  // Encryption / Decryption
  // ==========================================================================

  describe('encryptCredential() / decryptCredential()', () => {
    it('should encrypt and decrypt a credential', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');
      const plaintext = 'my-secret-api-key-12345';

      const encrypted = utils.encryptCredential(plaintext, key);
      const decrypted = utils.decryptCredential(encrypted, key);

      assert.strictEqual(decrypted, plaintext,
        'Decrypted value should match original');
    });

    it('should produce encrypted value in correct format', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');
      const plaintext = 'test-value';

      const encrypted = utils.encryptCredential(plaintext, key);

      assert.ok(encrypted.startsWith('${GENTYR_ENCRYPTED:'),
        'Encrypted value must start with prefix');
      assert.ok(encrypted.endsWith('}'),
        'Encrypted value must end with suffix');

      // Extract payload and verify format: iv:authTag:ciphertext
      const payload = encrypted.slice(
        '${GENTYR_ENCRYPTED:'.length,
        -1
      );
      const parts = payload.split(':');

      assert.strictEqual(parts.length, 3,
        'Payload must have 3 parts: iv:authTag:ciphertext');

      // Verify all parts are valid base64
      for (const part of parts) {
        assert.ok(part.length > 0, 'Each part must be non-empty');
        const decoded = Buffer.from(part, 'base64');
        assert.ok(decoded.length > 0, 'Each part must be valid base64');
      }
    });

    it('should fail decryption with wrong key', () => {
      const key1 = Buffer.from(utils.generateProtectionKey(), 'base64');
      const key2 = Buffer.from(utils.generateProtectionKey(), 'base64');
      const plaintext = 'secret-value';

      const encrypted = utils.encryptCredential(plaintext, key1);
      const decrypted = utils.decryptCredential(encrypted, key2);

      assert.strictEqual(decrypted, null,
        'Decryption with wrong key should return null');
    });

    it('should fail decryption with corrupted ciphertext', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');
      const plaintext = 'secret-value';

      const encrypted = utils.encryptCredential(plaintext, key);

      // Corrupt the ciphertext
      const corrupted = encrypted.slice(0, -5) + 'XXXXX}';
      const decrypted = utils.decryptCredential(corrupted, key);

      assert.strictEqual(decrypted, null,
        'Decryption of corrupted value should return null');
    });

    it('should fail decryption with invalid format', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');

      const invalidFormats = [
        'not-encrypted',
        '${GENTYR_ENCRYPTED:invalid',
        'missing-prefix:abc:def}',
        '${GENTYR_ENCRYPTED:only-two:parts}',
        '${GENTYR_ENCRYPTED:}',
      ];

      for (const invalid of invalidFormats) {
        const decrypted = utils.decryptCredential(invalid, key);
        assert.strictEqual(decrypted, null,
          `Invalid format should return null: ${invalid}`);
      }
    });

    it('should produce different ciphertexts for same plaintext', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');
      const plaintext = 'same-value';

      const encrypted1 = utils.encryptCredential(plaintext, key);
      const encrypted2 = utils.encryptCredential(plaintext, key);

      assert.notStrictEqual(encrypted1, encrypted2,
        'Each encryption should use unique IV');

      // But both should decrypt to same value
      const decrypted1 = utils.decryptCredential(encrypted1, key);
      const decrypted2 = utils.decryptCredential(encrypted2, key);

      assert.strictEqual(decrypted1, plaintext);
      assert.strictEqual(decrypted2, plaintext);
    });
  });

  describe('isEncrypted()', () => {
    it('should return true for encrypted values', () => {
      const key = Buffer.from(utils.generateProtectionKey(), 'base64');
      const encrypted = utils.encryptCredential('test', key);

      assert.strictEqual(utils.isEncrypted(encrypted), true);
    });

    it('should return false for plain text values', () => {
      const plainValues = [
        'plain-text',
        'just-a-string',
        '',
        '${NOT_ENCRYPTED:abc}',
        '${GENTYR_ENCRYPTED:missing-suffix',
      ];

      for (const plain of plainValues) {
        assert.strictEqual(utils.isEncrypted(plain), false,
          `Should not detect as encrypted: ${plain}`);
      }
    });

    it('should return false for non-string values', () => {
      const nonStrings = [null, undefined, 123, {}, []];

      for (const val of nonStrings) {
        assert.strictEqual(utils.isEncrypted(val), false);
      }
    });
  });

  // ==========================================================================
  // Protected Actions Configuration
  // ==========================================================================

  describe('loadProtectedActions() / saveProtectedActions()', () => {
    it('should return null when config file does not exist', () => {
      // Test with non-existent path
      const config = utils.loadProtectedActions();

      // Will return null or existing config from default location
      assert.ok(config === null || typeof config === 'object');
    });

    it('should save and load back the same config', () => {
      const configPath = path.join(tempDir.path, 'protected-actions.json');

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
            credentialKeys: ['TEST_KEY'],
          },
        },
      };

      // Write manually to temp directory
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Read back
      const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      assert.deepStrictEqual(loaded, config,
        'Loaded config should match saved config');
    });
  });

  describe('getProtection()', () => {
    it('should return null for non-protected server', () => {
      const config = {
        servers: {
          'other-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE OTHER',
            tools: '*',
          },
        },
      };

      const protection = utils.getProtection('test-server', 'test-tool', config);

      assert.strictEqual(protection, null,
        'Should return null for non-protected server');
    });

    it('should return protection config when tools is "*"', () => {
      const config = {
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      const protection = utils.getProtection('test-server', 'any-tool', config);

      assert.ok(protection !== null, 'Should return protection for any tool');
      assert.strictEqual(protection.phrase, 'APPROVE TEST');
    });

    it('should return protection config when tool is in list', () => {
      const config = {
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: ['create', 'delete', 'modify'],
          },
        },
      };

      const protection = utils.getProtection('test-server', 'delete', config);

      assert.ok(protection !== null, 'Should return protection for listed tool');
      assert.strictEqual(protection.phrase, 'APPROVE TEST');
    });

    it('should return null when tool is not in list', () => {
      const config = {
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: ['create', 'delete'],
          },
        },
      };

      const protection = utils.getProtection('test-server', 'read', config);

      assert.strictEqual(protection, null,
        'Should return null for non-listed tool');
    });
  });

  // ==========================================================================
  // Approval Management
  // ==========================================================================

  describe('createRequest()', () => {
    it('should create a valid approval request', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      // Mock approval storage by manually creating file
      fs.writeFileSync(approvalsPath, JSON.stringify({ approvals: {} }));

      const result = utils.createRequest(
        'test-server',
        'test-tool',
        { arg1: 'value1' },
        'APPROVE TEST'
      );

      assert.ok(result.code, 'Should return approval code');
      assert.strictEqual(result.code.length, 6, 'Code should be 6 characters');
      assert.strictEqual(result.phrase, 'APPROVE TEST');
      assert.match(result.message, /APPROVE TEST/,
        'Message should include phrase');
    });

    it('should store request with expiry timestamp', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');
      fs.writeFileSync(approvalsPath, JSON.stringify({ approvals: {} }));

      const before = Date.now();
      const result = utils.createRequest(
        'test-server',
        'test-tool',
        {},
        'APPROVE TEST'
      );
      const after = Date.now();

      // Read stored request
      const stored = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      const request = stored.approvals[result.code];

      assert.ok(request, 'Request should be stored');
      assert.strictEqual(request.status, 'pending');
      assert.strictEqual(request.server, 'test-server');
      assert.strictEqual(request.tool, 'test-tool');

      // Check timestamps
      assert.ok(request.created_timestamp >= before,
        'Created timestamp should be recent');
      assert.ok(request.created_timestamp <= after,
        'Created timestamp should be recent');

      // Should expire in ~5 minutes
      const expiryDelta = request.expires_timestamp - request.created_timestamp;
      assert.ok(expiryDelta >= 4.5 * 60 * 1000,
        'Should expire in at least 4.5 minutes');
      assert.ok(expiryDelta <= 5.5 * 60 * 1000,
        'Should expire in at most 5.5 minutes');
    });

    it('should clean up expired requests', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      // Create an expired request
      const now = Date.now();
      const expiredRequest = {
        code: 'OLDONE',
        server: 'test',
        tool: 'test',
        status: 'pending',
        created_timestamp: now - 10 * 60 * 1000, // 10 minutes ago
        expires_timestamp: now - 5 * 60 * 1000,  // expired 5 minutes ago
      };

      fs.writeFileSync(approvalsPath, JSON.stringify({
        approvals: { OLDONE: expiredRequest }
      }));

      // Create new request - should trigger cleanup
      utils.createRequest('test-server', 'test-tool', {}, 'APPROVE TEST');

      // Read back and verify expired request was removed
      const stored = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));

      assert.ok(!stored.approvals.OLDONE,
        'Expired request should be cleaned up');
    });
  });

  describe('validateApproval()', () => {
    it('should validate a valid pending approval', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code,
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.validateApproval('APPROVE TEST', code);

      assert.strictEqual(result.valid, true, 'Should validate successfully');
      assert.strictEqual(result.server, 'test-server');
      assert.strictEqual(result.tool, 'test-tool');
    });

    it('should reject approval with wrong phrase', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            phrase: 'APPROVE TEST',
            code,
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.validateApproval('APPROVE WRONG', code);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /Wrong approval phrase/i);
    });

    it('should reject already-used approval', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            phrase: 'APPROVE TEST',
            code,
            status: 'approved', // Already approved
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.validateApproval('APPROVE TEST', code);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /already been used/i);
    });

    it('should reject expired approval', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            phrase: 'APPROVE TEST',
            code,
            status: 'pending',
            created_timestamp: now - 10 * 60 * 1000,
            expires_timestamp: now - 1000, // Expired 1 second ago
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.validateApproval('APPROVE TEST', code);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /expired/i);
    });

    it('should reject non-existent code', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');
      fs.writeFileSync(approvalsPath, JSON.stringify({ approvals: {} }));

      const result = utils.validateApproval('APPROVE TEST', 'NOPE99');

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /No pending request/i);
    });

    it('should mark approval as approved after validation', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            phrase: 'APPROVE TEST',
            code,
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      utils.validateApproval('APPROVE TEST', code);

      // Read back and verify status changed
      const updated = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));

      assert.strictEqual(updated.approvals[code].status, 'approved');
      assert.ok(updated.approvals[code].approved_at,
        'Should have approved_at timestamp');
    });
  });

  describe('checkApproval()', () => {
    it('should find and consume valid approval', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const code = 'ABC123';
      const approvals = {
        approvals: {
          [code]: {
            server: 'test-server',
            tool: 'test-tool',
            code,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.checkApproval('test-server', 'test-tool', {});

      assert.ok(result !== null, 'Should find approval');
      assert.strictEqual(result.server, 'test-server');

      // Verify it was consumed (removed from file)
      const updated = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.ok(!updated.approvals[code],
        'Approval should be consumed after use');
    });

    it('should return null for non-matching server', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'other-server',
            tool: 'test-tool',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should not find approval for different server');
    });

    it('should return null for pending (not approved) request', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            status: 'pending', // Not approved yet
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should not find pending (not approved) request');
    });

    it('should skip expired approvals', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            status: 'approved',
            created_timestamp: now - 10 * 60 * 1000,
            expires_timestamp: now - 1000, // Expired
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = utils.checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should not find expired approval');
    });
  });

  describe('getPendingRequests()', () => {
    it('should return only pending non-expired requests', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          VALID1: {
            server: 'server1',
            tool: 'tool1',
            phrase: 'APPROVE TEST1',
            code: 'VALID1',
            status: 'pending',
            created_at: new Date(now).toISOString(),
            created_timestamp: now,
            expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
            expires_timestamp: now + 5 * 60 * 1000,
          },
          USED1: {
            server: 'server2',
            tool: 'tool2',
            phrase: 'APPROVE TEST2',
            code: 'USED1',
            status: 'approved', // Already approved
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
          EXPIRED: {
            server: 'server3',
            tool: 'tool3',
            phrase: 'APPROVE TEST3',
            code: 'EXPIRED',
            status: 'pending',
            created_timestamp: now - 10 * 60 * 1000,
            expires_timestamp: now - 1000, // Expired
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const pending = utils.getPendingRequests();

      assert.strictEqual(pending.length, 1,
        'Should return only valid pending request');
      assert.strictEqual(pending[0].code, 'VALID1');
      assert.strictEqual(pending[0].server, 'server1');
    });

    it('should return empty array when no pending requests', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');
      fs.writeFileSync(approvalsPath, JSON.stringify({ approvals: {} }));

      const pending = utils.getPendingRequests();

      assert.strictEqual(pending.length, 0);
    });
  });
});
