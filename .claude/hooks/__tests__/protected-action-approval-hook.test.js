/**
 * Unit tests for protected-action-approval-hook.js (UserPromptSubmit hook)
 *
 * Tests the UserPromptSubmit hook that processes CTO approval messages:
 * - Approval phrase detection (APPROVE <PHRASE> <CODE>)
 * - Code validation (6-char alphanumeric)
 * - Approval matching (phrase, code, expiry, status)
 * - Approval marking (pending -> approved)
 * - Pass-through for non-approval messages
 * - Bypass phrase exclusion (APPROVE BYPASS handled by separate hook)
 *
 * This hook ONLY runs on user keyboard input (UserPromptSubmit),
 * ensuring agents cannot forge approvals.
 *
 * Run with: node --test .claude/hooks/__tests__/protected-action-approval-hook.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory for test files
 */
function createTempDir(prefix = 'approval-hook-test') {
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
 * Execute the hook script with user message via stdin
 */
async function runHook(userMessage, projectDir) {
  const hookPath = path.join(__dirname, '..', 'protected-action-approval-hook.js');

  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  try {
    const { stdout, stderr } = await execAsync(
      `echo "${userMessage}" | node "${hookPath}"`,
      { env, shell: true }
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('protected-action-approval-hook.js (UserPromptSubmit Hook)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (tempDir) {
      tempDir.cleanup();
    }
  });

  // ==========================================================================
  // Message Detection
  // ==========================================================================

  describe('Message detection', () => {
    it('should pass through non-approval messages', async () => {
      const messages = [
        'Hello, how are you?',
        'Please help me with this task',
        'APPROVE but not formatted correctly',
        'approve test ABC123', // lowercase
        'Some text APPROVE TEST but missing code',
      ];

      for (const msg of messages) {
        const result = await runHook(msg, tempDir.path);

        assert.strictEqual(result.exitCode, 0,
          `Non-approval message should pass through: "${msg}"`);
        assert.ok(!result.stderr.includes('PROTECTED ACTION APPROVED'),
          'Should not show approval confirmation');
      }
    });

    it('should detect valid approval pattern', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      // Create pending approval
      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
        'Should show approval confirmation');
    });

    it('should detect approval with case-insensitive pattern', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Try with lowercase (pattern is case-insensitive)
      const result = await runHook('approve test abc123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/);
    });

    it('should handle multi-word phrases', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD DB',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const now = Date.now();
      const approvals = {
        approvals: {
          XYZ789: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE PROD DB',
            code: 'XYZ789',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE PROD DB XYZ789', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/);
    });
  });

  // ==========================================================================
  // Code Validation
  // ==========================================================================

  describe('Code validation', () => {
    beforeEach(() => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));
    });

    it('should reject code with wrong length', async () => {
      const invalidCodes = [
        'ABC12',    // Too short
        'ABC1234',  // Too long
        'A',        // Way too short
      ];

      for (const code of invalidCodes) {
        const result = await runHook(`APPROVE TEST ${code}`, tempDir.path);

        // Should pass through (pattern won't match)
        assert.strictEqual(result.exitCode, 0);
        assert.ok(!result.stderr.includes('PROTECTED ACTION APPROVED'),
          `Invalid length code should not match: ${code}`);
      }
    });

    it('should accept valid 6-character codes', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const validCodes = [
        'ABC123',
        'XYZ789',
        'AAA999',
        'QWERTY',
      ];

      for (const code of validCodes) {
        const now = Date.now();
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

        const result = await runHook(`APPROVE TEST ${code}`, tempDir.path);

        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
          `Valid code should be approved: ${code}`);
      }
    });
  });

  // ==========================================================================
  // Approval Validation
  // ==========================================================================

  describe('Approval validation', () => {
    beforeEach(() => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));
    });

    it('should reject non-existent code', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');
      fs.writeFileSync(approvalsPath, JSON.stringify({ approvals: {} }));

      const result = await runHook('APPROVE TEST NOPE99', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Invalid approval.*No pending request/i,
        'Should log invalid approval');
    });

    it('should reject already-used code', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          USED12: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'USED12',
            status: 'approved', // Already approved
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST USED12', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Invalid approval.*already been used/i,
        'Should log already-used code');
    });

    it('should reject expired code', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          EXPIRE: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'EXPIRE',
            status: 'pending',
            created_timestamp: now - 10 * 60 * 1000,
            expires_timestamp: now - 1000, // Expired 1 second ago
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST EXPIRE', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Invalid approval.*expired/i,
        'Should log expired code');
    });

    it('should reject code with wrong phrase', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Add another server with different phrase
      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
          'prod-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const now = Date.now();
      const approvals = {
        approvals: {
          WRONG1: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'WRONG1',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Use wrong phrase
      const result = await runHook('APPROVE PROD WRONG1', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Invalid approval.*Wrong approval phrase/i,
        'Should log wrong phrase');
    });
  });

  // ==========================================================================
  // Approval Marking
  // ==========================================================================

  describe('Approval marking', () => {
    beforeEach(() => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));
    });

    it('should mark approval as approved', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          MARK12: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'MARK12',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      await runHook('APPROVE TEST MARK12', tempDir.path);

      // Read back and verify status changed
      const updated = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));

      assert.strictEqual(updated.approvals.MARK12.status, 'approved',
        'Status should be approved');
      assert.ok(updated.approvals.MARK12.approved_at,
        'Should have approved_at timestamp');
      assert.ok(updated.approvals.MARK12.approved_timestamp,
        'Should have approved_timestamp');
    });

    it('should include approval details in output', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          DETAIL: {
            server: 'my-server',
            tool: 'dangerous-tool',
            phrase: 'APPROVE TEST',
            code: 'DETAIL',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST DETAIL', tempDir.path);

      assert.match(result.stderr, /Server:\s+my-server/,
        'Should show server name');
      assert.match(result.stderr, /Tool:\s+dangerous-tool/,
        'Should show tool name');
      assert.match(result.stderr, /Code:\s+DETAIL/,
        'Should show code');
      assert.match(result.stderr, /valid for 5 minutes/i,
        'Should show validity duration');
      assert.match(result.stderr, /can only be used once/i,
        'Should show one-time use warning');
    });
  });

  // ==========================================================================
  // Bypass Exclusion
  // ==========================================================================

  describe('Bypass exclusion', () => {
    it('should pass through APPROVE BYPASS messages', async () => {
      // This should be handled by bypass-approval-hook.js, not this hook
      const result = await runHook('APPROVE BYPASS ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(!result.stderr.includes('PROTECTED ACTION APPROVED'),
        'Should not process bypass approvals');
    });
  });

  // ==========================================================================
  // Phrase Validation
  // ==========================================================================

  describe('Phrase validation', () => {
    beforeEach(() => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'server1': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD',
            tools: '*',
          },
          'server2': {
            protection: 'credential-isolated',
            phrase: 'APPROVE EMAIL',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));
    });

    it('should warn about unrecognized phrases', async () => {
      const result = await runHook('APPROVE UNKNOWN ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Unrecognized phrase.*UNKNOWN/i,
        'Should warn about unrecognized phrase');
      assert.match(result.stderr, /Valid phrases/i,
        'Should list valid phrases');
    });

    it('should accept recognized phrases', async () => {
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      const now = Date.now();
      const approvals = {
        approvals: {
          VALID1: {
            server: 'server1',
            tool: 'test-tool',
            phrase: 'APPROVE PROD',
            code: 'VALID1',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE PROD VALID1', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('Error handling', () => {
    it('should handle missing config gracefully', async () => {
      // No config file exists
      const result = await runHook('APPROVE TEST ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should not crash on missing config');
    });

    it('should handle missing approvals file gracefully', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      // No approvals file
      const result = await runHook('APPROVE TEST ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should not crash on missing approvals file');
    });

    it('should handle empty stdin gracefully', async () => {
      const hookPath = path.join(__dirname, '..', 'protected-action-approval-hook.js');

      const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: tempDir.path,
      };

      // Run without stdin -- execAsync resolves on success (exit 0), rejects on failure
      try {
        await execAsync(
          `node "${hookPath}" < /dev/null`,
          { env, shell: true }
        );
        // If we get here, it exited 0
        assert.ok(true, 'Should handle empty stdin gracefully');
      } catch (err) {
        assert.fail(`Hook should exit 0 on empty stdin, got exit code ${err.code}: ${err.stderr}`);
      }
    });
  });
});
