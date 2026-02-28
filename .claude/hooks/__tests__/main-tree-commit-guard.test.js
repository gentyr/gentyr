/**
 * Unit tests for main-tree-commit-guard.js (PreToolUse hook) and the
 * git-wrappers/git spawned-agent guards.
 *
 * Tests the guard that blocks destructive git operations (add, commit,
 * reset --hard, stash) for spawned sub-agents in the main working tree.
 *
 * Run with: node --test .claude/hooks/__tests__/main-tree-commit-guard.test.js
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
function createMainTree(prefix = 'commit-guard-test') {
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
function createWorktreeDir(prefix = 'commit-guard-wt-test') {
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
function createNonRepo(prefix = 'commit-guard-nongit') {
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
    const hookPath = path.join(__dirname, '..', 'main-tree-commit-guard.js');

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
// PreToolUse Hook Tests
// ============================================================================

describe('main-tree-commit-guard.js (PreToolUse hook)', () => {
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

  // Spawned agent env: always set CLAUDE_SPAWNED_SESSION=true
  const spawnedEnv = (projectDir) => ({
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_SPAWNED_SESSION: 'true',
  });

  describe('blocks destructive git ops for spawned agents in main tree', () => {
    it('blocks git add .', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add .' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('BLOCKED'));
      assert.ok(output.permissionDecisionReason.includes('git add'));
    });

    it('blocks git add src/file.ts', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add src/file.ts' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git add -A', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add -A' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git commit -m "msg"', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "code-reviewer checkpoint"' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('git commit'));
    });

    it('blocks git add . && git commit -m "msg" (chained)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add . && git commit -m "checkpoint"' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git reset --hard HEAD', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git reset --hard HEAD' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('reset --hard'));
    });

    it('blocks git reset --hard (no ref)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git reset --hard' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git stash (bare)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('stash'));
    });

    it('blocks git stash push', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash push -m "save"' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git stash pop', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash pop' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git stash drop', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash drop' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks /usr/bin/git add .', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '/usr/bin/git add .' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git stash clear', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash clear' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git stash apply', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash apply' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git clean -fd', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git clean -fd' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('clean'));
    });

    it('blocks git clean -f', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git clean -f' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
    });

    it('blocks git pull', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes('pull'));
    });
  });

  describe('allows read-only git ops for spawned agents in main tree', () => {
    it('allows git status', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
      assert.strictEqual(output.permissionDecision, undefined);
    });

    it('allows git diff', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git diff' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git log', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log --oneline -10' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git show', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git show HEAD' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git stash list', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash list' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git stash show', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git stash show -p' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git reset (without --hard)', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git reset HEAD file.txt' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git push', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git push -u origin HEAD' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows everything for interactive sessions', () => {
    it('allows git add . for interactive user', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add .' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git commit for interactive user', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "manual commit"' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git reset --hard for interactive user', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git reset --hard HEAD' },
      }, { env: { CLAUDE_PROJECT_DIR: mainTree.path } });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows everything in worktrees', () => {
    it('allows git add . in worktree', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add .' },
      }, { env: spawnedEnv(worktree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git commit in worktree', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "checkpoint"' },
      }, { env: spawnedEnv(worktree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git reset --hard in worktree', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git reset --hard HEAD' },
      }, { env: spawnedEnv(worktree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows promotion pipeline agents', () => {
    it('allows git commit for promotion pipeline', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "promotion"' },
      }, { env: {
        CLAUDE_PROJECT_DIR: mainTree.path,
        CLAUDE_SPAWNED_SESSION: 'true',
        GENTYR_PROMOTION_PIPELINE: 'true',
      }});

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows git add . for promotion pipeline', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add .' },
      }, { env: {
        CLAUDE_PROJECT_DIR: mainTree.path,
        CLAUDE_SPAWNED_SESSION: 'true',
        GENTYR_PROMOTION_PIPELINE: 'true',
      }});

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('non-git passthrough', () => {
    it('allows non-Bash tool calls', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/some/path' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows empty command', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });

    it('allows non-git Bash commands', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
      }, { env: spawnedEnv(mainTree.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('allows everything in non-repo', () => {
    it('allows git add in non-repo directory', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add .' },
      }, { env: spawnedEnv(nonRepo.path) });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.allow, true);
    });
  });

  describe('invalid input handling', () => {
    it('allows on invalid JSON', async () => {
      const hookPath = path.join(__dirname, '..', 'main-tree-commit-guard.js');
      const result = await new Promise((resolve) => {
        const child = spawn('node', [hookPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_PROJECT_DIR: mainTree.path, CLAUDE_SPAWNED_SESSION: 'true' },
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
  });
});

// ============================================================================
// Git Wrapper Tests for spawned-agent guards
// ============================================================================

describe('git-wrappers/git spawned-agent guards', () => {
  let mainTree;
  let worktree;

  beforeEach(() => {
    mainTree = createMainTree();
    worktree = createWorktreeDir();
  });

  afterEach(() => {
    mainTree.cleanup();
    worktree.cleanup();
  });

  const spawnedWrapperEnv = { CLAUDE_SPAWNED_SESSION: 'true' };

  describe('blocks destructive ops for spawned agents in main tree', () => {
    it('blocks git add . with exit 128', () => {
      const result = runWrapper(['add', '.'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git commit -m "msg"', () => {
      const result = runWrapper(['commit', '-m', 'test'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git reset --hard', () => {
      const result = runWrapper(['reset', '--hard', 'HEAD'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git stash (bare)', () => {
      const result = runWrapper(['stash'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git stash pop', () => {
      const result = runWrapper(['stash', 'pop'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git stash drop', () => {
      const result = runWrapper(['stash', 'drop'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git clean -fd', () => {
      const result = runWrapper(['clean', '-fd'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });

    it('blocks git pull', () => {
      const result = runWrapper(['pull', 'origin', 'main'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.strictEqual(result.exitCode, 128);
      assert.ok(result.stderr.includes('BLOCKED'));
    });
  });

  describe('allows read-only ops for spawned agents in main tree', () => {
    it('allows git stash list', () => {
      const result = runWrapper(['stash', 'list'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git stash show', () => {
      const result = runWrapper(['stash', 'show'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git reset (soft, without --hard)', () => {
      const result = runWrapper(['reset', 'HEAD'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git status for spawned agents', () => {
      const result = runWrapper(['status'], {
        cwd: mainTree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });
  });

  describe('allows everything in worktrees for spawned agents', () => {
    it('allows git add . in worktree', () => {
      const result = runWrapper(['add', '.'], {
        cwd: worktree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git commit in worktree', () => {
      const result = runWrapper(['commit', '-m', 'test'], {
        cwd: worktree.path,
        env: spawnedWrapperEnv,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });
  });

  describe('allows everything for non-spawned agents', () => {
    it('allows git add . without CLAUDE_SPAWNED_SESSION', () => {
      const result = runWrapper(['add', '.'], {
        cwd: mainTree.path,
        // No CLAUDE_SPAWNED_SESSION
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git commit without CLAUDE_SPAWNED_SESSION', () => {
      const result = runWrapper(['commit', '-m', 'test'], {
        cwd: mainTree.path,
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });
  });

  describe('allows promotion pipeline agents', () => {
    it('allows git add . for promotion pipeline', () => {
      const result = runWrapper(['add', '.'], {
        cwd: mainTree.path,
        env: { CLAUDE_SPAWNED_SESSION: 'true', GENTYR_PROMOTION_PIPELINE: 'true' },
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });

    it('allows git commit for promotion pipeline', () => {
      const result = runWrapper(['commit', '-m', 'promotion'], {
        cwd: mainTree.path,
        env: { CLAUDE_SPAWNED_SESSION: 'true', GENTYR_PROMOTION_PIPELINE: 'true' },
      });
      assert.ok(!result.stderr.includes('BLOCKED'));
    });
  });
});
