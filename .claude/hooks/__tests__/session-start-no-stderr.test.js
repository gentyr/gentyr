/**
 * Cross-hook stderr guard test
 *
 * Verifies that NO SessionStart hook writes to stderr under any conditions.
 * Claude Code treats any stderr output from hooks as an error, displaying
 * "SessionStart:startup hook error" in the UI even when the hook exits
 * cleanly with valid JSON on stdout.
 *
 * Two-layer protection:
 * 1. Static analysis: assert zero process.stderr.write / console.error calls
 *    in each hook's source code.
 * 2. Runtime: run each hook in a subprocess and assert stderr === ''.
 *
 * Run with: node --test .claude/hooks/__tests__/session-start-no-stderr.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOKS_DIR = path.resolve(process.cwd(), '.claude/hooks');

// SessionStart hooks that must never write to stderr
const SESSION_START_HOOKS = [
  'gentyr-sync.js',
  'gentyr-splash.js',
  'todo-maintenance.js',
  'credential-health-check.js',
  'api-key-watcher.js',
  'plan-briefing.js',
  'playwright-health-check.js',
  'dead-agent-recovery.js',
];

// Shared library imported by hooks (must also be clean)
const SHARED_LIBS = [
  'config-reader.js',
];

// ---------------------------------------------------------------------------
// Static analysis: no stderr-writing calls in source
// ---------------------------------------------------------------------------

describe('SessionStart hooks — static analysis (no stderr writes)', () => {
  for (const hook of [...SESSION_START_HOOKS, ...SHARED_LIBS]) {
    it(`${hook} must not contain process.stderr.write`, () => {
      const code = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf8');
      assert.strictEqual(
        code.includes('process.stderr.write'),
        false,
        `${hook} must not contain process.stderr.write — use systemMessage in JSON stdout instead`,
      );
    });

    it(`${hook} must not contain console.error`, () => {
      const code = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf8');
      assert.strictEqual(
        code.includes('console.error'),
        false,
        `${hook} must not contain console.error — use systemMessage in JSON stdout instead`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Runtime: spawned session fast-path produces no stderr
// ---------------------------------------------------------------------------

describe('SessionStart hooks — runtime stderr check (spawned session fast-path)', () => {
  for (const hook of SESSION_START_HOOKS) {
    it(`${hook} produces empty stderr with CLAUDE_SPAWNED_SESSION=true`, () => {
      const hookPath = path.join(HOOKS_DIR, hook);
      const result = spawnSync('node', [hookPath], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          CLAUDE_SPAWNED_SESSION: 'true',
          CLAUDE_PROJECT_DIR: process.cwd(),
        },
        input: '{}', // Some hooks read stdin
      });

      assert.strictEqual(
        (result.stderr || '').trim(),
        '',
        `${hook} must not write to stderr (spawned session path)`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Runtime: config-reader error path (corrupted JSON) produces no stderr
// ---------------------------------------------------------------------------

describe('SessionStart hooks — config-reader error path (no stderr on corrupted config)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-guard-'));
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
  });

  it('gentyr-sync.js produces empty stderr with corrupted automation-config.json', () => {
    // Write corrupted config that triggers config-reader.js error path
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'automation-config.json'),
      '{ invalid json }',
    );

    const hookPath = path.join(HOOKS_DIR, 'gentyr-sync.js');
    const result = spawnSync('node', [hookPath], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
    });

    assert.strictEqual(
      (result.stderr || '').trim(),
      '',
      'gentyr-sync.js must not write to stderr even with corrupted automation-config.json',
    );
  });

  it('todo-maintenance.js produces empty stderr with corrupted automation-config.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'automation-config.json'),
      '{ invalid json }',
    );

    const hookPath = path.join(HOOKS_DIR, 'todo-maintenance.js');
    const result = spawnSync('node', [hookPath], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
      input: '{}',
    });

    assert.strictEqual(
      (result.stderr || '').trim(),
      '',
      'todo-maintenance.js must not write to stderr even with corrupted automation-config.json',
    );
  });
});
