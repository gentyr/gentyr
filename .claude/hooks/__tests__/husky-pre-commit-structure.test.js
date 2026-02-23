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
});
