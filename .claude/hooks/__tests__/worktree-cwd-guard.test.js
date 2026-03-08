/**
 * Unit tests for worktree-cwd-guard.js (PreToolUse hook).
 *
 * Tests the guard that detects stale CWD from deleted worktrees and
 * provides recovery guidance to agents.
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-cwd-guard.test.js
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ============================================================================
// Test Utilities
// ============================================================================

const HOOK_PATH = path.resolve(import.meta.dirname, '..', 'worktree-cwd-guard.js');

/** Temp dirs to clean up after each test */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

/**
 * Create a temp dir that exists.
 */
function createTempDir(prefix = 'cwd-guard-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

/**
 * Execute the hook by spawning a subprocess and sending JSON on stdin.
 */
async function runHook(hookInput, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ exitCode, stdout, stderr, parsed });
    });

    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('worktree-cwd-guard', () => {
  describe('valid CWD', () => {
    it('should allow Bash when CWD exists', async () => {
      const dir = createTempDir();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir },
        { CLAUDE_PROJECT_DIR: dir },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('non-Bash tools', () => {
    it('should allow Write tool even with stale CWD', async () => {
      const stalePath = '/tmp/nonexistent-worktree-' + Date.now();
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/test.txt' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('stale CWD (deleted worktree)', () => {
    it('should DENY Bash when CWD does not exist', async () => {
      const stalePath = '/tmp/nonexistent-worktree-' + Date.now();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
      assert.ok(result.parsed?.permissionDecisionReason.includes('no longer exists'));
    });

    it('should extract main project dir from worktree path pattern', async () => {
      const mainProject = '/Users/test/git/myproject';
      const stalePath = `${mainProject}/.claude/worktrees/feature-xyz`;
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
      assert.ok(result.parsed?.permissionDecisionReason.includes(mainProject),
        `Should suggest main project dir: ${mainProject}`);
    });

    it('should provide generic recovery when path is not a worktree pattern', async () => {
      const stalePath = '/tmp/some-deleted-dir-' + Date.now();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
      assert.ok(result.parsed?.permissionDecisionReason.includes('cd /path/to/your/project'),
        'Should provide generic recovery instruction');
    });
  });

  describe('cd recovery', () => {
    it('should ALLOW cd commands for CWD recovery', async () => {
      const stalePath = '/tmp/nonexistent-worktree-' + Date.now();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'cd /Users/test/git/myproject' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should ALLOW compound commands starting with cd', async () => {
      const stalePath = '/tmp/nonexistent-worktree-' + Date.now();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'cd /Users/test/git/myproject && git status' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should DENY non-cd commands when CWD is stale', async () => {
      const stalePath = '/tmp/nonexistent-worktree-' + Date.now();
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: stalePath },
        { CLAUDE_PROJECT_DIR: stalePath },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
    });
  });

  describe('edge cases', () => {
    it('should allow when no CLAUDE_PROJECT_DIR and no cwd', async () => {
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        { CLAUDE_PROJECT_DIR: '' },
      );
      // With no CWD info, fail-open (allow)
      assert.equal(result.parsed?.allow, true);
    });

    it('should fail-open on invalid JSON input', async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (exitCode) => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch {}
          resolve({ exitCode, parsed });
        });
        child.stdin.write('not valid json');
        child.stdin.end();
      });
      assert.equal(result.parsed?.allow, true);
    });
  });
});
