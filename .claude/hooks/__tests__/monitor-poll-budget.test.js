/**
 * Tests for monitor-poll-budget-hook.js — verifies the soft warning emitted
 * when a spawned monitor session exceeds the per-window peek_session budget.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK = path.join(__dirname, '..', 'monitor-poll-budget-hook.js');

function runHook({ tool, projectDir, persistentTaskId, isSpawned, sessionId }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  if (persistentTaskId !== undefined) env.GENTYR_PERSISTENT_TASK_ID = persistentTaskId;
  else delete env.GENTYR_PERSISTENT_TASK_ID;
  if (isSpawned) env.CLAUDE_SPAWNED_SESSION = 'true';
  else delete env.CLAUDE_SPAWNED_SESSION;

  const input = JSON.stringify({
    tool_name: tool,
    session_id: sessionId || 'sess-test',
  });
  const result = spawnSync('node', [HOOK], { input, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout || '{}');
}

describe('monitor-poll-budget-hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-poll-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('exits cleanly for non-peek_session tools', () => {
    const result = runHook({
      tool: 'Bash',
      projectDir: tmpDir,
      persistentTaskId: 'pt-1',
      isSpawned: true,
    });
    assert.strictEqual(result.continue, true);
    assert.strictEqual(result.hookSpecificOutput, undefined);
  });

  it('exits cleanly for interactive (non-spawned) sessions', () => {
    const result = runHook({
      tool: 'mcp__agent-tracker__peek_session',
      projectDir: tmpDir,
      isSpawned: false,
    });
    assert.strictEqual(result.continue, true);
    assert.strictEqual(result.hookSpecificOutput, undefined);
  });

  it('exits cleanly for spawned sessions without GENTYR_PERSISTENT_TASK_ID (non-monitors)', () => {
    const result = runHook({
      tool: 'mcp__agent-tracker__peek_session',
      projectDir: tmpDir,
      isSpawned: true,
    });
    assert.strictEqual(result.continue, true);
    assert.strictEqual(result.hookSpecificOutput, undefined);
  });

  it('does not warn under the budget (5 calls or fewer per window)', () => {
    for (let i = 0; i < 5; i++) {
      const result = runHook({
        tool: 'mcp__agent-tracker__peek_session',
        projectDir: tmpDir,
        persistentTaskId: 'pt-budget',
        isSpawned: true,
        sessionId: 'sess-monitor',
      });
      assert.strictEqual(result.continue, true);
      assert.strictEqual(result.hookSpecificOutput, undefined, `call #${i + 1} should not warn`);
    }
  });

  it('emits warning on the 6th call within the 5-min window', () => {
    let lastResult = null;
    for (let i = 0; i < 6; i++) {
      lastResult = runHook({
        tool: 'mcp__agent-tracker__peek_session',
        projectDir: tmpDir,
        persistentTaskId: 'pt-overbudget',
        isSpawned: true,
        sessionId: 'sess-monitor-overbudget',
      });
    }
    assert.ok(lastResult.hookSpecificOutput, '6th call should emit warning');
    assert.strictEqual(lastResult.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(lastResult.hookSpecificOutput.additionalContext, /POLLING BUDGET EXCEEDED/);
    assert.match(lastResult.hookSpecificOutput.additionalContext, /summarize_work/);
  });

  it('persists state across invocations (atomic JSON)', () => {
    runHook({
      tool: 'mcp__agent-tracker__peek_session',
      projectDir: tmpDir,
      persistentTaskId: 'pt-persist',
      isSpawned: true,
      sessionId: 'sess-persist',
    });
    const stateFile = path.join(tmpDir, '.claude', 'state', 'monitor-poll-budget.json');
    assert.ok(fs.existsSync(stateFile), 'state file should exist after first call');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(state['sess-persist'], 'session entry should be persisted');
    assert.strictEqual(state['sess-persist'].calls.length, 1);
  });

  it('isolates per-session budgets', () => {
    // 5 calls on session A — within budget.
    for (let i = 0; i < 5; i++) {
      runHook({
        tool: 'mcp__agent-tracker__peek_session',
        projectDir: tmpDir,
        persistentTaskId: 'pt-iso',
        isSpawned: true,
        sessionId: 'sess-A',
      });
    }
    // 1 call on session B — should NOT trigger a warning even though A is at budget.
    const resultB = runHook({
      tool: 'mcp__agent-tracker__peek_session',
      projectDir: tmpDir,
      persistentTaskId: 'pt-iso',
      isSpawned: true,
      sessionId: 'sess-B',
    });
    assert.strictEqual(resultB.continue, true);
    assert.strictEqual(resultB.hookSpecificOutput, undefined, 'session B should be unaffected by session A budget');
  });
});
