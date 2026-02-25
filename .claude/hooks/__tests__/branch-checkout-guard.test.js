/**
 * Unit tests for branch-checkout-guard.js (PreToolUse hook) and
 * git-wrappers/git (POSIX shell wrapper).
 *
 * Tests both layers of the branch checkout guard:
 * - Layer 1: git wrapper script (shell-level, spawned via execFileSync)
 * - Layer 2: PreToolUse hook (JSON stdin/stdout protocol)
 *
 * Run with: node --test .claude/hooks/__tests__/branch-checkout-guard.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory simulating a main working tree (.git directory).
 */
function createMainTree(prefix = 'branch-guard-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.git'));
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
 * Create a temporary directory simulating a worktree (.git is a file).
 */
function createWorktreeDir(prefix = 'branch-guard-wt-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/wt\n');
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
 * Create a temporary directory with no git context.
 */
function createNonRepo(prefix = 'branch-guard-nongit') {
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
 * Execute the PreToolUse hook by spawning a subprocess and sending JSON on stdin.
 * Returns { exitCode, stdout, stderr }.
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const hookPath = path.join(__dirname, '..', 'branch-checkout-guard.js');

    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (opts.env) {
      spawnOpts.env = { ...process.env, ...opts.env };
    }

    const child = spawn('node', [hookPath], spawnOpts);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

/**
 * Parse JSON output from hook, returning the parsed object.
 */
function parseOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Run the git wrapper script with the given arguments.
 * Returns { exitCode, stdout, stderr }.
 */
function runWrapper(args, opts = {}) {
  const wrapperPath = path.join(__dirname, '..', 'git-wrappers', 'git');
  try {
    const stdout = execFileSync(wrapperPath, args, {
      cwd: opts.cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

// ============================================================================
// Layer 2: PreToolUse Hook Tests
// ============================================================================

describe('branch-checkout-guard.js (PreToolUse hook)', () => {
  let mainTree;
  let worktree;
  let nonRepo;

  beforeEach(() => {
    mainTree = createMainTree();
    worktree = createWorktreeDir();
    nonRepo = createNonRepo();
  });

  afterEach(() => {
    mainTree.cleanup();
    worktree.cleanup();
    nonRepo.cleanup();
  });

  describe('blocks checkout/switch in main tree', () => {
    it('blocks git checkout -b feature/foo', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout -b feature/foo' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('BLOCKED'));
    });

    it('blocks git switch -c feature/bar', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git switch -c feature/bar' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git checkout existing-branch', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout preview' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git checkout -B feature/force-create', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout -B feature/force-create' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks checkout in piped commands', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello && git checkout -b feature/sneaky' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks /usr/bin/git checkout', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '/usr/bin/git checkout -b feature/direct' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });
  });

  describe('allows safe operations in main tree', () => {
    it('allows git checkout main (recovery)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout main' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
      assert.strictEqual(output.permissionDecision, undefined);
    });

    it('allows git checkout -- file.txt (file restore)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout -- src/index.js' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows non-checkout git commands', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git log, diff, add, commit', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add . && git commit -m "test"' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git push', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git push -u origin HEAD' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows everything in worktree', () => {
    it('allows git checkout -b in worktree', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout -b feature/anything' },
      }, { env: { CLAUDE_PROJECT_DIR: worktree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git switch in worktree', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git switch preview' },
      }, { env: { CLAUDE_PROJECT_DIR: worktree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows everything in non-repo', () => {
    it('allows git checkout in non-repo directory', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git checkout -b test' },
      }, { env: { CLAUDE_PROJECT_DIR: nonRepo.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('non-Bash tools pass through', () => {
    it('allows Read tool calls', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/some/path' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('invalid input handling', () => {
    it('allows on invalid JSON', async () => {
      const hookPath = path.join(__dirname, '..', 'branch-checkout-guard.js');
      const result = await new Promise((resolve) => {
        const child = spawn('node', [hookPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_PROJECT_DIR: mainTree.path },
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (exitCode) => resolve({ exitCode, stdout }));
        child.stdin.write('not json');
        child.stdin.end();
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows on empty command', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });
});

// ============================================================================
// Layer 1: Git Wrapper Script Tests
// ============================================================================

describe('git-wrappers/git (shell wrapper)', () => {
  let mainTree;
  let worktree;
  let nonRepo;

  beforeEach(() => {
    mainTree = createMainTree();
    worktree = createWorktreeDir();
    nonRepo = createNonRepo();
  });

  afterEach(() => {
    mainTree.cleanup();
    worktree.cleanup();
    nonRepo.cleanup();
  });

  describe('blocks checkout in main tree', () => {
    it('blocks git checkout -b feature/foo with exit 128', () => {
      const result = runWrapper(['checkout', '-b', 'feature/foo'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git switch -c feature/bar', () => {
      const result = runWrapper(['switch', '-c', 'feature/bar'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git checkout preview', () => {
      const result = runWrapper(['checkout', 'preview'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git checkout -B force-create', () => {
      const result = runWrapper(['checkout', '-B', 'force-create'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });
  });

  describe('allows safe operations in main tree', () => {
    // Note: real git may return 128 for its own errors (not a real repo).
    // We verify the wrapper didn't block by checking stderr for "BLOCKED".
    it('allows git checkout main', () => {
      const result = runWrapper(['checkout', 'main'], { cwd: mainTree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });

    it('allows git checkout -- file.txt (file restore)', () => {
      const result = runWrapper(['checkout', '--', 'file.txt'], { cwd: mainTree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });

    it('allows git status (non-checkout command)', () => {
      const result = runWrapper(['status'], { cwd: mainTree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });

    it('allows git log', () => {
      const result = runWrapper(['log', '--oneline', '-5'], { cwd: mainTree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });
  });

  describe('allows everything in worktree', () => {
    it('allows git checkout -b in worktree', () => {
      const result = runWrapper(['checkout', '-b', 'feature/anything'], { cwd: worktree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });

    it('allows git switch -c in worktree', () => {
      const result = runWrapper(['switch', '-c', 'feature/thing'], { cwd: worktree.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });
  });

  describe('allows everything in non-repo', () => {
    it('allows git checkout in non-repo', () => {
      const result = runWrapper(['checkout', '-b', 'test'], { cwd: nonRepo.path });
      assert.ok(!result.stderr.includes('BLOCKED'), 'should not contain BLOCKED message');
    });
  });

  describe('combined flag forms', () => {
    it('blocks -bfeature/combined form', () => {
      const result = runWrapper(['checkout', '-bfeature/combined'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
    });

    it('blocks switch --create new-branch', () => {
      const result = runWrapper(['switch', '--create', 'new-branch'], { cwd: mainTree.path });
      assert.strictEqual(result.exitCode, 128);
    });
  });
});
