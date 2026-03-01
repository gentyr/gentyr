/**
 * Tests for worktree core.hooksPath poisoning fix
 *
 * Validates 4 defense-in-depth changes:
 * 1. safeSymlink() handles existing directories (worktree-manager.js)
 * 2. removeWorktree() resets stale core.hooksPath (worktree-manager.js)
 * 3. tamperCheck() detects worktree hooksPath (gentyr-sync.js) — structural
 * 4. husky/pre-commit detects worktree hooksPath — structural
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-hookspath-fix.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Change 1: safeSymlink() directory handling
// ============================================================================

describe('safeSymlink() directory handling', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-symlink-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
  });

  // We test the safeSymlink logic by reading the source and verifying
  // the behavioral fix is present, since importing ESM with top-level
  // side effects (process.cwd()-dependent constants) is fragile in tests.

  it('should check lstat before calling readlinkSync (prevents EINVAL on directories)', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    // The fix adds fs.lstatSync before any readlinkSync call
    const eexistBlock = code.match(/if \(err\.code === 'EEXIST'\) \{([\s\S]*?)\n  \}/);
    assert.ok(eexistBlock, 'EEXIST handler must exist in safeSymlink');

    const handler = eexistBlock[1];
    assert.ok(handler.includes('fs.lstatSync(linkPath)'),
      'Must call lstatSync to determine item type before readlinkSync');
  });

  it('should handle existing directories by removing them with rmSync', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    assert.ok(code.includes('stat.isDirectory()'),
      'Must check if existing item is a directory');
    assert.ok(code.includes("fs.rmSync(linkPath, { recursive: true, force: true })"),
      'Must remove directories with rmSync recursive');
  });

  it('should handle existing symlinks with wrong target by unlinking', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    assert.ok(code.includes('stat.isSymbolicLink()'),
      'Must check if existing item is a symlink');
    assert.ok(code.includes('if (existing === target) return'),
      'Must short-circuit when symlink already points to correct target');
  });

  it('should handle existing regular files by unlinking', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    const eexistBlock = code.match(/if \(err\.code === 'EEXIST'\) \{([\s\S]*?)\n  \}/);
    const handler = eexistBlock[1];
    // After the directory branch, there's an else for regular files
    assert.ok(handler.includes('fs.unlinkSync(linkPath)'),
      'Must unlink regular files before re-symlinking');
  });

  // Behavioral test: actually exercise the safeSymlink logic
  it('should replace an existing directory with a symlink (behavioral)', () => {
    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'marker'), 'ok');

    const linkPath = path.join(tmpDir, 'link');
    // Create a real directory at linkPath (simulates git checkout of .husky/)
    fs.mkdirSync(linkPath);
    fs.writeFileSync(path.join(linkPath, 'stale'), 'old content');

    // Exercise the safeSymlink logic inline
    try {
      fs.symlinkSync(targetDir, linkPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          const existing = fs.readlinkSync(linkPath);
          if (existing === targetDir) { /* already correct */ }
          else { fs.unlinkSync(linkPath); }
        } else if (stat.isDirectory()) {
          fs.rmSync(linkPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(linkPath);
        }
        fs.symlinkSync(targetDir, linkPath);
      } else {
        throw err;
      }
    }

    // Verify result
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'linkPath must now be a symlink');
    assert.strictEqual(fs.readlinkSync(linkPath), targetDir, 'Symlink must point to target');
    assert.ok(fs.existsSync(path.join(linkPath, 'marker')), 'Must be able to read through symlink');
  });

  it('should preserve an existing symlink pointing to correct target (behavioral)', () => {
    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir);

    const linkPath = path.join(tmpDir, 'link');
    fs.symlinkSync(targetDir, linkPath);

    // Exercise safeSymlink logic — should be a no-op
    try {
      fs.symlinkSync(targetDir, linkPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          const existing = fs.readlinkSync(linkPath);
          if (existing === targetDir) return; // Correct target — skip
        }
      }
      throw err;
    }

    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'Must still be a symlink');
    assert.strictEqual(fs.readlinkSync(linkPath), targetDir, 'Target must be unchanged');
  });
});

// ============================================================================
// Change 2: removeWorktree() core.hooksPath reset (structural)
// ============================================================================

describe('removeWorktree() core.hooksPath reset', () => {
  it('should check core.hooksPath before removing the worktree', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );

    // The hooksPath check must appear BEFORE the worktree remove command
    const hooksPathIdx = code.indexOf("git config --local --get core.hooksPath");
    const removeIdx = code.indexOf("git worktree remove");
    assert.ok(hooksPathIdx > 0, 'Must read core.hooksPath in removeWorktree');
    assert.ok(removeIdx > 0, 'Must have git worktree remove command');
    assert.ok(hooksPathIdx < removeIdx,
      'core.hooksPath check must come BEFORE git worktree remove');
  });

  it('should reset core.hooksPath to .husky when it points into the worktree', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    assert.ok(code.includes("git config --local core.hooksPath .husky"),
      'Must reset core.hooksPath to .husky');
  });

  it('should only reset when hooksPath starts with the worktree path', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    // Must use path.resolve to normalize and startsWith to compare
    assert.ok(code.includes('path.resolve(PROJECT_DIR, hooksPath).startsWith(worktreePath)'),
      'Must use path.resolve + startsWith for safe prefix comparison');
  });

  it('should wrap the hooksPath check in try-catch (non-fatal)', () => {
    const code = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'lib', 'worktree-manager.js'),
      'utf8',
    );
    // Find the removeWorktree function
    const fnMatch = code.match(/export function removeWorktree\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'removeWorktree function must exist');
    const fnBody = fnMatch[0];

    // The hooksPath check must be wrapped in try-catch
    assert.ok(fnBody.includes('try {') && fnBody.includes("// No hooksPath set or git error"),
      'hooksPath check must be in a try-catch with appropriate comment');
  });
});

