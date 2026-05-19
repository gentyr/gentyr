/**
 * Tests for the source granularity sweep (PR 2):
 *   - lib/session-queue.js `isAutomatedSource()` — matches explicit
 *     AUTOMATED_SOURCES entries and the `hourly-automation:<block>` prefix
 *   - hourly-automation.js `currentSource()` / `_currentBlock` tracking via
 *     static check that all enqueueSession callsites use currentSource()
 *
 * Run: node --test .claude/hooks/__tests__/source-granularity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAutomatedSource } from '../lib/session-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOURLY_AUTOMATION_PATH = path.resolve(__dirname, '../hourly-automation.js');

describe('lib/session-queue.js isAutomatedSource()', () => {
  it('matches the original AUTOMATED_SOURCES entries', () => {
    assert.strictEqual(isAutomatedSource('hourly-automation'), true);
    assert.strictEqual(isAutomatedSource('demo-failure-spawner'), true);
    assert.strictEqual(isAutomatedSource('ai-pr-review-hook'), true);
    assert.strictEqual(isAutomatedSource('session-reviver'), true);
    assert.strictEqual(isAutomatedSource('session-reaper-audit-revival'), true);
  });

  it('matches hourly-automation:<block> prefix variants', () => {
    assert.strictEqual(isAutomatedSource('hourly-automation:task_runner'), true);
    assert.strictEqual(isAutomatedSource('hourly-automation:demo_validation'), true);
    assert.strictEqual(isAutomatedSource('hourly-automation:report_auto_resolve'), true);
    assert.strictEqual(isAutomatedSource('hourly-automation:preview_promotion'), true);
    assert.strictEqual(isAutomatedSource('hourly-automation:auto_rollback_check'), true);
  });

  it('rejects non-automated sources', () => {
    assert.strictEqual(isAutomatedSource('urgent-task-spawner'), false);
    assert.strictEqual(isAutomatedSource('force-spawn-tasks'), false);
    assert.strictEqual(isAutomatedSource('persistent-task-spawner'), false);
    assert.strictEqual(isAutomatedSource('sync-recycle'), false);
    assert.strictEqual(isAutomatedSource('interactive-cto'), false);
  });

  it('handles null/undefined/empty inputs safely', () => {
    assert.strictEqual(isAutomatedSource(null), false);
    assert.strictEqual(isAutomatedSource(undefined), false);
    assert.strictEqual(isAutomatedSource(''), false);
  });

  it('rejects partial-prefix lookalikes', () => {
    // Must be exactly "hourly-automation:<something>", not similar strings.
    assert.strictEqual(isAutomatedSource('hourly-automation-fake'), false);
    assert.strictEqual(isAutomatedSource('not-hourly-automation:task'), false);
  });
});

describe('hourly-automation.js source granularity', () => {
  const src = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');

  it('defines currentSource() helper and _currentBlock tracker', () => {
    assert.ok(/let\s+_currentBlock\s*=\s*null/.test(src), '_currentBlock declared');
    assert.ok(/function\s+currentSource\s*\(\s*\)/.test(src), 'currentSource() function declared');
    assert.ok(/return\s+_currentBlock\s*\?\s*`hourly-automation:\$\{_currentBlock\}`\s*:\s*'hourly-automation'/.test(src),
      'currentSource() returns granular suffix when block is active');
  });

  it('runIfDue sets _currentBlock before fn() and resets it in finally', () => {
    // The runIfDue body should assign _currentBlock = key in the try block
    // and reset to null in a finally clause.
    assert.ok(/_currentBlock\s*=\s*key/.test(src), '_currentBlock = key assignment present');
    assert.ok(/finally\s*\{\s*_currentBlock\s*=\s*null\s*;\s*\}/s.test(src),
      'finally block resets _currentBlock');
  });

  it('all enqueueSession callsites use currentSource() (no bare hourly-automation literals)', () => {
    // No remaining literal `source: 'hourly-automation'` strings in
    // enqueueSession callsites. We allow them only in audit-event metadata
    // (which the sweep intentionally leaves alone).
    const bareSourceLines = src.split('\n')
      .map((line, i) => ({ line, lineNumber: i + 1 }))
      .filter(({ line }) => /^\s*source: 'hourly-automation',\s*$/.test(line));
    assert.strictEqual(
      bareSourceLines.length,
      0,
      `Expected zero bare \`source: 'hourly-automation'\` lines (would lose granularity); ` +
      `found at lines: ${bareSourceLines.map(b => b.lineNumber).join(', ')}`,
    );
  });

  it('the sweep updated at least 20 enqueue callsites', () => {
    const currentSourceMatches = src.match(/source: currentSource\(\),/g) || [];
    assert.ok(
      currentSourceMatches.length >= 20,
      `Expected at least 20 currentSource() callsites; found ${currentSourceMatches.length}`,
    );
  });
});
