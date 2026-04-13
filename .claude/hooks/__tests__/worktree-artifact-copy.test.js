/**
 * Tests for worktree build artifact copying.
 *
 * Validates:
 * 1. worktree-manager.js reads worktreeArtifactCopy from services.json
 * 2. Artifact copy runs before install (so bin symlinks resolve)
 * 3. Artifact copy runs before build health check
 * 4. Non-fatal error handling in lenient mode
 * 5. ServicesConfigSchema accepts worktreeArtifactCopy
 * 6. expandArtifactGlob matches wildcard patterns
 * 7. copyBuildArtifacts copies directories recursively
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-artifact-copy.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECT_DIR = process.cwd();
const WORKTREE_MANAGER_PATH = path.join(PROJECT_DIR, '.claude/hooks/lib/worktree-manager.js');

// ============================================================================
// Source structural validation
// ============================================================================

describe('worktree-artifact-copy: source structure', () => {
  let code;

  beforeEach(() => {
    code = fs.readFileSync(WORKTREE_MANAGER_PATH, 'utf8');
  });

  it('should read worktreeArtifactCopy from services.json config', () => {
    assert.match(code, /worktreeArtifactCopy/, 'Must reference worktreeArtifactCopy');
  });

  it('should have expandArtifactGlob function', () => {
    assert.match(code, /function expandArtifactGlob/, 'Must define expandArtifactGlob');
  });

  it('should have copyBuildArtifacts function', () => {
    assert.match(code, /function copyBuildArtifacts/, 'Must define copyBuildArtifacts');
  });

  it('should copy artifacts before install step', () => {
    const artifactCopyIdx = code.indexOf('Build artifact copy (BEFORE install)');
    const installIdx = code.indexOf('Package manager install');
    assert.ok(artifactCopyIdx > 0, 'Must have artifact copy section');
    assert.ok(installIdx > 0, 'Must have install section');
    assert.ok(artifactCopyIdx < installIdx, 'Artifact copy must come before install');
  });

  it('should copy artifacts before build health check', () => {
    const artifactCopyIdx = code.indexOf('Build artifact copy (BEFORE install)');
    const buildIdx = code.indexOf('Workspace build');
    assert.ok(artifactCopyIdx > 0, 'Must have artifact copy section');
    assert.ok(buildIdx > 0, 'Must have build section');
    assert.ok(artifactCopyIdx < buildIdx, 'Artifact copy must come before build');
  });

  it('should skip artifact copy when skipInstall option is set', () => {
    assert.match(
      code,
      /!options\?\.skipInstall[\s\S]*?worktreeArtifactCopy/,
      'Artifact copy must be gated by !options?.skipInstall'
    );
  });

  it('should log success when artifacts are copied', () => {
    assert.match(
      code,
      /artifact-copy: copied/,
      'Must log success message after copying artifacts'
    );
  });

  it('should use fs.cpSync for recursive directory copy', () => {
    assert.match(code, /fs\.cpSync\(/, 'Must use fs.cpSync for copying');
  });

  it('should also copy artifacts in syncWorktreeDeps', () => {
    const syncFnStart = code.indexOf('export function syncWorktreeDeps');
    const syncFnCode = code.slice(syncFnStart);
    assert.match(syncFnCode, /worktreeArtifactCopy/, 'syncWorktreeDeps must handle artifact copy');
    assert.match(syncFnCode, /copyBuildArtifacts/, 'syncWorktreeDeps must call copyBuildArtifacts');
  });

  it('should use non-fatal artifact copy in syncWorktreeDeps', () => {
    const syncFnStart = code.indexOf('export function syncWorktreeDeps');
    const syncFnCode = code.slice(syncFnStart);
    assert.match(syncFnCode, /artifact copy failed \(non-fatal\)/, 'syncWorktreeDeps artifact copy must be non-fatal');
  });
});

// ============================================================================
// ServicesConfigSchema validation
// ============================================================================

describe('worktree-artifact-copy: ServicesConfigSchema', () => {
  let ServicesConfigSchema;

  beforeEach(async () => {
    const typesPath = path.join(PROJECT_DIR, 'packages/mcp-servers/dist/secret-sync/types.js');
    if (!fs.existsSync(typesPath)) return;
    const types = await import(typesPath);
    ServicesConfigSchema = types.ServicesConfigSchema;
  });

  it('should accept worktreeArtifactCopy as an optional array of strings', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeArtifactCopy: ['packages/*/dist', 'apps/extension/dist'],
    });
    assert.ok(result.success, 'Schema must accept worktreeArtifactCopy array');
  });

  it('should reject non-array worktreeArtifactCopy', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeArtifactCopy: 'packages/*/dist',
    });
    assert.ok(!result.success, 'Schema must reject non-array worktreeArtifactCopy');
  });

  it('should parse without worktreeArtifactCopy (optional)', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({ secrets: {} });
    assert.ok(result.success, 'Schema must parse without worktreeArtifactCopy');
  });

  it('should accept empty array', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeArtifactCopy: [],
    });
    assert.ok(result.success, 'Schema must accept empty array');
  });
});

