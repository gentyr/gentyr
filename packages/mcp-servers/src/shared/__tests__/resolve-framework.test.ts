/**
 * Unit tests for packages/mcp-servers/src/shared/resolve-framework.ts
 *
 * Validates that resolveFrameworkRelative() uses resolveFrameworkDir() + path.relative()
 * instead of returning literal tokens like 'node_modules/gentyr'. This is the key
 * behavioral change that makes GENTYR symlinks resilient to `pnpm install` pruning:
 * when node_modules/gentyr is a real directory (resolved via realpathSync), the relative
 * path may differ from the literal token.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveFrameworkDir,
  resolveFrameworkRelative,
  detectInstallModel,
} from '../resolve-framework.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temporary project directory. Returns realpath-resolved absolute path
 * to be stable against macOS /var -> /private/var symlink indirection.
 */
function makeTempProject(): {
  dir: string;
  cleanup: () => void;
  createNpmDir: () => string;
  createLegacyDir: () => string;
  createNpmSymlink: (target: string) => string;
  createLegacySymlink: (target: string) => string;
} {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-rf-ts-test-')));

  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    /** Create node_modules/gentyr as a real directory (post-pnpm-prune scenario). */
    createNpmDir() {
      const p = path.join(dir, 'node_modules', 'gentyr');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'version.json'), JSON.stringify({ version: '1.0.0' }));
      return p;
    },
    /** Create .claude-framework as a real directory (legacy model). */
    createLegacyDir() {
      const p = path.join(dir, '.claude-framework');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'version.json'), JSON.stringify({ version: '0.9.0' }));
      return p;
    },
    /** Create node_modules/gentyr as a symlink to an external directory. */
    createNpmSymlink(target: string) {
      const nmDir = path.join(dir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
      const link = path.join(nmDir, 'gentyr');
      fs.symlinkSync(target, link);
      return link;
    },
    /** Create .claude-framework as a symlink to an external directory. */
    createLegacySymlink(target: string) {
      const link = path.join(dir, '.claude-framework');
      fs.symlinkSync(target, link);
      return link;
    },
  };
}

/**
 * Create a standalone framework directory outside the project (simulating ~/git/gentyr).
 * Returns realpathSync-resolved path.
 */
function makeFrameworkDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-fw-ts-')));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.3.0' }));
  return dir;
}

// ============================================================================
// resolveFrameworkDir()
// ============================================================================

