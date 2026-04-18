/**
 * Unit tests for signal-reader.js (PostToolUse hook).
 *
 * Tests the signal-reader hook that injects inter-agent signals into the
 * model's context via additionalContext.
 *
 * Run with: node --test .claude/hooks/__tests__/signal-reader.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.join(__dirname, '..', 'signal-reader.js');
const SIGNALS_MODULE_PATH = path.join(__dirname, '..', 'lib', 'session-signals.js');

// ============================================================================
// Test Utilities
// ============================================================================

function createTempProject(prefix = 'signal-reader-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state', 'session-signals'), { recursive: true });
  return {
    path: tmpDir,
    signalDir: path.join(tmpDir, '.claude', 'state', 'session-signals'),
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Execute the signal-reader hook as a subprocess and return parsed output.
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...(opts.env || {}),
    };

    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (exitCode) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (_) { /* cleanup - failure expected */ }
      resolve({ exitCode, stdout, stderr, parsed });
    });

    child.stdin.write(JSON.stringify(hookInput || {}));
    child.stdin.end();
  });
}

// ============================================================================
// Shared module for setup
// ============================================================================

let sendSignal;
let getMainProjectDir;
let readPendingSignals;

before(async () => {
  const mod = await import(SIGNALS_MODULE_PATH);
  sendSignal = mod.sendSignal;
  getMainProjectDir = mod.getMainProjectDir;
  readPendingSignals = mod.readPendingSignals;
});

// ============================================================================
// Tests
// ============================================================================

