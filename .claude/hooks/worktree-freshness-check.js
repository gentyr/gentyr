#!/usr/bin/env node
/**
 * PostToolUse Hook: Worktree Freshness Check
 *
 * Fires on every tool call for spawned agents (or interactive monitors) running
 * inside a worktree. Detects when the worktree has fallen behind the base branch
 * (preview or main) and injects a [WORKTREE STALE] notice into the model's
 * context with concrete git commands to sync.
 *
 * Fast-exits immediately (no git calls) when:
 *   - Not a spawned session AND not an interactive monitor
 *   - CLAUDE_WORKTREE_DIR is not set (not running inside a worktree)
 *   - Within the 2-minute cooldown window
 *
 * Output format: PostToolUse (decision + hookSpecificOutput.additionalContext)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ============================================================================
// Environment
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// CLAUDE_WORKTREE_DIR is injected by spawnQueueItem; CWD fallback for edge cases
const cwdWorktreeMatch = process.cwd().match(/^(.+\/\.claude\/worktrees\/[^/]+)/);
const WORKTREE_DIR = process.env.CLAUDE_WORKTREE_DIR || (cwdWorktreeMatch ? cwdWorktreeMatch[1] : null);
const AGENT_ID = process.env.CLAUDE_AGENT_ID || 'unknown';

// ============================================================================
// Fast-exit: only runs in worktree sessions
// ============================================================================

const isSpawned = process.env.CLAUDE_SPAWNED_SESSION === 'true';
const isInteractiveMonitor = process.env.GENTYR_INTERACTIVE_MONITOR === 'true';

if ((!isSpawned && !isInteractiveMonitor) || !WORKTREE_DIR) {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// ============================================================================
// Output helpers
// ============================================================================

function approve() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

function approveWithContext(message) {
  process.stdout.write(JSON.stringify({
    decision: 'approve',
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
  process.exit(0);
}

// ============================================================================
// State management (cooldown)
// ============================================================================

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_PATH = path.join(STATE_DIR, `worktree-freshness-state-${AGENT_ID}.json`);
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { lastCheck: 0 };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state) + '\n');
  } catch (_) {
    // Non-fatal — state dir may not be writable
  }
}

// ============================================================================
// Base branch detection
// ============================================================================

function detectBaseBranch() {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
      cwd: WORKTREE_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    return 'preview';
  } catch (_) {
    return 'main';
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Consume stdin (required by PostToolUse contract) — contents not needed
  let _input = '';
  for await (const chunk of process.stdin) {
    _input += chunk;
  }

  // Cooldown check
  const state = readState();
  const now = Date.now();
  if (state.lastCheck && (now - state.lastCheck) < COOLDOWN_MS) {
    return approve();
  }

  // Detect base branch
  let baseBranch;
  try {
    baseBranch = detectBaseBranch();
  } catch (_) {
    return approve();
  }

  // NOTE: No git fetch here — the preview-watcher daemon fetches every 30s globally.
  // All worktrees share the same .git, so the daemon's fetch updates refs for everyone.
  // The rev-list check below uses existing refs, which are at most 30s stale.

  // Count how far behind we are
  let behindBy = 0;
  try {
    const output = execFileSync(
      'git', ['rev-list', `HEAD..origin/${baseBranch}`, '--count'],
      { cwd: WORKTREE_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
    ).trim();
    behindBy = parseInt(output, 10) || 0;
  } catch (_) {
    // Cannot determine — skip injection, save state anyway
  }

  // Update cooldown state
  writeState({ lastCheck: now });

  if (behindBy === 0) {
    return approve();
  }

  // Determine whether there are uncommitted changes
  let isDirty = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: WORKTREE_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    isDirty = status.length > 0;
  } catch (_) {
    // Cannot determine — assume dirty to be safe
    isDirty = true;
  }

  let message;
  if (isDirty) {
    message = [
      `[WORKTREE STALE] Your worktree is ${behindBy} commit${behindBy === 1 ? '' : 's'} behind origin/${baseBranch}.`,
      `You have uncommitted changes. Commit first, then merge:`,
      `  git merge origin/${baseBranch} --no-edit`,
    ].join(' ');
  } else {
    message = [
      `[WORKTREE STALE] Your worktree is ${behindBy} commit${behindBy === 1 ? '' : 's'} behind origin/${baseBranch}.`,
      `Auto-sync available — run:`,
      `  git fetch origin && git merge origin/${baseBranch} --no-edit`,
    ].join(' ');
  }

  approveWithContext(message);
}

main().catch((_err) => {
  // Never block the session on unexpected errors
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
});
