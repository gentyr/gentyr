/**
 * Unit tests for protected-action-approval-hook.js - Files Section Support
 *
 * Tests the new getValidPhrases() enhancement that supports config.files section
 * in addition to config.servers. This ensures file-based protection phrases are
 * properly recognized and validated.
 *
 * Run with: node --test .claude/hooks/__tests__/protected-action-approval-hook-files.test.js
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

function createTempDir(prefix = 'approval-hook-files-test') {
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
// Test Suite: Files Section Support
// ============================================================================

describe('protected-action-approval-hook.js - Files Section Support', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (tempDir) {
      tempDir.cleanup();
    }
  });

  describe('getValidPhrases() with files section', () => {
    it('should recognize phrases from files section only', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Config with ONLY files section, no servers
      const config = {
        version: '2.0.0',
        servers: {},
        files: {
          '.mcp.json': {
            protection: 'approval-only',
            phrase: 'APPROVE MCP',
            description: 'MCP server definitions',
          },
          '.claude/credential-provider.json': {
            protection: 'approval-only',
            phrase: 'APPROVE CREDENTIAL',
            description: 'Credential provider configuration',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      // Create pending approval for file-based phrase
      const now = Date.now();
      const approvals = {
        approvals: {
          FILE01: {
            server: 'credential-file-guard',
            tool: 'write_protected_file',
            phrase: 'APPROVE MCP',
            code: 'FILE01',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE MCP FILE01', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
        'Should approve file-based phrase');
    });

    it('should recognize phrases from both servers and files sections', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Config with BOTH servers and files
      const config = {
        version: '2.0.0',
        servers: {
          'supabase': {
            protection: 'credential-isolated',
            phrase: 'APPROVE DATABASE',
            tools: '*',
          },
        },
        files: {
          '.mcp.json': {
            protection: 'approval-only',
            phrase: 'APPROVE MCP',
            description: 'MCP config',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      // Test server phrase
      const now = Date.now();
      const approvals = {
        approvals: {
          SVR001: {
            server: 'supabase',
            tool: 'delete_table',
            phrase: 'APPROVE DATABASE',
            code: 'SVR001',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const serverResult = await runHook('APPROVE DATABASE SVR001', tempDir.path);

      assert.strictEqual(serverResult.exitCode, 0);
      assert.match(serverResult.stderr, /PROTECTED ACTION APPROVED/,
        'Should approve server phrase');

      // Test file phrase
      approvals.approvals.FILE01 = {
        server: 'credential-file-guard',
        tool: 'write_protected_file',
        phrase: 'APPROVE MCP',
        code: 'FILE01',
        status: 'pending',
        created_timestamp: now,
        expires_timestamp: now + 5 * 60 * 1000,
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const fileResult = await runHook('APPROVE MCP FILE01', tempDir.path);

      assert.strictEqual(fileResult.exitCode, 0);
      assert.match(fileResult.stderr, /PROTECTED ACTION APPROVED/,
        'Should approve file phrase');
    });

    it('should warn about unrecognized phrase when not in servers or files', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'server1': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD',
            tools: '*',
          },
        },
        files: {
          '.mcp.json': {
            protection: 'approval-only',
            phrase: 'APPROVE MCP',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('APPROVE UNKNOWN ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /Unrecognized phrase.*UNKNOWN/i,
        'Should warn about unrecognized phrase');
      assert.match(result.stderr, /Valid phrases/i,
        'Should list valid phrases');
    });

    it('should list both server and file phrases in valid phrases warning', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'supabase': {
            protection: 'credential-isolated',
            phrase: 'APPROVE DATABASE',
            tools: '*',
          },
        },
        files: {
          '.mcp.json': {
            protection: 'approval-only',
            phrase: 'APPROVE MCP',
          },
          '.claude/credential-provider.json': {
            protection: 'approval-only',
            phrase: 'APPROVE CREDENTIAL',
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('APPROVE UNKNOWN ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /APPROVE DATABASE/,
        'Should list server phrase');
      assert.match(result.stderr, /APPROVE MCP/,
        'Should list file phrase 1');
      assert.match(result.stderr, /APPROVE CREDENTIAL/,
        'Should list file phrase 2');
    });

    it('should handle config with empty files section', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'test-server': {
            protection: 'credential-isolated',
            phrase: 'APPROVE TEST',
            tools: '*',
          },
        },
        files: {}, // Empty files section
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const now = Date.now();
      const approvals = {
        approvals: {
          TEST01: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'TEST01',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST TEST01', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
        'Should still work with empty files section');
    });

    it('should handle config with missing files section (backward compatibility)', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Old config format without files section
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
          TEST01: {
            server: 'test-server',
            tool: 'test-tool',
            phrase: 'APPROVE TEST',
            code: 'TEST01',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE TEST TEST01', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
        'Should work without files section for backward compatibility');
    });

    it('should handle files section with phrase but no description', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      const approvalsPath = path.join(tempDir.path, '.claude', 'protected-action-approvals.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {},
        files: {
          'test.json': {
            protection: 'approval-only',
            phrase: 'APPROVE CONFIG',
            // No description field
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const now = Date.now();
      const approvals = {
        approvals: {
          CFG001: {
            server: 'credential-file-guard',
            tool: 'write_protected_file',
            phrase: 'APPROVE CONFIG',
            code: 'CFG001',
            status: 'pending',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      fs.writeFileSync(approvalsPath, JSON.stringify(approvals));

      const result = await runHook('APPROVE CONFIG CFG001', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /PROTECTED ACTION APPROVED/,
        'Should work with phrase but no description');
    });

    it('should ignore files without phrase property', async () => {
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');

      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'server1': {
            protection: 'credential-isolated',
            phrase: 'APPROVE PROD',
            tools: '*',
          },
        },
        files: {
          'file-with-phrase': {
            protection: 'approval-only',
            phrase: 'APPROVE FILE',
          },
          'file-without-phrase': {
            protection: 'approval-only',
            // No phrase property
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await runHook('APPROVE UNKNOWN ABC123', tempDir.path);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /APPROVE PROD/,
        'Should list server phrase');
      assert.match(result.stderr, /APPROVE FILE/,
        'Should list file phrase from file-with-phrase');
      // Should not crash or include undefined/null phrases
    });
  });
});
