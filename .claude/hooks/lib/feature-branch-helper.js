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
  } catch {
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
// Exports
// ============================================================================

export {
  PROTECTED_BRANCHES,
  FEATURE_PREFIXES,
  getFeatureBranchName,
  getCurrentBranch,
  isOnFeatureBranch,
  isOnProtectedBranch,
};

export default {
  PROTECTED_BRANCHES,
  FEATURE_PREFIXES,
  getFeatureBranchName,
  getCurrentBranch,
  isOnFeatureBranch,
  isOnProtectedBranch,
};
