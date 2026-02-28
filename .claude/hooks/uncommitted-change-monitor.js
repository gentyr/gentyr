#!/usr/bin/env node
/**
 * PostToolUse Hook: Uncommitted Change Monitor
 *
 * Fires after Write and Edit tool calls. Tracks the count of file-modifying
 * tool calls since the last git commit and emits an additionalContext warning
 * to the AI model when the count exceeds a threshold, instructing it to
 * commit immediately.
 *
 * Why: Uncommitted work is vulnerable to git stash/reset --hard chains,
 * session crashes, context compactions, and process death. Frequent commits
 * create recovery points.
 *
 * Behavior:
 *   - Only fires for Write and Edit tool calls
 *   - Maintains counter in .claude/state/uncommitted-changes-state.json
 *   - At threshold (5 edits), emits additionalContext warning
 *   - Resets counter when a new commit is detected (HEAD hash change)
 *   - Cooldown: warns at most once per 3 minutes
 *   - Worktree-aware: only fires in worktrees or interactive sessions
 *     (spawned agents in main tree are blocked from committing by
 *     main-tree-commit-guard.js, so warning them is counterproductive)
 *
 * Input: JSON on stdin from Claude Code PostToolUse event
 * Output: JSON on stdout with continue + optional additionalContext
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_FILE = path.join(STATE_DIR, 'uncommitted-changes-state.json');

const EDIT_THRESHOLD = 5;
const WARNING_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

// ============================================================================
// State Management
// ============================================================================

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      changesSinceLastCommit: 0,
      lastCommitHash: '',
      lastWarningAt: 0,
    };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch {
    // Non-fatal — state loss just means we may warn again sooner
  }
}

// ============================================================================
// Git Helpers
// ============================================================================

function getCurrentCommitHash() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Check if we're in a worktree (.git is a file).
 */
function isWorktree() {
  try {
    const gitPath = path.join(PROJECT_DIR, '.git');
    return fs.lstatSync(gitPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if this is a spawned agent session.
 */
function isSpawnedSession() {
  return process.env.CLAUDE_SPAWNED_SESSION === 'true';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Only fire for Write and Edit tool calls
  const toolName = event?.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit') {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Skip spawned agents in main tree — they're blocked from committing by
  // main-tree-commit-guard.js, so warning them to commit is counterproductive
  if (isSpawnedSession() && !isWorktree()) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Read state and check for new commit (resets counter)
  const state = readState();
  const currentHash = getCurrentCommitHash();

  if (currentHash && currentHash !== state.lastCommitHash) {
    // New commit detected — reset counter
    state.changesSinceLastCommit = 0;
    state.lastCommitHash = currentHash;
  }

  // Increment counter
  state.changesSinceLastCommit++;

  const now = Date.now();

  // Check if we should warn
  if (state.changesSinceLastCommit >= EDIT_THRESHOLD) {
    const timeSinceLastWarning = now - (state.lastWarningAt || 0);

    if (timeSinceLastWarning >= WARNING_COOLDOWN_MS) {
      state.lastWarningAt = now;
      writeState(state);

      const warningMessage = `WARNING: You have ${state.changesSinceLastCommit} uncommitted file changes since your last commit. Commit your work NOW with a descriptive message before continuing. Uncommitted changes can be destroyed by git operations (stash, reset), context compactions, or session interruptions. Run: git add <specific-files> && git commit -m "wip: <description>"`;

      process.stdout.write(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: warningMessage,
        },
      }));
      return;
    }
  }

  writeState(state);
  process.stdout.write(JSON.stringify({ continue: true }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ continue: true }));
});
