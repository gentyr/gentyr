/**
 * Tests for the baseRef-aware Read deny added to audit-lane-guard.js.
 *
 * PR 3 (Fix 2) — when the auditor's queue row has metadata.baseRef set,
 * bare Read of tracked source files must be DENIED with a deny message
 * pointing at `git show origin/<baseRef>:<path>`. Allowed: .claude/ paths,
 * lockfiles, JSON/YAML/TOML configs, untracked files, files outside
 * PROJECT_DIR. Pre-existing deny rules (Edit/Write/NotebookEdit/Task/
 * code-modifying-Bash/wait-loops) must continue to fire identically.
 *
 * Run with: node --test .claude/hooks/__tests__/audit-lane-guard-read.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'audit-lane-guard.js');

// Mirrors the queue_items columns the hook touches. We only need id +
// metadata for the baseRef lookup, but include the full set so SQLite's
// CREATE TABLE matches the production schema (this also exercises that
// the hook only reads `metadata` rather than relying on adjacent columns).
const QUEUE_SCHEMA_SQL = `
  CREATE TABLE queue_items (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    priority TEXT NOT NULL DEFAULT 'normal',
    lane TEXT NOT NULL DEFAULT 'standard',
    spawn_type TEXT NOT NULL DEFAULT 'fresh',
    title TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL DEFAULT '',
    hook_type TEXT NOT NULL DEFAULT '',
    tag_context TEXT NOT NULL DEFAULT '',
    prompt TEXT,
    model TEXT,
    cwd TEXT,
    mcp_config TEXT,
    resume_session_id TEXT,
    extra_args TEXT,
    extra_env TEXT,
    project_dir TEXT NOT NULL DEFAULT '',
    worktree_path TEXT,
    metadata TEXT,
    source TEXT NOT NULL DEFAULT '',
    agent TEXT,
    agent_id TEXT,
    pid INTEGER,
    enqueued_at TEXT,
    spawned_at TEXT,
    completed_at TEXT,
    error TEXT,
    expires_at TEXT
  );
`;

function createTestProject({ withQueueRow = true, baseRef = 'preview', taskId = 't1', taskType = 'persistent' } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alguard-test-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'state'), { recursive: true });
  // Initialize as a git repo with a tracked source file so the deny path
  // can complete its git ls-files check.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: projectDir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: projectDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(projectDir, 'tracked.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"test"}\n');
  fs.writeFileSync(path.join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(projectDir, 'untracked.ts'), 'export const y = 2;\n');
  spawnSync('git', ['add', 'tracked.ts', 'package.json', 'pnpm-lock.yaml'], { cwd: projectDir, stdio: 'ignore' });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  const db = new Database(dbPath);
  db.exec(QUEUE_SCHEMA_SQL);
  if (withQueueRow) {
    const meta = { taskId, taskType, baseRef };
    db.prepare('INSERT INTO queue_items (id, lane, metadata) VALUES (?, ?, ?)').run('sq-test-audit', 'audit', JSON.stringify(meta));
  }
  db.close();
  return projectDir;
}

function runHook(projectDir, toolName, toolInput, opts = {}) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    GENTYR_SESSION_LANE: opts.skipLane ? '' : 'audit',
  };
  if (opts.queueId !== false) env.CLAUDE_QUEUE_ID = opts.queueId || 'sq-test-audit';
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, transcript_path: '' }),
    encoding: 'utf8',
    env,
    timeout: 5000,
  });
  if (result.status !== 0) {
    throw new Error(`hook exited non-zero (${result.status}): stderr=${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

let projectDir;

beforeEach(() => { projectDir = createTestProject(); });
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

describe('audit-lane-guard — Read enforcement when baseRef is set', () => {
  it('DENIES Read on tracked .ts source file', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'tracked.ts' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /tracked source file/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /git show origin\/preview:tracked\.ts/);
  });

  it('ALLOWS Read on package.json (config — always allowed)', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'package.json' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('ALLOWS Read on pnpm-lock.yaml (lockfile — always allowed)', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'pnpm-lock.yaml' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('ALLOWS Read on untracked.ts (not in git index)', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'untracked.ts' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('ALLOWS Read on .claude/state/something.json (.claude/ whitelist)', () => {
    fs.writeFileSync(path.join(projectDir, '.claude', 'state', 'something.json'), '{}');
    const out = runHook(projectDir, 'Read', { file_path: '.claude/state/something.json' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('ALLOWS Read on files outside PROJECT_DIR', () => {
    const out = runHook(projectDir, 'Read', { file_path: '/etc/hostname' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('does NOT enforce when baseRef is missing from metadata', () => {
    fs.rmSync(path.join(projectDir, '.claude', 'state', 'session-queue.db'));
    const db = new Database(path.join(projectDir, '.claude', 'state', 'session-queue.db'));
    db.exec(QUEUE_SCHEMA_SQL);
    db.prepare('INSERT INTO queue_items (id, lane, metadata) VALUES (?, ?, ?)').run(
      'sq-test-audit', 'audit',
      JSON.stringify({ taskId: 't1', taskType: 'persistent' }), // no baseRef
    );
    db.close();
    const out = runHook(projectDir, 'Read', { file_path: 'tracked.ts' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('does NOT enforce when CLAUDE_QUEUE_ID is unset', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'tracked.ts' }, { queueId: false });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('does NOT enforce outside audit lane', () => {
    const out = runHook(projectDir, 'Read', { file_path: 'tracked.ts' }, { skipLane: true });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('DENIES Read on tracked .md file (source extension)', () => {
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: projectDir, stdio: 'ignore' });
    spawnSync('git', ['commit', '-q', '-m', 'add readme'], { cwd: projectDir, stdio: 'ignore' });
    const out = runHook(projectDir, 'Read', { file_path: 'README.md' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /git show origin\/preview:README\.md/);
  });
});

describe('audit-lane-guard — pre-existing deny rules unchanged', () => {
  it('still DENIES Edit', () => {
    const out = runHook(projectDir, 'Edit', { file_path: 'x', old_string: 'a', new_string: 'b' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Edit is BLOCKED/);
  });

  it('still DENIES Task', () => {
    const out = runHook(projectDir, 'Task', { description: 'x', prompt: 'y' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Task .* is BLOCKED/);
  });

  it('still DENIES Bash with code-modifying command', () => {
    const out = runHook(projectDir, 'Bash', { command: 'git commit -m "test"' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /git commit/);
  });

  it('still DENIES Bash with wait-loop pattern', () => {
    const out = runHook(projectDir, 'Bash', { command: 'until [ -f x ]; do sleep 5; done' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /wait-loop/);
  });
});
