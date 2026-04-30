#!/usr/bin/env node
/**
 * Pre-Merge Test Runner
 *
 * Runs unit tests before a PR is created/merged to catch failures early.
 * Called by the project-manager agent as a pre-merge quality gate.
 *
 * Usage: node .claude/hooks/lib/pre-merge-test-runner.js [--project-dir /path]
 * Output: JSON on stdout with { passed, failed, skipped, total, verdict, failures }
 *
 * Respects:
 * - services.json preMergeTestCommand (override default test command)
 * - services.json preMergeTestEnabled (set false to skip)
 * - GENTYR_TEST_SCOPE / services.json activeTestScope (scoped gating)
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.argv.includes('--project-dir')
  ? process.argv[process.argv.indexOf('--project-dir') + 1]
  : (process.env.CLAUDE_PROJECT_DIR || process.cwd());

function getServicesConfig() {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { return {}; }
}

function getActiveTestScope(config) {
  const scopeName = process.env.GENTYR_TEST_SCOPE || config.activeTestScope;
  if (!scopeName || !config.testScopes?.[scopeName]) return null;
  return { name: scopeName, ...config.testScopes[scopeName] };
}

function run() {
  const config = getServicesConfig();

  // Check if pre-merge tests are disabled
  if (config.preMergeTestEnabled === false) {
    const result = { passed: 0, failed: 0, skipped: 0, total: 0, verdict: 'skipped', reason: 'preMergeTestEnabled is false', failures: [] };
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Determine test command
  const defaultCommand = 'pnpm test:unit --reporter=json 2>/dev/null';
  const testCommand = config.preMergeTestCommand || defaultCommand;
  const timeout = 120000; // 2 minutes

  let stdout = '';
  let exitCode = 0;

  try {
    stdout = execSync(testCommand, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NODE_ENV: 'test' },
    });
  } catch (err) {
    exitCode = err.status || 1;
    stdout = err.stdout || '';
  }

  // Try to parse JSON output (Jest/Vitest JSON reporter)
  let parsed = null;
  try {
    // Find the JSON object in stdout (may have non-JSON prefix)
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      parsed = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
    }
  } catch { /* couldn't parse JSON */ }

  let passed = 0, failed = 0, skipped = 0, total = 0;
  let failures = [];

  if (parsed) {
    // Jest JSON format
    if (parsed.numPassedTests !== undefined) {
      passed = parsed.numPassedTests || 0;
      failed = parsed.numFailedTests || 0;
      skipped = parsed.numPendingTests || 0;
      total = parsed.numTotalTests || 0;
      if (parsed.testResults) {
        for (const suite of parsed.testResults) {
          if (suite.status === 'failed') {
            for (const tc of (suite.assertionResults || [])) {
              if (tc.status === 'failed') {
                failures.push({ name: tc.fullName || tc.title, error: (tc.failureMessages || []).join('\n').slice(0, 500) });
              }
            }
          }
        }
      }
    }
    // Vitest JSON format
    else if (parsed.testResults && Array.isArray(parsed.testResults)) {
      for (const suite of parsed.testResults) {
        for (const tc of (suite.assertionResults || [])) {
          total++;
          if (tc.status === 'passed') passed++;
          else if (tc.status === 'failed') {
            failed++;
            failures.push({ name: tc.fullName || tc.ancestorTitles?.join(' > ') || 'unknown', error: (tc.failureMessages || []).join('\n').slice(0, 500) });
          }
          else skipped++;
        }
      }
    }
  }

  // If we couldn't parse JSON, infer from exit code
  if (total === 0 && exitCode !== 0) {
    failed = 1;
    total = 1;
    failures.push({ name: 'test-suite', error: `Test command exited with code ${exitCode}. Output: ${stdout.slice(-500)}` });
  } else if (total === 0 && exitCode === 0) {
    // No JSON output but exit 0 — likely no tests or custom command
    passed = 1;
    total = 1;
  }

  // Apply test scope gating
  const scope = getActiveTestScope(config);
  let verdict = failed > 0 ? 'failed' : 'passed';

  if (scope && failed > 0 && scope.unitTestPattern) {
    const scopeRegex = new RegExp(scope.unitTestPattern);
    const scopedFailures = failures.filter(f => scopeRegex.test(f.name));
    const nonScopedFailures = failures.filter(f => !scopeRegex.test(f.name));

    if (scopedFailures.length === 0) {
      // All failures are outside the active scope — informational only
      verdict = 'passed_with_warnings';
      failures = nonScopedFailures.map(f => ({ ...f, scoped: false }));
    } else {
      failures = [
        ...scopedFailures.map(f => ({ ...f, scoped: true })),
        ...nonScopedFailures.map(f => ({ ...f, scoped: false })),
      ];
    }
  }

  const result = {
    passed,
    failed,
    skipped,
    total,
    verdict,
    scope: scope ? scope.name : null,
    failures,
  };

  process.stdout.write(JSON.stringify(result));
}

run();
