import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateGitignore } from '../config-gen.js';

describe('updateGitignore()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-gitignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readGitignore() {
    return fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
  }

  it('should create .gitignore with BEGIN/END block when file does not exist', () => {
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(content.includes('# BEGIN GENTYR GITIGNORE'));
    assert.ok(content.includes('# END GENTYR GITIGNORE'));
    assert.ok(content.includes('.claude/*.db'));
    assert.ok(content.includes('.mcp.json'));
    assert.ok(content.includes('op-secrets.conf'));
  });

  it('should append block to existing .gitignore content', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(content.startsWith('node_modules/\ndist/'));
    assert.ok(content.includes('# BEGIN GENTYR GITIGNORE'));
    assert.ok(content.includes('# END GENTYR GITIGNORE'));
  });

  it('should be idempotent: running twice produces the same result', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
    updateGitignore(tmpDir);
    const first = readGitignore();
    updateGitignore(tmpDir);
    const second = readGitignore();
    assert.strictEqual(first, second, 'Second run should produce identical output');
  });

  it('should not duplicate BEGIN/END block on re-run', () => {
    updateGitignore(tmpDir);
    updateGitignore(tmpDir);
    const content = readGitignore();
    const beginCount = (content.match(/# BEGIN GENTYR GITIGNORE/g) || []).length;
    const endCount = (content.match(/# END GENTYR GITIGNORE/g) || []).length;
    assert.strictEqual(beginCount, 1, 'Should have exactly one BEGIN marker');
    assert.strictEqual(endCount, 1, 'Should have exactly one END marker');
  });

  it('should preserve content above the block on re-run', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# My project\nnode_modules/\n*.log\n');
    updateGitignore(tmpDir);
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(content.includes('# My project'));
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('*.log'));
  });

  it('should remove legacy "# GENTYR runtime" block and add new block', () => {
    const legacy = [
      'node_modules/',
      '',
      '# GENTYR runtime',
      '.claude/*.db',
      '.claude/*.db-shm',
      '.claude/*.db-wal',
      '.claude/*-state.json',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), legacy);
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(!content.includes('# GENTYR runtime'), 'Legacy marker should be removed');
    assert.ok(content.includes('# BEGIN GENTYR GITIGNORE'));
    assert.ok(content.includes('node_modules/'), 'Non-legacy content preserved');
  });

  it('should preserve non-legacy lines that follow a legacy block', () => {
    const legacy = [
      '# My stuff',
      '',
      '# GENTYR runtime',
      '.claude/*.db',
      '',
      '# Custom entries',
      'build/',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), legacy);
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(content.includes('# My stuff'), 'Content before legacy block preserved');
    assert.ok(content.includes('# Custom entries'), 'Content after legacy block preserved');
    assert.ok(content.includes('build/'), 'Custom entries after legacy block preserved');
  });

  it('should include all expected new patterns', () => {
    updateGitignore(tmpDir);
    const content = readGitignore();
    const expected = [
      '.claude/settings.json',
      '.claude/protection-key',
      '.claude/protected-action-approvals.json',
      '.claude/protection-state.json',
      '.claude/specs-config.json',
      '.claude/playwright-health.json',
      '.claude/config/',
      '.claude/worktrees/',
      '.mcp.json',
      'op-secrets.conf',
    ];
    for (const pattern of expected) {
      assert.ok(content.includes(pattern), `Missing pattern: ${pattern}`);
    }
  });

  it('should handle legacy block at end of file with no trailing newline', () => {
    const legacy = '# GENTYR runtime\n.claude/*.db\n.claude/*.db-shm';
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), legacy);
    updateGitignore(tmpDir);
    const content = readGitignore();
    assert.ok(!content.includes('# GENTYR runtime'));
    assert.ok(content.includes('# BEGIN GENTYR GITIGNORE'));
  });
});
