/**
 * Unit tests for branch-drift-check.js (UserPromptSubmit hook)
 *
 * Tests that the hook detects when the main working tree is not on 'main'
 * and emits an appropriate systemMessage warning to the AI agent.
 * Also tests cooldown and branch-change state tracking.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/gentyr-sync-branch-drift.test.js
 *
 * @version 2.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_PATH = path.resolve(process.cwd(), '.claude/hooks/branch-drift-check.js');

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
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.claude/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'pipe' });
  }
}

/**
 * Write a branch-drift-state.json to simulate prior state.
 */
function writeState(dir, state) {
  const stateDir = path.join(dir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'branch-drift-state.json'), JSON.stringify(state, null, 2));
}

describe('branch-drift-check hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-drift-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should emit no warning when on main', () => {
    createGitRepo(tmpDir, 'main');
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn about branch drift when on main',
      );
    }
  });

  it('should warn when on a feature branch with no uncommitted changes', () => {
    createGitRepo(tmpDir, 'feature/test-branch');
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
    const worktreeDir = path.join(tmpDir, 'wt');
    execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'feature/wt-test'], {
      cwd: tmpDir, stdio: 'pipe',
    });
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
    const { exitCode, parsed } = runHook(tmpDir, { CLAUDE_SPAWNED_SESSION: 'true' });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.strictEqual(parsed.suppressOutput, true, 'spawned sessions should be silent');
  });

  it('should not warn when git is not available or repo is corrupted', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
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
    for (const branch of ['staging', 'preview']) {
      const branchDir = fs.mkdtempSync(path.join(os.tmpdir(), `branch-drift-${branch}-`));
      try {
        createGitRepo(branchDir, branch);
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
    createGitRepo(tmpDir, 'feature/context-sentence-test');
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
    createGitRepo(tmpDir, 'feature/stash-roundtrip-test');
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
    const fakeGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-'));
    try {
      createGitRepo(tmpDir, 'feature/git-status-fails');

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

  // --- Cooldown tests ---

  it('should respect cooldown: second run within window is silent', () => {
    createGitRepo(tmpDir, 'feature/cooldown-test');

    // First run — should warn
    const first = runHook(tmpDir);
    assert.strictEqual(first.exitCode, 0);
    assert.ok(first.parsed.systemMessage, 'first run should emit warning');
    assert.ok(first.parsed.systemMessage.includes('BRANCH DRIFT'));

    // Second run immediately — should be silent (within 30-min cooldown)
    const second = runHook(tmpDir);
    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(second.parsed.continue, true);
    assert.strictEqual(second.parsed.suppressOutput, true, 'second run should be silent due to cooldown');
  });

  it('should reset cooldown when branch changes', () => {
    createGitRepo(tmpDir, 'feature/branch-a');

    // First run on branch-a — warns and records state
    const first = runHook(tmpDir);
    assert.ok(first.parsed.systemMessage, 'first run should warn');
    assert.ok(first.parsed.systemMessage.includes("'feature/branch-a'"));

    // Switch to branch-b
    execFileSync('git', ['checkout', '-b', 'feature/branch-b'], { cwd: tmpDir, stdio: 'pipe' });

    // Second run — should warn again despite being within cooldown window
    const second = runHook(tmpDir);
    assert.ok(second.parsed.systemMessage, 'should warn after branch change despite cooldown');
    assert.ok(second.parsed.systemMessage.includes("'feature/branch-b'"));
  });

  it('should emit no warning when returning to main (clears state)', () => {
    createGitRepo(tmpDir, 'feature/drift-then-fix');

    // First run on feature branch — warns
    const first = runHook(tmpDir);
    assert.ok(first.parsed.systemMessage);
    assert.ok(first.parsed.systemMessage.includes('BRANCH DRIFT'));

    // Switch back to main
    execFileSync('git', ['checkout', 'main'], { cwd: tmpDir, stdio: 'pipe' });

    // Second run on main — no warning
    const second = runHook(tmpDir);
    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(second.parsed.continue, true);
    if (second.parsed.systemMessage) {
      assert.ok(
        !second.parsed.systemMessage.includes('BRANCH DRIFT'),
        'should not warn after returning to main',
      );
    }
  });

  // --- hookSpecificOutput tests ---

  it('should include hookSpecificOutput with hookEventName and additionalContext when warning', () => {
    createGitRepo(tmpDir, 'feature/hook-output-test');
    const { exitCode, parsed } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(parsed.hookSpecificOutput, 'should include hookSpecificOutput field');
    assert.strictEqual(
      parsed.hookSpecificOutput.hookEventName,
      'UserPromptSubmit',
      'hookEventName must be UserPromptSubmit',
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext,
      'additionalContext must be present',
    );
  });

  it('additionalContext must equal systemMessage when warning is emitted', () => {
    createGitRepo(tmpDir, 'feature/context-sync-test');
    const { parsed } = runHook(tmpDir);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(parsed.hookSpecificOutput, 'should include hookSpecificOutput');
    assert.strictEqual(
      parsed.hookSpecificOutput.additionalContext,
      parsed.systemMessage,
      'additionalContext must be identical to systemMessage so the AI model receives the same text as the terminal',
    );
  });

  it('additionalContext must contain the full BRANCH DRIFT message text', () => {
    createGitRepo(tmpDir, 'feature/additional-context-content-test');
    const { parsed } = runHook(tmpDir);
    assert.ok(parsed.hookSpecificOutput, 'should include hookSpecificOutput');
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes('BRANCH DRIFT'),
      'additionalContext must include BRANCH DRIFT label',
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("'feature/additional-context-content-test'"),
      'additionalContext must include the branch name',
    );
  });

  it('should not include hookSpecificOutput when session is silent (spawned session)', () => {
    createGitRepo(tmpDir, 'feature/spawned-no-hook-output');
    const { exitCode, parsed } = runHook(tmpDir, { CLAUDE_SPAWNED_SESSION: 'true' });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.strictEqual(parsed.suppressOutput, true);
    assert.ok(
      !parsed.hookSpecificOutput,
      'spawned sessions must not include hookSpecificOutput',
    );
  });
});
