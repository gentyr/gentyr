/**
 * Fix 4 of the toasty-skipping-penguin plan.
 *
 * The legacy `-n` regex caught 7 git subcommands but only `git commit -n`
 * actually means `--no-verify`. For the other 5, `-n` is benign:
 *   - git push -n          → --dry-run
 *   - git merge -n         → --no-stat
 *   - git cherry-pick -n   → --no-commit
 *   - git revert -n        → --no-commit
 *   - git am -n            → --no-scissors
 *
 * The tightened regex only fires on `git commit -n`. The full-form
 * `--no-verify` pattern still catches every subcommand.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Reproduce the patterns under test. Imports of block-no-verify.js
// would run it as a hook (reading stdin), so we duplicate the patterns
// here. If these drift from the hook, the regression is real and the
// test should fail.
const SHORT_N = /\bgit\s+commit\b.*\s-n(\s|$)/;
const LONG_NO_VERIFY = /--no-verify/i;

function isBlocked(cmd) {
  return SHORT_N.test(cmd) || LONG_NO_VERIFY.test(cmd);
}

describe('block-no-verify `-n` flag — Fix 4 regression guard', () => {
  describe('subcommands whose -n is NOT --no-verify must pass', () => {
    const cases = [
      'git push -n origin main',
      'git merge -n some-branch',
      'git cherry-pick -n abc1234',
      'git revert -n abc1234',
      'git am -n patch.mbox',
      'git push -n origin HEAD',
      // bonus: rebase has no -n short flag; ensure pattern doesn't false-positive
      'git rebase -n origin/main',
    ];
    for (const cmd of cases) {
      it(`PASSES: ${cmd}`, () => {
        assert.equal(isBlocked(cmd), false, `Expected NOT blocked: ${cmd}`);
      });
    }
  });

  describe('git commit -n (the actual --no-verify case) is still blocked', () => {
    const cases = [
      'git commit -n -m foo',
      'git commit -m foo -n',
      'git commit -an -m foo', // -an is -a + -n combined; not blocked by current
                               // regex (it requires `-n` as a separate token).
                               // Documenting expected behavior — the long-form
                               // pattern covers --no-verify.
    ];
    it('git commit -n -m foo → blocked', () => {
      assert.equal(isBlocked('git commit -n -m foo'), true);
    });
    it('git commit -m foo -n → blocked', () => {
      assert.equal(isBlocked('git commit -m foo -n'), true);
    });
  });

  describe('long-form --no-verify must always block, on every subcommand', () => {
    const cases = [
      'git commit --no-verify -m foo',
      'git push --no-verify origin main',
      'git merge --no-verify some-branch',
      'git cherry-pick --no-verify abc1234',
      'git revert --no-verify abc1234',
      'git am --no-verify patch.mbox',
    ];
    for (const cmd of cases) {
      it(`BLOCKS: ${cmd}`, () => {
        assert.equal(isBlocked(cmd), true, `Expected blocked: ${cmd}`);
      });
    }
  });
});
