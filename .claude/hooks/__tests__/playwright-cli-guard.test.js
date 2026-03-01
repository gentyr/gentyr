/**
 * Unit tests for Playwright CLI Guard Hook
 *
 * Tests that the hook correctly detects playwright CLI commands,
 * hard-blocks them via permissionDecision deny, and only allows
 * bypass when PLAYWRIGHT_CLI_BYPASS=1 prefixes the specific
 * sub-command containing the playwright invocation.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/playwright-cli-guard.test.js
 *
 * @version 2.1.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HOOK_PATH = path.resolve(process.cwd(), '.claude/hooks/playwright-cli-guard.js');

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

describe('playwright-cli-guard hook', () => {
  describe('should BLOCK playwright CLI commands', () => {
    const blockCases = [
      { cmd: 'npx playwright test', label: 'npx playwright test' },
      { cmd: 'npx playwright test --project vendor-owner', label: 'npx playwright test' },
      { cmd: 'npx playwright show-report', label: 'npx playwright show-report' },
      { cmd: 'pnpm test:e2e', label: 'pnpm test:e2e' },
      { cmd: 'pnpm run test:e2e', label: 'pnpm test:e2e' },
      { cmd: 'pnpm test:pw', label: 'pnpm test:pw' },
      { cmd: 'npm run test:e2e', label: 'npm run test:e2e' },
      { cmd: 'yarn test:e2e', label: 'yarn test:e2e' },
      { cmd: 'yarn run test:pw', label: 'yarn test:pw' },
    ];

    for (const { cmd, label } of blockCases) {
      it(`should block: ${cmd}`, () => {
        const result = runHook({
          tool_name: 'Bash',
          tool_input: { command: cmd },
        });

        assert.notStrictEqual(result, null, 'Expected non-null output');
        assert.ok(result.hookSpecificOutput, 'Expected hookSpecificOutput');
        assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /BLOCKED: Playwright CLI detected/);
        assert.ok(
          result.hookSpecificOutput.permissionDecisionReason.includes(label),
          `Expected label "${label}" in deny reason`
        );
        assert.ok(
          result.hookSpecificOutput.permissionDecisionReason.includes('mcp__playwright__preflight_check'),
          'Expected preflight_check suggestion'
        );
        assert.ok(
          result.hookSpecificOutput.permissionDecisionReason.includes('mcp__playwright__run_tests'),
          'Expected MCP tool suggestion'
        );
      });
    }
  });

  describe('should include bypass instructions in deny reason', () => {
    it('should mention PLAYWRIGHT_CLI_BYPASS=1', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npx playwright test' },
      });

      assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('PLAYWRIGHT_CLI_BYPASS=1'));
      assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('BYPASS'));
    });

    it('should list valid bypass reasons', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npx playwright test' },
      });

      const reason = result.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.includes('codegen'), 'Expected codegen as valid reason');
      assert.ok(reason.includes('Installing browsers'), 'Expected browser install as valid reason');
    });
  });

  describe('should allow bypass with PLAYWRIGHT_CLI_BYPASS=1 prefix', () => {
    const bypassCases = [
      'PLAYWRIGHT_CLI_BYPASS=1 npx playwright test',
      'PLAYWRIGHT_CLI_BYPASS=1 npx playwright test --project vendor-owner',
      'PLAYWRIGHT_CLI_BYPASS=1 pnpm test:e2e',
      'PLAYWRIGHT_CLI_BYPASS=1 pnpm run test:pw',
    ];

    for (const cmd of bypassCases) {
      it(`should allow with bypass: ${cmd}`, () => {
        const result = runHook({
          tool_name: 'Bash',
          tool_input: { command: cmd },
        });

        assert.strictEqual(result, null, `Expected null output (allow) for bypassed "${cmd}"`);
      });
    }

    it('should not allow bypass with wrong value', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'PLAYWRIGHT_CLI_BYPASS=0 npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should still block with BYPASS=0');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should not allow bypass as substring', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'XPLAYWRIGHT_CLI_BYPASS=1 npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should still block with partial var name');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });
  });

  describe('should NOT allow bypass via chained commands', () => {
    it('should block: echo BYPASS && npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo PLAYWRIGHT_CLI_BYPASS=1 && npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is on echo, not playwright');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block: echo BYPASS; npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo PLAYWRIGHT_CLI_BYPASS=1; npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is on echo, not playwright');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block: echo BYPASS | npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo PLAYWRIGHT_CLI_BYPASS=1 | npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is on echo, not playwright');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block: echo BYPASS || npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo PLAYWRIGHT_CLI_BYPASS=1 || npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is on echo, not playwright');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block: playwright test --grep "BYPASS"', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npx playwright test --grep "PLAYWRIGHT_CLI_BYPASS=1"' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is in grep arg, not as env prefix');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });

    it('should block: echo BYPASS > /dev/null; npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'echo PLAYWRIGHT_CLI_BYPASS=1 > /dev/null; npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block — bypass is on echo redirect, not playwright');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });
  });

  describe('should allow bypass per-subcommand in chained commands', () => {
    it('should allow: git status && BYPASS=1 npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git status && PLAYWRIGHT_CLI_BYPASS=1 npx playwright test' },
      });

      assert.strictEqual(result, null, 'Should allow — bypass prefixes the playwright sub-command');
    });

    it('should allow: ls; BYPASS=1 pnpm test:e2e', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'ls; PLAYWRIGHT_CLI_BYPASS=1 pnpm test:e2e' },
      });

      assert.strictEqual(result, null, 'Should allow — bypass prefixes the playwright sub-command');
    });
  });

  describe('should block chained commands with non-playwright + playwright', () => {
    it('should block: git status && npx playwright test', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git status && npx playwright test' },
      });

      assert.notStrictEqual(result, null, 'Should block the playwright sub-command');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });
  });

  describe('should NOT block non-playwright commands', () => {
    const allowCases = [
      'git status',
      'pnpm test',
      'pnpm run test:unit',
      'npm run build',
      'vitest run',
      'pnpm test:feedback-agents',
      'node scripts/setup.sh',
      'ls -la',
    ];

    for (const cmd of allowCases) {
      it(`should allow silently: ${cmd}`, () => {
        const result = runHook({
          tool_name: 'Bash',
          tool_input: { command: cmd },
        });

        assert.strictEqual(result, null, `Expected null output for "${cmd}"`);
      });
    }
  });

  describe('should ignore non-Bash tool calls', () => {
    it('should exit silently for Read tool', () => {
      const result = runHook({
        tool_name: 'Read',
        tool_input: { file_path: '/some/path' },
      });

      assert.strictEqual(result, null);
    });

    it('should exit silently for Write tool', () => {
      const result = runHook({
        tool_name: 'Write',
        tool_input: { file_path: '/some/path', content: 'test' },
      });

      assert.strictEqual(result, null);
    });
  });

  describe('should be a hard block (permissionDecision deny)', () => {
    it('should use hookSpecificOutput with permissionDecision deny', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npx playwright test' },
      });

      assert.notStrictEqual(result, null);
      assert.ok(result.hookSpecificOutput, 'Expected hookSpecificOutput');
      assert.strictEqual(result.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(result.hookSpecificOutput.permissionDecisionReason, 'Expected deny reason');
      // Should NOT have bare systemMessage (old warn-only behavior)
      assert.strictEqual(result.systemMessage, undefined, 'Should not have bare systemMessage');
    });
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
    it('should handle empty command', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: '' },
      });

      assert.strictEqual(result, null);
    });

    it('should handle missing tool_input', () => {
      const result = runHook({
        tool_name: 'Bash',
      });

      assert.strictEqual(result, null);
    });

    it('should block case-insensitively', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'NPX PLAYWRIGHT TEST' },
      });

      assert.notStrictEqual(result, null);
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    });
  });
});