describe('resolveFrameworkDir()', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('should return null when no framework is installed', () => {
    expect(resolveFrameworkDir(project.dir)).toBeNull();
  });

  it('should return an absolute path for npm directory model', () => {
    project.createNpmDir();
    const result = resolveFrameworkDir(project.dir);

    expect(result).not.toBeNull();
    expect(path.isAbsolute(result!)).toBe(true);
    expect(fs.existsSync(result!)).toBe(true);
  });

  it('should return an absolute path for legacy .claude-framework directory model', () => {
    project.createLegacyDir();
    const result = resolveFrameworkDir(project.dir);

    expect(result).not.toBeNull();
    expect(path.isAbsolute(result!)).toBe(true);
  });

  it('should prefer npm model over legacy when both are present', () => {
    const npmPath = project.createNpmDir();
    project.createLegacyDir();

    const result = resolveFrameworkDir(project.dir);
    const expectedNpm = fs.realpathSync(npmPath);

    expect(result).toBe(expectedNpm);
  });

  it('should resolve a symlink to its real path (npm symlink model)', () => {
    const frameworkDir = makeFrameworkDir();
    try {
      project.createNpmSymlink(frameworkDir);
      const result = resolveFrameworkDir(project.dir);

      expect(result).toBe(frameworkDir);
    } finally {
      fs.rmSync(frameworkDir, { recursive: true, force: true });
    }
  });

  it('should resolve a legacy symlink to its real path', () => {
    const frameworkDir = makeFrameworkDir();
    try {
      project.createLegacySymlink(frameworkDir);
      const result = resolveFrameworkDir(project.dir);

      expect(result).toBe(frameworkDir);
    } finally {
      fs.rmSync(frameworkDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// resolveFrameworkRelative()
// ============================================================================

describe('resolveFrameworkRelative()', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('should return ".claude-framework" fallback when no framework is installed', () => {
    expect(resolveFrameworkRelative(project.dir)).toBe('.claude-framework');
  });

  it('should return a relative path (not absolute) for npm directory model', () => {
    project.createNpmDir();
    const result = resolveFrameworkRelative(project.dir);

    expect(typeof result).toBe('string');
    expect(path.isAbsolute(result)).toBe(false);
  });

  it('should produce a path that resolves back to the framework directory', () => {
    project.createNpmDir();
    const result = resolveFrameworkRelative(project.dir);
    const resolved = path.resolve(project.dir, result);

    expect(fs.existsSync(resolved)).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'version.json'))).toBe(true);
  });

  it('should match path.relative(projectDir, realpathSync(npmDir))', () => {
    project.createNpmDir();
    const frameworkReal = fs.realpathSync(path.join(project.dir, 'node_modules', 'gentyr'));

    const result = resolveFrameworkRelative(project.dir);
    const expected = path.relative(project.dir, frameworkReal);

    expect(result).toBe(expected);
  });

  it('should NOT return the literal string "node_modules/gentyr" when realpath differs from the link path', () => {
    // pnpm link scenario: node_modules/gentyr -> /some/other/path/gentyr
    const frameworkDir = makeFrameworkDir();
    try {
      project.createNpmSymlink(frameworkDir);
      const result = resolveFrameworkRelative(project.dir);

      // The resolved path is the external frameworkDir — it differs from the npm link path
      const expected = path.relative(project.dir, frameworkDir);
      expect(result).toBe(expected);
      expect(result).not.toBe('node_modules/gentyr');
    } finally {
      fs.rmSync(frameworkDir, { recursive: true, force: true });
    }
  });

  it('should return relative path for legacy .claude-framework directory', () => {
    project.createLegacyDir();
    const result = resolveFrameworkRelative(project.dir);
    const expected = path.relative(
      project.dir,
      fs.realpathSync(path.join(project.dir, '.claude-framework')),
    );

    expect(result).toBe(expected);
    expect(path.isAbsolute(result)).toBe(false);
  });

  it('should return "." when projectDir is the same as frameworkDir (self-contained dev scenario)', () => {
    // Symlink node_modules/gentyr -> project.dir (the project IS the framework)
    const nmDir = path.join(project.dir, 'node_modules');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.symlinkSync(project.dir, path.join(nmDir, 'gentyr'));

    const result = resolveFrameworkRelative(project.dir);
    // path.relative(x, x) returns '' which the module normalises to '.'
    expect(result).toBe('.');
  });
});

// ============================================================================
// detectInstallModel()
// ============================================================================

describe('detectInstallModel()', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('should return null when nothing is installed', () => {
    expect(detectInstallModel(project.dir)).toBeNull();
  });

  it('should return "npm" for node_modules/gentyr directory', () => {
    project.createNpmDir();
    expect(detectInstallModel(project.dir)).toBe('npm');
  });

  it('should return "npm" for node_modules/gentyr symlink', () => {
    const frameworkDir = makeFrameworkDir();
    try {
      project.createNpmSymlink(frameworkDir);
      expect(detectInstallModel(project.dir)).toBe('npm');
    } finally {
      fs.rmSync(frameworkDir, { recursive: true, force: true });
    }
  });

  it('should return "legacy" for .claude-framework directory', () => {
    project.createLegacyDir();
    expect(detectInstallModel(project.dir)).toBe('legacy');
  });

  it('should return "legacy" for .claude-framework symlink', () => {
    const frameworkDir = makeFrameworkDir();
    try {
      project.createLegacySymlink(frameworkDir);
      expect(detectInstallModel(project.dir)).toBe('legacy');
    } finally {
      fs.rmSync(frameworkDir, { recursive: true, force: true });
    }
  });

  it('should prefer "npm" when both npm and legacy are present', () => {
    project.createNpmDir();
    project.createLegacyDir();
    expect(detectInstallModel(project.dir)).toBe('npm');
  });
});
