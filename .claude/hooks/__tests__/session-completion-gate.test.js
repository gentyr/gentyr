/**
 * Unit tests for session-completion-gate.js (PostToolUse hook).
 *
 * Tests the gate that enforces required sub-agent sequencing (user-alignment +
 * project-manager) before automated worktree agents can submit their work report.
 *
 * Run with: node --test .claude/hooks/__tests__/session-completion-gate.test.js
 *
 * @version 1.0.0
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.join(__dirname, '..', 'session-completion-gate.js');

// ============================================================================
// Test Utilities
// ============================================================================

/** Temp dirs to clean up after each test */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup */}
  }
  tmpDirs.length = 0;
});

/**
 * Create a temporary directory (persisted in cleanup list).
 */
function createTempDir(prefix = 'scg-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

/**
 * Create a simulated worktree path:
 * <projectRoot>/.claude/worktrees/<branchName>/
 *
 * Returns { worktreePath, projectRoot }.
 */
function createWorktreePath(branchName = 'feature-test') {
  const projectRoot = createTempDir('scg-project-');
  const worktreePath = path.join(projectRoot, '.claude', 'worktrees', branchName);
  fs.mkdirSync(worktreePath, { recursive: true });
  // Simulate .git file (worktree marker)
  fs.writeFileSync(
    path.join(worktreePath, '.git'),
    `gitdir: ${projectRoot}/.git/worktrees/${branchName}\n`,
  );
  return { worktreePath, projectRoot };
}

/**
 * Write a fake session JSONL file with the given content.
 * Returns the path to the file.
 */
function writeSessionJsonl(dir, lines) {
  const sessionPath = path.join(dir, `${Date.now()}.jsonl`);
  fs.writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf8');
  return sessionPath;
}

/**
 * Build a JSONL line that simulates an Agent tool_use call for the given subagent.
 */
function agentToolUseLine(subagentType) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Task',
          input: {
            subagent_type: subagentType,
            prompt: `Run ${subagentType} checks`,
          },
        },
      ],
    },
  });
}

