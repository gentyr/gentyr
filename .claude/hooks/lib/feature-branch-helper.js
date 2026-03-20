#!/usr/bin/env node
/**
 * Feature Branch Helper
 *
 * Utilities for generating and inspecting feature branch names.
 * Used by automation hooks that need to create or validate
 * branches for task-based workflows.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';

// ============================================================================
// Constants
// ============================================================================

const PROTECTED_BRANCHES = ['main', 'preview', 'staging'];
const FEATURE_PREFIXES = ['feature/', 'fix/', 'refactor/', 'docs/'];

// ============================================================================
// Branch Name Generation
// ============================================================================

/**
 * Generate a feature branch name from a task title and ID.
 *
 * @param {string} taskTitle - Human-readable task title
 * @param {string} taskId - UUID or unique task identifier
 * @returns {string} Branch name in the form feature/{idPrefix}-{sanitizedTitle}
 */
function getFeatureBranchName(taskTitle, taskId) {
  const taskIdPrefix = taskId.slice(0, 8);

  const sanitizedTitle = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

  return `feature/${taskIdPrefix}-${sanitizedTitle}`;
}

// ============================================================================
// Branch Inspection
// ============================================================================

/**
 * Get the name of the currently checked-out branch.
 *
 * @returns {string} Current branch name, or 'unknown' if detection fails
 */
function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('[feature-branch-helper] Warning:', err.message);
    return 'unknown';
  }
}

/**
 * Check whether the current branch starts with a recognized feature prefix.
 *
 * @returns {boolean} true if the current branch is a feature branch
 */
function isOnFeatureBranch() {
  const currentBranch = getCurrentBranch();
  return FEATURE_PREFIXES.some((prefix) => currentBranch.startsWith(prefix));
}

/**
 * Check whether the current branch is a protected branch.
 *
 * @returns {boolean} true if the current branch is protected
 */
function isOnProtectedBranch() {
  const currentBranch = getCurrentBranch();
  return PROTECTED_BRANCHES.includes(currentBranch);
}

// ============================================================================
// Base Branch Detection
// ============================================================================

/**
 * Detect the base branch for this project.
 * Target projects (with origin/preview) use 'preview'.
 * The gentyr repo (no origin/preview) uses 'main'.
 *
 * NOTE: Must not write to stderr — may be called from SessionStart hooks.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {string} 'preview' or 'main'
 */
function detectBaseBranch(cwd) {
  try {
    execSync('git rev-parse --verify origin/preview', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return 'preview';
  } catch (_) {
    /* F004: err captured but not logged — shared with SessionStart hooks that must not write to stderr */
    return 'main';
  }
}

/**
 * Check if a branch is protected but NOT the base branch.
 * These are the branches that should never have direct commits.
 *
 * @param {string} branch - Branch name to check
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {boolean}
 */
function isProtectedNonBase(branch, cwd) {
  return PROTECTED_BRANCHES.includes(branch) && branch !== detectBaseBranch(cwd);
}

// ============================================================================
// Exports
// ============================================================================

export {
  PROTECTED_BRANCHES,
  FEATURE_PREFIXES,
  getFeatureBranchName,
  getCurrentBranch,
  isOnFeatureBranch,
  isOnProtectedBranch,
  detectBaseBranch,
  isProtectedNonBase,
};

export default {
  PROTECTED_BRANCHES,
  FEATURE_PREFIXES,
  getFeatureBranchName,
  getCurrentBranch,
  isOnFeatureBranch,
  isOnProtectedBranch,
  detectBaseBranch,
  isProtectedNonBase,
};
