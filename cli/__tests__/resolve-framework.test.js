/**
 * Unit tests for cli/lib/resolve-framework.js
 *
 * Validates that resolveFrameworkRelative() uses resolveFrameworkDir() + path.relative()
 * instead of returning literal tokens like 'node_modules/gentyr'. This is the key
 * behavioral change that makes GENTYR symlinks resilient to `pnpm install` pruning:
 * when node_modules/gentyr is a real directory (resolved via realpathSync), the relative
 * path may differ from the literal token.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test cli/__tests__/resolve-framework.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODULE_PATH = path.resolve(__dirname, '../lib/resolve-framework.js');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temporary directory structure that simulates a target project.
 * Returns an object with cleanup() and helper methods.
 */
function makeTempProject() {
  // Use realpathSync so that comparisons against module-internal realpathSync
  // results are stable on macOS where /var/folders is a symlink to /private/var/folders.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-rf-test-')));

  function cleanup() {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Create node_modules/gentyr as a real directory containing version.json.
   * This simulates a non-symlink npm install (e.g. after pnpm install prunes).
   */
  function createNpmDir(frameworkSubdir = 'node_modules/gentyr') {
    const frameworkPath = path.join(dir, frameworkSubdir);
    fs.mkdirSync(frameworkPath, { recursive: true });
    fs.writeFileSync(
      path.join(frameworkPath, 'version.json'),
      JSON.stringify({ version: '1.0.0' }),
    );
    return frameworkPath;
  }

  /**
   * Create .claude-framework as a real directory (legacy model).
   */
  function createLegacyDir() {
    const legacyPath = path.join(dir, '.claude-framework');
    fs.mkdirSync(legacyPath, { recursive: true });
    fs.writeFileSync(
      path.join(legacyPath, 'version.json'),
      JSON.stringify({ version: '0.9.0' }),
    );
    return legacyPath;
  }

  /**
   * Create node_modules/gentyr as a symlink pointing to a real framework directory.
   * This simulates `pnpm link ~/git/gentyr` where realpath differs from the path.
   */
  function createNpmSymlink(realFrameworkDir) {
    const nmDir = path.join(dir, 'node_modules');
    fs.mkdirSync(nmDir, { recursive: true });
    const linkPath = path.join(nmDir, 'gentyr');
    fs.symlinkSync(realFrameworkDir, linkPath);
    return linkPath;
  }

  /**
   * Create .claude-framework as a symlink pointing to a real framework directory.
   */
  function createLegacySymlink(realFrameworkDir) {
    const linkPath = path.join(dir, '.claude-framework');
    fs.symlinkSync(realFrameworkDir, linkPath);
    return linkPath;
  }

  return {
    dir,
    cleanup,
    createNpmDir,
    createLegacyDir,
    createNpmSymlink,
    createLegacySymlink,
  };
}

/**
 * Create a standalone "framework" directory outside of the project (simulating ~/git/gentyr).
 * Returns the realpathSync-resolved absolute path so comparisons against realpathSync
 * results in the module under test are stable (e.g. macOS /var -> /private/var).
 */
function makeFrameworkDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-framework-')));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.3.0' }));
  return dir;
}

// ============================================================================
// Dynamically import module under test (ESM)
// ============================================================================

async function loadModule() {
  // Use a cache-busting query string to allow re-import after temp dirs change.
  // Node caches by URL, so appending a unique query bypasses the cache.
  const url = `${MODULE_PATH}?t=${Date.now()}`;
  return import(url);
}

// ============================================================================
// Tests
// ============================================================================

