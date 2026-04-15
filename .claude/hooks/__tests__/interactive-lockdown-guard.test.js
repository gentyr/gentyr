/**
 * Unit tests for interactive-lockdown-guard.js (PreToolUse hook)
 *
 * Tests that the hook correctly enforces the deputy-CTO console model:
 * - Spawned sessions bypass the lockdown entirely
 * - Interactive sessions: read/observe tools allowed
 * - Interactive sessions: all mcp__* tools allowed
 * - Interactive sessions: file-editing tools blocked
 * - Interactive sessions: sub-agent tools blocked
 * - Lockdown disabled via config: all tools allowed + warning injected
 * - Deny response includes actionable GENTYR guidance
 *
 * Run with: node --test .claude/hooks/__tests__/interactive-lockdown-guard.test.js
 *
 * @version 1.0.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.join(__dirname, '..', 'interactive-lockdown-guard.js');

// ============================================================================
// Test Utilities
// ============================================================================

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

    // Set CLAUDE_PROJECT_DIR to the test project dir (or opts override)
    if (!('CLAUDE_PROJECT_DIR' in (opts.env || {}))) {
      env.CLAUDE_PROJECT_DIR = opts.projectDir || '/tmp';
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
    return null;
  }
}

// ============================================================================
// Temp directory for lockdown-disabled config tests
// ============================================================================

let tmpDir;
let tmpConfigDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-guard-test-'));
  tmpConfigDir = path.join(tmpDir, '.claude', 'state');
  fs.mkdirSync(tmpConfigDir, { recursive: true });
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Tests
// ============================================================================

describe('interactive-lockdown-guard.js', () => {

  describe('spawned sessions → bypass (allow all tools)', () => {
    const env = { CLAUDE_SPAWNED_SESSION: 'true' };

    it('allows Edit in spawned session', async () => {
      const result = await runHook({ tool_name: 'Edit', tool_input: {} }, { env });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'Edit should be allowed in spawned sessions');
    });

    it('allows Write in spawned session', async () => {
      const result = await runHook({ tool_name: 'Write', tool_input: {} }, { env });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Agent in spawned session', async () => {
      const result = await runHook({ tool_name: 'Agent', tool_input: {} }, { env });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Task in spawned session', async () => {
      const result = await runHook({ tool_name: 'Task', tool_input: {} }, { env });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows NotebookEdit in spawned session', async () => {
      const result = await runHook({ tool_name: 'NotebookEdit', tool_input: {} }, { env });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });
  });

  describe('interactive sessions → allowed read/observe tools', () => {
    it('allows StructuredOutput', async () => {
      // Fix 2: StructuredOutput added to ALLOWED_TOOLS so structured output
      // calls are never blocked in interactive sessions — the AI model relies on
      // this internally and blocking it breaks the session.
      const result = await runHook({ tool_name: 'StructuredOutput', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'StructuredOutput must be allowed in interactive sessions');
    });

    it('StructuredOutput passes through even when lockdown is fully enforced (no config override)', async () => {
      // Verify that ALLOWED_TOOLS membership is sufficient — no config file needed,
      // no spawned-session env var needed.
      const result = await runHook(
        { tool_name: 'StructuredOutput', tool_input: { content: [{ type: 'text', text: 'ok' }] } },
        { env: { CLAUDE_PROJECT_DIR: '/tmp' } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
      assert.ok(!output?.hookSpecificOutput?.permissionDecision, 'Should not produce a deny decision');
    });

    it('allows Read', async () => {
      const result = await runHook({ tool_name: 'Read', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Glob', async () => {
      const result = await runHook({ tool_name: 'Glob', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Grep', async () => {
      const result = await runHook({ tool_name: 'Grep', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Bash', async () => {
      const result = await runHook({ tool_name: 'Bash', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows WebFetch', async () => {
      const result = await runHook({ tool_name: 'WebFetch', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows WebSearch', async () => {
      const result = await runHook({ tool_name: 'WebSearch', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows AskUserQuestion', async () => {
      const result = await runHook({ tool_name: 'AskUserQuestion', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Skill', async () => {
      const result = await runHook({ tool_name: 'Skill', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows ToolSearch', async () => {
      const result = await runHook({ tool_name: 'ToolSearch', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });
  });

  describe('interactive sessions → allowed mcp__* tools', () => {
    it('allows mcp__todo-db__create_task', async () => {
      const result = await runHook({ tool_name: 'mcp__todo-db__create_task', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__agent-tracker__force_spawn_tasks', async () => {
      const result = await runHook({ tool_name: 'mcp__agent-tracker__force_spawn_tasks', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__agent-tracker__monitor_agents', async () => {
      const result = await runHook({ tool_name: 'mcp__agent-tracker__monitor_agents', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__specs-browser__get_spec', async () => {
      const result = await runHook({ tool_name: 'mcp__specs-browser__get_spec', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__show__show_plans (arbitrary mcp__ prefix)', async () => {
      const result = await runHook({ tool_name: 'mcp__show__show_plans', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });
  });

  describe('interactive sessions → blocked file-editing tools', () => {
    it('blocks Edit', async () => {
      const result = await runHook({ tool_name: 'Edit', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(output?.hookSpecificOutput, 'Expected hookSpecificOutput');
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('blocks Write', async () => {
      const result = await runHook({ tool_name: 'Write', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });

    it('blocks NotebookEdit', async () => {
      const result = await runHook({ tool_name: 'NotebookEdit', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });
  });

  describe('interactive sessions → blocked sub-agent tools', () => {
    it('blocks Agent', async () => {
      const result = await runHook({ tool_name: 'Agent', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });

    it('blocks Task', async () => {
      const result = await runHook({ tool_name: 'Task', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });
  });

  describe('deny response includes actionable GENTYR guidance', () => {
    it('includes mcp__todo-db__create_task in deny reason', async () => {
      const result = await runHook({ tool_name: 'Edit', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('mcp__todo-db__create_task'),
        'Expected create_task in deny reason'
      );
    });

    it('includes mcp__agent-tracker__force_spawn_tasks in deny reason', async () => {
      const result = await runHook({ tool_name: 'Write', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('mcp__agent-tracker__force_spawn_tasks'),
        'Expected force_spawn_tasks in deny reason'
      );
    });

    it('includes /spawn-tasks in deny reason', async () => {
      const result = await runHook({ tool_name: 'Agent', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('/spawn-tasks'),
        'Expected /spawn-tasks in deny reason'
      );
    });

    it('includes the blocked tool name in deny reason', async () => {
      const result = await runHook({ tool_name: 'Edit', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('Edit'),
        'Expected tool name in deny reason'
      );
    });

    it('includes /lockdown off hint in deny reason', async () => {
      const result = await runHook({ tool_name: 'Edit', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('/lockdown off'),
        'Expected /lockdown off hint in deny reason'
      );
    });
  });

  describe('lockdown disabled via config → all tools allowed + warning', () => {
    before(() => {
      fs.writeFileSync(
        path.join(tmpConfigDir, 'automation-config.json'),
        JSON.stringify({ interactiveLockdownDisabled: true })
      );
    });

    after(() => {
      // Remove config so other tests are unaffected
      const configPath = path.join(tmpConfigDir, 'automation-config.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    });

    it('allows Edit when lockdown is disabled', async () => {
      const result = await runHook(
        { tool_name: 'Edit', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Write when lockdown is disabled', async () => {
      const result = await runHook(
        { tool_name: 'Write', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows Agent when lockdown is disabled', async () => {
      const result = await runHook(
        { tool_name: 'Agent', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('injects LOCKDOWN DISABLED warning into additionalContext', async () => {
      const result = await runHook(
        { tool_name: 'Edit', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.ok(
        output?.hookSpecificOutput?.additionalContext?.includes('[LOCKDOWN DISABLED]'),
        'Expected LOCKDOWN DISABLED warning in additionalContext'
      );
    });

    it('warning mentions /lockdown on for re-enabling', async () => {
      const result = await runHook(
        { tool_name: 'Edit', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.ok(
        output?.hookSpecificOutput?.additionalContext?.includes('/lockdown on'),
        'Expected /lockdown on in warning message'
      );
    });

    it('hookEventName is PreToolUse in disabled-lockdown response', async () => {
      const result = await runHook(
        { tool_name: 'Edit', tool_input: {} },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.hookEventName, 'PreToolUse');
    });
  });

  describe('G001 fail-closed on errors', () => {
    it('denies on malformed JSON input', async () => {
      const result = await runHook('not valid json {{{}');
      const output = parseOutput(result.stdout);
      assert.ok(output?.hookSpecificOutput, 'Expected hookSpecificOutput on malformed input');
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('G001 FAIL-CLOSED'),
        'Expected G001 FAIL-CLOSED in deny reason'
      );
    });

    it('exits with code 0 even on malformed input', async () => {
      const result = await runHook('not valid json');
      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe('edge cases', () => {
    it('blocks empty tool_name (treats as unknown tool)', async () => {
      const result = await runHook({ tool_name: '', tool_input: {} });
      const output = parseOutput(result.stdout);
      // Empty string is not in ALLOWED_TOOLS and does not start with mcp__
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });

    it('blocks missing tool_name field', async () => {
      const result = await runHook({ tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });

    it('case-sensitive: does not allow "read" (lowercase)', async () => {
      const result = await runHook({ tool_name: 'read', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });

    it('does not allow tool named "mcp" (must be prefixed mcp__)', async () => {
      const result = await runHook({ tool_name: 'mcp', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    });
  });
});
