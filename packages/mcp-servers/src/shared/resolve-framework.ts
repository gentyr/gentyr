/**
 * Shared framework path resolver for GENTYR MCP servers.
 *
 * Resolves the framework directory from a target project, supporting:
 *   1. node_modules/gentyr (npm link model - preferred)
 *   2. .claude-framework (legacy symlink model - fallback)
 *   3. .claude/hooks symlink (resilient to node_modules pruning)
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve the absolute path to the GENTYR framework directory from a project.
 */
export function resolveFrameworkDir(projectDir: string): string | null {
  // 1. node_modules/gentyr (npm model)
  const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(npmPath);
    }
  } catch {}

  // 2. .claude-framework (legacy model)
  const legacyPath = path.join(projectDir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch {}

  // 3. Follow .claude/hooks symlink (resilient to node_modules pruning)
  const hooksPath = path.join(projectDir, '.claude', 'hooks');
  try {
    const stat = fs.lstatSync(hooksPath);
    if (stat.isSymbolicLink()) {
      const realHooks = fs.realpathSync(hooksPath);
      // hooks dir is at <framework>/.claude/hooks
      const candidate = path.resolve(realHooks, '..', '..');
      if (fs.existsSync(path.join(candidate, 'version.json'))) {
        return candidate;
      }
    }
  } catch {}

  return null;
}

/**
 * Get the relative path token for templates.
 */
export function resolveFrameworkRelative(projectDir: string): string {
  const resolved = resolveFrameworkDir(projectDir);
  if (resolved) {
    const rel = path.relative(projectDir, resolved);
    return rel || '.';
  }
  return '.claude-framework';
}

/**
 * Check which installation model is active.
 */
export function detectInstallModel(projectDir: string): 'npm' | 'legacy' | null {
  try {
    const stat = fs.lstatSync(path.join(projectDir, 'node_modules', 'gentyr'));
    if (stat.isSymbolicLink() || stat.isDirectory()) return 'npm';
  } catch {}
  try {
    const stat = fs.lstatSync(path.join(projectDir, '.claude-framework'));
    if (stat.isSymbolicLink() || stat.isDirectory()) return 'legacy';
  } catch {}
  return null;
}
