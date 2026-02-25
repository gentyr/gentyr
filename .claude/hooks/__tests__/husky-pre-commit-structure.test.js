import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HUSKY_PRE_COMMIT = path.resolve(import.meta.dirname, '..', '..', '..', 'husky', 'pre-commit');

describe('husky/pre-commit structural verification', () => {
  const content = fs.readFileSync(HUSKY_PRE_COMMIT, 'utf8');

  it('should contain the symlink target verification block', () => {
    assert.ok(content.includes('SYMLINK TARGET VERIFICATION'),
      'Must contain the symlink target verification section header');
  });

  it('should check if .claude/hooks is a symlink', () => {
    assert.ok(content.includes('if [ -L ".claude/hooks" ]'),
      'Must test for symlink with -L flag');
  });

  it('should verify version.json exists at framework root', () => {
    assert.ok(content.includes('version.json'),
      'Must check for version.json as GENTYR framework marker');
  });

  it('should block commit when symlink target is invalid', () => {
    assert.ok(content.includes('COMMIT BLOCKED: .claude/hooks does not point to a GENTYR framework'),
      'Must block commit with clear message for invalid symlink target');
  });

  it('should block commit when hooks is a regular directory in non-framework repo', () => {
    assert.ok(content.includes('COMMIT BLOCKED: .claude/hooks is a regular directory'),
      'Must block commit when hooks is a regular dir (not symlink)');
  });

  it('should block commit when .claude/hooks does not exist', () => {
    assert.ok(content.includes('COMMIT BLOCKED: .claude/hooks does not exist'),
      'Must block commit when .claude/hooks is missing entirely');
  });

  it('should allow regular directory in framework repo (has version.json)', () => {
    assert.ok(content.includes('Framework repo hooks verified'),
      'Must have framework repo pass-through path');
  });

  it('should still contain the hook integrity check', () => {
    assert.ok(content.includes('HOOK INTEGRITY CHECK'),
      'Must retain the existing hook integrity check section');
    assert.ok(content.includes('pre-commit-review.js'),
      'Must check pre-commit-review.js ownership');
  });

  it('should prefer hooks-protected directory for ownership checks (copy-on-protect)', () => {
    assert.ok(content.includes('.claude/hooks-protected'),
      'Must check for copy-on-protect directory');
    assert.ok(content.includes('HOOKS_CHECK_DIR'),
      'Must use HOOKS_CHECK_DIR variable for directory selection');
    assert.ok(content.includes('HOOKS_CHECK_DIR=".claude/hooks-protected"'),
      'Must prefer hooks-protected when it exists');
    assert.ok(content.includes('HOOKS_CHECK_DIR=".claude/hooks"'),
      'Must fall back to .claude/hooks');
  });

  it('should use HOOKS_CHECK_DIR in ownership check loop', () => {
    assert.ok(content.includes('$HOOKS_CHECK_DIR/$f'),
      'Must use $HOOKS_CHECK_DIR/$f (not hardcoded .claude/hooks/$f) in the ownership check');
  });

  it('should include branch-checkout-guard.js in the ownership check loop', () => {
    assert.ok(content.includes('branch-checkout-guard.js'),
      'Ownership check loop must include branch-checkout-guard.js');
  });

  it('should include git-wrappers/git in the ownership check loop', () => {
    assert.ok(content.includes('git-wrappers/git'),
      'Ownership check loop must include git-wrappers/git wrapper binary');
  });

  it('should include all 10 critical hook files in the ownership check loop', () => {
    const expectedHooks = [
      'pre-commit-review.js',
      'bypass-approval-hook.js',
      'block-no-verify.js',
      'protected-action-gate.js',
      'protected-action-approval-hook.js',
      'credential-file-guard.js',
      'secret-leak-detector.js',
      'protected-actions.json',
      'branch-checkout-guard.js',
      'git-wrappers/git',
    ];
    for (const hook of expectedHooks) {
      assert.ok(content.includes(hook),
        `Ownership check loop must include ${hook}`);
    }
  });
});
