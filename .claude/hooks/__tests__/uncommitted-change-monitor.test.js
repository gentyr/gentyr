/**
 * Unit tests for uncommitted-change-monitor.js (PostToolUse hook).
 *
 * Tests the hook that warns after N uncommitted file edits.
 *
 * Run with: node --test .claude/hooks/__tests__/uncommitted-change-monitor.test.js
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

const HOOK_PATH = path.join(__dirname, '..', 'uncommitted-change-monitor.js');

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temp dir with a real git repo (so git log works).
 */
function createGitRepo(prefix = 'ucm-repo-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init');
  execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: tmpDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  return {
    path: tmpDir,
    stateFile: path.join(tmpDir, '.claude', 'state', 'uncommitted-changes-state.json'),
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create a simple temp dir for the hook (with mock .git dir, no real repo).
 */
function createTempProject(prefix = 'ucm-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.git')); // directory = main tree
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  return {
    path: tmpDir,
    stateFile: path.join(tmpDir, '.claude', 'state', 'uncommitted-changes-state.json'),
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create a temp dir simulating a worktree (.git is a file).
 */
function createWorktreeProject(prefix = 'ucm-wt-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/wt\n');
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  return {
    path: tmpDir,
    stateFile: path.join(tmpDir, '.claude', 'state', 'uncommitted-changes-state.json'),
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Execute the hook and return parsed output.
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (opts.env) {
      spawnOpts.env = { ...process.env, ...opts.env };
    }

    const child = spawn('node', [HOOK_PATH], spawnOpts);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (exitCode) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {}
      resolve({ exitCode, stdout, stderr, parsed });
    });

    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

/**
 * Write a pre-set state file.
 */
function writeState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Read the state file.
 */
