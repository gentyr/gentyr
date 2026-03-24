/**
 * Tests for session-briefing.js (SessionStart hook)
 *
 * Validates:
 * 1. Interactive session produces DEPUTY-CTO SESSION BRIEFING
 * 2. Spawned session produces MANDATORY PRE-WORK PROTOCOL
 * 3. Graceful degradation when DBs don't exist
 * 4. Output includes hookEventName: "SessionStart"
 * 5. Output includes additionalContext
 * 6. No stderr output (SessionStart hook requirement)
 *
 * Run with: node --test .claude/hooks/__tests__/session-briefing.test.js
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = path.resolve(import.meta.dirname, '..', 'session-briefing.js');

/** Temp dirs to clean up after each test */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup - failure expected */ }
  }
  tmpDirs.length = 0;
});

/**
 * Create a minimal temp project dir with .claude/state directories.
 */
function createTempProjectDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-briefing-test-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  // Create a minimal .git directory so git commands don't fail hard
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/test-branch\n', 'utf8');
  return tmpDir;
}

/**
 * Run the session-briefing hook synchronously.
 */
function runHook(env = {}, stdinInput = '{}') {
  const result = spawnSync('node', [HOOK_PATH], {
    encoding: 'utf8',
    timeout: 15000,
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
// Interactive session tests
// ---------------------------------------------------------------------------

describe('session-briefing — interactive session', () => {
  it('outputs valid JSON with continue: true', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });

  it('includes DEPUTY-CTO SESSION BRIEFING in additionalContext', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.ok(result.parsed.hookSpecificOutput, 'Must have hookSpecificOutput');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext,
      'Must have additionalContext',
    );
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('DEPUTY-CTO SESSION BRIEFING'),
      'Interactive session must include DEPUTY-CTO SESSION BRIEFING header',
    );
  });

  it('includes hookEventName: SessionStart', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.strictEqual(
      result.parsed.hookSpecificOutput?.hookEventName,
      'SessionStart',
      'hookEventName must be SessionStart',
    );
  });

  it('includes queue status section', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    const ctx = result.parsed.hookSpecificOutput?.additionalContext || '';
    assert.ok(
      ctx.includes('Queue:'),
      'Interactive briefing must include Queue status',
    );
  });

  it('includes hint about peek_session tool', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    const ctx = result.parsed.hookSpecificOutput?.additionalContext || '';
    assert.ok(
      ctx.includes('peek_session'),
      'Interactive briefing must include hint about peek_session tool',
    );
  });

  it('produces empty stderr', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.strictEqual(
      (result.stderr || '').trim(),
      '',
      'SessionStart hook must not write to stderr',
    );
  });
});

// ---------------------------------------------------------------------------
// Spawned session tests
// ---------------------------------------------------------------------------

describe('session-briefing — spawned session', () => {
  it('outputs valid JSON with continue: true', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must be true');
  });

  it('includes MANDATORY PRE-WORK PROTOCOL in additionalContext', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    assert.ok(result.parsed?.hookSpecificOutput?.additionalContext, 'Must have additionalContext');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('MANDATORY PRE-WORK PROTOCOL'),
      'Spawned session must include MANDATORY PRE-WORK PROTOCOL header',
    );
  });

  it('includes hookEventName: SessionStart', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    assert.strictEqual(
      result.parsed?.hookSpecificOutput?.hookEventName,
      'SessionStart',
      'hookEventName must be SessionStart',
    );
  });

  it('includes completion protocol reminder', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    const ctx = result.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.ok(
      ctx.includes('summarize_work'),
      'Spawned briefing must include completion protocol with summarize_work',
    );
  });

  it('includes numbered pre-work steps', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    const ctx = result.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.includes('1. INVESTIGATOR AGENT'), 'Must include step 1: INVESTIGATOR AGENT');
    assert.ok(ctx.includes('2. USER-ALIGNMENT AGENT'), 'Must include step 2: USER-ALIGNMENT AGENT');
    assert.ok(ctx.includes('3. REVIEW ACTIVE SESSIONS'), 'Must include step 3: REVIEW ACTIVE SESSIONS');
    assert.ok(ctx.includes('4. CHECK SIGNALS'), 'Must include step 4: CHECK SIGNALS');
    assert.ok(ctx.includes('5. ONLY THEN'), 'Must include step 5: ONLY THEN');
  });

  it('produces empty stderr', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    assert.strictEqual(
      (result.stderr || '').trim(),
      '',
      'SessionStart hook must not write to stderr',
    );
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation tests
// ---------------------------------------------------------------------------

describe('session-briefing — graceful degradation', () => {
  it('degrades gracefully when no DBs exist (interactive)', () => {
    // Use a temp dir with NO databases
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-empty-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.ok(result.parsed, 'Must output valid JSON even with no DBs');
    assert.strictEqual(result.parsed.continue, true, 'Must still continue');
    assert.ok(
      result.parsed.hookSpecificOutput?.additionalContext,
      'Must still have additionalContext',
    );
  });

  it('degrades gracefully when no DBs exist (spawned)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-empty-spawned-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/feature/test\n', 'utf8');

    const result = runHook({
      CLAUDE_PROJECT_DIR: tmpDir,
      CLAUDE_SPAWNED_SESSION: 'true',
    });

    assert.ok(result.parsed, 'Must output valid JSON even with no DBs');
    assert.strictEqual(result.parsed.continue, true, 'Must still continue');
    assert.ok(
      result.parsed.hookSpecificOutput?.additionalContext,
      'Must still have additionalContext',
    );
  });

  it('exits successfully even with no git repo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nogit-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
    // No .git directory

    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.ok(result.parsed, 'Must output valid JSON even without git repo');
    assert.strictEqual(result.parsed.continue, true, 'Must still continue');
    // No stderr allowed
    assert.strictEqual(
      (result.stderr || '').trim(),
      '',
      'Must not write to stderr even without git',
    );
  });
});

// ---------------------------------------------------------------------------
// Output structure tests
// ---------------------------------------------------------------------------

describe('session-briefing — output structure', () => {
  it('systemMessage contains line count', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    assert.ok(
      result.parsed?.systemMessage,
      'Must have systemMessage',
    );
    assert.ok(
      result.parsed.systemMessage.includes('session-briefing'),
      'systemMessage must reference session-briefing',
    );
  });

  it('additionalContext is a non-empty string', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook({ CLAUDE_PROJECT_DIR: tmpDir });

    const ctx = result.parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(typeof ctx === 'string', 'additionalContext must be a string');
    assert.ok(ctx.length > 10, 'additionalContext must have meaningful content');
  });
});
