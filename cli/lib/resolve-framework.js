#!/usr/bin/env node
/**
 * Shared framework path resolver for GENTYR.
 *
 * Resolves the framework directory from a target project, supporting:
 *   1. node_modules/gentyr (npm link model - preferred)
 *   2. .claude-framework (legacy symlink model - fallback)
 *   3. Symlink-following from .claude/hooks (worktree support)
 *
 * @module resolve-framework
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the absolute path to the GENTYR framework directory from a project.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @returns {string|null} Absolute path to the framework directory, or null if not found
 */
export function resolveFrameworkDir(projectDir) {
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

  // 3. Follow .claude/hooks symlink (worktree support)
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
 * Get the relative path token used in templates and symlinks.
 * Returns 'node_modules/gentyr' if the npm model is active, '.claude-framework' otherwise.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @returns {string} Relative framework path for template substitution
 */
export function resolveFrameworkRelative(projectDir) {
  const resolved = resolveFrameworkDir(projectDir);
  if (resolved) {
    const rel = path.relative(projectDir, resolved);
    return rel || '.';
  }
  return '.claude-framework';
}

/**
 * Check which installation model is active.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @returns {'npm'|'legacy'|null} The active installation model
 */
export function detectInstallModel(projectDir) {
  const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) return 'npm';
  } catch {}

  const legacyPath = path.join(projectDir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) return 'legacy';
  } catch {}

  return null;
}
