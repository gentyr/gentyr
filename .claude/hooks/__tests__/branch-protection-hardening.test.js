/**
 * Unit tests for branch protection hardening changes.
 *
 * Covers NEW behavior introduced by the hardening:
 *   1. feature-branch-helper: detectBaseBranch() and isProtectedNonBase()
 *   2. branch-checkout-guard: preview-as-recovery when origin/preview exists;
 *      BLOCKS git checkout main in a target project; promotion pipeline bypass
 *   3. main-tree-commit-guard Layer 1: blocks git add/commit for ALL sessions on
 *      protected non-base branches; allows on base branch; promotion pipeline bypass
 *   4. git-wrappers/git Layer 1: blocks add/commit on protected non-base branches;
 *      promotion pipeline bypass
 *   5. gentyr-sync SessionStart: auto-fix from protected branch to base branch
 *
 * Does NOT duplicate coverage already in:
 *   - branch-checkout-guard.test.js (spawned-only guards, worktree pass-through,
 *     checkout main recovery in no-remote repos, checkout -b blocking)
 *   - main-tree-commit-guard.test.js (spawned-agent stash/clean/pull blocking,
 *     worktree pass-through, non-spawned add/commit on base branch)
 *   - gentyr-sync-branch-drift.test.js (branch-drift-check.js auto-fix behavior)
 *
 * Uses Node.js built-in test runner (node:test).
 * Run with: node --test .claude/hooks/__tests__/branch-protection-hardening.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Shared test utilities
// ============================================================================

/**
 * Create a real git repo in a temp directory on the specified branch.
 * This is required for detectBaseBranch() to work (it runs git rev-parse).
 */
function createGitRepo(dir, branch = 'main') {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'pipe' });
  }
}

/**
 * Add a remote origin/preview so detectBaseBranch() returns 'preview'.
 * Creates a bare repo, sets as origin, pushes the named branch.
 * Returns the bare dir path (caller should clean up).
 */
function addRemotePreview(dir) {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-remote-preview-'));
  execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: dir, stdio: 'pipe' });
  // Create preview locally, push it, then delete local copy
  const currentBranch = execFileSync('git', ['branch', '--show-current'], {
    cwd: dir, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  if (currentBranch !== 'preview') {
    try {
      execFileSync('git', ['branch', 'preview'], { cwd: dir, stdio: 'pipe' });
    } catch (_) { /* already exists — expected */ }
  }
  execFileSync('git', ['push', 'origin', 'preview'], { cwd: dir, stdio: 'pipe' });
  if (currentBranch !== 'preview') {
    try {
      execFileSync('git', ['branch', '-D', 'preview'], { cwd: dir, stdio: 'pipe' });
    } catch (_) { /* branch delete failed — non-fatal in test setup */ }
  }
  return bareDir;
}

/**
 * Run the branch-checkout-guard PreToolUse hook with JSON on stdin.
 * Returns { exitCode, stdout, stderr, parsed }.
 */
async function runCheckoutGuardHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const hookPath = path.join(__dirname, '..', 'branch-checkout-guard.js');
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    };
    const child = spawn('node', [hookPath], spawnOpts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch (_) { /* non-JSON stdout — parse error expected in some cases */ }
      resolve({ exitCode, stdout, stderr, parsed });
    });
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

/**
 * Run the main-tree-commit-guard PreToolUse hook with JSON on stdin.
 * Returns { exitCode, stdout, stderr, parsed }.
 */
async function runCommitGuardHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const hookPath = path.join(__dirname, '..', 'main-tree-commit-guard.js');
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    };
    const child = spawn('node', [hookPath], spawnOpts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch (_) { /* non-JSON stdout — parse error expected in some cases */ }
      resolve({ exitCode, stdout, stderr, parsed });
    });
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

/**
 * Run the git wrapper script.
 * Returns { exitCode, stdout, stderr }.
 */
function runWrapper(args, opts = {}) {
  const wrapperPath = path.join(__dirname, '..', 'git-wrappers', 'git');
  try {
    const stdout = execFileSync(wrapperPath, args, {
      cwd: opts.cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

/**
 * Run gentyr-sync.js as a subprocess.
 * Returns { exitCode, stdout, stderr, parsed }.
 */
function runGentySync(projectDir, extraEnv = {}) {
  const hookPath = path.join(__dirname, '..', 'gentyr-sync.js');
  try {
    const stdout = execFileSync('node', [hookPath], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_SPAWNED_SESSION: '',
        ...extraEnv,
      },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout.trim()); } catch (_) { /* non-JSON stdout — parse error expected in some cases */ }
    return { exitCode: 0, stdout, stderr: '', parsed };
  } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse((err.stdout || '').trim()); } catch (_) { /* non-JSON stdout — parse error expected in some cases */ }
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      parsed,
    };
  }
}