describe('cli/lib/resolve-framework.js', async () => {
  // Load the module once — we test pure path logic, so no state issues.
  const {
    resolveFrameworkDir,
    resolveFrameworkRelative,
    detectInstallModel,
  } = await loadModule();

  // ============================================================================
  // resolveFrameworkDir()
  // ============================================================================

  describe('resolveFrameworkDir()', () => {
    let project;

    beforeEach(() => {
      project = makeTempProject();
    });

    afterEach(() => {
      project.cleanup();
    });

    it('should return null when no framework is installed', () => {
      const result = resolveFrameworkDir(project.dir);
      assert.equal(result, null);
    });

    it('should return absolute path for npm directory model', () => {
      project.createNpmDir();
      const result = resolveFrameworkDir(project.dir);

      assert.notEqual(result, null, 'should find npm directory');
      assert.ok(path.isAbsolute(result), 'result must be an absolute path');
      assert.ok(fs.existsSync(result), 'resolved path must exist on disk');
    });

    it('should return absolute path for legacy directory model', () => {
      project.createLegacyDir();
      const result = resolveFrameworkDir(project.dir);

      assert.notEqual(result, null, 'should find .claude-framework directory');
      assert.ok(path.isAbsolute(result), 'result must be an absolute path');
    });

    it('should prefer npm model over legacy when both exist', () => {
      const npmFramework = project.createNpmDir();
      project.createLegacyDir();

      const result = resolveFrameworkDir(project.dir);

      // realpathSync of npm model
      const expectedNpm = fs.realpathSync(npmFramework);
      assert.equal(result, expectedNpm, 'npm model should take priority over legacy');
    });

    it('should resolve symlink to its real path (npm symlink model)', () => {
      const frameworkDir = makeFrameworkDir();
      try {
        project.createNpmSymlink(frameworkDir);
        const result = resolveFrameworkDir(project.dir);

        assert.equal(
          result,
          frameworkDir,
          'realpathSync must follow the symlink to the real framework directory',
        );
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });

    it('should resolve legacy symlink to its real path', () => {
      const frameworkDir = makeFrameworkDir();
      try {
        project.createLegacySymlink(frameworkDir);
        const result = resolveFrameworkDir(project.dir);

        assert.equal(
          result,
          frameworkDir,
          'realpathSync must follow the .claude-framework symlink',
        );
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });

    it('should follow .claude/hooks symlink to discover framework (worktree model)', () => {
      // Simulate a worktree: .claude/hooks -> <framework>/.claude/hooks
      const frameworkDir = makeFrameworkDir();
      try {
        const claudeDir = path.join(project.dir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        // Create real hooks dir in framework
        const realHooks = path.join(frameworkDir, '.claude', 'hooks');
        fs.mkdirSync(realHooks, { recursive: true });
        // Symlink project's .claude/hooks -> framework's .claude/hooks
        fs.symlinkSync(realHooks, path.join(claudeDir, 'hooks'));

        const result = resolveFrameworkDir(project.dir);
        assert.equal(result, frameworkDir, 'should resolve framework via .claude/hooks symlink');
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // resolveFrameworkRelative()
  // ============================================================================

  describe('resolveFrameworkRelative()', () => {
    let project;

    beforeEach(() => {
      project = makeTempProject();
    });

    afterEach(() => {
      project.cleanup();
    });

    it('should return .claude-framework fallback when no framework is installed', () => {
      const result = resolveFrameworkRelative(project.dir);
      assert.equal(result, '.claude-framework');
    });

    it('should return a relative path — NOT a literal token — for npm directory model', () => {
      project.createNpmDir();
      const result = resolveFrameworkRelative(project.dir);

      // Must be a string
      assert.equal(typeof result, 'string');
      // Must NOT be an absolute path
      assert.ok(!path.isAbsolute(result), `result must be relative, got: ${result}`);
      // Must NOT start with / or contain OS-level absolute path separators
      assert.ok(
        !result.startsWith(path.sep),
        `result must not start with path separator, got: ${result}`,
      );
    });

    it('should produce a path that, when joined with projectDir, reaches the framework', () => {
      project.createNpmDir();
      const result = resolveFrameworkRelative(project.dir);
      const resolved = path.resolve(project.dir, result);

      assert.ok(
        fs.existsSync(resolved),
        `path.resolve(projectDir, relative) must exist: ${resolved}`,
      );
      assert.ok(
        fs.existsSync(path.join(resolved, 'version.json')),
        'resolved path must contain version.json',
      );
    });

    it('should use path.relative() logic — result matches path.relative(projectDir, frameworkRealpath)', () => {
      project.createNpmDir();
      const frameworkReal = fs.realpathSync(path.join(project.dir, 'node_modules', 'gentyr'));

      const result = resolveFrameworkRelative(project.dir);
      const expected = path.relative(project.dir, frameworkReal);

      assert.equal(result, expected);
    });

    it('should work correctly when framework is a symlink pointing outside the project', () => {
      const frameworkDir = makeFrameworkDir();
      try {
        project.createNpmSymlink(frameworkDir);
        const result = resolveFrameworkRelative(project.dir);

        // The realpath is the external frameworkDir — path.relative() will produce a ../.. path
        const expected = path.relative(project.dir, frameworkDir);
        assert.equal(result, expected);
        // Must not be the literal string 'node_modules/gentyr'
        assert.notEqual(
          result,
          'node_modules/gentyr',
          'must NOT return the literal token when realpath differs',
        );
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });

    it('should return relative path for legacy .claude-framework directory', () => {
      project.createLegacyDir();
      const result = resolveFrameworkRelative(project.dir);

      assert.equal(typeof result, 'string');
      assert.ok(!path.isAbsolute(result));

      const expected = path.relative(
        project.dir,
        fs.realpathSync(path.join(project.dir, '.claude-framework')),
      );
      assert.equal(result, expected);
    });

    it('should return "." when projectDir and frameworkDir are the same (self-contained)', () => {
      // When the project IS the framework (e.g. during development in ~/git/gentyr)
      // Create a fake version.json to make resolveFrameworkDir recognise the hooks path
      const claudeDir = path.join(project.dir, '.claude');
      const hooksDir = path.join(claudeDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(project.dir, 'version.json'), '{"version":"1.0.0"}');

      // Symlink .claude/hooks -> itself (unusual, but covers the path.relative -> '' case)
      // Instead, create a scenario where resolveFrameworkDir returns projectDir itself
      // by putting node_modules/gentyr pointing at projectDir
      const nmDir = path.join(project.dir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
      fs.symlinkSync(project.dir, path.join(nmDir, 'gentyr'));

      const result = resolveFrameworkRelative(project.dir);
      // path.relative(x, x) returns '' — the module normalises this to '.'
      assert.equal(result, '.');
    });
  });

  // ============================================================================
  // detectInstallModel()
  // ============================================================================

  describe('detectInstallModel()', () => {
    let project;

    beforeEach(() => {
      project = makeTempProject();
    });

    afterEach(() => {
      project.cleanup();
    });

    it('should return null when nothing is installed', () => {
      const result = detectInstallModel(project.dir);
      assert.equal(result, null);
    });

    it('should return "npm" for node_modules/gentyr directory', () => {
      project.createNpmDir();
      const result = detectInstallModel(project.dir);
      assert.equal(result, 'npm');
    });

    it('should return "npm" for node_modules/gentyr symlink', () => {
      const frameworkDir = makeFrameworkDir();
      try {
        project.createNpmSymlink(frameworkDir);
        const result = detectInstallModel(project.dir);
        assert.equal(result, 'npm');
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });

    it('should return "legacy" for .claude-framework directory', () => {
      project.createLegacyDir();
      const result = detectInstallModel(project.dir);
      assert.equal(result, 'legacy');
    });

    it('should return "legacy" for .claude-framework symlink', () => {
      const frameworkDir = makeFrameworkDir();
      try {
        project.createLegacySymlink(frameworkDir);
        const result = detectInstallModel(project.dir);
        assert.equal(result, 'legacy');
      } finally {
        fs.rmSync(frameworkDir, { recursive: true, force: true });
      }
    });

    it('should prefer "npm" when both npm and legacy are present', () => {
      project.createNpmDir();
      project.createLegacyDir();
      const result = detectInstallModel(project.dir);
      assert.equal(result, 'npm');
    });
  });
});
