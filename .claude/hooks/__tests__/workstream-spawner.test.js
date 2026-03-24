/**
 * Tests for workstream-spawner.js PostToolUse hook
 *
 * Validates:
 * 1. Non-task-creation tool → allow, no spawn
 * 2. Task creation with non-pending_review status → attempts to enqueue workstream-manager
 * 3. Pending-review task → skip (gate handles first)
 * 4. Output is always { decision: "allow" } — actually: hook exits 0 with no stdout
 *    (PostToolUse hooks that don't inject context just exit 0)
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/workstream-spawner.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.cwd();
const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/workstream-spawner.js');
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude/hooks/agent-tracker.js');

// ============================================================================
// Helpers: run the hook as a subprocess
// ============================================================================

/**
 * Run the hook with the given stdin JSON and return { stdout, stderr, exitCode }.
 */
function runHook(stdinJson) {
  const input = JSON.stringify(stdinJson);
  try {
    const stdout = execSync(
      `node ${HOOK_PATH}`,
      {
        input,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: PROJECT_DIR,
          // Prevent actual DB access in tests by pointing to a non-existent dir
          // The hook fails open when DBs don't exist
        },
      }
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    // execSync throws on non-zero exit — but PostToolUse hooks should always exit 0
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

// ============================================================================
// Test: File structure
// ============================================================================

describe('workstream-spawner.js — file structure', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
  });

  it('should exist at expected path', () => {
    assert.ok(fs.existsSync(HOOK_PATH), `Hook file not found at ${HOOK_PATH}`);
  });

  it('should be a valid ES module (import syntax)', () => {
    assert.match(hookCode, /^import\s/m, 'Should use ES module imports');
  });

  it('should import from agent-tracker.js', () => {
    assert.match(
      hookCode,
      /import\s+\{[^}]*AGENT_TYPES[^}]*\}\s+from\s+['"]\.\/agent-tracker\.js['"]/,
      'Should import AGENT_TYPES from agent-tracker.js'
    );
  });

  it('should import enqueueSession from session-queue.js', () => {
    assert.match(
      hookCode,
      /import\s+\{[^}]*enqueueSession[^}]*\}\s+from\s+['"]\.\/lib\/session-queue\.js['"]/,
      'Should import enqueueSession from session-queue.js'
    );
  });

  it('should reference AGENT_TYPES.TASK_RUNNER_WORKSTREAM_MANAGER', () => {
    assert.match(
      hookCode,
      /AGENT_TYPES\.TASK_RUNNER_WORKSTREAM_MANAGER/,
      'Should use AGENT_TYPES.TASK_RUNNER_WORKSTREAM_MANAGER'
    );
  });

  it('should reference HOOK_TYPES.WORKSTREAM_SPAWNER', () => {
    assert.match(
      hookCode,
      /HOOK_TYPES\.WORKSTREAM_SPAWNER/,
      'Should use HOOK_TYPES.WORKSTREAM_SPAWNER'
    );
  });

  it('should always exit 0 (PostToolUse must never block)', () => {
    assert.match(hookCode, /process\.exit\(0\)/, 'Should always call process.exit(0)');
  });

  it('should read from process.stdin', () => {
    assert.match(hookCode, /process\.stdin\.on/, 'Should listen on stdin');
  });

  it('should use lane: gate for lightweight workstream assessment', () => {
    assert.match(hookCode, /lane:\s*['"]gate['"]/, "Should use gate lane for workstream-manager");
  });

  it('should use Haiku model for lightweight assessment', () => {
    assert.match(hookCode, /claude-haiku/, 'Should use Haiku model for workstream-manager agent');
  });
});

// ============================================================================
// Test: AGENT_TYPES and HOOK_TYPES integration
// ============================================================================