// ============================================================================
// 1. feature-branch-helper: detectBaseBranch() and isProtectedNonBase()
// ============================================================================

describe('feature-branch-helper detectBaseBranch()', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbh-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  it('returns "main" when origin/preview does not exist', async () => {
    createGitRepo(tmpDir, 'main');
    const { detectBaseBranch } = await import('../lib/feature-branch-helper.js');
    const result = detectBaseBranch(tmpDir);
    assert.strictEqual(result, 'main');
  });

  it('returns "preview" when origin/preview exists', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    const { detectBaseBranch } = await import('../lib/feature-branch-helper.js');
    const result = detectBaseBranch(tmpDir);
    assert.strictEqual(result, 'preview');
  });

  it('returns "main" when directory is not a git repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fbh-nongit-'));
    try {
      const { detectBaseBranch } = await import('../lib/feature-branch-helper.js');
      const result = detectBaseBranch(nonRepo);
      assert.strictEqual(result, 'main');
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('feature-branch-helper isProtectedNonBase()', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbh-protected-'));
    bareDir = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  it('returns true for "main" when base is "preview" (target project)', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('main', tmpDir), true);
  });

  it('returns true for "staging" when base is "preview"', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('staging', tmpDir), true);
  });

  it('returns false for "preview" when base is "preview" (preview IS the base)', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('preview', tmpDir), false);
  });

  it('returns true for "staging" when base is "main" (gentyr repo)', async () => {
    createGitRepo(tmpDir, 'main');
    // No origin/preview — base is main
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('staging', tmpDir), true);
  });

  it('returns true for "preview" when base is "main" (gentyr repo)', async () => {
    createGitRepo(tmpDir, 'main');
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('preview', tmpDir), true);
  });

  it('returns false for "main" when base is "main" (gentyr repo — main IS the base)', async () => {
    createGitRepo(tmpDir, 'main');
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('main', tmpDir), false);
  });

  it('returns false for a feature branch (not in PROTECTED_BRANCHES)', async () => {
    createGitRepo(tmpDir, 'main');
    const { isProtectedNonBase } = await import('../lib/feature-branch-helper.js');
    assert.strictEqual(isProtectedNonBase('feature/something', tmpDir), false);
  });
});

// ============================================================================
// 2. branch-checkout-guard: dynamic recovery path (preview vs main)
// ============================================================================

describe('branch-checkout-guard — dynamic recovery path (PreToolUse hook)', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcg-recovery-'));
    bareDir = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  it('allows git checkout preview when origin/preview exists (preview is recovery path)', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout preview' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.allow, true, 'git checkout preview should be allowed when origin/preview exists');
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  it('blocks git checkout main when origin/preview exists (main is not the recovery path)', async () => {
    createGitRepo(tmpDir, 'preview');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout main' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
  });

  it('allows git checkout main when no origin/preview exists (main is the recovery path)', async () => {
    createGitRepo(tmpDir, 'main');
    // No remote — detectBaseBranch() returns 'main'

    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout main' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.allow, true);
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  it('blocks git checkout staging regardless of base branch', async () => {
    createGitRepo(tmpDir, 'main');

    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout staging' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
  });

  it('recovery message includes the correct base branch name', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout main' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(
      result.parsed.permissionDecisionReason.includes("git checkout preview"),
      'recovery message should reference the actual base branch (preview)',
    );
  });
});

describe('branch-checkout-guard — promotion pipeline bypass (PreToolUse hook)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcg-promo-'));
    createGitRepo(tmpDir, 'main');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows git checkout -b feature/anything when GENTYR_PROMOTION_PIPELINE=true', async () => {
    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -b feature/anything' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir, GENTYR_PROMOTION_PIPELINE: 'true' } });

    assert.strictEqual(result.parsed.allow, true);
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  it('allows git checkout staging when GENTYR_PROMOTION_PIPELINE=true', async () => {
    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout staging' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir, GENTYR_PROMOTION_PIPELINE: 'true' } });

    assert.strictEqual(result.parsed.allow, true);
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  it('blocks git checkout staging without GENTYR_PROMOTION_PIPELINE (control)', async () => {
    const result = await runCheckoutGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout staging' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
  });
});

