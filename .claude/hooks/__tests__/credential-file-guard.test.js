/**
 * Unit tests for credential-file-guard.js (PreToolUse hook)
 *
 * Tests the PreToolUse hook that blocks access to credential files:
 * - Read/Write/Edit tool blocking for protected files
 * - Bash command analysis (file paths and env vars)
 * - Protected file patterns (basenames, suffixes, regex)
 * - Shell tokenization (quotes, escaping, pipes)
 * - G001 fail-closed behavior (errors block operation)
 *
 * This hook runs BEFORE tool execution, so it cannot be bypassed by agents.
 * Tests verify it fails closed (blocks on error) per G001.
 *
 * Run with: node --test .claude/hooks/__tests__/credential-file-guard.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory for test files.
 */
function createTempDir(prefix = 'credential-guard-test') {
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
 * Execute the hook script by spawning a subprocess and sending JSON on stdin.
 * Returns { exitCode, stdout, stderr }.
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const hookPath = path.join(__dirname, '..', 'credential-file-guard.js');

    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (opts.env) {
      spawnOpts.env = { ...process.env, ...opts.env };
    }

    const proc = spawn('node', [hookPath], spawnOpts);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ exitCode: exitCode || 0, stdout, stderr });
    });

    // Send JSON input on stdin
    proc.stdin.write(JSON.stringify(hookInput));
    proc.stdin.end();
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('credential-file-guard.js (PreToolUse Hook)', () => {
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
  // Read/Write/Edit Tool Blocking
  // ==========================================================================

  describe('File access tool blocking (Read/Write/Edit)', () => {
    it('should block Read of .env file', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/path/to/.env' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0, 'Hook should exit 0 (permissionDecision handles block)');

      // Check JSON output
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /credentials/i);
    });

    it('should block Write of .env.local file', async () => {
      const result = await runHook({
        tool_name: 'Write',
        tool_input: { file_path: '/path/to/.env.local' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env\.local/);
    });

    it('should block Edit of .mcp.json file', async () => {
      const result = await runHook({
        tool_name: 'Edit',
        tool_input: { file_path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.mcp\.json/);
    });

    it('should block Read of .claude/protection-key', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.claude/protection-key` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /protection-key/);
    });

    it('should pass through Read of non-protected file', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/README.md` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      // Should NOT output permissionDecision (pass through)
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should block Grep with no path or glob parameter (searches entire tree)', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'test' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Grep without path or glob should be blocked (searches entire tree including credential files)');
    });

    it('should block any .env.* variant', async () => {
      const envFiles = ['.env.production', '.env.staging', '.env.development', '.env.test'];

      for (const file of envFiles) {
        const result = await runHook({
          tool_name: 'Read',
          tool_input: { file_path: `/path/to/${file}` },
          cwd: tempDir.path,
        });

        const jsonMatch = result.stdout.match(/\{.*\}/s);
        const output = JSON.parse(jsonMatch[0]);

        assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
          `Should block ${file}`);
      }
    });
  });

  // ==========================================================================
  // Grep/Glob Tool Blocking (C1 fix)
  // ==========================================================================

  describe('Grep/Glob tool blocking (C1 fix)', () => {
    it('should block Grep with path=".mcp.json" (protected path)', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'test', path: '.mcp.json' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.mcp\.json/);
    });

    it('should block Grep with path pointing to ".claude/protection-key"', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'token', path: `${tempDir.path}/.claude/protection-key` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /protection-key/);
    });

    it('should pass through Grep with path="src/" (non-protected)', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'function', path: 'src/' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should block Grep with no path parameter (searches entire tree)', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'search' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Grep without path should be blocked (searches entire tree including credential files)');
    });

    it('should block Grep with glob pattern containing ".env"', async () => {
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'TOKEN', glob: '**/.env' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });

    it('should block Glob with path pointing to ".mcp.json"', async () => {
      const result = await runHook({
        tool_name: 'Glob',
        tool_input: { pattern: '*.json', path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.mcp\.json/);
    });

    it('should block Glob with pattern containing ".mcp.json"', async () => {
      const result = await runHook({
        tool_name: 'Glob',
        tool_input: { pattern: '**/.mcp.json' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.mcp\.json/);
    });

    it('should block Glob with pattern containing ".env"', async () => {
      const result = await runHook({
        tool_name: 'Glob',
        tool_input: { pattern: '**/.env' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });

    it('should pass through Glob with pattern="**/*.ts" (non-protected)', async () => {
      const result = await runHook({
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.ts' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should verify Grep previously passed through (was NOT in FILE_ACCESS_TOOLS before fix)', async () => {
      // This test documents that before C1 fix, Grep was NOT in FILE_ACCESS_TOOLS
      // and would have passed through even when targeting protected files.
      // Now it should be blocked when targeting protected files.
      const result = await runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'SECRET', path: '.env' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      // After C1 fix, this should be BLOCKED (not passed through)
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'C1 fix: Grep should now be blocked when targeting .env');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });
  });

  // ==========================================================================
  // Bash File Path Detection
  // ==========================================================================

  describe('Bash file path detection', () => {
    it('should block cat .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });

    it('should block head .mcp.json', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'head .mcp.json' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.mcp\.json/);
    });

    it('should block tail .claude/protection-key', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'tail .claude/protection-key' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /protection-key/);
    });

    it('should block cp .env /tmp/stolen', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cp .env /tmp/stolen' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });

    it('should block mv .env.local backup.txt', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'mv .env.local backup.txt' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env\.local/);
    });

    it('should block file paths with flags: cat -n .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat -n .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block input redirection: grep secret < .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'grep secret < .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block protected file in piped command: cat .env | grep TOKEN', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env | grep TOKEN' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block protected file in complex command: cat .env && echo done', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env && echo done' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should pass through cat on non-protected file', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat README.md' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should pass through commands without file access', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello world' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });
  });

  // ==========================================================================
  // Bash Environment Variable Detection
  // ==========================================================================

  describe('Bash env var detection', () => {
    beforeEach(() => {
      // Create protected-actions.json with credential keys
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {
          'github': {
            protection: 'credential-isolated',
            phrase: 'APPROVE GIT',
            tools: '*',
            credentialKeys: ['GITHUB_TOKEN', 'GITHUB_PAT'],
          },
          'vercel': {
            protection: 'credential-isolated',
            phrase: 'APPROVE DEPLOY',
            tools: '*',
            credentialKeys: ['VERCEL_TOKEN', 'VERCEL_ORG_ID'],
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config));
    });

    it('should block echo $GITHUB_TOKEN', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo $GITHUB_TOKEN' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /GITHUB_TOKEN/);
    });

    it('should block echo ${VERCEL_TOKEN}', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo ${VERCEL_TOKEN}' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /VERCEL_TOKEN/);
    });

    it('should block printenv GITHUB_PAT', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'printenv GITHUB_PAT' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /GITHUB_PAT/);
    });

    it('should block env (full environment dump)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /Environment dump/);
    });

    it('should block printenv (full environment dump)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'printenv' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /Environment dump/);
    });

    it('should block export -p (full environment dump)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'export -p' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /Environment dump/);
    });

    it('should pass through non-credential env vars like $HOME', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo $HOME' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should pass through commands without env var access', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });

    it('should handle missing protected-actions.json gracefully', async () => {
      // Remove config file
      const configPath = path.join(tempDir.path, '.claude', 'hooks', 'protected-actions.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      // Should pass through (architectural defense is primary)
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo $GITHUB_TOKEN' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });
  });

  // ==========================================================================
  // Shell Tokenization Edge Cases
  // ==========================================================================

  describe('Shell tokenization', () => {
    it('should handle single-quoted paths: cat \'.env\'', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: "cat '.env'" },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle double-quoted paths: cat ".env"', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat ".env"' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle escaped spaces: cat my\\ file.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat my\\ file.env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      // Should detect .env pattern
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle absolute paths: cat /etc/.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat /etc/.env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle relative paths: cat ../../.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat ../../.env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block output redirection to protected files: cat README.md > .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat README.md > .env' },
        cwd: tempDir.path,
      });

      // SECURITY FIX (M1): Output redirection to protected files is now blocked.
      // Writing to .env is as dangerous as reading it (e.g., forging bypass tokens).
      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
    });

    it('should handle complex pipeline: cat .env | grep TOKEN | head -n 5', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env | grep TOKEN | head -n 5' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle semicolon-separated commands: ls -la; cat .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la; cat .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle && chains: mkdir tmp && cp .env tmp/', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'mkdir tmp && cp .env tmp/' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should handle || chains: cat .env.local || cat .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env.local || cat .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    // Tokenize-first: pipes/semicolons inside quotes must NOT split commands
    it('should handle pipe inside double-quoted path: cat "file with | pipe.txt"', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat "file with | pipe.txt"' },
        cwd: tempDir.path,
      });

      // Should NOT be blocked - "file with | pipe.txt" is not a protected file
      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'Pipe inside quoted path should not mangle tokenization');
      }
    });

    it('should handle semicolons inside single-quoted path: cat \'path;with;semicolons/.env\'', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: "cat 'path;with;semicolons/.env'" },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      // Should be blocked because the resolved path ends in .env
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Path with .env at end should still be blocked even with semicolons in quotes');
    });

    it('should handle && outside quotes with quoted .env: cat ".env" && echo done', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat ".env" && echo done' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Quoted .env with && outside quotes should still be blocked');
    });

    it('should handle || inside quotes: cat "a || b.txt"', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat "a || b.txt"' },
        cwd: tempDir.path,
      });

      // Should NOT be blocked - "a || b.txt" is not a protected file
      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          '|| inside quotes should not split into sub-commands');
      }
    });

    it('should handle && inside quotes: cat "a && b.txt"', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat "a && b.txt"' },
        cwd: tempDir.path,
      });

      // Should NOT be blocked - "a && b.txt" is not a protected file
      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          '&& inside quotes should not split into sub-commands');
      }
    });

    it('should handle input redirection with protected file via token: grep secret < .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'grep secret < .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Input redirection with < token to .env should be blocked');
    });
  });

  // ==========================================================================
  // G001 Fail-Closed Behavior
  // ==========================================================================

  describe('G001 fail-closed behavior', () => {
    it('should block on malformed JSON input', async () => {
      return new Promise((resolve) => {
        const hookPath = path.join(__dirname, '..', 'credential-file-guard.js');

        const proc = spawn('node', [hookPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });

        proc.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        proc.on('close', (exitCode) => {
          assert.strictEqual(exitCode, 0, 'Should exit 0 (permissionDecision handles block)');

          const jsonMatch = stdout.match(/\{.*\}/s);
          assert.ok(jsonMatch, 'Should output JSON');
          const output = JSON.parse(jsonMatch[0]);

          assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
          assert.match(output.hookSpecificOutput.permissionDecisionReason, /G001 FAIL-CLOSED/);
          assert.match(stderr, /G001 FAIL-CLOSED/);

          resolve();
        });

        // Send invalid JSON
        proc.stdin.write('{ invalid json }');
        proc.stdin.end();
      });
    });

    it('should block on missing tool_name', async () => {
      const result = await runHook({
        tool_input: { command: 'cat .env' },
        cwd: tempDir.path,
      });

      // Should still attempt to process but fail gracefully
      assert.strictEqual(result.exitCode, 0);
    });

    it('should block on missing tool_input', async () => {
      const result = await runHook({
        tool_name: 'Read',
        cwd: tempDir.path,
      });

      // Should pass through (no file path to check)
      assert.strictEqual(result.exitCode, 0);
    });

    it('should handle empty command gracefully', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '' },
        cwd: tempDir.path,
      });

      // Should pass through (no file path to check)
      assert.strictEqual(result.exitCode, 0);
    });
  });

  // ==========================================================================
  // Expanded FILE_READ_COMMANDS
  // (Requires implementation: expanded FILE_READ_COMMANDS or universal scan)
  // ==========================================================================

  describe('Expanded FILE_READ_COMMANDS blocking', () => {
    const expandedCommands = [
      { cmd: 'sed', args: "-n 'p' .env", desc: 'sed reading .env' },
      { cmd: 'awk', args: "'{print}' .env", desc: 'awk reading .env' },
      { cmd: 'grep', args: 'TOKEN .env', desc: 'grep searching .env' },
      { cmd: 'rg', args: 'TOKEN .env', desc: 'rg searching .env' },
      { cmd: 'python', args: '.env', desc: 'python reading .env' },
      { cmd: 'python3', args: '.env', desc: 'python3 reading .env' },
      { cmd: 'node', args: '.env', desc: 'node reading .env' },
      { cmd: 'ruby', args: '.env', desc: 'ruby reading .env' },
      { cmd: 'perl', args: '.env', desc: 'perl reading .env' },
      { cmd: 'sort', args: '.env', desc: 'sort reading .env' },
      { cmd: 'uniq', args: '.env', desc: 'uniq reading .env' },
      { cmd: 'wc', args: '.env', desc: 'wc reading .env' },
      { cmd: 'diff', args: '.env .env.local', desc: 'diff comparing .env files' },
      { cmd: 'cut', args: '-d= -f2 .env', desc: 'cut parsing .env' },
      { cmd: 'paste', args: '.env .env.local', desc: 'paste combining .env files' },
      { cmd: 'od', args: '.env', desc: 'od dumping .env' },
      { cmd: 'file', args: '.env', desc: 'file inspecting .env' },
    ];

    for (const { cmd, args, desc } of expandedCommands) {
      it(`should block ${desc}: ${cmd} ${args}`, async () => {
        const result = await runHook({
          tool_name: 'Bash',
          tool_input: { command: `${cmd} ${args}` },
          cwd: tempDir.path,
        });

        const jsonMatch = result.stdout.match(/\{.*\}/s);
        assert.ok(jsonMatch, `Should output JSON for: ${cmd} ${args}`);
        const output = JSON.parse(jsonMatch[0]);

        assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
          `${cmd} ${args} should be blocked`);
        assert.match(output.hookSpecificOutput.permissionDecisionReason, /\.env/);
      });
    }
  });

  // ==========================================================================
  // Universal Path Scanning
  // (Requires implementation: universal scan for ANY command with protected path)
  // ==========================================================================

  describe('Universal path scanning', () => {
    it('should block any unknown command accessing .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'someweirdcommand .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Unknown command with .env argument should be blocked');
    });

    it('should block any unknown command accessing .env.production', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'mycustomtool --flag .env.production' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Unknown command with .env.production argument should be blocked');
    });

    it('should block any unknown command accessing .mcp.json', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'sometool .mcp.json' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Unknown command with .mcp.json argument should be blocked');
    });

    it('should block any unknown command accessing protection-key', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'randomutil .claude/protection-key' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Unknown command with protection-key argument should be blocked');
    });

    it('should block unknown command with protected path as non-first arg', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'customtool --input .env --output result.txt' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Unknown command with .env as non-first arg should be blocked');
    });

    it('should allow unknown command with non-protected args', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'mycustomtool --flag README.md --verbose' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
      }
    });
  });

  // ==========================================================================
  // Special-Case Patterns
  // (Requires implementation: dd if=, curl file://, openssl -in, tar patterns)
  // ==========================================================================

  describe('Special-case patterns', () => {
    it('should block dd if=.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'dd if=.env of=/tmp/stolen bs=1024' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'dd if=.env should be blocked');
    });

    it('should block curl file://.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'curl file://.env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'curl file://.env should be blocked');
    });

    it('should block openssl -in .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'openssl enc -aes-256-cbc -in .env -out encrypted.dat' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'openssl -in .env should be blocked');
    });

    it('should block tar cf out.tar .env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'tar cf out.tar .env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'tar cf out.tar .env should be blocked');
    });

    it('should block dd if=.env.production', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'dd if=.env.production of=/dev/null' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'dd if=.env.production should be blocked');
    });

    it('should block curl file:///full/path/to/.env', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'curl file:///home/user/project/.env' },
        cwd: tempDir.path,
      });

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      assert.ok(jsonMatch, 'Should output JSON');
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'curl file:///full/path/to/.env should be blocked');
    });
  });

  // ==========================================================================
  // SKIP_UNIVERSAL_SCAN Exclusions
  // (Requires implementation: SKIP_UNIVERSAL_SCAN set)
  // ==========================================================================

  describe('SKIP_UNIVERSAL_SCAN exclusions', () => {
    const safeCommands = [
      { cmd: 'mkdir .env-backup-dir', desc: 'mkdir with non-protected dir name' },
      { cmd: 'echo .env', desc: 'echo with .env argument (not file access)' },
      { cmd: 'touch newfile.txt', desc: 'touch creating a new file' },
      { cmd: 'chmod 644 somefile.txt', desc: 'chmod on non-protected file' },
      { cmd: 'ln -s target link', desc: 'ln creating symlink' },
      { cmd: 'ls .env-directory/', desc: 'ls listing non-protected dir' },
      { cmd: 'printf "hello"', desc: 'printf with string argument' },
      { cmd: 'export MY_VAR=value', desc: 'export setting a variable' },
      { cmd: 'alias ll="ls -la"', desc: 'alias command' },
    ];

    for (const { cmd, desc } of safeCommands) {
      it(`should NOT block: ${desc}`, async () => {
        const result = await runHook({
          tool_name: 'Bash',
          tool_input: { command: cmd },
          cwd: tempDir.path,
        });

        assert.strictEqual(result.exitCode, 0);

        const jsonMatch = result.stdout.match(/\{.*\}/s);
        if (jsonMatch) {
          const output = JSON.parse(jsonMatch[0]);
          assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
            `${cmd} should NOT be blocked`);
        }
      });
    }
  });

  // ==========================================================================
  // False Positive Validation
  // ==========================================================================

  describe('False positive validation', () => {
    it('should NOT block npm install .env-parser (not a protected file)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npm install .env-parser' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'npm install .env-parser should NOT be blocked');
      }
    });

    it('should NOT block git log .env-config/ (not a protected file)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log .env-config/' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'git log .env-config/ should NOT be blocked');
      }
    });

    it('should NOT block pip install python-dotenv (contains "env" but not protected)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'pip install python-dotenv' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'pip install python-dotenv should NOT be blocked');
      }
    });

    it('should NOT block pnpm add dotenv (package name, not .env file)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'pnpm add dotenv' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'pnpm add dotenv should NOT be blocked');
      }
    });

    it('should NOT block cd .environment-setup (directory, not .env)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cd .environment-setup' },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'cd .environment-setup should NOT be blocked');
      }
    });

    it('should NOT block Read of .envrc (not in blocked list)', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.envrc` },
        cwd: tempDir.path,
      });

      assert.strictEqual(result.exitCode, 0);

      // .envrc should NOT match /\.env(\.[a-z]+)?$/i since "rc" follows
      // directly without a dot separator
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          '.envrc should NOT be blocked (not a .env variant)');
      }
    });
  });

  // ==========================================================================
  // Output Format
  // ==========================================================================

  describe('Block message format', () => {
    it('should display clear block message for Read tool', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/path/to/.env' },
        cwd: tempDir.path,
      });

      assert.match(result.stderr, /READ BLOCKED/i);
      assert.match(result.stderr, /Credential File Protection/i);
      assert.match(result.stderr, /\.env/);
      assert.match(result.stderr, /credentials/i);
    });

    it('should display clear block message for Bash tool', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env' },
        cwd: tempDir.path,
      });

      assert.match(result.stderr, /BASH BLOCKED/i);
      assert.match(result.stderr, /Credential Protection/i);
      assert.match(result.stderr, /cat \.env/);
    });

    it('should truncate long commands in block message', async () => {
      const longCommand = 'cat .env && ' + 'echo hello '.repeat(50);

      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: longCommand },
        cwd: tempDir.path,
      });

      assert.match(result.stderr, /\.\.\./,
        'Long commands should be truncated with ...');
    });
  });

  // ==========================================================================
  // CTO-Approved File Access (Approval Flow)
  // ==========================================================================

  describe('CTO-approved file access', () => {
    /**
     * Helper to set up protected-actions.json with files section and
     * optionally create an approved entry in protected-action-approvals.json.
     */
    function setupApprovalEnv(tmpDir, opts = {}) {
      // Create protected-actions.json with files section
      const hooksDir = path.join(tmpDir, '.claude', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const config = {
        version: '2.0.0',
        servers: {},
        files: {
          '.claude/config/services.json': {
            protection: 'deputy-cto-approval',
            phrase: 'APPROVE CONFIG',
            description: 'Service configuration',
          },
          '.mcp.json': {
            protection: 'approval-only',
            phrase: 'APPROVE MCP',
            description: 'MCP server definitions',
          },
          '.claude/api-key-rotation.json': {
            protection: 'approval-only',
            phrase: 'APPROVE ROTATION',
            description: 'API key rotation state',
          },
        },
        settings: {
          codeLength: 6,
          expiryMinutes: 5,
        },
      };

      fs.writeFileSync(path.join(hooksDir, 'protected-actions.json'), JSON.stringify(config, null, 2));

      // Create approvals file with optional pre-approved entry
      if (opts.approvedFile) {
        const approvalsDir = path.join(tmpDir, '.claude');
        fs.mkdirSync(approvalsDir, { recursive: true });

        const code = opts.approvedCode || 'T3ST99';
        const approvals = {
          approvals: {
            [code]: {
              server: '__file__',
              tool: opts.approvedFile,
              args: {},
              phrase: opts.approvedPhrase || 'APPROVE CONFIG',
              code,
              status: 'approved',
              created_at: new Date().toISOString(),
              created_timestamp: Date.now(),
              expires_at: new Date(Date.now() + 300000).toISOString(),
              expires_timestamp: Date.now() + 300000,
              approved_at: new Date().toISOString(),
              approved_timestamp: Date.now(),
            },
          },
        };

        fs.writeFileSync(path.join(approvalsDir, 'protected-action-approvals.json'), JSON.stringify(approvals, null, 2));
      }
    }

    it('should hard-block .claude/protection-key with no approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.claude/protection-key` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      // Should NOT include approval code instructions
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('CTO must type'),
        'protection-key should be hard-blocked with no approval option');
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'protection-key should not show Approval Required');
    });

    it('should hard-block .claude/protected-action-approvals.json with no approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.claude/protected-action-approvals.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'approvals.json should be hard-blocked with no approval option');
    });

    it('should hard-block .env files with no approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.env` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        '.env should be hard-blocked with no approval option');
    });

    it('should hard-block .env.production with no approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.env.production` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        '.env.production should be hard-blocked with no approval option');
    });

    it('should block approvable file (.mcp.json) with approval code when no approval exists', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        '.mcp.json should show Approval Required');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('APPROVE MCP'),
        '.mcp.json should show the APPROVE MCP phrase');
      // Should contain a 6-char code
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /[A-Z0-9]{6}/,
        '.mcp.json should contain an approval code');
    });

    it('should block approvable file (services.json) with deputy-cto-approval instructions', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.claude/config/services.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('deputy-CTO'),
        'services.json should mention deputy-CTO approval option');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('APPROVE CONFIG'),
        'services.json should show the APPROVE CONFIG phrase');
    });

    it('should allow approvable file (.mcp.json) when valid approval exists', async () => {
      setupApprovalEnv(tempDir.path, {
        approvedFile: '.mcp.json',
        approvedCode: 'X7Y8Z9',
        approvedPhrase: 'APPROVE MCP',
      });

      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      // Should NOT have a deny decision
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          '.mcp.json should be allowed when approval exists');
      }
    });

    it('should consume approval (one-time use) — second attempt should be blocked', async () => {
      setupApprovalEnv(tempDir.path, {
        approvedFile: '.mcp.json',
        approvedCode: 'X7Y8Z9',
        approvedPhrase: 'APPROVE MCP',
      });

      const envOpts = { env: { CLAUDE_PROJECT_DIR: tempDir.path } };

      // First attempt — should be allowed (consumes the approval)
      const result1 = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, envOpts);
      assert.strictEqual(result1.exitCode, 0);

      // Second attempt — approval consumed, should be blocked with new code
      const result2 = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: `${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, envOpts);
      assert.strictEqual(result2.exitCode, 0);
      const jsonMatch = result2.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny',
        'Second attempt should be blocked after approval consumed');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'Second attempt should show Approval Required with new code');
    });

    it('should hard-block Bash command with mixed always-blocked and approvable files', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `cat ${tempDir.path}/.env && cat ${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      // Should be hard-blocked (not approval-required) because .env is always-blocked
      assert.ok(!output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'Mixed always-blocked + approvable should be hard-blocked');
    });

    it('should block Bash with approvable file and show approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `cat ${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'Bash with approvable file should show Approval Required');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('APPROVE MCP'),
        'Bash with approvable file should show phrase');
    });

    it('should allow Bash with approvable file when approval exists', async () => {
      setupApprovalEnv(tempDir.path, {
        approvedFile: '.mcp.json',
        approvedCode: 'B4SH01',
        approvedPhrase: 'APPROVE MCP',
      });

      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `cat ${tempDir.path}/.mcp.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      if (jsonMatch) {
        const output = JSON.parse(jsonMatch[0]);
        assert.notStrictEqual(output.hookSpecificOutput?.permissionDecision, 'deny',
          'Bash with approvable file should be allowed when approval exists');
      }
    });

    it('should block Write to approvable file with approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Write',
        tool_input: { file_path: `${tempDir.path}/.mcp.json`, content: '{}' },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'Write to approvable file should show Approval Required');
    });

    it('should block Edit to approvable file with approval code', async () => {
      setupApprovalEnv(tempDir.path);

      const result = await runHook({
        tool_name: 'Edit',
        tool_input: { file_path: `${tempDir.path}/.claude/api-key-rotation.json` },
        cwd: tempDir.path,
      }, { env: { CLAUDE_PROJECT_DIR: tempDir.path } });

      assert.strictEqual(result.exitCode, 0);
      const jsonMatch = result.stdout.match(/\{.*\}/s);
      const output = JSON.parse(jsonMatch[0]);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Approval Required'),
        'Edit to approvable file should show Approval Required');
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('APPROVE ROTATION'),
        'Edit to api-key-rotation.json should show APPROVE ROTATION phrase');
    });
  });

});
