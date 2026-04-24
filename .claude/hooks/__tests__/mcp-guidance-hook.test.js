/**
 * Tests for mcp-guidance-hook.js (UserPromptSubmit hook)
 *
 * Validates:
 * 1. Spawned sessions exit silently without injecting any context
 * 2. Slash commands and HOOK:GENTYR markers are skipped
 * 3. Empty prompts are skipped
 * 4. MCP keyword in prompt triggers guidance injection (with cooldown)
 * 5. Cooldown suppresses repeated MCP keyword injections within 30 minutes
 * 6. Pending staged servers always inject a notification (no cooldown)
 * 7. Both triggers fire simultaneously when both conditions are met
 * 8. Output format: { continue: true, suppressOutput: true, hookSpecificOutput } structure
 *
 * Run with: node --test .claude/hooks/__tests__/mcp-guidance-hook.test.js
 *
 * @version 1.0.0
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = path.resolve(import.meta.dirname, '..', 'mcp-guidance-hook.js');

/** Temp dirs to clean up after each test */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup - failure expected */ }
  }
  tmpDirs.length = 0;
});

/**
 * Create a minimal temp project dir with .claude/state/.
 */
function createTempProjectDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guidance-hook-test-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  return tmpDir;
}

/**
 * Run the mcp-guidance-hook synchronously and return parsed output.
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
    // Non-fatal — tests below will assert what they need
  }

  return { ...result, parsed };
}

/**
 * Write a pending MCP servers file to the given project dir.
 */
function writePendingServers(projectDir, servers = { notion: { command: 'npx' } }) {
  const pendingPath = path.join(projectDir, '.claude', 'state', 'mcp-servers-pending.json');
  fs.writeFileSync(pendingPath, JSON.stringify({ servers, stagedAt: new Date().toISOString() }));
}

/**
 * Write a guidance state file with lastKeywordCheck set to a given ms timestamp.
 */
function writeGuidanceState(projectDir, lastKeywordCheck) {
  const statePath = path.join(projectDir, '.claude', 'state', 'mcp-guidance-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ lastKeywordCheck }));
}

// ---------------------------------------------------------------------------
// Spawned session fast-path
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — spawned session fast-path', () => {
  it('exits with { continue: true, suppressOutput: true } for spawned sessions', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      {
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
      JSON.stringify({ user_prompt: 'how do I add an mcp server?' }),
    );

    assert.strictEqual(result.status, 0, `Hook exited with non-zero: ${result.stderr}`);
    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true);
    assert.strictEqual(result.parsed.suppressOutput, true);
    // Must NOT inject any context for spawned sessions
    assert.ok(!result.parsed.hookSpecificOutput, 'Spawned sessions must not inject additionalContext');
  });

  it('does not fire MCP keyword guidance for spawned sessions even when pending servers exist', () => {
    const tmpDir = createTempProjectDir();
    writePendingServers(tmpDir);

    const result = runHook(
      {
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
      JSON.stringify({ user_prompt: 'tell me about mcp' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true);
    assert.ok(!result.parsed.hookSpecificOutput, 'Spawned sessions must not inject context even with pending servers');
  });
});

// ---------------------------------------------------------------------------
// Prompt skip conditions
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — prompt skip conditions', () => {
  it('skips empty prompt', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: '' }),
    );

    assert.strictEqual(result.status, 0);
    assert.ok(result.parsed);
    assert.strictEqual(result.parsed.continue, true);
    assert.ok(!result.parsed.hookSpecificOutput, 'Empty prompt must not inject context');
  });

  it('skips slash commands', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: '/spawn-tasks add an mcp server' }),
    );

    assert.ok(result.parsed);
    assert.ok(!result.parsed.hookSpecificOutput, 'Slash commands must be skipped');
  });

  it('skips HOOK:GENTYR sentinel markers', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'some context <!-- HOOK:GENTYR:demo -->' }),
    );

    assert.ok(result.parsed);
    assert.ok(!result.parsed.hookSpecificOutput, 'HOOK:GENTYR markers must be skipped');
  });

  it('does not skip non-slash non-sentinel prompts mentioning mcp', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'how do I add a new mcp server to this project?' }),
    );

    assert.ok(result.parsed);
    assert.ok(result.parsed.hookSpecificOutput, 'MCP keyword prompt should inject context');
  });
});