// ============================================================================
// 3. main-tree-commit-guard Layer 1 (PreToolUse hook, ALL sessions)
// ============================================================================

describe('main-tree-commit-guard Layer 1 — protected non-base branch (PreToolUse hook)', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtcg-l1-'));
    bareDir = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  // --- Target project (origin/preview exists, base=preview) ---

  it('blocks git add on "main" for interactive session when base is preview', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    // Interactive session (no CLAUDE_SPAWNED_SESSION)
    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
    assert.ok(result.parsed.permissionDecisionReason.includes("'main'"));
  });

  it('blocks git commit on "main" for interactive session when base is preview', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "oops"' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
  });

  it('blocks git add on "staging" for interactive session when base is preview', async () => {
    createGitRepo(tmpDir, 'staging');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add src/file.ts' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
    assert.ok(result.parsed.permissionDecisionReason.includes("'staging'"));
  });

  it('allows git add on "preview" for interactive session when base is preview', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    execFileSync('git', ['checkout', '-b', 'preview'], { cwd: tmpDir, stdio: 'pipe' });

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    // preview IS the base branch — should be allowed by Layer 1
    assert.strictEqual(result.parsed.allow, true);
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  // --- Gentyr repo (no origin/preview, base=main) ---

  it('blocks git add on "staging" for interactive session when base is main', async () => {
    createGitRepo(tmpDir, 'staging');

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
    assert.ok(result.parsed.permissionDecisionReason.includes("'staging'"));
  });

  it('blocks git commit on "staging" for interactive session when base is main', async () => {
    createGitRepo(tmpDir, 'staging');

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(result.parsed.permissionDecisionReason.includes('BLOCKED'));
  });

  it('allows git add on "main" for interactive session when base is main', async () => {
    createGitRepo(tmpDir, 'main');

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.allow, true);
    assert.strictEqual(result.parsed.permissionDecision, undefined);
  });

  it('Layer 1 block message includes the feature/* -> base -> staging -> main chain', async () => {
    createGitRepo(tmpDir, 'staging');

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir } });

    assert.strictEqual(result.parsed.permissionDecision, 'deny');
    assert.ok(
      result.parsed.permissionDecisionReason.includes('feature/*'),
      'denial reason should describe the merge chain',
    );
    assert.ok(
      result.parsed.permissionDecisionReason.includes('checkout -b feature/'),
      'denial reason should suggest creating a feature branch',
    );
  });

  // --- Promotion pipeline bypass ---

  it('allows git add on "staging" when GENTYR_PROMOTION_PIPELINE=true (interactive)', async () => {
    createGitRepo(tmpDir, 'staging');

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir, GENTYR_PROMOTION_PIPELINE: 'true' } });

    assert.strictEqual(result.parsed.allow, true);
  });

  it('allows git commit on "main" when GENTYR_PROMOTION_PIPELINE=true and base is preview', async () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = await runCommitGuardHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "promote"' },
    }, { env: { CLAUDE_PROJECT_DIR: tmpDir, GENTYR_PROMOTION_PIPELINE: 'true' } });

    assert.strictEqual(result.parsed.allow, true);
  });
});

// ============================================================================
// 4. git-wrappers/git Layer 1 (shell wrapper, ALL sessions)
// ============================================================================

