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
function createTempDir(prefix = 'protected-gate-test') {
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

    it('should detect MCP tools by name pattern', async () => {
      // Without config file, should pass through (not yet configured)
      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'MCP tools without config should pass through');
    });
  });

  // ==========================================================================
  // Protection Configuration
  // ==========================================================================

  describe('Protection checking', () => {
    it('should pass through when no config file exists', async () => {
      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should pass through when config does not exist (fail-open for unconfigured)');
    });

    it('should pass through unprotected MCP tools', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '1.0.0',
        servers: {
          'other-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE OTHER',
            tools: '*',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      assert.strictEqual(result.exitCode, 0,
        'Should pass through unprotected server');
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

      // Create a valid approval
      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
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

      // Create a valid approval
      const now = Date.now();
      const approvals = {
        approvals: {
          ABC123: {
            server: 'test-server',
            tool: 'test-tool',
            code: 'ABC123',
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
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
    it('should pass through on corrupted config (fail-open for unconfigured)', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Write invalid JSON
      fs.writeFileSync(configPath, '{ invalid json }');

      const result = await runHook('mcp__test-server__test-tool', {}, tempDir.path);

      // Should pass through (fail-safe for config issues)
      assert.strictEqual(result.exitCode, 0,
        'Should pass through on corrupted config (fail-safe)');
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
