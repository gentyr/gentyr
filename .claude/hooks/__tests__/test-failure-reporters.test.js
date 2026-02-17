/**
 * Tests for test failure reporters (Jest, Vitest, Playwright)
 *
 * These tests validate:
 * 1. getConfiguredCooldown() - Dynamic cooldown resolution
 * 2. isInCooldown() - Cooldown check with dynamic values
 * 3. Reporter structure and behavior
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/test-failure-reporters.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();

// Test all three reporters with same structure
const REPORTERS = [
  {
    name: 'jest-failure-reporter',
    path: path.join(PROJECT_DIR, '.claude/hooks/reporters/jest-failure-reporter.js'),
    defaultCooldown: 120,
    configKey: 'test_failure_reporter',
  },
  {
    name: 'vitest-failure-reporter',
    path: path.join(PROJECT_DIR, '.claude/hooks/reporters/vitest-failure-reporter.js'),
    defaultCooldown: 120,
    configKey: 'test_failure_reporter',
  },
  {
    name: 'playwright-failure-reporter',
    path: path.join(PROJECT_DIR, '.claude/hooks/reporters/playwright-failure-reporter.js'),
    defaultCooldown: 120,
    configKey: 'test_failure_reporter',
  },
];

for (const reporter of REPORTERS) {
  describe(`${reporter.name} - Structure Validation`, () => {
    it('should be a valid ES module', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      // Should use ES module imports
      assert.match(code, /import .* from ['"]fs['"]/, 'Must import fs');
      assert.match(code, /import .* from ['"]path['"]/, 'Must import path');
      assert.match(code, /import .* from ['"]crypto['"]/, 'Must import crypto');
      assert.match(code, /import .* from ['"]child_process['"]/, 'Must import child_process');
    });

    it('should define CONFIG object with constants', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      assert.match(
        code,
        /const CONFIG = \{/,
        'Must define CONFIG object'
      );

      assert.match(
        code,
        /COOLDOWN_MINUTES:\s*120/,
        `Must define COOLDOWN_MINUTES = ${reporter.defaultCooldown}`
      );
    });

    it('should define getConfiguredCooldown() function', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      assert.match(
        code,
        /async function getConfiguredCooldown\(\)/,
        'Must define getConfiguredCooldown as async function'
      );
    });

    it('should define isInCooldown() function with cooldownMinutes parameter', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      assert.match(
        code,
        /function isInCooldown\(state, suiteName, cooldownMinutes/,
        'Must define isInCooldown with cooldownMinutes parameter'
      );
    });
  });

  describe(`${reporter.name} - getConfiguredCooldown()`, () => {
    it('should import config-reader.js dynamically', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getConfiguredCooldown must exist');

      const functionBody = functionMatch[0];

      // Should use dynamic import for config-reader
      assert.match(
        functionBody,
        /await import\(configReaderPath\)/,
        'Must dynamically import config-reader.js'
      );

      assert.match(
        functionBody,
        /const \{ getCooldown \} = await import/,
        'Must destructure getCooldown from import'
      );
    });

    it('should call getCooldown with correct parameters', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call getCooldown with config key and default
      assert.match(
        functionBody,
        new RegExp(`getCooldown\\(['"]${reporter.configKey}['"], ${reporter.defaultCooldown}\\)`),
        `Must call getCooldown('${reporter.configKey}', ${reporter.defaultCooldown})`
      );
    });

    it('should return default cooldown on import failure', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap import in try-catch
      assert.match(
        functionBody,
        /try \{[\s\S]*?await import[\s\S]*?\} catch \{/s,
        'Must wrap import in try-catch'
      );

      // Should return default on error
      assert.match(
        functionBody,
        new RegExp(`catch \\{[\\s\\S]*?return ${reporter.defaultCooldown}`),
        `Must return ${reporter.defaultCooldown} on error`
      );
    });

    it('should construct config-reader path relative to framework directory', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should use getFrameworkDir() to construct path
      assert.match(
        functionBody,
        /const configReaderPath = path\.join\(getFrameworkDir\(\)/,
        'Must use getFrameworkDir() to construct config-reader path'
      );

      // Should point to config-reader.js
      assert.match(
        functionBody,
        /['"]config-reader\.js['"]/,
        'Must point to config-reader.js'
      );
    });
  });

  describe(`${reporter.name} - isInCooldown()`, () => {
    it('should accept cooldownMinutes parameter with default', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes = CONFIG\.COOLDOWN_MINUTES/);
      assert.ok(functionMatch, 'isInCooldown must accept cooldownMinutes with default from CONFIG');
    });

    it('should calculate minutes elapsed since last spawn', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'isInCooldown function must exist');

      const functionBody = functionMatch[0];

      // Should calculate minutesSince by dividing time difference by (1000 * 60)
      assert.match(
        functionBody,
        /minutesSince = \(now - lastSpawnDate\) \/ \(1000 \* 60\)/,
        'Must calculate minutesSince by dividing by (1000 * 60)'
      );
    });

    it('should compare minutesSince against cooldownMinutes', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should use cooldownMinutes in comparison
      assert.match(
        functionBody,
        /return minutesSince < cooldownMinutes/,
        'Must return true when minutesSince < cooldownMinutes'
      );
    });

    it('should return false when no previous spawn', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if lastSpawn exists
      assert.match(
        functionBody,
        /if \(!lastSpawn\)/,
        'Must check if lastSpawn exists'
      );

      // Should return false when no previous spawn
      assert.match(
        functionBody,
        /if \(!lastSpawn\)[\s\S]*?return false/s,
        'Must return false when no previous spawn'
      );
    });

    it('should parse lastSpawn as Date', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should create lastSpawnDate from lastSpawn
      assert.match(
        functionBody,
        /lastSpawnDate = new Date\(lastSpawn\)/,
        'Must parse lastSpawn as Date'
      );
    });
  });

  describe(`${reporter.name} - Reporter Integration`, () => {
    it('should call getConfiguredCooldown() when spawning agents', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      // Should await getConfiguredCooldown before spawning
      assert.match(
        code,
        /await getConfiguredCooldown\(\)/,
        'Must call getConfiguredCooldown before spawning'
      );
    });

    it('should pass cooldown to isInCooldown() calls', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      // Should pass cooldown variable to isInCooldown
      assert.match(
        code,
        /isInCooldown\(state, [\w.]+, cooldown/,
        'Must pass cooldown parameter to isInCooldown'
      );
    });

    it('should maintain backwards compatibility with default cooldown', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      // CONFIG.COOLDOWN_MINUTES should still exist
      assert.match(
        code,
        new RegExp(`COOLDOWN_MINUTES:\\s*${reporter.defaultCooldown}`),
        'Must define COOLDOWN_MINUTES constant for backwards compatibility'
      );

      // isInCooldown should default to CONFIG.COOLDOWN_MINUTES
      assert.match(
        code,
        /cooldownMinutes = CONFIG\.COOLDOWN_MINUTES/,
        'isInCooldown must default to CONFIG.COOLDOWN_MINUTES'
      );
    });
  });

  describe(`${reporter.name} - Error Handling`, () => {
    it('should handle config-reader import failure gracefully', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should catch import errors
      assert.match(
        functionBody,
        /\} catch \{/,
        'Must catch import errors'
      );

      // Should not throw or crash
      assert.match(
        functionBody,
        new RegExp(`return ${reporter.defaultCooldown}`),
        'Must return default value on error'
      );
    });

    it('should handle invalid state gracefully', () => {
      const code = fs.readFileSync(reporter.path, 'utf8');

      const functionMatch = code.match(/function isInCooldown\(state, suiteName, cooldownMinutes[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should handle null/undefined state.suites
      assert.match(
        functionBody,
        /state\.suites\[suiteName\]/,
        'Must safely access state.suites property'
      );
    });
  });
}

describe('Test Failure Reporters - Consistency Check', () => {
  it('should have identical getConfiguredCooldown() implementation across all reporters', () => {
    const implementations = REPORTERS.map(reporter => {
      const code = fs.readFileSync(reporter.path, 'utf8');
      const match = code.match(/async function getConfiguredCooldown\(\) \{[\s\S]*?\n\}/);
      return match ? match[0] : '';
    });

    // All implementations should be structurally similar
    for (let i = 1; i < implementations.length; i++) {
      // Check for key structural elements
      assert.ok(
        implementations[i].includes('await import(configReaderPath)'),
        `${REPORTERS[i].name} must use same import pattern`
      );
      assert.ok(
        implementations[i].includes('getCooldown'),
        `${REPORTERS[i].name} must call getCooldown`
      );
      assert.ok(
        implementations[i].includes('catch {'),
        `${REPORTERS[i].name} must have error handling`
      );
    }
  });

  it('should have identical isInCooldown() signature across all reporters', () => {
    const signatures = REPORTERS.map(reporter => {
      const code = fs.readFileSync(reporter.path, 'utf8');
      const match = code.match(/function isInCooldown\([^)]+\)/);
      return match ? match[0] : '';
    });

    // All signatures should match
    for (let i = 1; i < signatures.length; i++) {
      assert.strictEqual(
        signatures[i],
        signatures[0],
        `${REPORTERS[i].name} should have same isInCooldown signature as ${REPORTERS[0].name}`
      );
    }
  });

  it('should use same config key for all reporters', () => {
    // All test failure reporters should use the same config key
    const configKeys = REPORTERS.map(r => r.configKey);
    const uniqueKeys = [...new Set(configKeys)];

    assert.strictEqual(
      uniqueKeys.length,
      1,
      'All test failure reporters must use the same config key'
    );

    assert.strictEqual(
      uniqueKeys[0],
      'test_failure_reporter',
      'Config key must be test_failure_reporter'
    );
  });
});
