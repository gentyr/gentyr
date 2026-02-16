/**
 * Unit tests for protected-action-gate.js (PreToolUse hook)
 *
 * Tests the PreToolUse hook that blocks protected MCP actions:
 * - MCP tool name parsing (mcp__server__tool format)
 * - Protection checking (server/tool wildcard matching)
 * - Approval validation (one-time use, expiry)
 * - Block behavior (exit code 1, generates approval code)
 * - Pass-through for non-MCP and non-protected tools
 *
 * This hook runs BEFORE tool execution, so it cannot be bypassed by agents.
 * Tests verify it fails closed (blocks on error) per G001.
 *
 * Run with: node --test .claude/hooks/__tests__/protected-action-gate.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

// Static test protection key (base64-encoded 32 bytes)
const TEST_PROTECTION_KEY = crypto.randomBytes(32).toString('base64');

/**
 * Compute HMAC-SHA256 matching the gate hook's algorithm.
 * Used to create valid HMAC fields in test approval entries.
 */
function computeTestHmac(...fields) {
  const keyBuffer = Buffer.from(TEST_PROTECTION_KEY, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

/**
 * Compute args hash matching the gate hook's algorithm.
 */
function computeArgsHash(args) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(args || {}))
    .digest('hex');
}

/**
 * Create a temporary directory for test files.
 * Automatically creates .claude/ dir and protection-key.
 */
function createTempDir(prefix = 'protected-gate-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  // Create protection key (required by gate hook for HMAC verification)
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'protection-key'), TEST_PROTECTION_KEY);

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
 * Execute the hook script with environment variables
 */
