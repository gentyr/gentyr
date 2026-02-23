#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Branch Drift Check
 *
 * Warns the AI agent when the main working tree is not on 'main'.
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
  } catch {
    return { lastCheck: 0, lastBranch: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch {
    // Non-fatal — state dir may be root-owned
  }
}

// ============================================================================
// Branch drift detection
// ============================================================================

function detectDrift() {
  const gitDir = path.join(PROJECT_DIR, '.git');

  // Skip if .git is a file (we're inside a worktree, not the main checkout)
  try {
    if (fs.statSync(gitDir).isFile()) return null;
  } catch { return null; }

  // Get current branch
  let currentBranch;
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
  } catch { return null; }

  if (!currentBranch) return null; // Detached HEAD
  if (currentBranch === 'main') return { branch: currentBranch, warning: null };

  // Check for uncommitted changes
  let hasChanges = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    hasChanges = status.length > 0;
  } catch {}

  // Build warning message
  const parts = [
    `BRANCH DRIFT: Main working tree is on '${currentBranch}' instead of 'main'.`,
    'This may cause incorrect preflight checks, stale worktree bases, and promotion failures.',
  ];

  if (hasChanges) {
    parts.push('Uncommitted changes detected. To restore: git stash && git checkout main && git stash pop (if changes belong on main) or create a worktree for in-progress work.');
  } else {
    parts.push('No uncommitted changes. To restore: git checkout main');
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
  } catch {}

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
