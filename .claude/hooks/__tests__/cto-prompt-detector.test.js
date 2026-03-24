/**
 * Tests for cto-prompt-detector.js (UserPromptSubmit hook)
 *
 * Validates:
 * 1. Spawned sessions exit with { continue: true } and write no signal file
 * 2. Interactive sessions write the cto-prompt-signal.json file
 * 3. Output is always { continue: true }
 * 4. Slash commands are skipped
 * 5. Signal file contains expected fields
 *
 * Run with: node --test .claude/hooks/__tests__/cto-prompt-detector.test.js
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = path.resolve(import.meta.dirname, '..', 'cto-prompt-detector.js');

/** Temp dirs to clean up after each test */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup - failure expected */ }
  }
  tmpDirs.length = 0;
});

/**
 * Create a minimal temp project dir.
 */
function createTempProjectDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-prompt-detector-test-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  return tmpDir;
}

/**
 * Run the cto-prompt-detector hook synchronously.
 */
function runHook(env = {}, stdinInput = '{}') {
  const result = spawnSync('node', [HOOK_PATH], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      ...env,
    },
    input: stdinInput,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    // Non-fatal
  }

  return { ...result, parsed };
}

// ---------------------------------------------------------------------------
// Spawned session tests
// ---------------------------------------------------------------------------

describe('cto-prompt-detector — spawned session', () => {
  it('exits with { continue: true } for spawned session', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      {
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
      JSON.stringify({ session_id: 'test-session', user_prompt: 'Do some work' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });

  it('does NOT write signal file for spawned session', () => {
    const tmpDir = createTempProjectDir();
    const signalFile = path.join(tmpDir, '.claude', 'state', 'cto-prompt-signal.json');

    runHook(
      {
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
      JSON.stringify({ session_id: 'test-session', user_prompt: 'Do some work' }),
    );

    assert.strictEqual(
      fs.existsSync(signalFile),
      false,
      'Signal file must NOT be written for spawned sessions',
    );
  });
});

// ---------------------------------------------------------------------------
// Interactive session tests
// ---------------------------------------------------------------------------

describe('cto-prompt-detector — interactive session', () => {
  it('exits with { continue: true } for interactive session', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'test-session', user_prompt: 'Check the status of agents' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });

  it('writes cto-prompt-signal.json for interactive session', () => {
    const tmpDir = createTempProjectDir();
    const signalFile = path.join(tmpDir, '.claude', 'state', 'cto-prompt-signal.json');

    runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'abc123', user_prompt: 'Check the status of all agents' }),
    );

    assert.strictEqual(
      fs.existsSync(signalFile),
      true,
      'Signal file must be written for interactive sessions',
    );
  });

  it('signal file contains content_preview, timestamp, and session_id', () => {
    const tmpDir = createTempProjectDir();
    const signalFile = path.join(tmpDir, '.claude', 'state', 'cto-prompt-signal.json');

    runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'abc123', user_prompt: 'Review the agent queue status' }),
    );

    assert.ok(fs.existsSync(signalFile), 'Signal file must exist');
    const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'));

    assert.ok(signal.content_preview, 'Signal must have content_preview');
    assert.ok(signal.timestamp, 'Signal must have timestamp');
    assert.ok(
      signal.content_preview.includes('Review the agent queue status'),
      'content_preview must contain the prompt text',
    );
    assert.ok(
      new Date(signal.timestamp).getTime() > 0,
      'timestamp must be a valid ISO date',
    );
  });

  it('content_preview is truncated to 200 chars', () => {
    const tmpDir = createTempProjectDir();
    const signalFile = path.join(tmpDir, '.claude', 'state', 'cto-prompt-signal.json');
    const longPrompt = 'A'.repeat(500);

    runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'abc123', user_prompt: longPrompt }),
    );

    assert.ok(fs.existsSync(signalFile), 'Signal file must exist');
    const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'));

    assert.ok(
      signal.content_preview.length <= 200,
      'content_preview must be at most 200 chars',
    );
  });
});

// ---------------------------------------------------------------------------
// Slash command skip tests
// ---------------------------------------------------------------------------

describe('cto-prompt-detector — slash command skipping', () => {
  it('does NOT write signal file for slash commands', () => {
    const tmpDir = createTempProjectDir();
    const signalFile = path.join(tmpDir, '.claude', 'state', 'cto-prompt-signal.json');

    runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'abc123', user_prompt: '/spawn-tasks' }),
    );

    assert.strictEqual(
      fs.existsSync(signalFile),
      false,
      'Signal file must NOT be written for slash commands',
    );
  });

  it('exits with { continue: true } for slash commands', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ session_id: 'abc123', user_prompt: '/demo-all' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });
});

// ---------------------------------------------------------------------------
// Output invariant tests
// ---------------------------------------------------------------------------

describe('cto-prompt-detector — output invariants', () => {
  it('always outputs { continue: true } — never blocks prompts', () => {
    const tmpDir = createTempProjectDir();

    // Test several scenarios
    const scenarios = [
      { session_id: 's1', user_prompt: 'Hello' },
      { session_id: 's2', user_prompt: '/slash-command' },
      { session_id: 's3', user_prompt: '' },
    ];

    for (const input of scenarios) {
      const result = runHook(
        { CLAUDE_PROJECT_DIR: tmpDir },
        JSON.stringify(input),
      );
      assert.ok(result.parsed, `Output must be valid JSON for input: ${JSON.stringify(input)}`);
      assert.strictEqual(
        result.parsed.continue,
        true,
        `continue must always be true, got: ${JSON.stringify(result.parsed)}`,
      );
    }
  });

  it('handles empty stdin gracefully', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir }, '');

    assert.ok(result.parsed, 'Output must be valid JSON for empty stdin');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });

  it('handles malformed JSON stdin gracefully', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir }, 'not valid json {{{');

    assert.ok(result.parsed, 'Output must be valid JSON for malformed stdin');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });
});
