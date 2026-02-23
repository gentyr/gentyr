/**
 * Unit tests for gentyr-sync.js branchDriftCheck()
 *
 * Tests that the SessionStart hook detects when the main working tree
 * is not on 'main' and emits an appropriate warning.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/gentyr-sync-branch-drift.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_PATH = path.resolve(process.cwd(), '.claude/hooks/gentyr-sync.js');

/**
 * Run the hook with a given project directory and env vars.
 * Returns { exitCode, stdout, parsed, stderr }.
 */
function runHook(projectDir, extraEnv = {}) {
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Don't inherit the real spawned session flag
        CLAUDE_SPAWNED_SESSION: '',
        ...extraEnv,
      },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout.trim()); } catch {}
    return { exitCode: 0, stdout, stderr: '', parsed };
  } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse((err.stdout || '').trim()); } catch {}
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      parsed,
    };
  }
}

/**
 * Create a real git repo in a temp directory on the specified branch.
 */
function createGitRepo(dir, branch = 'main') {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Need at least one commit for branch operations
  // Include .gitignore so node_modules/.claude don't appear as untracked
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.claude/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'pipe' });
  }
}

/**
 * Set up minimal framework structure so the hook doesn't exit early
 * at resolveFrameworkDir(). We create a version.json and the .claude dir.
 */
function setupFrameworkStub(dir) {
  // The hook needs resolveFrameworkDir to succeed; create node_modules/gentyr
  // with a version.json as the minimal requirement
  const gentyrDir = path.join(dir, 'node_modules', 'gentyr');
  fs.mkdirSync(gentyrDir, { recursive: true });
  fs.writeFileSync(path.join(gentyrDir, 'version.json'), JSON.stringify({ version: '0.0.0-test' }));
  // Create .claude dir for gentyr-state.json
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // Create template files so computeConfigHash works
  const claudeDir = path.join(gentyrDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json.template'), '{}');
  fs.writeFileSync(path.join(gentyrDir, '.mcp.json.template'), '{}');
  // Write state that matches so statBasedSync does nothing (fast path)
  const configHash = computeConfigHashForTest(gentyrDir);
  fs.writeFileSync(path.join(dir, '.claude', 'gentyr-state.json'), JSON.stringify({
    version: '0.0.0-test',
    configHash,
    claudeMdHash: '',
    agentList: [],
    stateFilesVersion: 1,
    lastSync: new Date().toISOString(),
  }));
}

/**
 * Replicate computeConfigHash logic for test setup
 */
function computeConfigHashForTest(frameworkDir) {
  const files = [
    path.join(frameworkDir, '.claude', 'settings.json.template'),
    path.join(frameworkDir, '.mcp.json.template'),
  ];
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    try { hash.update(fs.readFileSync(f, 'utf8')); } catch { hash.update(''); }
  }
  return hash.digest('hex');
}