function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('uncommitted-change-monitor.js (PostToolUse hook)', () => {
  let project;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  describe('tool filtering', () => {
    it('processes Write tool calls', async () => {
      const result = await runHook(
        { tool_name: 'Write' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );
      assert.strictEqual(result.parsed.continue, true);
      // Should have incremented counter
      const state = readState(project.stateFile);
      assert.strictEqual(state.changesSinceLastCommit, 1);
    });

    it('processes Edit tool calls', async () => {
      const result = await runHook(
        { tool_name: 'Edit' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );
      assert.strictEqual(result.parsed.continue, true);
      const state = readState(project.stateFile);
      assert.strictEqual(state.changesSinceLastCommit, 1);
    });

    it('ignores Bash tool calls', async () => {
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );
      assert.strictEqual(result.parsed.continue, true);
      // No state file should have been written
      const state = readState(project.stateFile);
      assert.strictEqual(state, null);
    });

    it('ignores Read tool calls', async () => {
      const result = await runHook(
        { tool_name: 'Read', tool_input: { file_path: '/tmp/foo' } },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );
      assert.strictEqual(result.parsed.continue, true);
      const state = readState(project.stateFile);
      assert.strictEqual(state, null);
    });
  });

  describe('counter tracking', () => {
    it('increments counter on each Edit call', async () => {
      for (let i = 1; i <= 3; i++) {
        await runHook(
          { tool_name: 'Edit' },
          { env: { CLAUDE_PROJECT_DIR: project.path } },
        );
        const state = readState(project.stateFile);
        assert.strictEqual(state.changesSinceLastCommit, i);
      }
    });

    it('increments counter for mixed Write and Edit calls', async () => {
      await runHook({ tool_name: 'Write' }, { env: { CLAUDE_PROJECT_DIR: project.path } });
      await runHook({ tool_name: 'Edit' }, { env: { CLAUDE_PROJECT_DIR: project.path } });
      await runHook({ tool_name: 'Write' }, { env: { CLAUDE_PROJECT_DIR: project.path } });

      const state = readState(project.stateFile);
      assert.strictEqual(state.changesSinceLastCommit, 3);
    });
  });

  describe('warning threshold', () => {
    it('does not warn before threshold (4 edits)', async () => {
      for (let i = 0; i < 4; i++) {
        const result = await runHook(
          { tool_name: 'Edit' },
          { env: { CLAUDE_PROJECT_DIR: project.path } },
        );
        assert.strictEqual(result.parsed.continue, true);
        assert.strictEqual(result.parsed.hookSpecificOutput, undefined);
      }
    });

    it('warns at threshold (5th edit)', async () => {
      // Pre-set state to 4 changes
      writeState(project.stateFile, {
        changesSinceLastCommit: 4,
        lastCommitHash: '',
        lastWarningAt: 0,
      });

      const result = await runHook(
        { tool_name: 'Edit' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );

      assert.strictEqual(result.parsed.continue, true);
      assert.ok(result.parsed.hookSpecificOutput);
      assert.ok(result.parsed.hookSpecificOutput.additionalContext.includes('uncommitted file changes'));
      assert.ok(result.parsed.hookSpecificOutput.additionalContext.includes('5'));
    });

    it('warns with correct count above threshold', async () => {
      writeState(project.stateFile, {
        changesSinceLastCommit: 9,
        lastCommitHash: '',
        lastWarningAt: 0,
      });

      const result = await runHook(
        { tool_name: 'Write' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );

      assert.ok(result.parsed.hookSpecificOutput);
      assert.ok(result.parsed.hookSpecificOutput.additionalContext.includes('10'));
    });
  });

  describe('warning cooldown', () => {
    it('respects 3-minute cooldown', async () => {
      // Pre-set state to above threshold with recent warning
      writeState(project.stateFile, {
        changesSinceLastCommit: 6,
        lastCommitHash: '',
        lastWarningAt: Date.now(), // Just warned
      });

      const result = await runHook(
        { tool_name: 'Edit' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );

      assert.strictEqual(result.parsed.continue, true);
      // Should NOT have additionalContext because cooldown hasn't elapsed
      assert.strictEqual(result.parsed.hookSpecificOutput, undefined);
    });

    it('warns again after cooldown expires', async () => {
      // Pre-set state with expired cooldown (4 minutes ago)
      writeState(project.stateFile, {
        changesSinceLastCommit: 6,
        lastCommitHash: '',
        lastWarningAt: Date.now() - 4 * 60 * 1000,
      });

      const result = await runHook(
        { tool_name: 'Edit' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );

      assert.ok(result.parsed.hookSpecificOutput);
      assert.ok(result.parsed.hookSpecificOutput.additionalContext.includes('uncommitted'));
    });
  });

  describe('spawned agent behavior', () => {
    it('skips spawned agents in main tree', async () => {
      const result = await runHook(
        { tool_name: 'Edit' },
        { env: {
          CLAUDE_PROJECT_DIR: project.path,
          CLAUDE_SPAWNED_SESSION: 'true',
        }},
      );

      assert.strictEqual(result.parsed.continue, true);
      // Should not have written state because it was skipped
      const state = readState(project.stateFile);
      assert.strictEqual(state, null);
    });

    it('skips spawned agents in worktrees', async () => {
      const wt = createWorktreeProject();
      try {
        const result = await runHook(
          { tool_name: 'Edit' },
          { env: {
            CLAUDE_PROJECT_DIR: wt.path,
            CLAUDE_SPAWNED_SESSION: 'true',
          }},
        );

        assert.strictEqual(result.parsed.continue, true);
        // Should not have written state because spawned agents are skipped
        const state = readState(wt.stateFile);
        assert.strictEqual(state, null);
      } finally {
        wt.cleanup();
      }
    });
  });

  describe('commit hash reset', () => {
    it('resets counter when commit hash changes', async () => {
      // Need a real git repo for git log to return a hash
      const gitRepo = createGitRepo();
      try {
        // Pre-set state with old commit hash and high counter
        writeState(gitRepo.stateFile, {
          changesSinceLastCommit: 10,
          lastCommitHash: 'old-hash-that-does-not-match-current',
          lastWarningAt: 0,
        });

        const result = await runHook(
          { tool_name: 'Edit' },
          { env: { CLAUDE_PROJECT_DIR: gitRepo.path } },
        );

        assert.strictEqual(result.parsed.continue, true);
        const state = readState(gitRepo.stateFile);
        // Counter should be 1 (reset to 0 then incremented)
        assert.strictEqual(state.changesSinceLastCommit, 1);
      } finally {
        gitRepo.cleanup();
      }
    });
  });

  describe('invalid input handling', () => {
    it('continues on invalid JSON', async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_PROJECT_DIR: project.path },
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (exitCode) => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch {}
          resolve({ exitCode, parsed });
        });
        child.stdin.write('not json');
        child.stdin.end();
      });

      assert.strictEqual(result.parsed.continue, true);
    });

    it('continues on missing tool_name', async () => {
      const result = await runHook(
        { some_field: 'value' },
        { env: { CLAUDE_PROJECT_DIR: project.path } },
      );
      assert.strictEqual(result.parsed.continue, true);
    });
  });
});
