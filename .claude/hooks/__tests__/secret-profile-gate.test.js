/**
 * Unit tests for secret-profile-gate.js (PreToolUse hook)
 *
 * Tests the PreToolUse hook that gates secret_run_command calls when
 * a matching secret profile exists but the agent didn't use it.
 *
 * Tests verify:
 * - No profiles → allow
 * - Profile param set → allow
 * - Matching profile, first attempt → deny
 * - Matching profile, second attempt → allow
 * - Multiple profiles match → deny listing all
 * - commandPattern only, cwdPattern only, both patterns (AND logic)
 * - No match block → never auto-matches
 * - Malformed config → fail-open
 * - State file cleanup
 *
 * Run with: node --test .claude/hooks/__tests__/secret-profile-gate.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

function createTempProject(config = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-profile-gate-test-'));
  const configDir = path.join(tmpDir, '.claude', 'config');
  const stateDir = path.join(tmpDir, '.claude', 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (Object.keys(config).length > 0) {
    fs.writeFileSync(
      path.join(configDir, 'services.json'),
      JSON.stringify(config, null, 2),
    );
  }

  return {
    path: tmpDir,
    stateDir,
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const hookPath = path.join(__dirname, '..', 'secret-profile-gate.js');

    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: hookInput.cwd || '/tmp',
      ...opts.env,
    };

    const proc = spawn('node', [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (exitCode) => {
      resolve({ exitCode: exitCode || 0, stdout, stderr });
    });

    proc.stdin.write(JSON.stringify(hookInput));
    proc.stdin.end();
  });
}

function parseOutput(result) {
  try {
    const jsonMatch = result.stdout.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* ignore */ }
  return null;
}

function assertDenied(result, messageFragment) {
  assert.strictEqual(result.exitCode, 0, 'Hook should exit 0');
  const output = parseOutput(result);
  assert.ok(output, 'Should output JSON');
  assert.strictEqual(
    output?.hookSpecificOutput?.permissionDecision,
    'deny',
    'Should deny the call',
  );
  if (messageFragment) {
    assert.ok(
      output.hookSpecificOutput.permissionDecisionReason.includes(messageFragment),
      `Deny reason should mention: ${messageFragment}`,
    );
  }
}

function assertAllowed(result) {
  assert.strictEqual(result.exitCode, 0, 'Hook should exit 0');
  const output = parseOutput(result);
  if (output?.hookSpecificOutput?.permissionDecision) {
    assert.notStrictEqual(
      output.hookSpecificOutput.permissionDecision,
      'deny',
      'Should NOT deny the call',
    );
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('secret-profile-gate: no profiles configured', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTempProject({ secrets: { local: {} } });
  });

  afterEach(() => tmp.cleanup());

  it('should allow when no secretProfiles in config', async () => {
    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'vitest', 'run'] },
      cwd: tmp.path,
    });
    assertAllowed(result);
  });

  it('should allow non-secret_run_command tools', async () => {
    const result = await runHook({
      tool_name: 'mcp__todo-db__create_task',
      tool_input: { title: 'test' },
      cwd: tmp.path,
    });
    assertAllowed(result);
  });
});

describe('secret-profile-gate: profile param provided', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTempProject({
      secretProfiles: {
        'aws-login': {
          secretKeys: ['AWS_ROOT_EMAIL', 'AWS_ROOT_PASSWORD'],
          match: { commandPattern: 'vitest.*aws' },
        },
      },
      secrets: { local: {} },
    });
  });

  afterEach(() => tmp.cleanup());

  it('should allow when profile param is set', async () => {
    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login-chain'],
        profile: 'aws-login',
      },
      cwd: tmp.path,
    });
    assertAllowed(result);
  });
});

describe('secret-profile-gate: first attempt block', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTempProject({
      secretProfiles: {
        'aws-login': {
          secretKeys: ['AWS_ROOT_EMAIL', 'AWS_ROOT_PASSWORD', 'GMAIL_CLIENT_ID'],
          description: 'AWS root login + MFA',
          match: { commandPattern: 'vitest.*aws-login' },
        },
      },
      secrets: { local: {} },
    });
  });

  afterEach(() => tmp.cleanup());

  it('should deny first attempt when profile matches command', async () => {
    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login-chain'],
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-agent-1' } });

    assertDenied(result, 'aws-login');
    assertDenied(result, 'AWS_ROOT_EMAIL');
    assertDenied(result, 'GMAIL_CLIENT_ID');
    assertDenied(result, 'AWS root login + MFA');
  });

  it('should allow second attempt with same args', async () => {
    // First attempt — blocked
    const result1 = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login-chain'],
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-agent-2' } });
    assertDenied(result1, 'aws-login');

    // Second attempt — allowed
    const result2 = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login-chain'],
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-agent-2' } });
    assertAllowed(result2);
  });
});