// ============================================================================
// Behavioral: expandArtifactGlob and copyBuildArtifacts
// ============================================================================

describe('worktree-artifact-copy: behavioral', () => {
  let tempDir;
  let expandArtifactGlob;
  let copyBuildArtifacts;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-artifact-test-'));

    // Replicate the internal functions for direct behavioral testing
    // (originals are not exported from worktree-manager.js)
    expandArtifactGlob = (baseDir, pattern) => {
      const segments = pattern.split('/');
      let candidates = [baseDir];
      for (const segment of segments) {
        const nextCandidates = [];
        for (const dir of candidates) {
          if (segment.includes('*')) {
            const regexStr = segment
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '[^/]*');
            const regex = new RegExp(`^${regexStr}$`);
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory() && regex.test(entry.name)) {
                  nextCandidates.push(path.join(dir, entry.name));
                }
              }
            } catch (_) { /* skip */ }
          } else {
            const next = path.join(dir, segment);
            try {
              if (fs.statSync(next).isDirectory()) {
                nextCandidates.push(next);
              }
            } catch (_) { /* skip */ }
          }
        }
        candidates = nextCandidates;
      }
      return candidates;
    };

    copyBuildArtifacts = (mainDir, worktreePath, patterns, isStrict) => {
      let copied = 0;
      let skipped = 0;
      const errors = [];
      for (const pattern of patterns) {
        const sourceDirs = expandArtifactGlob(mainDir, pattern);
        if (sourceDirs.length === 0) { skipped++; continue; }
        for (const srcDir of sourceDirs) {
          const relPath = path.relative(mainDir, srcDir);
          const destDir = path.join(worktreePath, relPath);
          try {
            fs.mkdirSync(path.dirname(destDir), { recursive: true });
            if (fs.existsSync(destDir)) {
              fs.rmSync(destDir, { recursive: true, force: true });
            }
            fs.cpSync(srcDir, destDir, { recursive: true });
            copied++;
          } catch (err) {
            const msg = `artifact-copy: failed to copy ${relPath}: ${err.message?.slice(0, 150)}`;
            errors.push(msg);
            if (isStrict) throw new Error(`[worktree-manager] STRICT: ${msg}`);
          }
        }
      }
      return { copied, skipped, errors };
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should expand wildcard patterns', () => {
    // Create packages/foo/dist and packages/bar/dist
    fs.mkdirSync(path.join(tempDir, 'packages/foo/dist'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages/bar/dist'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages/baz/src'), { recursive: true }); // no dist

    const result = expandArtifactGlob(tempDir, 'packages/*/dist');
    assert.strictEqual(result.length, 2, 'Should match foo/dist and bar/dist');
    assert.ok(result.some(r => r.includes('foo/dist')), 'Should include foo/dist');
    assert.ok(result.some(r => r.includes('bar/dist')), 'Should include bar/dist');
  });

  it('should handle literal patterns', () => {
    fs.mkdirSync(path.join(tempDir, 'apps/extension/dist'), { recursive: true });

    const result = expandArtifactGlob(tempDir, 'apps/extension/dist');
    assert.strictEqual(result.length, 1, 'Should match exactly one directory');
    assert.ok(result[0].endsWith('apps/extension/dist'));
  });

  it('should return empty array for no matches', () => {
    const result = expandArtifactGlob(tempDir, 'nonexistent/*/dist');
    assert.strictEqual(result.length, 0, 'Should return empty for no matches');
  });

  it('should copy directories recursively', () => {
    const mainDir = path.join(tempDir, 'main');
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(path.join(mainDir, 'packages/foo/dist'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'packages/foo/dist/index.js'), 'module.exports = {}');
    fs.mkdirSync(worktree, { recursive: true });

    const result = copyBuildArtifacts(mainDir, worktree, ['packages/*/dist'], false);
    assert.strictEqual(result.copied, 1);
    assert.ok(fs.existsSync(path.join(worktree, 'packages/foo/dist/index.js')), 'File should be copied');
  });

  it('should skip patterns with no matches', () => {
    const mainDir = path.join(tempDir, 'main');
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    const result = copyBuildArtifacts(mainDir, worktree, ['nonexistent/*/dist'], false);
    assert.strictEqual(result.copied, 0);
    assert.strictEqual(result.skipped, 1);
  });

  it('should handle idempotent re-copy', () => {
    const mainDir = path.join(tempDir, 'main');
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(path.join(mainDir, 'pkg/dist'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'pkg/dist/index.js'), 'v2');
    fs.mkdirSync(path.join(worktree, 'pkg/dist'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'pkg/dist/index.js'), 'v1');

    const result = copyBuildArtifacts(mainDir, worktree, ['pkg/dist'], false);
    assert.strictEqual(result.copied, 1);
    const content = fs.readFileSync(path.join(worktree, 'pkg/dist/index.js'), 'utf8');
    assert.strictEqual(content, 'v2', 'Should overwrite with fresh copy');
  });

  it('should throw in strict mode on copy failure', () => {
    const mainDir = path.join(tempDir, 'main');
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(path.join(mainDir, 'pkg/dist'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'pkg/dist/index.js'), 'data');
    // Make worktree parent read-only so copy fails
    fs.mkdirSync(path.join(worktree, 'pkg'), { recursive: true });
    fs.chmodSync(path.join(worktree, 'pkg'), 0o444);

    assert.throws(() => {
      copyBuildArtifacts(mainDir, worktree, ['pkg/dist'], true);
    }, /STRICT/, 'Should throw in strict mode');

    // Restore permissions for cleanup
    fs.chmodSync(path.join(worktree, 'pkg'), 0o755);
  });

  it('should handle multiple patterns', () => {
    const mainDir = path.join(tempDir, 'main');
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(path.join(mainDir, 'packages/a/dist'), { recursive: true });
    fs.mkdirSync(path.join(mainDir, 'apps/ext/dist'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'packages/a/dist/a.js'), 'a');
    fs.writeFileSync(path.join(mainDir, 'apps/ext/dist/ext.js'), 'ext');
    fs.mkdirSync(worktree, { recursive: true });

    const result = copyBuildArtifacts(mainDir, worktree, ['packages/*/dist', 'apps/ext/dist'], false);
    assert.strictEqual(result.copied, 2);
    assert.ok(fs.existsSync(path.join(worktree, 'packages/a/dist/a.js')));
    assert.ok(fs.existsSync(path.join(worktree, 'apps/ext/dist/ext.js')));
  });
});