describe('git-wrappers/git Layer 1 — protected non-base branch (shell wrapper)', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitwrap-l1-'));
    bareDir = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  // --- Target project: origin/preview exists, base=preview ---

  it('blocks git add on "main" for non-spawned session when origin/preview exists', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    // Not a spawned agent — the Layer 1 check fires for all sessions
    const result = runWrapper(['add', '.'], {
      cwd: tmpDir,
      // No CLAUDE_SPAWNED_SESSION — interactive / non-spawned
    });

    assert.strictEqual(result.exitCode, 128);
    assert.ok(result.stderr.includes('BLOCKED'));
    assert.ok(result.stderr.includes("'main'"));
  });

  it('blocks git commit on "main" for non-spawned session when origin/preview exists', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = runWrapper(['commit', '-m', 'oops'], { cwd: tmpDir });

    assert.strictEqual(result.exitCode, 128);
    assert.ok(result.stderr.includes('BLOCKED'));
  });

  it('blocks git add on "staging" for non-spawned session when origin/preview exists', () => {
    createGitRepo(tmpDir, 'staging');
    bareDir = addRemotePreview(tmpDir);

    const result = runWrapper(['add', '.'], { cwd: tmpDir });

    assert.strictEqual(result.exitCode, 128);
    assert.ok(result.stderr.includes('BLOCKED'));
    assert.ok(result.stderr.includes("'staging'"));
  });

  it('does NOT block git add on "preview" when base is preview (preview is base)', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    execFileSync('git', ['checkout', '-b', 'preview'], { cwd: tmpDir, stdio: 'pipe' });

    // preview IS the base branch — Layer 1 should not block
    const result = runWrapper(['add', '.'], { cwd: tmpDir });

    // May fail for real git reasons (nothing staged) but must NOT be a BLOCKED error
    assert.ok(!result.stderr.includes('BLOCKED'), 'preview (base) should not be blocked');
  });

  // --- Gentyr repo: no origin/preview, base=main ---

  it('blocks git add on "staging" for non-spawned session when base is main', () => {
    createGitRepo(tmpDir, 'staging');

    const result = runWrapper(['add', '.'], { cwd: tmpDir });

    assert.strictEqual(result.exitCode, 128);
    assert.ok(result.stderr.includes('BLOCKED'));
    assert.ok(result.stderr.includes("'staging'"));
  });

  it('does NOT block git add on "main" when base is main (main is base)', () => {
    createGitRepo(tmpDir, 'main');

    const result = runWrapper(['add', '.'], { cwd: tmpDir });

    // May fail for real git reasons, but must not emit BLOCKED
    assert.ok(!result.stderr.includes('BLOCKED'), 'main (base in gentyr repo) should not be blocked');
  });

  // --- Promotion pipeline bypass ---

  it('allows git add on "staging" when GENTYR_PROMOTION_PIPELINE=true', () => {
    createGitRepo(tmpDir, 'staging');

    const result = runWrapper(['add', '.'], {
      cwd: tmpDir,
      env: { GENTYR_PROMOTION_PIPELINE: 'true' },
    });

    assert.ok(!result.stderr.includes('BLOCKED'), 'promotion pipeline must bypass Layer 1');
  });

  it('allows git commit on "main" when GENTYR_PROMOTION_PIPELINE=true (target project)', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const result = runWrapper(['commit', '-m', 'promote'], {
      cwd: tmpDir,
      env: { GENTYR_PROMOTION_PIPELINE: 'true' },
    });

    assert.ok(!result.stderr.includes('BLOCKED'), 'promotion pipeline must bypass Layer 1');
  });

  // --- Layer 1 message content ---

  it('Layer 1 block message includes the merge chain description', () => {
    createGitRepo(tmpDir, 'staging');

    const result = runWrapper(['add', '.'], { cwd: tmpDir });

    assert.strictEqual(result.exitCode, 128);
    assert.ok(
      result.stderr.includes('feature/*'),
      'block message should describe the merge chain',
    );
    assert.ok(
      result.stderr.includes('checkout -b feature/'),
      'block message should suggest creating a feature branch',
    );
  });
});

// ============================================================================
// 5. gentyr-sync SessionStart — auto-fix from protected branch to base
//
// gentyr-sync resolves a framework dir via resolveFrameworkDir(). Without a
// framework it calls silent() immediately, before reaching the branch
// protection code. Tests must create a minimal mock framework so the hook
// continues past that gate.
//
// We use the `.claude-framework` resolution path (option 2 in resolveFrameworkDir)
// because it requires no symlinks. We also write a matching gentyr-state.json +
// settings.json + .mcp.json so the fast-path fires and skips the actual sync.
// ============================================================================

const MOCK_SETTINGS_TEMPLATE = JSON.stringify({ hooks: {} });
const MOCK_MCP_TEMPLATE = JSON.stringify({ mcpServers: {} });

function computeMockConfigHash() {
  const hash = crypto.createHash('sha256');
  hash.update(MOCK_SETTINGS_TEMPLATE);
  hash.update(MOCK_MCP_TEMPLATE);
  return hash.digest('hex');
}

/**
 * Create a minimal mock .claude-framework directory inside projectDir
 * so that resolveFrameworkDir() resolves it and the hook proceeds past
 * the `if (!frameworkDir) silent()` gate.
 */