describe('secret-profile-gate: multiple profiles match', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTempProject({
      secretProfiles: {
        'aws-creds': {
          secretKeys: ['AWS_ROOT_EMAIL', 'AWS_ROOT_PASSWORD'],
          match: { commandPattern: 'vitest.*aws' },
        },
        'gmail-oauth': {
          secretKeys: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'],
          match: { commandPattern: 'vitest.*aws' },
        },
      },
      secrets: { local: {} },
    });
  });

  afterEach(() => tmp.cleanup());

  it('should deny listing all matching profiles', async () => {
    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login-chain'],
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-agent-multi' } });

    assertDenied(result, 'aws-creds');
    assertDenied(result, 'gmail-oauth');
  });
});

describe('secret-profile-gate: match patterns', () => {
  let tmp;

  afterEach(() => tmp?.cleanup());

  it('should match on commandPattern only', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'cmd-only': {
          secretKeys: ['KEY_A'],
          match: { commandPattern: 'vitest.*special' },
        },
      },
      secrets: { local: {} },
    });

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'vitest', 'run', 'special-test'] },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-cmd-only' } });
    assertDenied(result, 'cmd-only');
  });

  it('should match on cwdPattern only', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'cwd-only': {
          secretKeys: ['KEY_B'],
          match: { cwdPattern: '*/aws-integration' },
        },
      },
      secrets: { local: {} },
    });

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'test'],
        cwd: '/project/e2e/aws-integration',
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-cwd-only' } });
    assertDenied(result, 'cwd-only');
  });

  it('should require both patterns to match (AND logic)', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'both-required': {
          secretKeys: ['KEY_C'],
          match: {
            commandPattern: 'vitest.*aws',
            cwdPattern: '*/aws-integration',
          },
        },
      },
      secrets: { local: {} },
    });

    // Command matches but cwd doesn't → allow
    const result1 = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login'],
        cwd: '/project/e2e/other-dir',
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-and-1' } });
    assertAllowed(result1);

    // Both match → deny
    const result2 = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: {
        command: ['npx', 'vitest', 'run', 'aws-login'],
        cwd: '/project/e2e/aws-integration',
      },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-and-2' } });
    assertDenied(result2, 'both-required');
  });

  it('should never auto-match profile with no match block', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'no-match': {
          secretKeys: ['KEY_D'],
          // no match property
        },
      },
      secrets: { local: {} },
    });

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'anything'] },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-no-match' } });
    assertAllowed(result);
  });

  it('should not match when commandPattern does not match', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'specific': {
          secretKeys: ['KEY_E'],
          match: { commandPattern: 'vitest.*aws' },
        },
      },
      secrets: { local: {} },
    });

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'vitest', 'run', 'unit-tests'] },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-no-cmd-match' } });
    assertAllowed(result);
  });
});

describe('secret-profile-gate: error handling', () => {
  let tmp;

  afterEach(() => tmp?.cleanup());

  it('should fail-open on malformed services.json', async () => {
    tmp = createTempProject();
    // Write invalid JSON
    fs.writeFileSync(
      path.join(tmp.path, '.claude', 'config', 'services.json'),
      'not valid json {{{',
    );

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'test'] },
      cwd: tmp.path,
    });
    assertAllowed(result);
  });

  it('should fail-open on missing services.json', async () => {
    tmp = createTempProject();
    // No services.json written

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'test'] },
      cwd: tmp.path,
    });
    assertAllowed(result);
  });

  it('should fail-open on invalid regex in commandPattern', async () => {
    tmp = createTempProject({
      secretProfiles: {
        'bad-regex': {
          secretKeys: ['KEY_F'],
          match: { commandPattern: '[invalid(regex' },
        },
      },
      secrets: { local: {} },
    });

    const result = await runHook({
      tool_name: 'mcp__secret-sync__secret_run_command',
      tool_input: { command: ['npx', 'test'] },
      cwd: tmp.path,
    }, { env: { CLAUDE_AGENT_ID: 'test-bad-regex' } });
    assertAllowed(result);
  });
});