/**
 * Execute the hook as a subprocess and return parsed output.
 *
 * @param {object} hookInput - The JSON input to pass via stdin
 * @param {object} [opts.env] - Additional env vars (merged with process.env)
 * @param {string} [opts.cwd] - Working directory for the hook process
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, parsed: object|null}>}
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    // Build env with overrides
    spawnOpts.env = { ...process.env, ...opts.env };
    // Remove any inherited env vars that would affect the gate logic
    delete spawnOpts.env.CLAUDE_SPAWNED_SESSION;
    delete spawnOpts.env.CLAUDE_PROJECT_DIR;
    if (opts.env) {
      Object.assign(spawnOpts.env, opts.env);
    }

    if (opts.cwd) {
      spawnOpts.cwd = opts.cwd;
    }

    const child = spawn('node', [HOOK_PATH], spawnOpts);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch (_) { /* parse failure is a test concern */}
      resolve({ exitCode, stdout, stderr, parsed });
    });

    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('session-completion-gate.js (PostToolUse hook)', () => {

  // --------------------------------------------------------------------------
  // Non-spawned session — always allow
  // --------------------------------------------------------------------------
  describe('non-spawned session', () => {
    it('allows summarize_work without checking sub-agents', async () => {
      const result = await runHook(
        { tool_name: 'mcp__todo-db__summarize_work' },
        { env: { CLAUDE_SPAWNED_SESSION: 'false' } },
      );
      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed, `Expected JSON output, got: ${result.stdout}`);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });

    it('allows complete_task when not a spawned session', async () => {
      const result = await runHook(
        { tool_name: 'mcp__todo-db__complete_task' },
        // CLAUDE_SPAWNED_SESSION not set (deleted from env by runHook)
      );
      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Spawned session NOT in worktree — always allow
  // --------------------------------------------------------------------------
  describe('spawned session not in worktree', () => {
    it('allows when CLAUDE_PROJECT_DIR is not a worktree path', async () => {
      const projectRoot = createTempDir('scg-plain-project-');
      const result = await runHook(
        { tool_name: 'mcp__todo-db__summarize_work' },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: projectRoot,
          },
          cwd: projectRoot,
        },
      );
      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Spawned session in worktree, both agents found — gate satisfied
  // --------------------------------------------------------------------------
  describe('spawned session in worktree — both agents found', () => {
    it('allows summarize_work when both agents appear in transcript', async () => {
      const { worktreePath } = createWorktreePath('feature-both-agents');

      // Create a fake session dir and JSONL with both agents
      const sessionsDir = createTempDir('scg-sessions-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        agentToolUseLine('user-alignment'),
        agentToolUseLine('project-manager'),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__summarize_work',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });

    it('allows complete_task when both agents appear in transcript', async () => {
      const { worktreePath } = createWorktreePath('feature-both-ct');

      const sessionsDir = createTempDir('scg-sessions-ct-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        agentToolUseLine('user-alignment'),
        agentToolUseLine('project-manager'),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__complete_task',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Spawned session in worktree — alignment agent missing
  // --------------------------------------------------------------------------
  describe('spawned session in worktree — alignment agent missing', () => {
    it('injects completion checklist when user-alignment was not spawned', async () => {
      const { worktreePath } = createWorktreePath('feature-no-alignment');

      const sessionsDir = createTempDir('scg-sessions-na-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        // Only project-manager — no user-alignment
        agentToolUseLine('project-manager'),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__summarize_work',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.ok(
        result.parsed.hookSpecificOutput,
        'Should have hookSpecificOutput when gate fails',
      );
      assert.ok(
        result.parsed.hookSpecificOutput.additionalContext.includes('MANDATORY REQUIREMENTS'),
        'Should include MANDATORY REQUIREMENTS in the checklist',
      );
      assert.ok(
        result.parsed.hookSpecificOutput.additionalContext.includes('user-alignment'),
        'Should name the missing user-alignment agent',
      );
    });
  });

  // --------------------------------------------------------------------------
  // Spawned session in worktree — project-manager missing
  // --------------------------------------------------------------------------
  describe('spawned session in worktree — project-manager missing', () => {
    it('injects completion checklist when project-manager was not spawned', async () => {
      const { worktreePath } = createWorktreePath('feature-no-pm');

      const sessionsDir = createTempDir('scg-sessions-npm-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        // Only user-alignment — no project-manager
        agentToolUseLine('user-alignment'),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__complete_task',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.ok(
        result.parsed.hookSpecificOutput,
        'Should have hookSpecificOutput when gate fails',
      );
      assert.ok(
        result.parsed.hookSpecificOutput.additionalContext.includes('MANDATORY REQUIREMENTS'),
        'Should include MANDATORY REQUIREMENTS in the checklist',
      );
      assert.ok(
        result.parsed.hookSpecificOutput.additionalContext.includes('project-manager'),
        'Should name the missing project-manager agent',
      );
    });
  });

  // --------------------------------------------------------------------------
  // Non-matching tool name — allow immediately
  // --------------------------------------------------------------------------
  describe('non-matching tool name', () => {
    it('allows Bash tool calls without any gate check', async () => {
      const { worktreePath } = createWorktreePath('feature-bash-tool');

      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'git status' } },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });

    it('allows Write tool calls without any gate check', async () => {
      const { worktreePath } = createWorktreePath('feature-write-tool');

      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt', content: 'x' } },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });

    it('allows mcp__todo-db__create_task without any gate check', async () => {
      const { worktreePath } = createWorktreePath('feature-create-task');

      const result = await runHook(
        { tool_name: 'mcp__todo-db__create_task', tool_input: { title: 'test' } },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Injected text contains expected markers
  // --------------------------------------------------------------------------
  describe('completion checklist content', () => {
    it('injected text contains "MANDATORY REQUIREMENTS"', async () => {
      const { worktreePath } = createWorktreePath('feature-checklist-content');

      // No transcript — no sub-agents in evidence
      const sessionsDir = createTempDir('scg-sessions-cc-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        // No agents spawned
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__summarize_work',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.ok(result.parsed?.hookSpecificOutput?.additionalContext);
      assert.ok(
        result.parsed.hookSpecificOutput.additionalContext.includes('MANDATORY REQUIREMENTS'),
        `Expected "MANDATORY REQUIREMENTS" in checklist. Got: ${result.parsed.hookSpecificOutput.additionalContext.slice(0, 200)}`,
      );
    });

    it('injected text describes the required sub-agent sequence', async () => {
      const { worktreePath } = createWorktreePath('feature-checklist-sequence');

      const sessionsDir = createTempDir('scg-sessions-seq-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__complete_task',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      const ctx = result.parsed?.hookSpecificOutput?.additionalContext || '';
      assert.ok(ctx.includes('REQUIRED SUB-AGENT SEQUENCE'), 'Should describe sub-agent sequence');
      assert.ok(ctx.includes('user-alignment'), 'Should mention user-alignment');
      assert.ok(ctx.includes('project-manager'), 'Should mention project-manager');
    });

    it('hookEventName is "PostToolUse"', async () => {
      const { worktreePath } = createWorktreePath('feature-event-name');

      const sessionsDir = createTempDir('scg-sessions-en-');
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__summarize_work',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(
        result.parsed?.hookSpecificOutput?.hookEventName,
        'PostToolUse',
        'hookEventName must be "PostToolUse"',
      );
    });
  });

  // --------------------------------------------------------------------------
  // Invalid JSON input — fail open
  // --------------------------------------------------------------------------
  describe('invalid input handling', () => {
    it('allows on invalid JSON stdin', async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (exitCode) => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch (_) { /* parse failure */}
          resolve({ exitCode, parsed });
        });
        child.stdin.write('this is not json {{');
        child.stdin.end();
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
    });

    it('allows on empty stdin', async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (exitCode) => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch (_) { /* parse failure */}
          resolve({ exitCode, parsed });
        });
        child.stdin.end();
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
    });
  });

  // --------------------------------------------------------------------------
  // AGENT session marker format detection
  // --------------------------------------------------------------------------
  describe('[AGENT:...] marker detection', () => {
    it('detects user-alignment via [AGENT:user-alignment] marker', async () => {
      const { worktreePath } = createWorktreePath('feature-agent-markers');

      const sessionsDir = createTempDir('scg-sessions-am-');
      // Simulate a transcript where both agents were started (via session markers)
      const sessionFile = writeSessionJsonl(sessionsDir, [
        JSON.stringify({ type: 'human', message: { content: '[Task] do work' } }),
        JSON.stringify({ type: 'human', message: { content: '[AGENT:user-alignment-abc123] Starting agent' } }),
        JSON.stringify({ type: 'human', message: { content: '[AGENT:project-manager-def456] Starting agent' } }),
      ]);

      const result = await runHook(
        {
          tool_name: 'mcp__todo-db__summarize_work',
          transcript_path: sessionFile,
        },
        {
          env: {
            CLAUDE_SPAWNED_SESSION: 'true',
            CLAUDE_PROJECT_DIR: worktreePath,
          },
          cwd: worktreePath,
        },
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.parsed);
      assert.equal(result.parsed.continue, true);
      assert.equal(result.parsed.hookSpecificOutput, undefined,
        'Gate should be satisfied when [AGENT:...] markers are present');
    });
  });
});
