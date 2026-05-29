/**
 * Fix 6 of the toasty-skipping-penguin plan.
 *
 * The pr-base-guard.js PreToolUse hook should:
 *   - Allow `gh pr create --head X --base Y` from anywhere.
 *   - Allow any `gh pr create` from inside a feature worktree.
 *   - DENY bare `gh pr create` when effective cwd is the main tree AND the
 *     main tree is on a protected branch (main/preview/staging).
 *   - Allow everything when GENTYR_PROMOTION_PIPELINE=true.
 *
 * We exercise the hook by spawning it as a Node subprocess with stdin =
 * the event JSON. The hook is small enough that this E2E shape is the
 * cleanest test surface.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const HOOK = path.resolve(path.dirname(__filename), '..', 'pr-base-guard.js');

function runHook(event, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(opts.env || {}) };
    delete env.GENTYR_PROMOTION_PIPELINE;
    if (opts.env?.GENTYR_PROMOTION_PIPELINE !== undefined) {
      env.GENTYR_PROMOTION_PIPELINE = opts.env.GENTYR_PROMOTION_PIPELINE;
    }
    const child = spawn('node', [HOOK], {
      env,
      cwd: opts.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

function parse(stdout) {
  try { return JSON.parse(stdout.trim()); } catch { return null; }
}

describe('pr-base-guard.js (Fix 6 — bare gh pr create from main tree)', () => {
  let tmpDir;
  let mainTreeCwd;
  let worktreeCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-base-guard-'));
    // Simulate a project structure:
    //   $tmpDir/                          ← main tree (.git here)
    //   $tmpDir/.claude/worktrees/feat-X/  ← feature worktree
    mainTreeCwd = tmpDir;
    execFileSync('git', ['init', '-q', '-b', 'preview'], { cwd: mainTreeCwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: mainTreeCwd });
    // The hook reads `git -C <cwd> rev-parse --abbrev-ref HEAD` — that
    // works on the same .git as long as cwd is inside the repo.
    worktreeCwd = path.join(mainTreeCwd, '.claude', 'worktrees', 'feat-X');
    fs.mkdirSync(worktreeCwd, { recursive: true });
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('ALLOWS gh pr create --head X --base Y from main tree', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --head feature/x --base preview --title foo' },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.continue, true, `Expected allow, got: ${res.stdout}`);
  });

  it('DENIES bare gh pr create from main tree on protected branch (preview)', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title foo --body bar' },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', `Expected deny, got: ${res.stdout}`);
    assert.match(out?.hookSpecificOutput?.permissionDecisionReason || '', /Refusing bare/);
    assert.match(out?.hookSpecificOutput?.permissionDecisionReason || '', /preview/);
  });

  it('DENIES bare `cd $main && gh pr create` (the L14205 xy footgun)', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: `cd ${mainTreeCwd} && gh pr create --title foo` },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('ALLOWS bare gh pr create from inside a feature worktree', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title foo --body bar' },
    }, { cwd: worktreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.continue, true, `Expected allow inside worktree, got: ${res.stdout}`);
  });

  it('ALLOWS everything when GENTYR_PROMOTION_PIPELINE=true', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title foo' },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd, GENTYR_PROMOTION_PIPELINE: 'true' } });
    const out = parse(res.stdout);
    assert.equal(out?.continue, true);
  });

  it('ALLOWS non-Bash tools', async () => {
    const res = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo' },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.continue, true);
  });

  it('ALLOWS commands that are not gh pr create', async () => {
    const res = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr list' },
    }, { cwd: mainTreeCwd, env: { CLAUDE_PROJECT_DIR: mainTreeCwd } });
    const out = parse(res.stdout);
    assert.equal(out?.continue, true);
  });
});
