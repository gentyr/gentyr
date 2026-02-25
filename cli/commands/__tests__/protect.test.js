/**
 * Unit tests for cli/commands/protect.js
 *
 * Validates that:
 *  - criticalHooks array includes all expected entries (branch-checkout-guard.js, git-wrappers/git)
 *  - files array in doProtect() includes branch-checkout-guard.js, git-wrappers/git, and services.json
 *  - protection-state.json is written with criticalHooks before directories are protected
 *  - mkdirSync is called for the hooks-protected subdirectory (git-wrappers)
 *
 * These are source-level structural tests — they read and parse the source file
 * to verify invariants that the protection system depends on.
 *
 * Run with: node --test cli/commands/__tests__/protect.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTECT_PATH = path.resolve(__dirname, '..', 'protect.js');

describe('protect.js — criticalHooks array', () => {
  const code = fs.readFileSync(PROTECT_PATH, 'utf8');

  it('should define criticalHooks array in doProtect', () => {
    assert.match(
      code,
      /const criticalHooks = \[/,
      'Must define criticalHooks array in doProtect()'
    );
  });

  it('should include branch-checkout-guard.js in criticalHooks', () => {
    const match = code.match(/const criticalHooks = \[[\s\S]*?\]/);
    assert.ok(match, 'criticalHooks array must exist');
    assert.ok(
      match[0].includes('branch-checkout-guard.js'),
      'criticalHooks must contain branch-checkout-guard.js'
    );
  });

  it('should include git-wrappers/git in criticalHooks', () => {
    const match = code.match(/const criticalHooks = \[[\s\S]*?\]/);
    assert.ok(match, 'criticalHooks array must exist');
    assert.ok(
      match[0].includes('git-wrappers/git'),
      'criticalHooks must contain git-wrappers/git'
    );
  });

  it('should include all 10 critical hook entries in criticalHooks', () => {
    const match = code.match(/const criticalHooks = \[[\s\S]*?\]/);
    assert.ok(match, 'criticalHooks array must exist');

    const expectedEntries = [
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

    for (const entry of expectedEntries) {
      assert.ok(
        match[0].includes(entry),
        `criticalHooks must include ${entry}`
      );
    }
  });

  it('should write criticalHooks into protection-state.json statePayload', () => {
    // The statePayload must include criticalHooks so gentyr-sync.js and the
    // pre-commit hook can read which files to ownership-check.
    assert.match(
      code,
      /criticalHooks,\s*\}|criticalHooks:/,
      'Must include criticalHooks in statePayload written to protection-state.json'
    );
  });
});

describe('protect.js — files array in doProtect', () => {
  const code = fs.readFileSync(PROTECT_PATH, 'utf8');

  // Extract the files array from doProtect (between `const files = [` and the closing `];`
  // that is followed by `// Protect directories`)
  const filesMatch = code.match(/const files = \[[\s\S]*?path\.join\(projectDir, '\.husky', 'pre-commit'\)/);

  it('should define files array in doProtect', () => {
    assert.ok(filesMatch, 'files array must be defined in doProtect()');
  });

  it('should include branch-checkout-guard.js in files array', () => {
    assert.ok(filesMatch, 'files array must exist');
    assert.ok(
      filesMatch[0].includes('branch-checkout-guard.js'),
      'files array must include branch-checkout-guard.js for root-owning'
    );
  });

  it('should include git-wrappers/git in files array', () => {
    assert.ok(filesMatch, 'files array must exist');
    assert.ok(
      filesMatch[0].includes("'git-wrappers', 'git'") || filesMatch[0].includes('"git-wrappers", "git"'),
      'files array must include path.join(..., "git-wrappers", "git") for root-owning'
    );
  });

  it('should include services.json in files array', () => {
    assert.ok(filesMatch, 'files array must exist');
    assert.ok(
      filesMatch[0].includes('services.json'),
      'files array must include services.json to prevent agent tampering with service config'
    );
  });

  it('should reference protection-key in files array', () => {
    assert.ok(filesMatch, 'files array must exist');
    assert.ok(
      filesMatch[0].includes('protection-key'),
      'files array must include protection-key'
    );
  });

  it('should reference .mcp.json in files array', () => {
    assert.ok(filesMatch, 'files array must exist');
    assert.ok(
      filesMatch[0].includes('.mcp.json'),
      'files array must include .mcp.json'
    );
  });
});

describe('protect.js — git-wrappers subdirectory creation', () => {
  const code = fs.readFileSync(PROTECT_PATH, 'utf8');

  it('should call mkdirSync with recursive when copying hooks', () => {
    // When isSymlinked, each hook's parent directory must be created before copying.
    // This handles git-wrappers/ subdirectory that does not exist in hooks-protected/.
    assert.match(
      code,
      /mkdirSync.*recursive.*true|mkdirSync\(path\.dirname\(dst\)/,
      'Must create parent directories recursively when copying hooks to hooks-protected'
    );
  });

  it('should copy each criticalHook including git-wrappers/git when symlinked', () => {
    // The copy loop iterates criticalHooks and copies src->dst.
    // Since git-wrappers/git is in criticalHooks, it must be included.
    assert.match(
      code,
      /for \(const hook of criticalHooks\)/,
      'Must iterate criticalHooks array when copying to hooks-protected'
    );

    assert.match(
      code,
      /fs\.copyFileSync\(src, dst\)/,
      'Must copy each hook file to hooks-protected directory'
    );
  });

  it('should write state BEFORE protecting directories', () => {
    // The protection-state.json must be written before chown/chmod runs,
    // because the user needs write access to .claude/ to write the file.
    const writeIdx = code.indexOf('fs.writeFileSync(stateFile');
    const protectDirsIdx = code.indexOf('for (const dir of dirs)');

    assert.ok(writeIdx > 0, 'Must write protection-state.json');
    assert.ok(protectDirsIdx > 0, 'Must have directory protection loop');
    assert.ok(
      writeIdx < protectDirsIdx,
      'protection-state.json must be written BEFORE directory protection loop'
    );
  });
});

describe('protect.js — doUnprotect files array', () => {
  const code = fs.readFileSync(PROTECT_PATH, 'utf8');

  it('should include branch-checkout-guard.js in doUnprotect files array', () => {
    // doUnprotect must restore ownership on the same files that doProtect root-owned.
    const unprotectSection = code.match(/function doUnprotect[\s\S]*?const files = \[[\s\S]*?\];/);
    assert.ok(unprotectSection, 'doUnprotect with files array must exist');
    assert.ok(
      unprotectSection[0].includes('branch-checkout-guard.js'),
      'doUnprotect files array must include branch-checkout-guard.js to restore user ownership'
    );
  });

  it('should include git-wrappers/git in doUnprotect files array', () => {
    const unprotectSection = code.match(/function doUnprotect[\s\S]*?const files = \[[\s\S]*?\];/);
    assert.ok(unprotectSection, 'doUnprotect with files array must exist');
    assert.ok(
      unprotectSection[0].includes("'git-wrappers', 'git'") || unprotectSection[0].includes('"git-wrappers", "git"'),
      'doUnprotect files array must include git-wrappers/git to restore user ownership'
    );
  });
});
