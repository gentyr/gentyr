/**
 * Unit tests for Playwright CLI Guard Hook
 *
 * Tests that the hook correctly detects playwright CLI commands
 * and emits non-blocking systemMessage warnings.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/playwright-cli-guard.test.js
 *
 * @version 1.0.0
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
  describe('should warn on playwright CLI commands', () => {
    const warnCases = [
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

    for (const { cmd, label } of warnCases) {
      it(`should warn for: ${cmd}`, () => {
        const result = runHook({
          tool_name: 'Bash',
          tool_input: { command: cmd },
        });

        assert.notStrictEqual(result, null, 'Expected non-null output');
        assert.ok(result.systemMessage, 'Expected systemMessage in output');
        assert.match(result.systemMessage, /WARNING: Playwright CLI detected/);
        assert.ok(result.systemMessage.includes(label), `Expected label "${label}" in message`);
        assert.ok(result.systemMessage.includes('mcp__playwright__preflight_check'), 'Expected preflight_check suggestion');
        assert.ok(result.systemMessage.includes('mcp__playwright__run_tests'), 'Expected MCP tool suggestion');
      });
    }
  });

  describe('should NOT warn on non-playwright commands', () => {
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

  describe('should be non-blocking', () => {
    it('should NOT include permissionDecision deny', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npx playwright test' },
      });

      assert.notStrictEqual(result, null);
      // Should NOT have hookSpecificOutput with deny
      assert.strictEqual(result.hookSpecificOutput, undefined, 'Should not have hookSpecificOutput');
      // Should only have systemMessage
      assert.ok(result.systemMessage, 'Expected systemMessage');
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

    it('should warn case-insensitively', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'NPX PLAYWRIGHT TEST' },
      });

      assert.notStrictEqual(result, null);
      assert.match(result.systemMessage, /WARNING/);
    });
  });
});