// ---------------------------------------------------------------------------
// MCP keyword trigger
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — MCP keyword trigger', () => {
  it('injects guidance context when prompt contains "mcp" (case-insensitive)', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'I want to add a new MCP server' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true);
    assert.ok(result.parsed.hookSpecificOutput, 'Must inject hookSpecificOutput');
    assert.strictEqual(result.parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(
      typeof result.parsed.hookSpecificOutput.additionalContext === 'string',
      'additionalContext must be a string',
    );
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('stage_mcp_server'),
      'Guidance must mention the stage_mcp_server tool',
    );
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('MCP Server Guidance'),
      'Guidance must include the [MCP Server Guidance] tag',
    );
  });

  it('matches "mcp" as a word boundary, not a substring', () => {
    const tmpDir = createTempProjectDir();
    // "stamp" contains "mp" but not the word "mcp"
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'I need to stamp a document' }),
    );

    assert.ok(result.parsed);
    assert.ok(!result.parsed.hookSpecificOutput, 'Non-mcp prompt must not inject guidance');
  });

  it('writes cooldown state after MCP keyword injection', () => {
    const tmpDir = createTempProjectDir();
    runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'how do I configure mcp?' }),
    );

    const statePath = path.join(tmpDir, '.claude', 'state', 'mcp-guidance-state.json');
    assert.ok(fs.existsSync(statePath), 'State file must be written after keyword injection');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok(typeof state.lastKeywordCheck === 'number', 'lastKeywordCheck must be a number');
    assert.ok(state.lastKeywordCheck > 0, 'lastKeywordCheck must be a positive timestamp');
  });

  it('suppresses keyword guidance when cooldown is active (within 30 minutes)', () => {
    const tmpDir = createTempProjectDir();
    // Simulate a recent injection — 5 minutes ago
    writeGuidanceState(tmpDir, Date.now() - 5 * 60 * 1000);

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'what about mcp configuration?' }),
    );

    assert.ok(result.parsed);
    // Cooldown active — no keyword guidance. But no pending servers either, so no context at all.
    assert.ok(
      !result.parsed.hookSpecificOutput,
      'Cooldown must suppress repeated MCP keyword guidance',
    );
  });

  it('injects guidance again after cooldown expires (>30 minutes)', () => {
    const tmpDir = createTempProjectDir();
    // Simulate an old injection — 31 minutes ago
    writeGuidanceState(tmpDir, Date.now() - 31 * 60 * 1000);

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'let us talk about mcp servers' }),
    );

    assert.ok(result.parsed);
    assert.ok(result.parsed.hookSpecificOutput, 'Expired cooldown must allow guidance injection');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('stage_mcp_server'),
    );
  });
});

