/**
 * Tests for the fast protected branch guard in husky/pre-commit.
 *
 * Verifies that the shell-level branch check appears BEFORE lint-staged,
 * preventing lint-staged's stash/restore cycle from running on doomed commits.
 *
 * Run with: node --test .claude/hooks/__tests__/pre-commit-branch-guard.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HUSKY_PRE_COMMIT = path.resolve(import.meta.dirname, '..', '..', '..', 'husky', 'pre-commit');

describe('husky/pre-commit fast branch guard', () => {
  const content = fs.readFileSync(HUSKY_PRE_COMMIT, 'utf8');

  it('should contain the fast protected branch guard section', () => {
    assert.ok(content.includes('FAST PROTECTED BRANCH GUARD'),
      'Must contain the fast protected branch guard section header');
  });

  it('should check the current branch name', () => {
    assert.ok(content.includes('git branch --show-current'),
      'Must use git branch --show-current to detect current branch');
  });

  it('should block commits on main, preview, and staging', () => {
    assert.ok(content.includes('main|preview|staging)'),
      'Must check for main, preview, and staging branches');
  });

  it('should allow GENTYR_PROMOTION_PIPELINE bypass', () => {
    assert.ok(content.includes('GENTYR_PROMOTION_PIPELINE'),
      'Must check GENTYR_PROMOTION_PIPELINE env var for bypass');
  });

  it('should appear BEFORE lint-staged', () => {
    const branchGuardIdx = content.indexOf('FAST PROTECTED BRANCH GUARD');
    const lintStagedIdx = content.indexOf('npm run lint-staged');
    assert.ok(branchGuardIdx > 0, 'Branch guard section must exist');
    assert.ok(lintStagedIdx > 0, 'lint-staged invocation must exist');
    assert.ok(branchGuardIdx < lintStagedIdx,
      'Branch guard must appear BEFORE lint-staged to prevent stash/restore on doomed commits');
  });

  it('should appear AFTER core.hooksPath check', () => {
    const hooksPathIdx = content.indexOf('core.hooksPath verified');
    const branchGuardIdx = content.indexOf('FAST PROTECTED BRANCH GUARD');
    assert.ok(hooksPathIdx > 0, 'core.hooksPath check must exist');
    assert.ok(branchGuardIdx > hooksPathIdx,
      'Branch guard must appear AFTER core.hooksPath check');
  });

  it('should show a clear error message with merge chain instructions', () => {
    assert.ok(content.includes('Merge chain: feature/* -> preview -> staging -> main'),
      'Must show the merge chain in the error message');
  });

  it('should suggest creating a feature branch', () => {
    assert.ok(content.includes('git checkout -b feature/<name> preview'),
      'Must suggest creating a feature branch from preview');
  });

  it('should exit with code 1 when blocked', () => {
    // Find the exit 1 inside the branch guard case block
    const branchGuardIdx = content.indexOf('FAST PROTECTED BRANCH GUARD');
    const lintStagedIdx = content.indexOf('LINT STAGED FILES');
    const guardSection = content.substring(branchGuardIdx, lintStagedIdx);
    assert.ok(guardSection.includes('exit 1'),
      'Branch guard must exit 1 when commit is blocked');
  });

  it('should echo "Branch guard passed" on allowed branches', () => {
    assert.ok(content.includes('Branch guard passed'),
      'Must echo success message when branch is allowed');
  });
});