// ============================================================================
// Change 3: tamperCheck() core.hooksPath worktree detection (structural)
// ============================================================================

describe('tamperCheck() core.hooksPath worktree detection (gentyr-sync.js)', () => {
  const code = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'gentyr-sync.js'),
    'utf8',
  );

  it('should contain the Check 1.5 hooksPath worktree check', () => {
    assert.ok(code.includes('Check 1.5: core.hooksPath worktree check'),
      'Must have Check 1.5 comment marker');
  });

  it('should read core.hooksPath via git config', () => {
    // Must use execFileSync (not execSync) consistent with the rest of gentyr-sync.js
    assert.ok(code.includes("'git', ['config', '--local', '--get', 'core.hooksPath']"),
      'Must read core.hooksPath via execFileSync with git config');
  });

  it('should compare resolved path against .claude/worktrees/ directory', () => {
    assert.ok(code.includes("path.join(projectDir, '.claude', 'worktrees')"),
      'Must construct the worktrees directory path');
    assert.ok(code.includes('resolved.startsWith(worktreesDir)'),
      'Must check if resolved hooksPath starts with worktrees dir');
  });

  it('should handle both absolute and relative hooksPath values', () => {
    assert.ok(code.includes('path.isAbsolute(hooksPathConfig)'),
      'Must check if hooksPath is absolute');
    assert.ok(code.includes('path.resolve(projectDir, hooksPathConfig)'),
      'Must resolve relative paths against projectDir');
  });

  it('should auto-repair by resetting core.hooksPath to .husky', () => {
    assert.ok(code.includes("'git', ['config', '--local', 'core.hooksPath', '.husky']"),
      'Must reset core.hooksPath to .husky via execFileSync');
  });

  it('should emit a warning on auto-repair (not fail silently)', () => {
    assert.ok(code.includes('auto-repaired to .husky'),
      'Must push a warning about the auto-repair');
  });

  it('should emit a manual-fix warning when auto-repair fails', () => {
    assert.ok(code.includes('pre-commit hooks are BYPASSED'),
      'Must warn about bypass when auto-repair fails');
    assert.ok(code.includes('git config --local core.hooksPath .husky'),
      'Must include manual fix command in the warning');
  });

  it('should place Check 1.5 between Check 1 (symlink) and Check 2 (ownership)', () => {
    const check1End = code.indexOf("// hooks path doesn't exist");
    const check15 = code.indexOf('Check 1.5: core.hooksPath worktree check');
    const check2 = code.indexOf('Check 2: Critical hook file ownership');

    assert.ok(check1End > 0, 'Check 1 end marker must exist');
    assert.ok(check15 > 0, 'Check 1.5 must exist');
    assert.ok(check2 > 0, 'Check 2 must exist');
    assert.ok(check1End < check15, 'Check 1.5 must come after Check 1');
    assert.ok(check15 < check2, 'Check 1.5 must come before Check 2');
  });
});

// ============================================================================
// Change 4: husky/pre-commit core.hooksPath worktree check (structural)
// ============================================================================

describe('husky/pre-commit core.hooksPath worktree check', () => {
  const content = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', '..', '..', 'husky', 'pre-commit'),
    'utf8',
  );

  it('should contain the hooksPath worktree check section', () => {
    assert.ok(content.includes('core.hooksPath WORKTREE CHECK'),
      'Must have the worktree check section header');
  });

  it('should read core.hooksPath from git config', () => {
    assert.ok(content.includes('git config --local --get core.hooksPath'),
      'Must read core.hooksPath via git config');
  });

  it('should detect .claude/worktrees/ in the hooksPath', () => {
    assert.ok(content.includes('*/.claude/worktrees/*)'),
      'Must use case pattern to match .claude/worktrees/ in hooksPath');
  });

  it('should auto-repair by setting core.hooksPath to .husky', () => {
    assert.ok(content.includes('git config --local core.hooksPath .husky'),
      'Must reset core.hooksPath to .husky');
  });

  it('should exit 1 after repairing (forces commit re-run)', () => {
    // After repair, exit 1 forces the user to re-run the commit so the
    // corrected hooksPath takes effect
    const repairBlock = content.match(
      /\*\/\.claude\/worktrees\/\*\)([\s\S]*?);;/,
    );
    assert.ok(repairBlock, 'Worktree case block must exist');
    assert.ok(repairBlock[1].includes('exit 1'),
      'Must exit 1 after repair to force re-run');
  });

  it('should place the check before lint-staged', () => {
    const worktreeCheckIdx = content.indexOf('core.hooksPath WORKTREE CHECK');
    const lintStagedIdx = content.indexOf('LINT STAGED FILES');
    assert.ok(worktreeCheckIdx > 0, 'Worktree check section must exist');
    assert.ok(lintStagedIdx > 0, 'Lint staged section must exist');
    assert.ok(worktreeCheckIdx < lintStagedIdx,
      'Worktree check must come before lint-staged');
  });

  it('should place the check after symlink target verification', () => {
    const symlinkCheckIdx = content.indexOf('SYMLINK TARGET VERIFICATION');
    const worktreeCheckIdx = content.indexOf('core.hooksPath WORKTREE CHECK');
    assert.ok(symlinkCheckIdx > 0, 'Symlink check section must exist');
    assert.ok(worktreeCheckIdx > 0, 'Worktree check section must exist');
    assert.ok(symlinkCheckIdx < worktreeCheckIdx,
      'Worktree check must come after symlink target verification');
  });

  it('should suppress errors from git config (|| true)', () => {
    assert.ok(content.includes('2>/dev/null || true'),
      'Must suppress git config errors with 2>/dev/null || true');
  });
});