describe('gentyr-sync branchDriftCheck', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-drift-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should emit no warning when on main', () => {
    createGitRepo(tmpDir, 'main');
    setupFrameworkStub(tmpDir);
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    // Should be silent (no systemMessage about branch drift)
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn about branch drift when on main',
      );
    }
  });

  it('should warn when on a feature branch with no uncommitted changes', () => {
    createGitRepo(tmpDir, 'feature/test-branch');
    setupFrameworkStub(tmpDir);
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('BRANCH DRIFT'),
      'should include BRANCH DRIFT label',
    );
    assert.ok(
      parsed.systemMessage.includes("'feature/test-branch'"),
      'should include the branch name',
    );
    assert.ok(
      parsed.systemMessage.includes('git checkout main'),
      'should suggest git checkout main',
    );
    assert.ok(
      !parsed.systemMessage.includes('git stash'),
      'should NOT suggest stash when no uncommitted changes',
    );
  });

  it('should warn with stash guidance when on a feature branch with uncommitted changes', () => {
    createGitRepo(tmpDir, 'hotfix/fix-ci');
    setupFrameworkStub(tmpDir);
    // Create an uncommitted file
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted change');
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('BRANCH DRIFT'),
      'should include BRANCH DRIFT label',
    );
    assert.ok(
      parsed.systemMessage.includes("'hotfix/fix-ci'"),
      'should include the branch name',
    );
    assert.ok(
      parsed.systemMessage.includes('git stash'),
      'should suggest git stash for uncommitted changes',
    );
  });

  it('should not warn on detached HEAD', () => {
    createGitRepo(tmpDir, 'main');
    setupFrameworkStub(tmpDir);
    // Detach HEAD
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpDir, encoding: 'utf8', stdio: 'pipe',
    }).trim();
    execFileSync('git', ['checkout', commitHash], { cwd: tmpDir, stdio: 'pipe' });
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn about branch drift on detached HEAD',
      );
    }
  });

  it('should not warn inside a worktree (.git is a file)', () => {
    createGitRepo(tmpDir, 'main');
    // Create a worktree on a different branch
    const worktreeDir = path.join(tmpDir, 'wt');
    execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'feature/wt-test'], {
      cwd: tmpDir, stdio: 'pipe',
    });
    setupFrameworkStub(worktreeDir);
    const { exitCode, parsed } = runHook(worktreeDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn about branch drift inside a worktree',
      );
    }
  });

  it('should not warn when CLAUDE_SPAWNED_SESSION=true', () => {
    createGitRepo(tmpDir, 'feature/spawned-test');
    setupFrameworkStub(tmpDir);
    const { exitCode, parsed } = runHook(tmpDir, { CLAUDE_SPAWNED_SESSION: 'true' });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    // Spawned sessions exit before branchDriftCheck runs
    assert.strictEqual(parsed.suppressOutput, true, 'spawned sessions should be silent');
  });

  it('should not warn when git is not available or repo is corrupted', () => {
    // No .git at all — not a git repo
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    setupFrameworkStub(tmpDir);
    // Remove the .git directory so it's not a repo
    const gitDir = path.join(tmpDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn when .git does not exist',
      );
    }
  });

  it('should warn on staging and preview branches (they are not main)', () => {
    // staging and preview are protected merge-chain branches, not 'main'.
    // branchDriftCheck currently warns for ANY branch that is not 'main'.
    // This test pins that behaviour so a future change to special-case these
    // branches (suppressing the warning) cannot regress silently.
    for (const branch of ['staging', 'preview']) {
      const branchDir = fs.mkdtempSync(path.join(os.tmpdir(), `branch-drift-${branch}-`));
      try {
        createGitRepo(branchDir, branch);
        setupFrameworkStub(branchDir);
        const { exitCode, parsed } = runHook(branchDir);
        assert.strictEqual(exitCode, 0, `exit code should be 0 on '${branch}'`);
        assert.strictEqual(parsed.continue, true, `continue should be true on '${branch}'`);
        assert.ok(parsed.systemMessage, `should emit a systemMessage on '${branch}'`);
        assert.ok(
          parsed.systemMessage.includes('BRANCH DRIFT'),
          `should include BRANCH DRIFT label on '${branch}'`,
        );
        assert.ok(
          parsed.systemMessage.includes(`'${branch}'`),
          `should include the branch name '${branch}'`,
        );
      } finally {
        fs.rmSync(branchDir, { recursive: true, force: true });
      }
    }
  });

  it('should include the full context sentence in the warning', () => {
    // The warning message contains a second sentence explaining *why* branch drift
    // matters. Pin it so accidental deletion does not go unnoticed.
    createGitRepo(tmpDir, 'feature/context-sentence-test');
    setupFrameworkStub(tmpDir);
    const { parsed } = runHook(tmpDir);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('incorrect preflight checks'),
      'should mention preflight checks in the context sentence',
    );
    assert.ok(
      parsed.systemMessage.includes('stale worktree bases'),
      'should mention stale worktree bases in the context sentence',
    );
    assert.ok(
      parsed.systemMessage.includes('promotion failures'),
      'should mention promotion failures in the context sentence',
    );
  });

  it('should include the full stash round-trip command when there are uncommitted changes', () => {
    // The dirty-branch recovery instruction is a three-step sequence.
    // Pin all three steps to prevent partial truncation from silently passing.
    createGitRepo(tmpDir, 'feature/stash-roundtrip-test');
    setupFrameworkStub(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted change');
    const { parsed } = runHook(tmpDir);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('git stash &&'),
      'should include the stash step of the recovery command',
    );
    assert.ok(
      parsed.systemMessage.includes('git checkout main'),
      'should include the checkout step of the recovery command',
    );
    assert.ok(
      parsed.systemMessage.includes('git stash pop'),
      'should include the stash pop step of the recovery command',
    );
  });

  it('should warn with the clean-branch message when git status fails on a non-main branch', () => {
    // When 'git status --porcelain' throws, the implementation silently falls
    // through with hasChanges = false and emits the no-stash variant.
    // Simulate this by making the project dir a git repo on a non-main branch
    // but placing a file named 'git' earlier in PATH that exits 1 for 'status'
    // but behaves normally for 'branch --show-current'.
    //
    // Approach: use a wrapper script directory on PATH that intercepts only 'status'.
    const fakeGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-'));
    try {
      createGitRepo(tmpDir, 'feature/git-status-fails');
      setupFrameworkStub(tmpDir);

      // Wrapper that delegates 'branch' normally but fails on 'status'
      const fakeGit = path.join(fakeGitDir, 'git');
      fs.writeFileSync(fakeGit,
        `#!/bin/sh
if [ "$1" = "status" ]; then
  exit 1
fi
exec /usr/bin/git "$@"
`);
      fs.chmodSync(fakeGit, 0o755);

      const origPath = process.env.PATH || '';
      const { exitCode, parsed } = runHook(tmpDir, {
        PATH: `${fakeGitDir}:${origPath}`,
      });

      assert.strictEqual(exitCode, 0, 'hook should not crash when git status fails');
      assert.strictEqual(parsed.continue, true);
      assert.ok(parsed.systemMessage, 'should still emit a systemMessage');
      assert.ok(
        parsed.systemMessage.includes('BRANCH DRIFT'),
        'should include BRANCH DRIFT label even when git status fails',
      );
      // With hasChanges = false (status threw), the no-stash message is used
      assert.ok(
        !parsed.systemMessage.includes('git stash &&'),
        'should NOT include the full stash command when git status failed',
      );
      assert.ok(
        parsed.systemMessage.includes('git checkout main'),
        'should still include git checkout main as recovery step',
      );
    } finally {
      fs.rmSync(fakeGitDir, { recursive: true, force: true });
    }
  });
});