// ---------------------------------------------------------------------------
// Pending staged servers trigger
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — pending staged servers trigger', () => {
  it('injects pending notification when mcp-servers-pending.json exists with servers', () => {
    const tmpDir = createTempProjectDir();
    writePendingServers(tmpDir, { notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] } });

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'what is the status of the project?' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.ok(result.parsed.hookSpecificOutput, 'Must inject context for pending servers');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('Pending MCP Servers'),
      'Must include the [Pending MCP Servers] tag',
    );
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('notion'),
      'Must list the pending server name',
    );
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('npx gentyr sync'),
      'Must mention npx gentyr sync',
    );
  });

  it('pending notification fires even when MCP keyword cooldown is active', () => {
    const tmpDir = createTempProjectDir();
    // Cooldown active — 5 minutes ago
    writeGuidanceState(tmpDir, Date.now() - 5 * 60 * 1000);
    writePendingServers(tmpDir, { 'my-server': { command: 'node', args: ['server.js'] } });

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'tell me about current work' }),
    );

    assert.ok(result.parsed);
    assert.ok(result.parsed.hookSpecificOutput, 'Pending notification must fire even during cooldown');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.includes('Pending MCP Servers'),
    );
    // Keyword guidance must NOT be present (cooldown active, no mcp in prompt)
    assert.ok(
      !result.parsed.hookSpecificOutput.additionalContext.includes('MCP Server Guidance'),
      'Keyword guidance must be suppressed by cooldown',
    );
  });

  it('lists multiple pending server names', () => {
    const tmpDir = createTempProjectDir();
    writePendingServers(tmpDir, {
      notion: { command: 'npx' },
      postgres: { command: 'node' },
    });

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'good morning' }),
    );

    assert.ok(result.parsed);
    assert.ok(result.parsed.hookSpecificOutput);
    const ctx = result.parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('notion'), 'Must list "notion"');
    assert.ok(ctx.includes('postgres'), 'Must list "postgres"');
    assert.ok(ctx.includes('2'), 'Must include pending count');
  });

  it('does not inject pending notification when servers object is empty', () => {
    const tmpDir = createTempProjectDir();
    writePendingServers(tmpDir, {});

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'good morning' }),
    );

    assert.ok(result.parsed);
    assert.ok(
      !result.parsed.hookSpecificOutput,
      'Empty servers object must not trigger pending notification',
    );
  });

  it('does not inject pending notification when file is absent', () => {
    const tmpDir = createTempProjectDir();
    // No mcp-servers-pending.json written

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'good morning' }),
    );

    assert.ok(result.parsed);
    assert.ok(!result.parsed.hookSpecificOutput, 'Absent pending file must not inject context');
  });
});

// ---------------------------------------------------------------------------
// Both triggers simultaneously
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — both triggers active', () => {
  it('injects both keyword guidance and pending notification when both fire', () => {
    const tmpDir = createTempProjectDir();
    writePendingServers(tmpDir, { notion: { command: 'npx' } });
    // No cooldown — let keyword trigger fire

    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'how do I configure my mcp servers?' }),
    );

    assert.ok(result.parsed);
    assert.ok(result.parsed.hookSpecificOutput);
    const ctx = result.parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('MCP Server Guidance'), 'Must include keyword guidance');
    assert.ok(ctx.includes('Pending MCP Servers'), 'Must include pending notification');
  });
});

// ---------------------------------------------------------------------------
// Output structure
// ---------------------------------------------------------------------------

describe('mcp-guidance-hook — output structure', () => {
  it('always outputs { continue: true }', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'no keyword here' }),
    );

    assert.ok(result.parsed, 'Output must be valid JSON');
    assert.strictEqual(result.parsed.continue, true, 'continue must always be true');
  });

  it('always outputs suppressOutput: true', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'tell me about mcp' }),
    );

    assert.ok(result.parsed);
    assert.strictEqual(result.parsed.suppressOutput, true, 'suppressOutput must always be true');
  });

  it('hookEventName is UserPromptSubmit when context is injected', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'adding mcp server' }),
    );

    assert.ok(result.parsed?.hookSpecificOutput);
    assert.strictEqual(
      result.parsed.hookSpecificOutput.hookEventName,
      'UserPromptSubmit',
    );
  });

  it('additionalContext is a string when injected', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      JSON.stringify({ user_prompt: 'mcp question' }),
    );

    assert.ok(result.parsed?.hookSpecificOutput);
    assert.strictEqual(typeof result.parsed.hookSpecificOutput.additionalContext, 'string');
    assert.ok(
      result.parsed.hookSpecificOutput.additionalContext.length > 0,
      'additionalContext must not be empty',
    );
  });

  it('hook exits with status 0 on malformed stdin', () => {
    const tmpDir = createTempProjectDir();
    const result = runHook(
      { CLAUDE_PROJECT_DIR: tmpDir },
      'not valid json at all',
    );

    assert.strictEqual(result.status, 0, 'Hook must not crash on malformed stdin');
    assert.ok(result.parsed, 'Must still produce valid JSON output');
    assert.strictEqual(result.parsed.continue, true);
  });
});