async function runHook(toolName, toolInput, projectDir) {
  const hookPath = path.join(__dirname, '..', 'protected-action-gate.js');

  const env = {
    ...process.env,
    TOOL_NAME: toolName,
    TOOL_INPUT: JSON.stringify(toolInput),
    CLAUDE_PROJECT_DIR: projectDir,
  };

  try {
    const { stdout, stderr } = await execAsync(`node "${hookPath}"`, { env });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('protected-action-gate.js (PreToolUse Hook)', () => {
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
  // MCP Tool Name Parsing
  // ==========================================================================

  describe('MCP tool detection', () => {
    it('should pass through non-MCP tools', async () => {
      const result = await runHook('Read', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Non-MCP tools should pass through');
    });

    it('should pass through built-in tools', async () => {
      const builtInTools = ['Bash', 'Edit', 'Write', 'Grep', 'Glob'];

      for (const tool of builtInTools) {
        const result = await runHook(tool, {}, tempDir.path);

        assert.strictEqual(result.exitCode, 0,
          `Built-in tool ${tool} should pass through`);
      }
    });

    it('should block MCP tools when config is missing (G001 fail-closed)', async () => {
      // Without config file, should block all MCP actions (A4/C5 defense)
      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'MCP tools without config should be blocked (G001 fail-closed)');
      assert.match(result.stderr, /config not found/i,
        'Should indicate config is missing');
    });
  });

  // ==========================================================================
  // Protection Configuration
  // ==========================================================================

  describe('Protection checking', () => {
    it('should block when no config file exists (G001 fail-closed)', async () => {
      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block when config does not exist (G001 fail-closed, A4/C5 defense)');
      assert.match(result.stderr, /config not found/i,
        'Should indicate config is missing');
    });

    it('should block unknown MCP servers not in allowlist (Fix 3)', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'other-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE OTHER',
            tools: '*',
          },
        },
        allowedUnprotectedServers: [],
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block unknown MCP server not in allowlist (Fix 3)');
      assert.match(result.stderr, /unrecognized mcp server/i,
        'Should indicate server is unrecognized');
    });

    it('should pass through servers in allowedUnprotectedServers (Fix 3)', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'other-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE OTHER',
            tools: '*',
          },
        },
        allowedUnprotectedServers: ['test-server'],
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should pass through server in allowedUnprotectedServers');
    });

    it('should block protected server with wildcard tools', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*', // All tools protected
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__any-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block protected server with wildcard');
      assert.match(result.stderr, /PROTECTED ACTION BLOCKED/,
        'Should show block message');
    });

    it('should block protected tool from tool list', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: ['create', 'delete', 'modify'],
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__delete', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block protected tool in list');
    });

    it('should pass through non-protected tool from same server', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: ['create', 'delete'],
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__read', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should pass through non-protected tool');
    });
  });

  // ==========================================================================
  // Approval Code Generation
  // ==========================================================================

  describe('Approval code generation', () => {
    it('should generate and display approval code when blocked', async () => {
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

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1, 'Should block');
      assert.match(result.stderr, /APPROVE TEST [A-Z0-9]{6}/,
        'Should display approval phrase and code');
      assert.match(result.stderr, /expires in 5 minutes/i,
        'Should show expiry time');
    });

    it('should store approval request in file', async () => {
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

      await runHook('mcp__test-server__test-tool', { arg: 'value' }, tempDir.path);

      // Verify approval request was created
      assert.ok(fs.existsSync(approvalsPath),
        'Approvals file should be created');

      const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));

      assert.ok(Object.keys(approvals.approvals).length > 0,
        'Should have at least one approval request');

      const request = Object.values(approvals.approvals)[0];

      assert.strictEqual(request.server, 'test-server');
      assert.strictEqual(request.tool, 'test-tool');
      assert.strictEqual(request.status, 'pending');
      assert.ok(request.code.length === 6, 'Code should be 6 characters');
    });

    it('should include tool arguments in approval request', async () => {
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

      const toolArgs = { database: 'production', action: 'delete' };

      await runHook('mcp__test-server__dangerous-tool', toolArgs, tempDir.path);

      const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      const request = Object.values(approvals.approvals)[0];

      assert.deepStrictEqual(request.args, toolArgs,
        'Should store tool arguments in request');
    });
  });

  // ==========================================================================
  // Approval Validation
  // ==========================================================================

  describe('Approval validation', () => {
    it('should pass through when valid approval exists', async () => {
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

      // Create a valid approval with HMAC fields (including argsHash for empty args)
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const emptyArgsHash = computeArgsHash({});
      const pendingHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', emptyArgsHash, String(expiresTimestamp));
      const approvedHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', 'approved', emptyArgsHash, String(expiresTimestamp));

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'approved',
            argsHash: emptyArgsHash,
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
            approved_hmac: approvedHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should pass through with valid approval');
      assert.match(result.stderr, /Approval verified/,
        'Should log approval verification');
    });

    it('should consume approval (one-time use)', async () => {
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

      // Create a valid approval with HMAC fields (including argsHash for empty args)
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const emptyArgsHash = computeArgsHash({});
      const pendingHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', emptyArgsHash, String(expiresTimestamp));
      const approvedHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', 'approved', emptyArgsHash, String(expiresTimestamp));

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'ABC123',
            status: 'approved',
            argsHash: emptyArgsHash,
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
            approved_hmac: approvedHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // First call - should pass
      const result1 = await runHook('mcp__test-server__test-tool', {}, tempDir.path);
      assert.strictEqual(result1.exitCode, 0);

      // Second call - should block (approval consumed)
      const result2 = await runHook('mcp__test-server__test-tool', {}, tempDir.path);
      assert.strictEqual(result2.exitCode, 1,
        'Second call should be blocked (approval consumed)');
    });

    it('should block bait-and-switch (approval args mismatch - Fix 3)', async () => {
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

      // Create a valid approval for safe query args
      const safeArgs = { query: 'SELECT count(*) FROM users' };
      const safeArgsHash = computeArgsHash(safeArgs);
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const pendingHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', safeArgsHash, String(expiresTimestamp));
      const approvedHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', 'approved', safeArgsHash, String(expiresTimestamp));

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'approved',
            args: safeArgs,
            argsHash: safeArgsHash,
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
            approved_hmac: approvedHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      // Attempt bait-and-switch: call with DIFFERENT args (dangerous query)
      const maliciousArgs = { query: 'DROP TABLE users CASCADE' };
      const result = await runHook('mcp__test-server__test-tool', maliciousArgs, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block when args do not match approved args (bait-and-switch prevention)');
      assert.match(result.stderr, /PROTECTED ACTION BLOCKED/,
        'Should show block message for args mismatch');
    });

    it('should block with pending (not approved) approval', async () => {
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

      // Create pending (not approved) request
      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'ABC123',
            status: 'pending', // Not approved yet
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block with pending approval');
    });

    it('should block with expired approval', async () => {
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

      // Create expired approval
      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now - 10 * 60 * 1000,
            expires_timestamp: now - 1000, // Expired
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block with expired approval');
    });
  });

  // ==========================================================================
  // Error Handling (G001: Fail Closed)
  // ==========================================================================

  describe('Error handling (G001)', () => {
    it('should block on corrupted config (G001 fail-closed)', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Write invalid JSON
      fs.writeFileSync(configPath, '{ invalid json }');

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      // G001: Fail-closed on corrupted config - block ALL MCP actions
      assert.strictEqual(result.exitCode, 1,
        'Should block on corrupted config (G001 fail-closed)');
      assert.match(result.stderr, /FAIL-CLOSED/i,
        'Should show G001 fail-closed message');
    });

    it('should handle malformed tool input gracefully', async () => {
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

      // Run with malformed input (should still check protection)
      const hookPath = path.join(__dirname, '..', 'protected-action-gate.js');

      const env = {
        ...process.env,
        TOOL_NAME: 'mcp__test-server__test-tool',
        TOOL_INPUT: '{ invalid json', // Malformed
        CLAUDE_PROJECT_DIR: tempDir.path,
      };

      try {
        await execAsync(`node "${hookPath}"`, { env });
        assert.fail('Should block protected action even with malformed input');
      } catch (err) {
        assert.strictEqual(err.code, 1, 'Should block despite malformed input');
      }
    });
  });

  // ==========================================================================
  // HMAC Forgery Detection (Fix 2)
  // ==========================================================================

  describe('HMAC forgery detection', () => {
    it('should reject approval with tampered pending_hmac', async () => {
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

      // Create an approval with a forged pending_hmac
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const forgedPendingHmac = 'deadbeef'.repeat(8); // 64-char hex, but wrong
      const approvedHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', 'approved', String(expiresTimestamp));

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: forgedPendingHmac,
            approved_hmac: approvedHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block when pending_hmac is forged');
      assert.match(result.stderr, /PROTECTED ACTION BLOCKED/,
        'Should show block message for forged pending_hmac');

      // Verify the forged entry was deleted
      const updatedApprovals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.strictEqual(updatedApprovals.approvals.ABC123, undefined,
        'Forged entry should be deleted from approvals file');
    });

    it('should reject approval with tampered approved_hmac', async () => {
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

      // Create an approval with valid pending_hmac but forged approved_hmac
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const pendingHmac = computeTestHmac('ABC123', 'test-server', 'test-tool', String(expiresTimestamp));
      const forgedApprovedHmac = 'cafebabe'.repeat(8); // 64-char hex, but wrong

      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: pendingHmac,
            approved_hmac: forgedApprovedHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block when approved_hmac is forged');
      assert.match(result.stderr, /PROTECTED ACTION BLOCKED/,
        'Should show block message for forged approved_hmac');

      // Verify the forged entry was deleted
      const updatedApprovals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.strictEqual(updatedApprovals.approvals.ABC123, undefined,
        'Forged entry should be deleted from approvals file');
    });

    it('should reject forged entry while preserving valid entries', async () => {
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
      const expiresTimestamp = now + 5 * 60 * 1000;

      // Forged entry for our target tool
      const forgedPendingHmac = 'deadbeef'.repeat(8);
      const forgedApprovedHmac = 'cafebabe'.repeat(8);

      // Legitimate pending entry for a different tool (should be preserved)
      const legitimatePendingHmac = computeTestHmac('XYZ789', 'test-server', 'other-tool', String(expiresTimestamp));

      const approvals = {
        approvals: {
          FORGED: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'FORGED',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: forgedPendingHmac,
            approved_hmac: forgedApprovedHmac,
          },
          XYZ789: {
            server: 'test-server',
            tool: 'other-tool',
            code: 'XYZ789',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: legitimatePendingHmac,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 1,
        'Should block (forged entry rejected, no valid approval)');

      // Verify forged entry was deleted but legitimate entry preserved
      const updatedApprovals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
      assert.strictEqual(updatedApprovals.approvals.FORGED, undefined,
        'Forged entry should be deleted');
      assert.ok(updatedApprovals.approvals.XYZ789,
        'Legitimate entry for other tool should be preserved');
    });
  });

  // ==========================================================================
  // Missing Protection Key (G001 Fail-Closed)
  // ==========================================================================

  describe('Missing protection-key (G001 fail-closed)', () => {
    it('should block protected action when protection-key is absent', async () => {
      // Create a temp dir WITHOUT a protection-key
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-no-key-'));
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      // Deliberately do NOT create protection-key file

      const configPath = path.join(tmpDir, '.claude', 'hooks', 'protected-actions.json');
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

      try {
        const result = await runHook('mcp__test-server__test-tool', {}, tmpDir);

        assert.strictEqual(result.exitCode, 1,
          'Should block when protection-key is missing (G001 fail-closed)');
        assert.match(result.stderr, /protection key missing/i,
          'Should indicate protection key is missing');
        assert.match(result.stderr, /FAIL-CLOSED/i,
          'Should reference G001 fail-closed behavior');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should block even when valid approval exists but protection-key is absent', async () => {
      // This tests that we cannot bypass HMAC verification by deleting the key
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-no-key-approval-'));
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      // No protection-key

      const configPath = path.join(tmpDir, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tmpDir, '.claude', 'protected-action-approvals.json');
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

      // Write an approval that looks valid (but cannot be HMAC-verified)
      const now = Date.now();
      const expiresTimestamp = now + 5 * 60 * 1000;
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: expiresTimestamp,
            pending_hmac: 'some_hmac_value',
            approved_hmac: 'some_approved_hmac',
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      try {
        const result = await runHook('mcp__test-server__test-tool', {}, tmpDir);

        assert.strictEqual(result.exitCode, 1,
          'Should block even with approval present when protection-key missing');
        assert.match(result.stderr, /protection key missing/i,
          'Should indicate protection key is missing');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should allow non-MCP tools even without protection-key', async () => {
      // Non-MCP tools should still pass through regardless of key presence
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-no-key-nonmcp-'));
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      // No protection-key

      try {
        const result = await runHook('Read', {}, tmpDir);

        assert.strictEqual(result.exitCode, 0,
          'Non-MCP tools should pass through even without protection-key');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // Output Format
  // ==========================================================================

  describe('Block message format', () => {
    it('should display clear block message with all details', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook(
        'mcp__test-server__dangerous-operation',
        { database: 'production', action: 'truncate' },
        tempDir.path
      );

      assert.strictEqual(result.exitCode, 1);

      // Check all required elements in output
      assert.match(result.stderr, /PROTECTED ACTION BLOCKED/,
        'Should show block header');
      assert.match(result.stderr, /Server:\s+test-server/,
        'Should show server name');
      assert.match(result.stderr, /Tool:\s+dangerous-operation/,
        'Should show tool name');
      assert.match(result.stderr, /Arguments:/,
        'Should show arguments section');
      assert.match(result.stderr, /database.*production/,
        'Should show argument details');
      assert.match(result.stderr, /APPROVE PROD [A-Z0-9]{6}/,
        'Should show approval command');
      assert.match(result.stderr, /expires in 5 minutes/i,
        'Should show expiry warning');
    });
  });
});
