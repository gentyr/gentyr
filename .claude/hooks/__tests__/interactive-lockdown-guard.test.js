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

  describe('lockdown disabled → Task sub-agent fast-exit (no LOCKDOWN OFF guidance)', () => {
    const CTO_SESSION_ID = '11111111-1111-1111-1111-111111111111';
    const SUBAGENT_SESSION_ID = '22222222-2222-2222-2222-222222222222';
    const ctoWorktreePath = '/tmp/lockdown-guard-test-cto-wt';

    before(() => {
      // Lockdown disabled + per-session CTO worktree registry populated.
      fs.writeFileSync(
        path.join(tmpConfigDir, 'automation-config.json'),
        JSON.stringify({
          interactiveLockdownDisabled: true,
          ctoWorktreePaths: { [CTO_SESSION_ID]: ctoWorktreePath },
        })
      );
    });

    after(() => {
      const configPath = path.join(tmpConfigDir, 'automation-config.json');
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    });

    it('CTO root session (session_id in registry) still receives LOCKDOWN OFF guidance', async () => {
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: CTO_SESSION_ID },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
      assert.ok(
        output?.hookSpecificOutput?.additionalContext?.includes('[LOCKDOWN OFF]'),
        'CTO root session must still see LOCKDOWN OFF guidance'
      );
    });

    it('CTO root pipelineReminder calls out the ONE-pipeline-at-a-time rule', async () => {
      // Regression: lockdown-off guidance must explicitly forbid parallel
      // Task fan-out (Scenario B) and point at multi-terminal as the
      // supported parallel pattern (Scenario A / PR #709). Without this,
      // the CTO fans out parallel Tasks A/B/C and project-managers trample
      // each other at step 6.
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: CTO_SESSION_ID },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      const ctx = output?.hookSpecificOutput?.additionalContext || '';
      assert.ok(
        ctx.includes('ONE pipeline at a time'),
        'pipelineReminder must include "ONE pipeline at a time" wording'
      );
      assert.ok(
        ctx.includes('another `claude` terminal') || ctx.includes('another claude terminal'),
        'pipelineReminder must direct parallel work to a separate claude terminal (PR #709)'
      );
      assert.ok(
        /fan(?:ning)?[\s-]?out|parallel work|parallel Tasks?/i.test(ctx),
        'pipelineReminder must name the fan-out anti-pattern explicitly'
      );
    });

    it('CTO root pipelineReminder mentions the project-manager worktree-lock-busy refusal', async () => {
      // Regression: the guidance should tell the model that step 6 will
      // refuse (with a lock-busy error), so it knows the defensive lock
      // exists and doesn't try to retry around it.
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: CTO_SESSION_ID },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      const ctx = output?.hookSpecificOutput?.additionalContext || '';
      assert.ok(
        /lock-busy|worktree-lock|lock/i.test(ctx),
        'pipelineReminder must mention the project-manager worktree lock so the model knows step 6 will refuse on collision'
      );
    });

    it('Task sub-agent (session_id NOT in registry) approves WITHOUT LOCKDOWN OFF guidance', async () => {
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: SUBAGENT_SESSION_ID },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
      assert.strictEqual(
        output?.hookSpecificOutput,
        undefined,
        'Sub-agent must NOT receive any additionalContext (would mislead it into delegating)'
      );
    });

    it('Task sub-agent Edit to main-tree path is NOT blocked (sub-agent has its own worktree)', async () => {
      // Without the fix, this would hit the lockdown-off main-tree edit block
      // with a "BLOCKED: Main-tree edits are not allowed" message — even
      // though the sub-agent is running in its own isolation worktree.
      const result = await runHook(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/some/main/tree/file.ts' },
          session_id: SUBAGENT_SESSION_ID,
        },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
      assert.notStrictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Sub-agent Edit must not be denied by the lockdown-off main-tree guard'
      );
    });

    it('Task sub-agent code-modifying Task() call approves WITHOUT lockdown-off rerouting message', async () => {
      // Without the fix, the sub-agent hitting Task(subagent_type='code-writer')
      // would get reroutered into the GENTYR queue via the "Only read-only
      // sub-agents are allowed" deny message at line ~526.
      const result = await runHook(
        {
          tool_name: 'Task',
          tool_input: { subagent_type: 'code-writer' },
          session_id: SUBAGENT_SESSION_ID,
        },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('session_id missing from event → falls through to lockdown-off treatment (back-compat)', async () => {
      // Some hook invocations (older Claude Code versions, edge cases) may
      // not include session_id. In that case the sub-agent detection cannot
      // fire and the existing lockdown-off behavior must hold.
      const result = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        { env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
      assert.ok(
        output?.hookSpecificOutput?.additionalContext?.includes('[LOCKDOWN OFF]'),
        'Missing session_id must fall through to lockdown-off behavior, not silently approve'
      );
    });

    it('ctoWorktreePaths empty → sub-agent detection inactive (back-compat with legacy singular path)', async () => {
      // Write a config with the legacy singular ctoWorktreePath but no
      // per-session registry. Sub-agent detection must NOT fire (it would
      // misclassify the legacy CTO root as a sub-agent).
      const legacyConfigPath = path.join(tmpConfigDir, 'automation-config.json');
      const originalConfig = fs.readFileSync(legacyConfigPath, 'utf8');
      fs.writeFileSync(
        legacyConfigPath,
        JSON.stringify({
          interactiveLockdownDisabled: true,
          ctoWorktreePath: ctoWorktreePath,
        })
      );
      try {
        const result = await runHook(
          { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: SUBAGENT_SESSION_ID },
          { env: { CLAUDE_PROJECT_DIR: tmpDir } }
        );
        const output = parseOutput(result.stdout);
        assert.strictEqual(output?.decision, 'approve');
        assert.ok(
          output?.hookSpecificOutput?.additionalContext?.includes('[LOCKDOWN OFF]'),
          'Empty registry must preserve legacy lockdown-off behavior'
        );
      } finally {
        // Restore the per-session-registry config for subsequent tests in this describe.
        fs.writeFileSync(legacyConfigPath, originalConfig);
      }
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

  describe('interactive sessions → ALLOWED_MCP_INDIVIDUAL tools (individually whitelisted from blocked servers)', () => {
    it('allows mcp__secret-sync__get_services_config', async () => {
      const result = await runHook({ tool_name: 'mcp__secret-sync__get_services_config', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__secret-sync__update_services_config', async () => {
      const result = await runHook({ tool_name: 'mcp__secret-sync__update_services_config', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__check_auth', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__check_auth', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__list_items', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__list_items', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__op_vault_map', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__op_vault_map', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__create_item', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__create_item', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__add_item_fields', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__add_item_fields', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('allows mcp__onepassword__read_secret (default include_value:false only confirms existence)', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__read_secret', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve');
    });

    it('blocks arbitrary mcp__onepassword__ tools not in the individual allowlist', async () => {
      const result = await runHook({ tool_name: 'mcp__onepassword__get_item', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Unlisted mcp__onepassword__ tools must be blocked — prefix is not in ALLOWED_MCP_PREFIXES'
      );
    });

    it('blocks arbitrary mcp__secret-sync__ tools not in the individual allowlist', async () => {
      const result = await runHook({ tool_name: 'mcp__secret-sync__push_secrets', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Unlisted mcp__secret-sync__ tools must be blocked — only specific config tools are whitelisted'
      );
    });
  });

  describe('plan mode tools → allowed in interactive lockdown', () => {
    it('allows EnterPlanMode', async () => {
      const result = await runHook({ tool_name: 'EnterPlanMode', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'EnterPlanMode must be allowed in interactive sessions');
    });

    it('allows ExitPlanMode', async () => {
      const result = await runHook({ tool_name: 'ExitPlanMode', tool_input: {} });
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'ExitPlanMode must be allowed in interactive sessions');
    });
  });

  describe('plan file whitelist → Write/Edit to .claude/plans/ allowed in lockdown', () => {
    let plansTmpDir;
    let plansDir;

    before(() => {
      plansTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-plans-test-'));
      plansDir = path.join(plansTmpDir, '.claude', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
    });

    after(() => {
      if (plansTmpDir && fs.existsSync(plansTmpDir)) {
        fs.rmSync(plansTmpDir, { recursive: true, force: true });
      }
    });

    it('allows Write to .claude/plans/foo.md', async () => {
      const filePath = path.join(plansDir, 'foo.md');
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: filePath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'Write to .claude/plans/foo.md must be approved');
    });

    it('allows Edit to .claude/plans/bar.md', async () => {
      const filePath = path.join(plansDir, 'bar.md');
      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: filePath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'Edit to .claude/plans/bar.md must be approved');
    });

    it('allows Write to nested .claude/plans/subdir/plan.md', async () => {
      const subdirPath = path.join(plansDir, 'subdir');
      fs.mkdirSync(subdirPath, { recursive: true });
      const filePath = path.join(subdirPath, 'plan.md');
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: filePath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(output?.decision, 'approve', 'Write to nested plans path must be approved');
    });

    it('blocks Write to .claude/plans/../../etc/passwd (path traversal)', async () => {
      // Path traversal attack: resolves outside .claude/plans/
      const maliciousPath = path.join(plansDir, '..', '..', 'etc', 'passwd');
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: maliciousPath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Path traversal attack must be denied — resolved path escapes .claude/plans/'
      );
    });

    it('blocks Write to src/foo.ts (not in .claude/plans/)', async () => {
      const filePath = path.join(plansTmpDir, 'src', 'foo.ts');
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: filePath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Write to src/foo.ts must still be blocked by lockdown'
      );
    });

    it('blocks Edit to src/foo.ts (not in .claude/plans/)', async () => {
      const filePath = path.join(plansTmpDir, 'src', 'foo.ts');
      const result = await runHook(
        { tool_name: 'Edit', tool_input: { file_path: filePath } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Edit to src/foo.ts must still be blocked by lockdown'
      );
    });

    it('blocks Write when file_path is empty string', async () => {
      const result = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '' } },
        { env: { CLAUDE_PROJECT_DIR: plansTmpDir } }
      );
      const output = parseOutput(result.stdout);
      assert.strictEqual(
        output?.hookSpecificOutput?.permissionDecision,
        'deny',
        'Write with empty file_path must still be blocked'
      );
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
