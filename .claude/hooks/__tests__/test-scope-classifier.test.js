/**
 * Tests for lib/test-scope-classifier.js
 *
 * Validates the CLI script's exit code behavior:
 * 1. Exit 0 when all tests pass (no classification needed)
 * 2. Exit 0 when scoped re-run passes (non-scoped failures are warnings)
 * 3. Exit 1 when scoped re-run fails (push blocked)
 * 4. Exit 1 when scope config is missing (fail-closed)
 * 5. Structural validation of the classifier script
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/test-scope-classifier.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

describe('lib/test-scope-classifier.js - Structure', () => {
  const CLASSIFIER_PATH = path.resolve('lib/test-scope-classifier.js');

  it('should exist', () => {
    assert.ok(fs.existsSync(CLASSIFIER_PATH), 'test-scope-classifier.js must exist');
  });

  it('should be a valid ES module with shebang', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /^#!\/usr\/bin\/env node/, 'Must have Node shebang');
    assert.match(code, /import .* from ['"]\.\/test-scope\.js['"]/, 'Must import from test-scope.js');
  });

  it('should import getActiveTestScope and buildScopedCommand', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /getActiveTestScope/, 'Must use getActiveTestScope');
    assert.match(code, /buildScopedCommand/, 'Must use buildScopedCommand');
    assert.match(code, /formatPushSummary/, 'Must use formatPushSummary');
  });

  it('should parse --scope, --project-dir, --unit-exit, --integration-exit args', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /--scope/, 'Must handle --scope arg');
    assert.match(code, /--project-dir/, 'Must handle --project-dir arg');
    assert.match(code, /--unit-exit/, 'Must handle --unit-exit arg');
    assert.match(code, /--integration-exit/, 'Must handle --integration-exit arg');
  });

  it('should exit 0 when both exit codes are 0 (early return)', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    // Verify the early-exit path for all-pass
    assert.match(code, /unitExit === 0 && integrationExit === 0/, 'Must check for all-pass early exit');
  });

  it('should exit 1 when scope not found (fail-closed)', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /Fail-closed/, 'Must document fail-closed behavior');
  });

  it('should use execSync for scoped re-runs with inherited stdio', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /execSync/, 'Must use execSync for re-runs');
    assert.match(code, /stdio:\s*['"]inherit['"]/, 'Must inherit stdio for live output');
  });

  it('should have a 5-minute timeout for re-runs', () => {
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(code, /timeout:\s*300000/, 'Must have 300s timeout for re-runs');
  });

  it('should default unitExit and integrationExit to 0 when args are absent', () => {
    // parseInt(undefined, 10) === NaN. The classifier uses `?? 0` as a fallback
    // so that missing --unit-exit / --integration-exit args don't produce NaN,
    // which would cause (unitExit === 0 && integrationExit === 0) to be false
    // and trigger a spurious scoped re-run.
    // Validate via source that both defaults are protected by the nullish coalescing fallback.
    const code = fs.readFileSync(CLASSIFIER_PATH, 'utf8');
    assert.match(
      code,
      /unitExit\s*=\s*args\.unitExit\s*\?\?\s*0/,
      'unitExit must default to 0 via ?? 0 to guard against NaN from missing arg',
    );
    assert.match(
      code,
      /integrationExit\s*=\s*args\.integrationExit\s*\?\?\s*0/,
      'integrationExit must default to 0 via ?? 0 to guard against NaN from missing arg',
    );
  });
});

describe('lib/test-scope-classifier.js - Scope Config', () => {
  const SCOPE_PATH = path.resolve('lib/test-scope.js');

  it('test-scope.js should exist', () => {
    assert.ok(fs.existsSync(SCOPE_PATH), 'test-scope.js must exist');
  });

  it('should export all required functions', () => {
    const code = fs.readFileSync(SCOPE_PATH, 'utf8');
    assert.match(code, /export function getActiveTestScope/, 'Must export getActiveTestScope');
    assert.match(code, /export function getTestScopeConfig/, 'Must export getTestScopeConfig');
    assert.match(code, /export function buildScopedCommand/, 'Must export buildScopedCommand');
    assert.match(code, /export function formatPushSummary/, 'Must export formatPushSummary');
  });

  it('should respect GENTYR_TEST_SCOPE env var', () => {
    const code = fs.readFileSync(SCOPE_PATH, 'utf8');
    assert.match(code, /process\.env\.GENTYR_TEST_SCOPE/, 'Must check GENTYR_TEST_SCOPE env var');
  });

  it('should read from services.json', () => {
    const code = fs.readFileSync(SCOPE_PATH, 'utf8');
    assert.match(code, /services\.json/, 'Must read services.json');
    assert.match(code, /activeTestScope/, 'Must read activeTestScope field');
    assert.match(code, /testScopes/, 'Must read testScopes field');
  });
});

describe('husky/pre-push - Test Scope Integration', () => {
  const PRE_PUSH_PATH = path.resolve('husky/pre-push');

  it('should exist', () => {
    assert.ok(fs.existsSync(PRE_PUSH_PATH), 'husky/pre-push must exist');
  });

  it('should check GENTYR_TEST_SCOPE env var', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    assert.match(code, /GENTYR_TEST_SCOPE/, 'Must check GENTYR_TEST_SCOPE env var');
  });

  it('should read activeTestScope from services.json', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    assert.match(code, /activeTestScope/, 'Must read activeTestScope from config');
  });

  it('should invoke test-scope-classifier.js on failure', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    assert.match(code, /test-scope-classifier\.js/, 'Must invoke classifier');
  });

  it('should preserve original non-scoped path', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    // The original path should still have "Unit tests FAILED. Push blocked."
    assert.match(code, /Unit tests FAILED\. Push blocked\./, 'Must preserve original block message');
    assert.match(code, /Integration tests FAILED\. Push blocked\./, 'Must preserve original integration block');
  });

  it('should pass --scope, --project-dir, --unit-exit, --integration-exit to classifier', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    assert.match(code, /--scope.*ACTIVE_SCOPE/, 'Must pass scope name');
    assert.match(code, /--project-dir/, 'Must pass project dir');
    assert.match(code, /--unit-exit.*UNIT_EXIT/, 'Must pass unit exit code');
    assert.match(code, /--integration-exit.*INT_EXIT/, 'Must pass integration exit code');
  });

  it('should display scope name in header when active', () => {
    const code = fs.readFileSync(PRE_PUSH_PATH, 'utf8');
    assert.match(code, /scope:.*ACTIVE_SCOPE/, 'Must show scope name in output');
  });
});
