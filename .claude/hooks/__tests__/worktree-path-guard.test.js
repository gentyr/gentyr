/**
 * Unit tests for worktree-path-guard.js (PreToolUse hook).
 *
 * Tests the guard that blocks Write/Edit operations targeting files outside
 * the worktree root when running in a worktree context.
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-path-guard.test.js
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

const HOOK_PATH = path.resolve(import.meta.dirname, '..', 'worktree-path-guard.js');

/** Temp dirs to clean up after each test */
const tmpDirs = [];

/**
 * Base directory for test fixtures.
 * Uses a subdirectory under the user's home dir (NOT os.tmpdir) because the hook
 * allows writes to /tmp/ and the OS tmpdir. Tests that verify deny behavior
 * need paths outside those allowed zones.
 */
const TEST_FIXTURE_BASE = path.join(os.homedir(), '.gentyr-test-fixtures');

/**
 * Create a temp dir simulating a worktree (.git is a file pointing to main repo).
 * The worktree dir is nested under the main repo path at .claude/worktrees/<name>/
 * to match real worktree layout.
 */
function createWorktreeDir(mainRepoPath) {
  const worktreeName = 'test-wt-' + Math.random().toString(36).slice(2, 8);
  const worktreesDir = path.join(mainRepoPath, '.claude', 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });
  const wtDir = path.join(worktreesDir, worktreeName);
  fs.mkdirSync(wtDir, { recursive: true });

  // .git file with gitdir reference
  fs.writeFileSync(
    path.join(wtDir, '.git'),
    `gitdir: ${mainRepoPath}/.git/worktrees/${worktreeName}\n`,
  );

  return wtDir;
}

/**
 * Create a temp dir simulating a main repo (.git is a directory).
 * Uses TEST_FIXTURE_BASE to avoid os.tmpdir() overlap.
 */
function createMainRepoDir() {
  fs.mkdirSync(TEST_FIXTURE_BASE, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(TEST_FIXTURE_BASE, 'main-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.git'));
  // Also create the worktrees dir under .git for gitdir references
  fs.mkdirSync(path.join(tmpDir, '.git', 'worktrees'), { recursive: true });
  return tmpDir;
}

/**
 * Create a temp dir with no git context.
 */
function createNonRepoDir() {
  fs.mkdirSync(TEST_FIXTURE_BASE, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(TEST_FIXTURE_BASE, 'nongit-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
  // Clean up fixture base if empty
  try { fs.rmdirSync(TEST_FIXTURE_BASE); } catch {}
});

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

describe('worktree-path-guard', () => {
  describe('non-worktree context (main repo)', () => {
    it('should allow Write to any path when not in a worktree', async () => {
      const mainRepo = createMainRepoDir();
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/some/other/path/file.js' }, cwd: mainRepo },
        { CLAUDE_PROJECT_DIR: mainRepo },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow Edit to any path when not in a worktree', async () => {
      const mainRepo = createMainRepoDir();
      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: '/some/other/path/file.js' }, cwd: mainRepo },
        { CLAUDE_PROJECT_DIR: mainRepo },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('non-file tools', () => {
    it('should allow Bash tool without checking paths', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow Read tool without checking paths', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Read', tool_input: { file_path: `${mainRepo}/some/file.js` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('worktree context — inside worktree paths', () => {
    it('should allow Write to files inside the worktree', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${wt}/src/index.js` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow Edit to files inside the worktree', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: `${wt}/package.json` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('worktree context — outside worktree paths', () => {
    it('should DENY Write to main repo path when in worktree', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${mainRepo}/src/index.js` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
      assert.ok(result.parsed?.permissionDecisionReason.includes('outside worktree'));
    });

    it('should DENY Edit to main repo path when in worktree', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: `${mainRepo}/package.json` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
    });

    it('should suggest the correct worktree path in deny message', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const targetPath = `${mainRepo}/src/components/App.tsx`;
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: targetPath }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
      // Should suggest the equivalent worktree path
      const expectedSuggestion = `${wt}/src/components/App.tsx`;
      assert.ok(result.parsed?.permissionDecisionReason.includes(expectedSuggestion),
        `Deny reason should suggest worktree path: ${expectedSuggestion}`);
    });

    it('should DENY Write to arbitrary paths outside worktree', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/usr/local/etc/config.txt' }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.permissionDecision, 'deny');
    });
  });

  describe('allowed exceptions', () => {
    it('should allow Write to /tmp/ paths', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/test-output.json' }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow Write to OS tmpdir paths', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const tmpFile = path.join(os.tmpdir(), 'test-file-' + Date.now() + '.txt');
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: tmpFile }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow Write to ~/.claude/ paths (user config)', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const home = process.env.HOME || '/Users/test';
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${home}/.claude/memory/notes.md` }, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });
  });

  describe('edge cases', () => {
    it('should allow when no file_path provided', async () => {
      const mainRepo = createMainRepoDir();
      const wt = createWorktreeDir(mainRepo);
      const result = await runHook(
        { tool_name: 'Write', tool_input: {}, cwd: wt },
        { CLAUDE_PROJECT_DIR: wt },
      );
      assert.equal(result.parsed?.allow, true);
    });

    it('should allow when no .git exists (not a repo)', async () => {
      const dir = createNonRepoDir();
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/some/path.js' }, cwd: dir },
        { CLAUDE_PROJECT_DIR: dir },
      );
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
