#!/usr/bin/env node

/**
 * Test Scope Classifier CLI.
 *
 * Called from the pre-push hook when a test scope is active and the full suite
 * has failures. Re-runs only the scoped test subset to determine whether the
 * failures are within the scope (block push) or outside it (warn only).
 *
 * Usage:
 *   node lib/test-scope-classifier.js \
 *     --scope <name> \
 *     --project-dir <path> \
 *     --unit-exit <code> \
 *     --integration-exit <code>
 *
 * Exit codes:
 *   0 — scoped tests pass (non-scoped failures are warnings)
 *   1 — scoped tests fail OR scope config error (push blocked)
 *
 * @module lib/test-scope-classifier
 */

import { execSync } from 'node:child_process';
import { getActiveTestScope, buildScopedCommand, formatPushSummary } from './test-scope.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scope' && argv[i + 1]) args.scope = argv[++i];
    else if (argv[i] === '--project-dir' && argv[i + 1]) args.projectDir = argv[++i];
    else if (argv[i] === '--unit-exit' && argv[i + 1]) args.unitExit = parseInt(argv[++i], 10);
    else if (argv[i] === '--integration-exit' && argv[i + 1]) args.integrationExit = parseInt(argv[++i], 10);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (!args.scope) {
    console.error('[test-scope-classifier] ERROR: --scope is required');
    process.exit(1);
  }

  const projectDir = args.projectDir || process.cwd();
  const unitExit = args.unitExit ?? 0;
  const integrationExit = args.integrationExit ?? 0;

  // If everything passed, no classification needed
  if (unitExit === 0 && integrationExit === 0) {
    console.log('[test-scope-classifier] All tests passed. No scope classification needed.');
    process.exit(0);
  }

  // Load scope config — override env so getActiveTestScope uses our scope name
  const prevEnv = process.env.GENTYR_TEST_SCOPE;
  process.env.GENTYR_TEST_SCOPE = args.scope;
  const scope = getActiveTestScope(projectDir);
  if (prevEnv !== undefined) {
    process.env.GENTYR_TEST_SCOPE = prevEnv;
  } else {
    delete process.env.GENTYR_TEST_SCOPE;
  }

  if (!scope.active) {
    console.error(`[test-scope-classifier] ERROR: ${scope.error || `Scope "${args.scope}" not found`}`);
    console.error('[test-scope-classifier] Fail-closed: push blocked (cannot classify without scope config)');
    process.exit(1);
  }

  let scopedUnitExit = null;
  let scopedIntegrationExit = null;

  // Re-run scoped unit tests if the full suite failed
  if (unitExit !== 0) {
    const unitCmd = buildScopedCommand(scope.config, 'unit', 'pnpm run test:unit');
    if (!unitCmd.command) {
      console.error('[test-scope-classifier] ERROR: No unitTestPattern or scopedUnitCommand configured');
      console.error('[test-scope-classifier] Fail-closed: cannot determine if unit failures are in scope');
      process.exit(1);
    }

    console.log('');
    console.log('==============================================');
    console.log(`RE-RUNNING SCOPED UNIT TESTS (scope: ${args.scope})`);
    console.log(`Command: ${unitCmd.command} (source: ${unitCmd.source})`);
    console.log('==============================================');
    console.log('');

    try {
      execSync(unitCmd.command, { cwd: projectDir, stdio: 'inherit', timeout: 300000 });
      scopedUnitExit = 0;
    } catch (err) {
      scopedUnitExit = err.status || 1;
    }
  }

  // Re-run scoped integration tests if the full suite failed
  if (integrationExit !== 0) {
    const intCmd = buildScopedCommand(scope.config, 'integration', 'pnpm run test:integration');
    if (!intCmd.command) {
      console.error('[test-scope-classifier] ERROR: No unitTestPattern or scopedIntegrationCommand configured');
      console.error('[test-scope-classifier] Fail-closed: cannot determine if integration failures are in scope');
      process.exit(1);
    }

    console.log('');
    console.log('==============================================');
    console.log(`RE-RUNNING SCOPED INTEGRATION TESTS (scope: ${args.scope})`);
    console.log(`Command: ${intCmd.command} (source: ${intCmd.source})`);
    console.log('==============================================');
    console.log('');

    try {
      execSync(intCmd.command, { cwd: projectDir, stdio: 'inherit', timeout: 300000 });
      scopedIntegrationExit = 0;
    } catch (err) {
      scopedIntegrationExit = err.status || 1;
    }
  }

  // Print summary
  const summary = formatPushSummary({
    scopeName: args.scope,
    fullUnitExit: unitExit,
    fullIntegrationExit: integrationExit,
    scopedUnitExit,
    scopedIntegrationExit,
  });
  console.log(summary);

  // Determine exit code
  const scopedFailed = (scopedUnitExit !== null && scopedUnitExit !== 0) ||
                       (scopedIntegrationExit !== null && scopedIntegrationExit !== 0);

  process.exit(scopedFailed ? 1 : 0);
}

main();
