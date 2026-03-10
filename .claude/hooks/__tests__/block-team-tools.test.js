/**
 * Unit tests for Block Team Tools Hook
 *
 * Tests that the hook correctly blocks TeamCreate, TeamDelete, and
 * SendMessage via permissionDecision deny, and allows all other tools.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/block-team-tools.test.js
 *
 * @version 1.0.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HOOK_PATH = path.resolve(process.cwd(), '.claude/hooks/block-team-tools.js');

/**
 * Run the hook with given input and return parsed output.
 */
function runHook(input) {
  try {
    const result = execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.trim() ? JSON.parse(result.trim()) : null;
  } catch (err) {
    // Hook exited with code 0 but no stdout
    if (err.status === 0) {
      const stdout = (err.stdout || '').trim();
      return stdout ? JSON.parse(stdout) : null;
    }
    throw err;
  }
}

describe('block-team-tools hook', () => {
  describe('should BLOCK team agent tools', () => {
    const blockedTools = ['TeamCreate', 'TeamDelete', 'SendMessage'];

    for (const toolName of blockedTools) {
      it(`should block ${toolName}`, () => {
        const result = runHook({
          tool_name: toolName,
          tool_input: {},
        });

        assert.notStrictEqual(result, null, `Expected non-null output for ${toolName}`);
        assert.ok(result.hookSpecificOutput, 'Expected hookSpecificOutput');
        assert.strictEqual(result.hookSpecificOutput.hookEventName, 'PreToolUse');
        assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.ok(result.hookSpecificOutput.permissionDecisionReason, 'Expected deny reason');
      });
    }
  });

  describe('deny message includes GENTYR spawning instructions', () => {
    it('should mention mcp__todo-db__create_task', () => {
      const result = runHook({
        tool_name: 'TeamCreate',
        tool_input: {},
      });

      assert.ok(
        result.hookSpecificOutput.permissionDecisionReason.includes('mcp__todo-db__create_task'),
        'Expected create_task in deny reason'
      );
    });

    it('should mention mcp__agent-tracker__force_spawn_tasks', () => {
      const result = runHook({
        tool_name: 'TeamCreate',
        tool_input: {},
      });

      assert.ok(
        result.hookSpecificOutput.permissionDecisionReason.includes('mcp__agent-tracker__force_spawn_tasks'),
        'Expected force_spawn_tasks in deny reason'
      );
    });

    it('should mention /spawn-tasks', () => {
      const result = runHook({
        tool_name: 'TeamCreate',
        tool_input: {},
      });

      assert.ok(
        result.hookSpecificOutput.permissionDecisionReason.includes('/spawn-tasks'),
        'Expected /spawn-tasks in deny reason'
      );
    });
  });

  describe('deny message includes specific tool name', () => {
    for (const toolName of ['TeamCreate', 'TeamDelete', 'SendMessage']) {
      it(`should include ${toolName} in deny reason`, () => {
        const result = runHook({
          tool_name: toolName,
          tool_input: {},
        });

        assert.ok(
          result.hookSpecificOutput.permissionDecisionReason.includes(toolName),
          `Expected "${toolName}" in deny reason`
        );
      });
    }
  });

  describe('should allow non-team tools', () => {
    const allowedTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task'];

    for (const toolName of allowedTools) {
      it(`should allow ${toolName}`, () => {
        const result = runHook({
          tool_name: toolName,
          tool_input: {},
        });

        assert.strictEqual(result, null, `Expected null output (allow) for ${toolName}`);
      });
    }
  });

  describe('G001 fail-closed on errors', () => {
    it('should deny on malformed JSON input', () => {
      try {
        const result = execFileSync('node', [HOOK_PATH], {
          input: 'not valid json',
          encoding: 'utf8',
          timeout: 5000,
        });
        const parsed = result.trim() ? JSON.parse(result.trim()) : null;
        assert.notStrictEqual(parsed, null, 'Expected deny output on malformed input');
        assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /G001 FAIL-CLOSED/);
      } catch (err) {
        if (err.status === 0) {
          const stdout = (err.stdout || '').trim();
          const parsed = stdout ? JSON.parse(stdout) : null;
          assert.notStrictEqual(parsed, null, 'Expected deny output on malformed input');
          assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
          assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /G001 FAIL-CLOSED/);
        } else {
          throw err;
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should handle missing tool_input', () => {
      const result = runHook({
        tool_name: 'TeamCreate',
      });

      assert.notStrictEqual(result, null, 'Should still block even without tool_input');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });
  });
});
