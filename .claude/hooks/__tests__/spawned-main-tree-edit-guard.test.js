/**
 * Tests for `.claude/hooks/spawned-main-tree-edit-guard.js`.
 *
 * Covers the four routing cases:
 *   1. spawned + main-tree path -> DENY
 *   2. spawned + worktree path -> ALLOW
 *   3. spawned + .claude/ path -> ALLOW
 *   4. interactive (no CLAUDE_SPAWNED_SESSION) -> ALLOW (fast-exit)
 *
 * Also: path resolution against CWD (relative paths), non-targeted tools
 * fast-exit, and missing PROJECT_DIR fail-closed behavior.
 *
 * Run with: node --test .claude/hooks/__tests__/spawned-main-tree-edit-guard.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'spawned-main-tree-edit-guard.js');

function runHook({ event, env = {}, cwd }) {
  const result = spawnSync('node', [HOOK_PATH], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? '' },
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 5000,
  });
  // Hook MUST exit 0 always
  assert.equal(result.status, 0, `hook exited non-zero: stderr=${result.stderr}`);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch (err) {
    assert.fail(`hook stdout was not valid JSON: ${result.stdout} (err: ${err.message})`);
  }
  return parsed;
}

function isAllowed(out) {
  if (out.decision === 'approve') return true;
  if (out.hookSpecificOutput?.permissionDecision === 'allow') return true;
  return false;
}

function isDenied(out) {
  return out.hookSpecificOutput?.permissionDecision === 'deny';
}

let projectDir;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-test-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'worktrees', 'feature-x'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'state'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src', 'components'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

describe('spawned-main-tree-edit-guard', () => {
  it('DENIES Write into main tree from spawned agent', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'src', 'components', 'foo.tsx'), content: 'x' },
      },
    });
    assert.ok(isDenied(out), `expected deny, got ${JSON.stringify(out)}`);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /main tree/i);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /submit_bypass_request/);
  });

  it('ALLOWS Write into worktree from spawned agent', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, '.claude', 'worktrees', 'feature-x', 'src', 'foo.tsx'), content: 'x' },
      },
    });
    assert.ok(isAllowed(out), `expected allow, got ${JSON.stringify(out)}`);
  });

  it('ALLOWS Write into .claude/state/ from spawned agent', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, '.claude', 'state', 'progress.json'), content: '{}' },
      },
    });
    assert.ok(isAllowed(out), `expected allow, got ${JSON.stringify(out)}`);
  });

  it('ALLOWS Write outside project tree entirely (e.g. /tmp)', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/scratch.txt', content: 'x' },
      },
    });
    assert.ok(isAllowed(out), `expected allow, got ${JSON.stringify(out)}`);
  });

  it('ALLOWS for interactive session (no CLAUDE_SPAWNED_SESSION)', () => {
    const out = runHook({
      env: { CLAUDE_PROJECT_DIR: projectDir, CLAUDE_SPAWNED_SESSION: '' },
      event: {
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'src', 'components', 'foo.tsx'), content: 'x' },
      },
    });
    assert.ok(isAllowed(out), `expected allow (interactive bypass), got ${JSON.stringify(out)}`);
  });

  it('ALLOWS non-targeted tools (e.g. Read)', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Read',
        tool_input: { file_path: path.join(projectDir, 'src', 'foo.tsx') },
      },
    });
    assert.ok(isAllowed(out), `expected allow, got ${JSON.stringify(out)}`);
  });

  it('DENIES Edit into main tree from spawned agent', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src', 'components', 'foo.tsx'),
          old_string: 'a',
          new_string: 'b',
        },
      },
    });
    assert.ok(isDenied(out));
  });

  it('DENIES NotebookEdit into main tree from spawned agent', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      event: {
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: path.join(projectDir, 'notebooks', 'foo.ipynb') },
      },
    });
    assert.ok(isDenied(out));
  });

  it('Resolves relative paths against CWD — relative path with CWD = main tree -> DENY', () => {
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      cwd: projectDir, // CWD is the polluted main tree
      event: {
        tool_name: 'Write',
        tool_input: { file_path: 'src/components/foo.tsx', content: 'x' },
      },
    });
    assert.ok(isDenied(out), `expected deny on relative-path-resolving-to-main-tree, got ${JSON.stringify(out)}`);
  });

  it('Resolves relative paths against CWD — relative path with CWD = worktree -> ALLOW', () => {
    const wtCwd = path.join(projectDir, '.claude', 'worktrees', 'feature-x');
    fs.mkdirSync(path.join(wtCwd, 'src'), { recursive: true });
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      cwd: wtCwd,
      event: {
        tool_name: 'Write',
        tool_input: { file_path: 'src/foo.tsx', content: 'x' },
      },
    });
    assert.ok(isAllowed(out), `expected allow when relative path resolves into worktree, got ${JSON.stringify(out)}`);
  });

  it('Resolves path-traversal attempts correctly (../ escape from worktree into main tree -> DENY)', () => {
    const wtCwd = path.join(projectDir, '.claude', 'worktrees', 'feature-x');
    const out = runHook({
      env: { CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      cwd: wtCwd,
      event: {
        tool_name: 'Write',
        tool_input: { file_path: '../../../src/foo.tsx', content: 'x' },
      },
    });
    assert.ok(isDenied(out), `expected deny on ../ escape into main tree, got ${JSON.stringify(out)}`);
  });

  it('Fails closed (DENY) on malformed JSON input', () => {
    const result = spawnSync('node', [HOOK_PATH], {
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true', CLAUDE_PROJECT_DIR: projectDir },
      input: 'not-valid-json{',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.ok(isDenied(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /G001/);
  });
});