describe('signal-reader.js (PostToolUse hook)', () => {
  let project;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  // --------------------------------------------------------------------------
  // Non-spawned sessions
  // --------------------------------------------------------------------------

  describe('non-spawned sessions', () => {
    it('exits immediately with allow when CLAUDE_AGENT_ID is not set', async () => {
      const result = await runHook(
        { tool_name: 'Write', tool_input: {} },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            // No CLAUDE_AGENT_ID
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      assert.strictEqual(result.parsed.hookSpecificOutput, undefined);
    });

    it('does not inject additionalContext for interactive sessions', async () => {
      // Even if there are signals in the dir, non-spawned sessions skip them
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-interactive',
        toAgentType: 'cto',
        tier: 'note',
        message: 'Test message',
        projectDir: project.path,
      });

      const result = await runHook(
        { tool_name: 'Write', tool_input: {} },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            // No CLAUDE_AGENT_ID means interactive session
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      assert.strictEqual(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // No signals
  // --------------------------------------------------------------------------

  describe('no signals', () => {
    it('exits quickly with allow when no signals exist', async () => {
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      assert.strictEqual(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Note tier
  // --------------------------------------------------------------------------

  describe('note tier', () => {
    it('formats a note signal correctly', async () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Fix auth module',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Hey I updated the auth interface',
        projectDir: project.path,
      });

      const result = await runHook(
        { tool_name: 'Read', tool_input: { file_path: '/tmp/foo' } },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      assert.ok(result.parsed.hookSpecificOutput, 'Should have hookSpecificOutput');
      assert.strictEqual(result.parsed.hookSpecificOutput.hookEventName, 'PostToolUse');

      const ctx = result.parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('[AGENT COMMUNICATION — HELPFUL NOTE]'), 'Should include note header');
      assert.ok(ctx.includes('code-writer'), 'Should include sender type');
      assert.ok(ctx.includes('Fix auth module'), 'Should include task title');
      assert.ok(ctx.includes('Hey I updated the auth interface'), 'Should include message');
      assert.ok(ctx.includes('FYI only'), 'Should indicate FYI nature');
      assert.ok(ctx.includes('agent-bbb'), 'Should reference receiving agent ID');
    });
  });

  // --------------------------------------------------------------------------
  // Instruction tier
  // --------------------------------------------------------------------------

  describe('instruction tier', () => {
    it('formats an instruction signal with urgent framing', async () => {
      sendSignal({
        fromAgentId: 'deputy-cto',
        fromAgentType: 'deputy-cto',
        fromTaskTitle: 'Deputy CTO',
        toAgentId: 'agent-bbb',
        toAgentType: 'code-writer',
        tier: 'instruction',
        message: 'Stop and apply security fix first',
        projectDir: project.path,
      });

      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: '/tmp/foo', old_string: '', new_string: '' } },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      const ctx = result.parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('[DEPUTY-CTO INSTRUCTION — URGENT]'), 'Should include instruction header');
      assert.ok(ctx.includes('MUST acknowledge'), 'Should indicate must acknowledge');
      assert.ok(ctx.includes('Stop and apply security fix first'), 'Should include message');
      assert.ok(ctx.includes('acknowledge_signal'), 'Should include acknowledge instruction');
    });
  });

  // --------------------------------------------------------------------------
  // Directive tier
  // --------------------------------------------------------------------------

  describe('directive tier', () => {
    it('formats a directive signal with mandatory override framing', async () => {
      const signal = sendSignal({
        fromAgentId: 'cto',
        fromAgentType: 'cto',
        fromTaskTitle: 'CTO Session',
        toAgentId: 'agent-bbb',
        toAgentType: 'code-writer',
        tier: 'directive',
        message: 'Abandon current approach and use the new architecture',
        projectDir: project.path,
      });

      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/foo', content: '' } },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      const ctx = result.parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('[CTO DIRECTIVE — MANDATORY OVERRIDE]'), 'Should include directive header');
      assert.ok(ctx.includes('OVERRIDES'), 'Should indicate override');
      assert.ok(ctx.includes('IMMEDIATELY'), 'Should indicate urgency');
      assert.ok(ctx.includes('Abandon current approach'), 'Should include message');
      assert.ok(ctx.includes(signal.id), 'Should include signal ID for acknowledge');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple signals
  // --------------------------------------------------------------------------

  describe('multiple signals', () => {
    it('formats multiple signals in one additionalContext', async () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Note message',
        projectDir: project.path,
      });

      sendSignal({
        fromAgentId: 'deputy-cto',
        fromAgentType: 'deputy-cto',
        fromTaskTitle: 'Deputy',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'Instruction message',
        projectDir: project.path,
      });

      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        {
          env: {
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        },
      );

      assert.strictEqual(result.parsed.decision, 'approve');
      const ctx = result.parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('[AGENT COMMUNICATION — HELPFUL NOTE]'));
      assert.ok(ctx.includes('[DEPUTY-CTO INSTRUCTION — URGENT]'));
      assert.ok(ctx.includes('Note message'));
      assert.ok(ctx.includes('Instruction message'));
    });
  });

  // --------------------------------------------------------------------------
  // Invalid input handling
  // --------------------------------------------------------------------------

  describe('invalid input handling', () => {
    it('continues with allow on invalid JSON stdin', async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: project.path,
            CLAUDE_AGENT_ID: 'agent-bbb',
          },
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', () => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch (_) { /* cleanup - failure expected */ }
          resolve({ parsed });
        });
        child.stdin.write('not valid json');
        child.stdin.end();
      });

      // Should still exit with allow (no signals in dir)
      assert.strictEqual(result.parsed.decision, 'approve');
    });
  });

  // --------------------------------------------------------------------------
  // Worktree context
  // --------------------------------------------------------------------------

  describe('worktree context', () => {
    it('finds signals in main tree when CLAUDE_PROJECT_DIR points to a worktree', async () => {
      // Build a temp directory structure that simulates a worktree:
      //   mainTree/          ← real project root, has .git/ directory
      //     .claude/state/session-signals/
      //     .git/worktrees/my-branch/   ← gitdir path referenced by worktree .git file
      //   worktree/          ← worktree root
      //     .git             ← FILE containing "gitdir: <mainTree>/.git/worktrees/my-branch"

      const mainTree = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-main-'));
      const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-wt-'));

      try {
        // Set up main tree git dir and worktrees subdir
        const mainGitDir = path.join(mainTree, '.git');
        const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'my-branch');
        fs.mkdirSync(worktreeGitDir, { recursive: true });

        // Set up main tree signal directory
        const mainSignalDir = path.join(mainTree, '.claude', 'state', 'session-signals');
        fs.mkdirSync(mainSignalDir, { recursive: true });

        // Worktree .git is a FILE pointing to the gitdir inside the main .git
        fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);

        // Verify getMainProjectDir() resolves the worktree path to the main tree
        const resolved = getMainProjectDir(worktreePath);
        assert.strictEqual(resolved, mainTree, 'getMainProjectDir should resolve worktree to main tree');

        // Write a signal to the MAIN TREE signal directory and verify readPendingSignals finds it
        sendSignal({
          fromAgentId: 'agent-sender',
          fromAgentType: 'code-writer',
          fromTaskTitle: 'Main task',
          toAgentId: 'agent-wt-api',
          toAgentType: 'test-writer',
          tier: 'note',
          message: 'Signal sent to main tree, read from worktree',
          projectDir: mainTree,
        });

        const signals = readPendingSignals('agent-wt-api', resolved);
        assert.strictEqual(signals.length, 1, 'Should find 1 pending signal in main tree');
        assert.strictEqual(signals[0].message, 'Signal sent to main tree, read from worktree');

        // Write a SECOND signal for a different agent ID so the hook subprocess sees it unread
        sendSignal({
          fromAgentId: 'agent-sender',
          fromAgentType: 'code-writer',
          fromTaskTitle: 'Main task',
          toAgentId: 'agent-wt-hook',
          toAgentType: 'test-writer',
          tier: 'note',
          message: 'Hook signal sent to main tree, read from worktree',
          projectDir: mainTree,
        });

        // Verify the hook subprocess also finds the signal when CLAUDE_PROJECT_DIR is the worktree
        const result = await runHook(
          { tool_name: 'Bash', tool_input: { command: 'ls' } },
          {
            env: {
              CLAUDE_PROJECT_DIR: worktreePath,
              CLAUDE_AGENT_ID: 'agent-wt-hook',
            },
          },
        );

        assert.strictEqual(result.parsed.decision, 'approve');
        assert.ok(result.parsed.hookSpecificOutput, 'Hook should have found and injected the signal');
        const ctx = result.parsed.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('Hook signal sent to main tree, read from worktree'), 'Signal message should be in context');
      } finally {
        fs.rmSync(mainTree, { recursive: true, force: true });
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    });

    it('getMainProjectDir returns projectDir unchanged for a non-worktree', async () => {
      // project.path has no .git at all — should return projectDir as-is
      const resolved = getMainProjectDir(project.path);
      assert.strictEqual(resolved, project.path);
    });
  });
});