function createMockFramework(projectDir) {
  const frameworkDir = path.join(projectDir, '.claude-framework');
  fs.mkdirSync(path.join(frameworkDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(frameworkDir, 'version.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(frameworkDir, '.claude', 'settings.json.template'), MOCK_SETTINGS_TEMPLATE);
  fs.writeFileSync(path.join(frameworkDir, '.mcp.json.template'), MOCK_MCP_TEMPLATE);
  return frameworkDir;
}

/**
 * Write a matching gentyr-state.json + settings.json + .mcp.json so the
 * statBasedSync() fast-path fires and exits early (no real sync attempt).
 * This lets the branch protection code at the bottom of gentyr-sync execute.
 */
function setupFastPath(projectDir) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // State file is at .claude/gentyr-state.json (not .claude/state/)
  fs.writeFileSync(path.join(claudeDir, 'gentyr-state.json'), JSON.stringify({
    version: '9.9.9',
    configHash: computeMockConfigHash(),
    claudeMdHash: '',
    agentList: [],
    lastSync: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{}');
}

describe('gentyr-sync — SessionStart auto-fix from protected branch', () => {
  let tmpDir;
  let bareDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-sync-autofix-'));
    bareDir = null;
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    createMockFramework(tmpDir);
    setupFastPath(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (bareDir) {
      fs.rmSync(bareDir, { recursive: true, force: true });
      bareDir = null;
    }
  });

  it('warns and auto-switches from "staging" to "main" when base is main and no uncommitted changes', () => {
    createGitRepo(tmpDir, 'staging');

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('BRANCH AUTO-FIX') || parsed.systemMessage.includes("'staging'"),
      'should reference auto-fix or the protected branch',
    );
  });

  it('warns and auto-switches from "preview" to "main" when no origin/preview exists', () => {
    // preview is a protected branch when base is main (gentyr repo scenario)
    createGitRepo(tmpDir, 'preview');

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('BRANCH AUTO-FIX') || parsed.systemMessage.includes("'preview'"),
      'should reference auto-fix or the branch name',
    );
    assert.ok(
      parsed.systemMessage.includes('main'),
      'should reference the target base branch (main)',
    );
  });

  it('warns and auto-switches from "main" to "preview" when origin/preview exists', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    assert.ok(
      parsed.systemMessage.includes('BRANCH AUTO-FIX') || parsed.systemMessage.includes("'main'"),
      'should reference auto-fix or the protected branch (main)',
    );
    assert.ok(
      parsed.systemMessage.includes('preview'),
      'should reference the target base branch (preview)',
    );
  });

  it('emits a warning (not auto-fix) when on protected branch with uncommitted changes', () => {
    createGitRepo(tmpDir, 'staging');
    // Add an uncommitted file so auto-fix cannot run
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted change');

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    assert.ok(parsed.systemMessage, 'should emit a systemMessage');
    // Should warn but not claim it switched (has uncommitted changes, can't switch)
    assert.ok(
      parsed.systemMessage.includes('WARNING') || parsed.systemMessage.includes("'staging'"),
      'should warn about protected branch',
    );
    assert.ok(
      parsed.systemMessage.includes('stash') || parsed.systemMessage.includes('git checkout'),
      'should include recovery instructions',
    );
  });

  it('does not emit a branch auto-fix message when on the correct base branch (main with no origin/preview)', () => {
    createGitRepo(tmpDir, 'main');

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    // Should not mention branch protection warnings
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH AUTO-FIX'),
        'should not auto-fix when already on the base branch',
      );
    }
  });

  it('does not emit a branch auto-fix message when on preview with origin/preview exists (preview is base)', () => {
    createGitRepo(tmpDir, 'main');
    bareDir = addRemotePreview(tmpDir);
    execFileSync('git', ['checkout', '-b', 'preview'], { cwd: tmpDir, stdio: 'pipe' });

    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH AUTO-FIX'),
        'preview is the base branch — should not trigger auto-fix',
      );
    }
  });

  it('does not auto-fix in spawned sessions (exits silently)', () => {
    createGitRepo(tmpDir, 'staging');

    // CLAUDE_SPAWNED_SESSION=true — hook exits immediately (silent)
    const { exitCode, parsed } = runGentySync(tmpDir, { CLAUDE_SPAWNED_SESSION: 'true' });

    assert.strictEqual(exitCode, 0);
    // Spawned sessions get suppressOutput=true — they should not auto-fix
    assert.strictEqual(parsed.suppressOutput, true);
    assert.ok(!parsed.systemMessage, 'spawned sessions should not emit branch messages');
  });

  it('exits 0 and continues when not in a git repo (no .git directory)', () => {
    // tmpDir has .claude and mock framework but no .git
    const { exitCode, parsed } = runGentySync(tmpDir);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(parsed.continue, true);
    // Should not crash; branch protection requires a git dir so no auto-fix
    if (parsed.systemMessage) {
      assert.ok(
        !parsed.systemMessage.includes('BRANCH AUTO-FIX'),
        'should not try to auto-fix in a non-repo',
      );
    }
  });
});
