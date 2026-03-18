/**
 * Unit tests for interactive-agent-guard.js (PreToolUse hook)
 *
 * Tests that the hook blocks code-modifying Agent calls in interactive sessions
 * while allowing read-only types and all calls from spawned sessions.
 *
 * Run with: node --test .claude/hooks/__tests__/interactive-agent-guard.test.js
 *
 * @version 1.0.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.join(__dirname, '..', 'interactive-agent-guard.js');

/**
 * Execute the hook by spawning a subprocess and sending JSON on stdin.
 * Returns { exitCode, stdout, stderr }.
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...opts.env };
    // Ensure CLAUDE_SPAWNED_SESSION is unset unless explicitly provided
    if (!('CLAUDE_SPAWNED_SESSION' in (opts.env || {}))) {
      delete env.CLAUDE_SPAWNED_SESSION;
    }

    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    const input = typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput);
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Parse JSON output from hook.
 */
function parseOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (err) {
    console.error('[interactive-agent-guard.test] Warning:', err.message);
    return null;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('interactive-agent-guard.js', () => {
  describe('spawned session → always allows', () => {
    it('allows code-writer in spawned session', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-writer' },
      }, { env: { CLAUDE_SPAWNED_SESSION: 'true' } });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows project-manager in spawned session', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'project-manager' },
      }, { env: { CLAUDE_SPAWNED_SESSION: 'true' } });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows general-purpose in spawned session', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose' },
      }, { env: { CLAUDE_SPAWNED_SESSION: 'true' } });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });
  });

  describe('interactive + allowed read-only types → allows', () => {
    it('allows Explore', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows Plan', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Plan' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows claude-code-guide', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'claude-code-guide' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows statusline-setup', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'statusline-setup' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });
  });

  describe('interactive + code-modifying types → denies', () => {
    it('denies code-writer', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-writer' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'code-writer'"));
      assert.ok(output.permissionDecisionReason.includes('/spawn-tasks'));
    });

    it('denies test-writer', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'test-writer' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'test-writer'"));
    });

    it('denies project-manager', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'project-manager' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'project-manager'"));
    });

    it('denies general-purpose (explicit)', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'general-purpose'"));
    });

    it('denies code-reviewer', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-reviewer' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'code-reviewer'"));
    });
  });

  describe('interactive + no subagent_type → denies (defaults to general-purpose)', () => {
    it('denies when subagent_type is omitted', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { prompt: 'do something' },
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'general-purpose'"));
    });

    it('denies when tool_input is empty', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: {},
      });

      const output = parseOutput(result.stdout);
      assert.strictEqual(output.permissionDecision, 'deny');
      assert.ok(output.permissionDecisionReason.includes("'general-purpose'"));
    });
  });

  describe('non-Agent tools → allows', () => {
    it('allows Bash tool', async () => {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows Read tool', async () => {
      const result = await runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test' },
      });

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });
  });

  describe('deny message includes GENTYR instructions', () => {
    it('mentions /spawn-tasks', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-writer' },
      });

      const output = parseOutput(result.stdout);
      assert.ok(output.permissionDecisionReason.includes('/spawn-tasks'));
    });

    it('mentions create_task + force_spawn_tasks', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-writer' },
      });

      const output = parseOutput(result.stdout);
      assert.ok(output.permissionDecisionReason.includes('create_task'));
      assert.ok(output.permissionDecisionReason.includes('force_spawn_tasks'));
    });

    it('lists allowed types', async () => {
      const result = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'code-writer' },
      });

      const output = parseOutput(result.stdout);
      assert.ok(output.permissionDecisionReason.includes('Explore'));
      assert.ok(output.permissionDecisionReason.includes('Plan'));
      assert.ok(output.permissionDecisionReason.includes('claude-code-guide'));
    });
  });

  describe('fail-open on errors', () => {
    it('allows on invalid JSON input', async () => {
      const result = await runHook('not valid json');

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });

    it('allows on empty input', async () => {
      const result = await runHook('');

      const output = parseOutput(result.stdout);
      assert.deepStrictEqual(output, { allow: true });
    });
  });
});
