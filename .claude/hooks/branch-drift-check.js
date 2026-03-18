#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Branch Drift Check
 *
 * Warns the AI agent when the main working tree is not on the expected base branch.
 * Auto-detects the expected branch: 'preview' if origin/preview exists, else 'main'.
 * Uses a cooldown to avoid repeating the warning on every prompt.
 * Cooldown resets immediately if the branch changes.
 *
 * Output: systemMessage (terminal display) + additionalContext (injected into AI model context)
 *
 * Location: .claude/hooks/branch-drift-check.js
 * Auto-propagates to target projects via directory symlink (npm link model).
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCooldown } from './config-reader.js';
import { detectBaseBranch as detectBaseBranchShared } from './lib/feature-branch-helper.js';

// ============================================================================
// Output helpers
// ============================================================================

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function warn(message) {
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
  }));
  process.exit(0);
}

// ============================================================================
// Fast-path: skip spawned sessions
// ============================================================================

if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  silent();
}

// ============================================================================
// State management
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_PATH = path.join(STATE_DIR, 'branch-drift-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
    return { lastCheck: 0, lastBranch: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
    // Non-fatal — state dir may be root-owned
  }
}

// ============================================================================
// Base branch detection (delegated to shared helper)
// ============================================================================

function detectBaseBranch() {
  return detectBaseBranchShared(PROJECT_DIR);
}

// ============================================================================
// Branch drift detection
// ============================================================================

function detectDrift() {
  const gitDir = path.join(PROJECT_DIR, '.git');

  // Skip if .git is a file (we're inside a worktree, not the main checkout)
  try {
    if (fs.statSync(gitDir).isFile()) return null;
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
    return null;
  }

  // Get current branch
  let currentBranch;
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
    return null;
  }

  if (!currentBranch) return null; // Detached HEAD

  const expectedBranch = detectBaseBranch();
  if (currentBranch === expectedBranch) return { branch: currentBranch, warning: null };

  // Check for uncommitted changes
  let hasChanges = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    hasChanges = status.length > 0;
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
  }

  // Build warning message with severity based on branch type
  const PROTECTED = ['main', 'preview', 'staging'];
  const isOnProtected = PROTECTED.includes(currentBranch);

  const parts = isOnProtected ? [
    `CRITICAL BRANCH DRIFT: Main tree is on '${currentBranch}' (PROTECTED — commits blocked here).`,
    `Switch to '${expectedBranch}' immediately. The merge chain is: feature/* -> ${expectedBranch} -> staging -> main.`,
  ] : [
    `BRANCH DRIFT: Main working tree is on '${currentBranch}' instead of '${expectedBranch}'.`,
    'This may cause incorrect preflight checks, stale worktree bases, and promotion failures.',
  ];

  // Auto-switch when on protected branch with no uncommitted changes
  if (isOnProtected && !hasChanges) {
    try {
      execFileSync('git', ['checkout', expectedBranch], {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
      });
      return {
        branch: expectedBranch,
        warning: `AUTO-FIX: Switched from '${currentBranch}' (protected) to '${expectedBranch}'. Direct work on '${currentBranch}' is not allowed.`,
      };
    } catch { /* fall through to warning */ }
  }

  if (hasChanges) {
    parts.push(`Uncommitted changes detected. To restore: git stash && git checkout ${expectedBranch} && git stash pop (if changes belong on ${expectedBranch}) or create a worktree for in-progress work.`);
  } else {
    parts.push(`No uncommitted changes. To restore: git checkout ${expectedBranch}`);
  }

  return { branch: currentBranch, warning: parts.join(' ') };
}

// ============================================================================
// Main
// ============================================================================

try {
  const state = readState();
  const now = Date.now();
  const cooldownMs = getCooldown('branch_drift_check', 30) * 60 * 1000;

  // Peek at current branch cheaply to check for branch change
  let currentBranch = null;
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim() || null;
  } catch (err) {
    console.error('[branch-drift-check] Warning:', err.message);
  }

  // Branch changed — reset cooldown
  const branchChanged = currentBranch !== null && state.lastBranch !== null && currentBranch !== state.lastBranch;

  // Check cooldown (skip if branch changed)
  if (!branchChanged && state.lastCheck && (now - state.lastCheck) < cooldownMs) {
    silent();
  }

  // Run full detection
  const result = detectDrift();

  // Update state
  writeState({
    lastCheck: now,
    lastBranch: result ? result.branch : (currentBranch || state.lastBranch),
  });

  if (result && result.warning) {
    warn(result.warning);
  }

  silent();
} catch (err) {
  // Never block the session
  process.stderr.write(`[branch-drift-check] Unexpected error: ${err.message || err}\n`);
  silent();
}
