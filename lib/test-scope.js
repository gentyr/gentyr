/**
 * Test Scope Profile resolver.
 *
 * Reads activeTestScope from services.json, applies scope patterns
 * to classify test results as scoped (blocking) or non-scoped (warning).
 * GENTYR_TEST_SCOPE env var overrides the config value.
 *
 * @module lib/test-scope
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Load the active test scope configuration.
 *
 * Resolution order:
 * 1. GENTYR_TEST_SCOPE env var (overrides config)
 * 2. activeTestScope in services.json
 *
 * @param {string} [projectDir] - Project root (defaults to CLAUDE_PROJECT_DIR or cwd)
 * @returns {{ active: boolean, scopeName: string|null, config: object|null, error: string|null }}
 */
export function getActiveTestScope(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(dir, '.claude', 'config', 'services.json');

  let scopeName = process.env.GENTYR_TEST_SCOPE || null;
  let config = null;

  try {
    if (!fs.existsSync(configPath)) {
      if (scopeName) {
        return { active: false, scopeName, config: null, error: `GENTYR_TEST_SCOPE="${scopeName}" set but ${configPath} not found` };
      }
      return { active: false, scopeName: null, config: null, error: null };
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!scopeName && raw.activeTestScope) {
      scopeName = raw.activeTestScope;
    }

    if (!scopeName) {
      return { active: false, scopeName: null, config: null, error: null };
    }

    if (!raw.testScopes || !raw.testScopes[scopeName]) {
      return { active: false, scopeName, config: null, error: `Test scope "${scopeName}" not found in testScopes config` };
    }

    config = raw.testScopes[scopeName];
    return { active: true, scopeName, config, error: null };
  } catch (err) {
    return { active: false, scopeName, config: null, error: `Failed to read test scope config: ${err.message}` };
  }
}

/**
 * Get a specific test scope profile by name.
 *
 * @param {string} name - Scope name
 * @param {string} [projectDir] - Project root
 * @returns {object|null} The scope config or null
 */
export function getTestScopeConfig(name, projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(dir, '.claude', 'config', 'services.json');

  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return raw.testScopes?.[name] || null;
  } catch {
    return null;
  }
}

/**
 * Build the scoped test command for a given test type.
 *
 * Uses scopedUnitCommand/scopedIntegrationCommand override if present,
 * otherwise constructs: <baseCommand> -- --testPathPattern='<unitTestPattern>'
 *
 * @param {object} scopeConfig - TestScope object from services.json
 * @param {'unit'|'integration'} testType
 * @param {string} baseCommand - e.g., 'pnpm run test:unit'
 * @returns {{ command: string, source: 'override'|'pattern'|null }}
 */
export function buildScopedCommand(scopeConfig, testType, baseCommand) {
  // Check for explicit command override
  const overrideKey = testType === 'unit' ? 'scopedUnitCommand' : 'scopedIntegrationCommand';
  if (scopeConfig[overrideKey]) {
    return { command: scopeConfig[overrideKey], source: 'override' };
  }

  // Build from unitTestPattern (used for both unit and integration — same file naming convention)
  if (scopeConfig.unitTestPattern) {
    // Sanitize: reject shell metacharacters to prevent injection via services.json
    if (/[';`$|&]/.test(scopeConfig.unitTestPattern)) {
      return { command: null, source: null };
    }
    return {
      command: `${baseCommand} -- --testPathPattern='${scopeConfig.unitTestPattern}'`,
      source: 'pattern',
    };
  }

  // No pattern available — cannot scope
  return { command: null, source: null };
}

/**
 * Format a human-readable push result summary.
 *
 * @param {object} opts
 * @param {string} opts.scopeName - Active scope name
 * @param {number} opts.fullUnitExit - Exit code from full unit test run
 * @param {number} opts.fullIntegrationExit - Exit code from full integration test run
 * @param {number|null} opts.scopedUnitExit - Exit code from scoped unit re-run (null if not run)
 * @param {number|null} opts.scopedIntegrationExit - Exit code from scoped integration re-run (null if not run)
 * @returns {string} Multi-line summary
 */
export function formatPushSummary({ scopeName, fullUnitExit, fullIntegrationExit, scopedUnitExit, scopedIntegrationExit }) {
  const lines = [];
  lines.push('');
  lines.push('==============================================');
  lines.push(`TEST SCOPE SUMMARY (scope: ${scopeName})`);
  lines.push('==============================================');

  // Report full suite results
  lines.push(`Full unit tests:        ${fullUnitExit === 0 ? 'PASSED' : 'FAILED'}`);
  lines.push(`Full integration tests: ${fullIntegrationExit === 0 ? 'PASSED' : 'FAILED'}`);

  // Report scoped re-run results (only if re-runs happened)
  if (scopedUnitExit !== null) {
    lines.push(`Scoped unit tests:      ${scopedUnitExit === 0 ? 'PASSED' : 'FAILED'} (re-run with scope filter)`);
  }
  if (scopedIntegrationExit !== null) {
    lines.push(`Scoped integration:     ${scopedIntegrationExit === 0 ? 'PASSED' : 'FAILED'} (re-run with scope filter)`);
  }

  lines.push('');

  // Determine overall outcome
  const scopedFailed = (scopedUnitExit !== null && scopedUnitExit !== 0) ||
                       (scopedIntegrationExit !== null && scopedIntegrationExit !== 0);

  const nonScopedFailed = (fullUnitExit !== 0 && (scopedUnitExit === null || scopedUnitExit === 0)) ||
                          (fullIntegrationExit !== 0 && (scopedIntegrationExit === null || scopedIntegrationExit === 0));

  if (scopedFailed) {
    lines.push(`BLOCKED: Scoped test failures in "${scopeName}" scope. Fix these before pushing.`);
  } else if (nonScopedFailed) {
    lines.push(`WARNING: Non-scoped test failures detected (not blocking for "${scopeName}" scope).`);
    lines.push('These tests are outside the active scope and do not gate this push.');
    lines.push('Consider fixing them to avoid drift.');
  } else {
    lines.push('All tests passed (scoped and non-scoped).');
  }

  lines.push('==============================================');
  return lines.join('\n');
}
