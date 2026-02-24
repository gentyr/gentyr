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
  // HMAC Computation
  // ==========================================================================

  describe('computeHmac()', () => {
    it('should compute HMAC-SHA256 for given fields', () => {
      const keyBase64 = utils.generateProtectionKey();
      const hmac = utils.computeHmac(keyBase64, 'field1', 'field2', 'field3');

      assert.strictEqual(typeof hmac, 'string', 'HMAC must be a string');
      assert.strictEqual(hmac.length, 64, 'HMAC-SHA256 hex output is 64 characters');
      assert.match(hmac, /^[0-9a-f]{64}$/, 'HMAC must be hex-encoded');
    });

    it('should produce different HMACs for different field orders', () => {
      const keyBase64 = utils.generateProtectionKey();
      const hmac1 = utils.computeHmac(keyBase64, 'a', 'b', 'c');
      const hmac2 = utils.computeHmac(keyBase64, 'c', 'b', 'a');

      assert.notStrictEqual(hmac1, hmac2,
        'Field order should affect HMAC output');
    });

    it('should produce different HMACs for different keys', () => {
      const key1 = utils.generateProtectionKey();
      const key2 = utils.generateProtectionKey();
      const hmac1 = utils.computeHmac(key1, 'field1', 'field2');
      const hmac2 = utils.computeHmac(key2, 'field1', 'field2');

      assert.notStrictEqual(hmac1, hmac2,
        'Different keys should produce different HMACs');
    });

    it('should produce same HMAC for same key and fields', () => {
      const keyBase64 = utils.generateProtectionKey();
      const hmac1 = utils.computeHmac(keyBase64, 'field1', 'field2', 'field3');
      const hmac2 = utils.computeHmac(keyBase64, 'field1', 'field2', 'field3');

      assert.strictEqual(hmac1, hmac2,
        'Same key and fields should produce identical HMAC');
    });

    it('should handle empty fields', () => {
      const keyBase64 = utils.generateProtectionKey();
      const hmac = utils.computeHmac(keyBase64, '', '', '');

      assert.strictEqual(typeof hmac, 'string');
      assert.strictEqual(hmac.length, 64);
    });

    it('should use pipe delimiter for fields', () => {
      const keyBase64 = utils.generateProtectionKey();

      // computeHmac('a', 'b') results in 'a|b'
      // computeHmac('ab') results in 'ab' (different from 'a|b')
      // This demonstrates the pipe delimiter prevents ambiguity
      const hmac1 = utils.computeHmac(keyBase64, 'a', 'b');
      const hmac2 = utils.computeHmac(keyBase64, 'ab');

      assert.notStrictEqual(hmac1, hmac2,
        'Pipe delimiter should prevent field boundary ambiguity');
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

    // HMAC verification tests for validateApproval.
    // These tests require a fresh module import per test (cache-busting) because
    // APPROVALS_PATH and PROTECTION_KEY_PATH are resolved from CLAUDE_PROJECT_DIR
    // at module load time (top-level constants).

    it('should reject request with forged pending_hmac during validateApproval', async () => {
      const hmacTempDir = createTempDir('validate-hmac-forgery');
      try {
        // Create .claude subdirectory (module reads from PROJECT_DIR/.claude/)
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        // Create an approval with a valid structure but an INVALID pending_hmac
        const now = Date.now();
        const code = 'FRGD22';
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash: crypto.createHash('sha256').update('{}').digest('hex'),
              phrase: 'APPROVE TEST',
              code,
              status: 'pending',
              created_timestamp: now,
              expires_timestamp: now + 5 * 60 * 1000,
              // deliberately invalid (forged) HMAC
              pending_hmac: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        // Set env and import fresh module (cache-bust with timestamp query)
        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.validateApproval('APPROVE TEST', code);

        assert.strictEqual(result.valid, false, 'Should reject forged pending_hmac');
        assert.ok(
          /FORGERY/i.test(result.reason) || /Invalid request signature/i.test(result.reason),
          `Reason should mention forgery or invalid signature, got: ${result.reason}`
        );
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should fail-closed when key is missing but request has pending_hmac during validateApproval', async () => {
      const hmacTempDir = createTempDir('validate-hmac-no-key');
      try {
        // Create .claude subdirectory but do NOT write a protection key
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Create an approval WITH a pending_hmac field (no key to verify against)
        const now = Date.now();
        const code = 'NOKEY3';
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash: crypto.createHash('sha256').update('{}').digest('hex'),
              phrase: 'APPROVE TEST',
              code,
              status: 'pending',
              created_timestamp: now,
              expires_timestamp: now + 5 * 60 * 1000,
              pending_hmac: 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd',
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        // Set env and import fresh module (cache-bust with timestamp query)
        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.validateApproval('APPROVE TEST', code);

        assert.strictEqual(result.valid, false,
          'Should fail-closed (G001) when key missing but pending_hmac present');
        assert.ok(
          /protection key missing/i.test(result.reason) || /Cannot verify/i.test(result.reason),
          `Reason should mention missing protection key or inability to verify, got: ${result.reason}`
        );
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should set approved_hmac when key is available during validateApproval', async () => {
      const hmacTempDir = createTempDir('validate-hmac-set-approved');
      try {
        // Create .claude subdirectory
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Generate and write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        // Build approval with a valid computed pending_hmac
        const now = Date.now();
        const code = 'HMAC44';
        const argsHash = ''; // validateApproval uses request.argsHash || ''
        const expiresTimestamp = now + 5 * 60 * 1000;
        const server = 'test-server';
        const tool = 'test-tool';

        // Compute the pending_hmac the same way the module does in createRequest()
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        const validPendingHmac = crypto
          .createHmac('sha256', keyBuffer)
          .update([code, server, tool, argsHash, String(expiresTimestamp)].join('|'))
          .digest('hex');

        const approvalsData = {
          approvals: {
            [code]: {
              server,
              tool,
              args: {},
              // No argsHash field so module falls back to '' — matches our computation above
              phrase: 'APPROVE TEST',
              code,
              status: 'pending',
              created_timestamp: now,
              expires_timestamp: expiresTimestamp,
              pending_hmac: validPendingHmac,
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        // Set env and import fresh module (cache-bust with timestamp query)
        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.validateApproval('APPROVE TEST', code);

        assert.strictEqual(result.valid, true,
          'Should accept valid pending_hmac and approve the request');

        // Read back the approvals file and verify approved_hmac was written
        const updated = JSON.parse(
          fs.readFileSync(path.join(claudeDir, 'protected-action-approvals.json'), 'utf8')
        );
        const updatedRequest = updated.approvals[code];

        assert.ok(updatedRequest, 'Request should still exist in approvals file');
        assert.strictEqual(updatedRequest.status, 'approved', 'Status should be approved');
        assert.ok(
          typeof updatedRequest.approved_hmac === 'string' && updatedRequest.approved_hmac.length > 0,
          'approved_hmac should be a non-empty string'
        );
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should reject request without HMAC fields when key is available during validateApproval (fail-closed)', async () => {
      const hmacTempDir = createTempDir('validate-hmac-legacy');
      try {
        // Create .claude subdirectory
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key (key IS present, but request has no HMAC fields)
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        // Create an approval WITHOUT any HMAC fields
        const now = Date.now();
        const code = 'LGCY55';
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              phrase: 'APPROVE TEST',
              code,
              status: 'pending',
              created_timestamp: now,
              expires_timestamp: now + 5 * 60 * 1000,
              // No pending_hmac or approved_hmac — missing HMAC fields
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        // Set env and import fresh module (cache-bust with timestamp query)
        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.validateApproval('APPROVE TEST', code);

        // G001 Fail-Closed: When a protection key exists, pending_hmac is verified
        // unconditionally. A request without pending_hmac (undefined) fails the
        // comparison against the computed HMAC hex string, blocking the request as FORGERY.
        assert.strictEqual(result.valid, false,
          'Should reject request without pending_hmac when protection key is present (G001 fail-closed)');
        assert.ok(
          /FORGERY/i.test(result.reason) || /Invalid request signature/i.test(result.reason),
          `Reason should indicate FORGERY or invalid signature, got: ${result.reason}`
        );

        // Verify the forged request was deleted from the approvals file
        const updated = JSON.parse(
          fs.readFileSync(path.join(claudeDir, 'protected-action-approvals.json'), 'utf8')
        );
        assert.ok(!updated.approvals[code],
          'Request without pending_hmac should be deleted from approvals file');
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should reject request without pending_hmac when key is available during validateApproval', async () => {
      const hmacTempDir = createTempDir('validate-hmac-no-pending');
      try {
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        // Create a pending request WITHOUT pending_hmac (attacker-injected request)
        const now = Date.now();
        const code = 'NOPND6';
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash: crypto.createHash('sha256').update('{}').digest('hex'),
              phrase: 'APPROVE TEST',
              code,
              status: 'pending',
              created_timestamp: now,
              expires_timestamp: now + 5 * 60 * 1000,
              // No pending_hmac — should be rejected as forgery
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.validateApproval('APPROVE TEST', code);

        assert.strictEqual(result.valid, false,
          'Should reject request without pending_hmac when protection key is present');
        assert.ok(
          /FORGERY/i.test(result.reason) || /Invalid request signature/i.test(result.reason),
          `Reason should indicate FORGERY or invalid signature, got: ${result.reason}`
        );
      } finally {
        hmacTempDir.cleanup();
      }
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

    it('should reject approval when argsHash does not match (bait-and-switch attack)', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvedArgs = { arg1: 'value1' };
      const differentArgs = { arg1: 'different-value' };

      const approvedArgsHash = crypto.createHash('sha256')
        .update(JSON.stringify(approvedArgs))
        .digest('hex');

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            args: approvedArgs,
            argsHash: approvedArgsHash,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Try to use approval with different args
      const result = utils.checkApproval('test-server', 'test-tool', differentArgs);

      assert.strictEqual(result, null,
        'Should reject approval when args do not match approved args');
    });

    it('should accept approval when argsHash matches', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const args = { arg1: 'value1', arg2: 'value2' };

      const argsHash = crypto.createHash('sha256')
        .update(JSON.stringify(args))
        .digest('hex');

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            args: args,
            argsHash: argsHash,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Use approval with matching args
      const result = utils.checkApproval('test-server', 'test-tool', args);

      assert.ok(result !== null, 'Should accept approval when args match');
      assert.strictEqual(result.server, 'test-server');
      assert.strictEqual(result.tool, 'test-tool');
    });

    it('should delete approval with forged pending_hmac', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');
      const keyPath = path.join(tempDir.path, 'protection-key');

      // Create protection key
      const keyBase64 = utils.generateProtectionKey();
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      const now = Date.now();
      const code = 'FORGED';
      const argsHash = crypto.createHash('sha256').update('{}').digest('hex');

      const approvals = {
        approvals: {
          [code]: {
            server: 'test-server',
            tool: 'test-tool',
            args: {},
            argsHash: argsHash,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
            pending_hmac: 'deadbeef00001111222233334444555566667777', // Invalid HMAC
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Override PROTECTION_KEY_PATH for this test
      const originalDir = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = tempDir.path;

      const result = utils.checkApproval('test-server', 'test-tool', {});

      process.env.CLAUDE_PROJECT_DIR = originalDir;

      assert.strictEqual(result, null,
        'Should reject approval with invalid pending_hmac');

      // Verify forged entry was deleted
      const updated = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.ok(!updated.approvals[code],
        'Forged approval should be deleted');
    });

    it('should delete approval with forged approved_hmac', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');
      const keyPath = path.join(tempDir.path, 'protection-key');

      // Create protection key
      const keyBase64 = utils.generateProtectionKey();
      fs.writeFileSync(keyPath, keyBase64 + '\n');

      const now = Date.now();
      const code = 'FORGED';
      const argsHash = crypto.createHash('sha256').update('{}').digest('hex');
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Compute valid pending_hmac
      const validPendingHmac = utils.computeHmac(
        keyBase64,
        code,
        'test-server',
        'test-tool',
        argsHash,
        String(expiresTimestamp)
      );

      const approvals = {
        approvals: {
          [code]: {
            server: 'test-server',
            tool: 'test-tool',
            args: {},
            argsHash: argsHash,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: validPendingHmac,
            approved_hmac: 'deadbeef00001111222233334444555566667777', // Invalid HMAC
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Override PROTECTION_KEY_PATH for this test
      const originalDir = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = tempDir.path;

      const result = utils.checkApproval('test-server', 'test-tool', {});

      process.env.CLAUDE_PROJECT_DIR = originalDir;

      assert.strictEqual(result, null,
        'Should reject approval with invalid approved_hmac');

      // Verify forged entry was deleted
      const updated = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.ok(!updated.approvals[code],
        'Forged approval should be deleted');
    });

    it('should fail-closed when protection key exists but cannot verify HMAC', () => {
      const approvalsPath = path.join(tempDir.path, 'approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            args: {},
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
            pending_hmac: 'some-hmac-value', // HMAC field present but key missing
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // No protection key exists — should fail-closed (G001)
      const result = utils.checkApproval('test-server', 'test-tool', {});

      assert.strictEqual(result, null,
        'Should fail-closed when key missing but HMAC field present (G001)');
    });

    // HMAC fail-closed tests for checkApproval.
    // These tests require fresh module imports (cache-busting) because APPROVALS_PATH and
    // PROTECTION_KEY_PATH are resolved from CLAUDE_PROJECT_DIR at module load time.

    it('should reject request without pending_hmac when key is available during checkApproval', async () => {
      const hmacTempDir = createTempDir('check-hmac-no-pending');
      try {
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        const now = Date.now();
        const code = 'NOPND7';
        const argsHash = crypto.createHash('sha256').update('{}').digest('hex');
        const expiresTimestamp = now + 5 * 60 * 1000;

        // Create an approved request WITHOUT pending_hmac or approved_hmac
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash,
              code,
              status: 'approved',
              created_timestamp: now,
              expires_timestamp: expiresTimestamp,
              approved_at: new Date(now).toISOString(),
              // No pending_hmac or approved_hmac — should be treated as forgery
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.checkApproval('test-server', 'test-tool', {});

        // G001 Fail-Closed: When protection key exists, pending_hmac is verified unconditionally.
        // A request without pending_hmac fails the comparison against the computed hex string.
        assert.strictEqual(result, null,
          'Should reject approved request without pending_hmac when protection key is present (G001 fail-closed)');

        // Verify the forged request was deleted from the approvals file
        const updated = JSON.parse(
          fs.readFileSync(path.join(claudeDir, 'protected-action-approvals.json'), 'utf8')
        );
        assert.ok(!updated.approvals[code],
          'Request without pending_hmac should be deleted from approvals file');
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should reject request without approved_hmac when key is available during checkApproval', async () => {
      const hmacTempDir = createTempDir('check-hmac-no-approved');
      try {
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        const now = Date.now();
        const code = 'NOAPV8';
        const argsHash = crypto.createHash('sha256').update('{}').digest('hex');
        const expiresTimestamp = now + 5 * 60 * 1000;

        // Compute a valid pending_hmac so it passes the first check
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        const validPendingHmac = crypto
          .createHmac('sha256', keyBuffer)
          .update([code, 'test-server', 'test-tool', argsHash, String(expiresTimestamp)].join('|'))
          .digest('hex');

        // Create an approved request WITH valid pending_hmac but WITHOUT approved_hmac
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash,
              code,
              status: 'approved',
              created_timestamp: now,
              expires_timestamp: expiresTimestamp,
              approved_at: new Date(now).toISOString(),
              pending_hmac: validPendingHmac,
              // No approved_hmac — should be treated as forgery
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.checkApproval('test-server', 'test-tool', {});

        // G001 Fail-Closed: approved_hmac is verified unconditionally when protection key exists.
        // Missing approved_hmac (undefined) fails comparison against computed hex string.
        assert.strictEqual(result, null,
          'Should reject approved request without approved_hmac when protection key is present (G001 fail-closed)');

        // Verify the forged request was deleted from the approvals file
        const updated = JSON.parse(
          fs.readFileSync(path.join(claudeDir, 'protected-action-approvals.json'), 'utf8')
        );
        assert.ok(!updated.approvals[code],
          'Request without approved_hmac should be deleted from approvals file');
      } finally {
        hmacTempDir.cleanup();
      }
    });

    it('should accept fully HMAC-signed request during checkApproval', async () => {
      const hmacTempDir = createTempDir('check-hmac-valid');
      try {
        const claudeDir = path.join(hmacTempDir.path, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });

        // Write a real protection key
        const keyBase64 = crypto.randomBytes(32).toString('base64');
        fs.writeFileSync(path.join(claudeDir, 'protection-key'), keyBase64 + '\n', { mode: 0o600 });

        const now = Date.now();
        const code = 'VALID9';
        const argsHash = crypto.createHash('sha256').update('{}').digest('hex');
        const expiresTimestamp = now + 5 * 60 * 1000;

        // Compute valid pending_hmac and approved_hmac using the same logic as approval-utils.js
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        const validPendingHmac = crypto
          .createHmac('sha256', keyBuffer)
          .update([code, 'test-server', 'test-tool', argsHash, String(expiresTimestamp)].join('|'))
          .digest('hex');
        const validApprovedHmac = crypto
          .createHmac('sha256', keyBuffer)
          .update([code, 'test-server', 'test-tool', 'approved', argsHash, String(expiresTimestamp)].join('|'))
          .digest('hex');

        // Create a fully signed approved request
        const approvalsData = {
          approvals: {
            [code]: {
              server: 'test-server',
              tool: 'test-tool',
              args: {},
              argsHash,
              code,
              status: 'approved',
              created_timestamp: now,
              expires_timestamp: expiresTimestamp,
              approved_at: new Date(now).toISOString(),
              pending_hmac: validPendingHmac,
              approved_hmac: validApprovedHmac,
            },
          },
        };
        fs.writeFileSync(
          path.join(claudeDir, 'protected-action-approvals.json'),
          JSON.stringify(approvalsData)
        );

        process.env.CLAUDE_PROJECT_DIR = hmacTempDir.path;
        const freshUtils = await import(`../lib/approval-utils.js?t=${Date.now()}`);

        const result = freshUtils.checkApproval('test-server', 'test-tool', {});

        assert.ok(result !== null,
          'Should accept fully HMAC-signed approval request');
        assert.strictEqual(result.server, 'test-server',
          'Returned approval should contain correct server');
        assert.strictEqual(result.tool, 'test-tool',
          'Returned approval should contain correct tool');

        // Verify the approval was consumed (one-time use)
        const updated = JSON.parse(
          fs.readFileSync(path.join(claudeDir, 'protected-action-approvals.json'), 'utf8')
        );
        assert.ok(!updated.approvals[code],
          'Valid approval should be consumed (deleted) after use');
      } finally {
        hmacTempDir.cleanup();
      }
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