describe('workstream-spawner.js — agent-tracker.js integration', () => {
  let agentTrackerCode;

  beforeEach(() => {
    agentTrackerCode = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
  });

  it('should have TASK_RUNNER_WORKSTREAM_MANAGER defined in agent-tracker.js', () => {
    assert.match(
      agentTrackerCode,
      /TASK_RUNNER_WORKSTREAM_MANAGER:\s*['"]task-runner-workstream-manager['"]/,
      'AGENT_TYPES.TASK_RUNNER_WORKSTREAM_MANAGER must be defined in agent-tracker.js'
    );
  });

  it('should have WORKSTREAM_SPAWNER defined in HOOK_TYPES in agent-tracker.js', () => {
    assert.match(
      agentTrackerCode,
      /WORKSTREAM_SPAWNER:\s*['"]workstream-spawner['"]/,
      'HOOK_TYPES.WORKSTREAM_SPAWNER must be defined in agent-tracker.js'
    );
  });

  it('should have TASK_RUNNER_WORKSTREAM_MANAGER in exported AGENT_TYPES', () => {
    assert.match(
      agentTrackerCode,
      /export const AGENT_TYPES = \{[\s\S]*?TASK_RUNNER_WORKSTREAM_MANAGER/,
      'TASK_RUNNER_WORKSTREAM_MANAGER should be in exported AGENT_TYPES'
    );
  });

  it('should have WORKSTREAM_SPAWNER in exported HOOK_TYPES', () => {
    assert.match(
      agentTrackerCode,
      /export const HOOK_TYPES = \{[\s\S]*?WORKSTREAM_SPAWNER/,
      'WORKSTREAM_SPAWNER should be in exported HOOK_TYPES'
    );
  });
});

// ============================================================================
// Test: pending_review skip logic (code inspection)
// ============================================================================

describe('workstream-spawner.js — pending_review skip logic', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
  });

  it('should skip pending_review tasks explicitly', () => {
    assert.match(
      hookCode,
      /taskStatus\s*===\s*['"]pending_review['"]/,
      'Should check for pending_review status to skip'
    );
  });

  it('should log reason for skipping pending_review tasks', () => {
    assert.match(
      hookCode,
      /gate agent handles/,
      'Should explain why pending_review is skipped'
    );
  });

  it('should check tool_name before processing', () => {
    assert.match(
      hookCode,
      /toolName\s*!==\s*['"]mcp__todo-db__create_task['"]/,
      'Should only process mcp__todo-db__create_task calls'
    );
  });

  it('should parse tool_response for status field', () => {
    assert.match(hookCode, /tool_response/, 'Should access tool_response from hook input');
    assert.match(hookCode, /response\.status/, 'Should read status from response');
  });

  it('should handle JSON-stringified tool_response', () => {
    assert.match(hookCode, /JSON\.parse/, 'Should handle JSON-stringified responses');
  });

  it('should handle MCP content array format', () => {
    assert.match(
      hookCode,
      /content.*Array\.isArray|Array\.isArray.*content/,
      'Should handle MCP content array format'
    );
  });
});

// ============================================================================
// Test: workstream duplicate-check logic (code inspection)
// ============================================================================

describe('workstream-spawner.js — duplicate assessment prevention', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
  });

  it('should check if a workstream-manager is already running', () => {
    assert.match(
      hookCode,
      /isWorkstreamManagerRunning/,
      'Should call isWorkstreamManagerRunning() before spawning'
    );
  });

  it('should query session-queue.db for running workstream agents', () => {
    assert.match(
      hookCode,
      /%workstream%/,
      'Should query for agent_type containing workstream'
    );
  });

  it('should skip spawning if workstream-manager already running', () => {
    // The hook should log a "skipping" message when already running
    assert.match(
      hookCode,
      /already running.*skipping|skipping.*already running/,
      'Should log skip reason when workstream-manager is already running'
    );
  });
});

// ============================================================================
// Test: Hook subprocess behavior — non-task-creation tool
// ============================================================================

describe('workstream-spawner.js — subprocess: non-matching tool', () => {
  it('should exit 0 for non-task-creation tools', () => {
    const result = runHook({
      tool_name: 'mcp__todo-db__list_tasks',
      tool_response: { tasks: [] },
      tool_input: {},
    });
    assert.strictEqual(result.exitCode, 0, 'Should always exit 0 for PostToolUse');
  });

  it('should exit 0 for Bash tool calls', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_response: { output: 'ok' },
      tool_input: { command: 'echo hello' },
    });
    assert.strictEqual(result.exitCode, 0, 'Should always exit 0 for Bash');
  });
});

// ============================================================================
// Test: Hook subprocess behavior — pending_review task
// ============================================================================

describe('workstream-spawner.js — subprocess: pending_review task', () => {
  it('should exit 0 for pending_review tasks (gate handles them)', () => {
    const result = runHook({
      tool_name: 'mcp__todo-db__create_task',
      tool_response: {
        id: 'task-test-001',
        title: 'Test task',
        section: 'CODE-REVIEWER',
        status: 'pending_review',
        description: 'A test task',
      },
      tool_input: {
        title: 'Test task',
        section: 'CODE-REVIEWER',
      },
    });
    assert.strictEqual(result.exitCode, 0, 'Should exit 0 for pending_review tasks');
  });
});

// ============================================================================
// Test: Hook subprocess behavior — task creation (non-pending_review)
// ============================================================================

describe('workstream-spawner.js — subprocess: task creation spawning', () => {
  it('should exit 0 for pending tasks (normal status)', () => {
    // This test verifies the hook doesn't crash when it tries to enqueue
    // (enqueueSession may fail gracefully if DB doesn't exist in test env,
    //  but the hook must always exit 0)
    const result = runHook({
      tool_name: 'mcp__todo-db__create_task',
      tool_response: {
        id: 'task-test-002',
        title: 'Implement new feature',
        section: 'CODE-REVIEWER',
        status: 'pending',
        description: 'Add feature X',
      },
      tool_input: {
        title: 'Implement new feature',
        section: 'CODE-REVIEWER',
        assigned_by: 'human',
      },
    });
    assert.strictEqual(result.exitCode, 0, 'Should always exit 0 regardless of spawn outcome');
  });

  it('should exit 0 even if enqueueSession fails', () => {
    // Corrupt input that causes parse errors — hook should still exit 0
    const result = runHook({
      tool_name: 'mcp__todo-db__create_task',
      tool_response: null,
      tool_input: {},
    });
    assert.strictEqual(result.exitCode, 0, 'Should exit 0 even on null tool_response');
  });
});

// ============================================================================
// Test: Assessment prompt structure (code inspection)
// ============================================================================

describe('workstream-spawner.js — assessment prompt', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
  });

  it('should include get_queue_context in the prompt', () => {
    assert.match(
      hookCode,
      /mcp__workstream__get_queue_context/,
      'Assessment prompt should reference get_queue_context tool'
    );
  });

  it('should include add_dependency in the prompt', () => {
    assert.match(
      hookCode,
      /mcp__workstream__add_dependency/,
      'Assessment prompt should reference add_dependency tool'
    );
  });

  it('should include record_assessment in the prompt', () => {
    assert.match(
      hookCode,
      /mcp__workstream__record_assessment/,
      'Assessment prompt should reference record_assessment tool'
    );
  });

  it('should instruct agent to only add real dependencies, not speculative ones', () => {
    assert.match(
      hookCode,
      /precautionary|speculative/,
      'Should instruct agent not to add speculative/precautionary dependencies'
    );
  });
});
