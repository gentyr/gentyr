#!/usr/bin/env node
/**
 * Preview Watcher Daemon - Auto-sync worktrees with base branch
 *
 * Polls every 30 seconds for new commits on the base branch (preview or main).
 * When new commits are detected:
 *   1. Single `git fetch` (all worktrees share .git, so one fetch updates all)
 *   2. For each worktree with a clean working tree: auto-merge
 *   3. Broadcast signal to all running agents
 *   4. Write freshness state to preview-head.json
 *
 * Runs as a launchd KeepAlive service.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'preview-watcher.log');
const STATE_FILE = path.join(STATE_DIR, 'preview-head.json');
const WORKTREES_DIR = path.join(PROJECT_DIR, '.claude', 'worktrees');

const POLL_INTERVAL_MS = 30000; // 30 seconds
const GIT_TIMEOUT = 15000; // 15s for git operations
const MERGE_TIMEOUT = 30000; // 30s for merges

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* best-effort */ }
}

// ============================================================================
// Base Branch Detection
// ============================================================================

function detectBaseBranch() {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    return 'preview';
  } catch {
    return 'main';
  }
}

// ============================================================================
// Worktree Discovery
// ============================================================================

function listManagedWorktrees() {
  if (!fs.existsSync(WORKTREES_DIR)) return [];
  const entries = [];
  try {
    for (const name of fs.readdirSync(WORKTREES_DIR)) {
      const wtPath = path.join(WORKTREES_DIR, name);
      const gitFile = path.join(wtPath, '.git');
      if (fs.existsSync(gitFile)) {
        // Read current branch
        try {
          const branch = execFileSync('git', ['branch', '--show-current'], {
            cwd: wtPath, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
          }).trim();
          entries.push({ path: wtPath, branch, name });
        } catch {
          entries.push({ path: wtPath, branch: 'unknown', name });
        }
      }
    }
  } catch { /* non-fatal */ }
  return entries;
}

// ============================================================================
// Broadcast
// ============================================================================

let broadcastSignalFn = null;

async function broadcast(baseBranch, sha, syncResults) {
  try {
    if (!broadcastSignalFn) {
      const mod = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js'));
      broadcastSignalFn = mod.broadcastSignal;
    }
    broadcastSignalFn({
      fromAgentId: 'preview-watcher',
      tier: 'instruction',
      message: `Base branch origin/${baseBranch} updated (${sha.slice(0, 7)}). ${syncResults.synced} worktree(s) auto-synced, ${syncResults.pending} pending (dirty/conflict). If your worktree is stale, run: git merge origin/${baseBranch} --no-edit`,
      projectDir: PROJECT_DIR,
    });
  } catch (err) {
    log(`Broadcast failed: ${err.message}`);
  }
}

// ============================================================================
// Sync Logic
// ============================================================================

function syncWorktrees(baseBranch) {
  const worktrees = listManagedWorktrees();
  const results = { synced: 0, pending: 0, upToDate: 0, errors: [], worktreeDetails: [] };

  for (const wt of worktrees) {
    try {
      // How many commits behind?
      const countStr = execFileSync(
        'git', ['rev-list', `HEAD..origin/${baseBranch}`, '--count'],
        { cwd: wt.path, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
      ).trim();
      const behindBy = parseInt(countStr, 10) || 0;

      if (behindBy === 0) {
        results.upToDate++;
        results.worktreeDetails.push({ name: wt.name, status: 'up_to_date' });
        continue;
      }

      // Check for uncommitted changes
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: wt.path, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      }).trim();

      if (status.length > 0) {
        // Dirty — can't auto-merge, write state file for hook to pick up
        results.pending++;
        results.worktreeDetails.push({ name: wt.name, status: 'dirty', behindBy });
        writeWorktreeState(wt.path, { needsMerge: true, behindBy, dirty: true });
        continue;
      }

      // Clean — auto-merge
      try {
        execFileSync('git', ['merge', `origin/${baseBranch}`, '--no-edit'], {
          cwd: wt.path, encoding: 'utf8', timeout: MERGE_TIMEOUT, stdio: 'pipe',
        });
        results.synced++;
        results.worktreeDetails.push({ name: wt.name, status: 'synced', behindBy });
        clearWorktreeState(wt.path);
        log(`Synced worktree ${wt.name}: merged ${behindBy} commit(s) from origin/${baseBranch}`);
      } catch (mergeErr) {
        // Merge conflict — abort and mark pending
        try {
          execFileSync('git', ['merge', '--abort'], {
            cwd: wt.path, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
          });
        } catch { /* abort may fail if no merge in progress */ }
        results.pending++;
        results.worktreeDetails.push({ name: wt.name, status: 'conflict', behindBy });
        writeWorktreeState(wt.path, { needsMerge: true, behindBy, conflict: true });
        log(`Conflict in worktree ${wt.name}: auto-merge aborted`);
      }
    } catch (err) {
      results.errors.push({ name: wt.name, error: err.message });
    }
  }

  return results;
}

function writeWorktreeState(worktreePath, state) {
  try {
    const stateDir = path.join(PROJECT_DIR, '.claude', 'state', 'worktree-freshness');
    fs.mkdirSync(stateDir, { recursive: true });
    const hash = path.basename(worktreePath);
    const filePath = path.join(stateDir, `${hash}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

function clearWorktreeState(worktreePath) {
  try {
    const hash = path.basename(worktreePath);
    const filePath = path.join(PROJECT_DIR, '.claude', 'state', 'worktree-freshness', `${hash}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* non-fatal */ }
}

// ============================================================================
// State Persistence
// ============================================================================

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* corrupted state, start fresh */ }
  return { sha: null, updatedAt: null };
}

function writeState(sha, baseBranch, syncResults) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const state = {
      sha,
      baseBranch,
      updatedAt: new Date().toISOString(),
      worktreesSynced: syncResults.synced,
      worktreesPending: syncResults.pending,
      worktreesUpToDate: syncResults.upToDate,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

// ============================================================================
// Main Loop
// ============================================================================

async function checkAndSync() {
  const baseBranch = detectBaseBranch();
  const state = readState();

  // Fetch latest
  try {
    execFileSync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: GIT_TIMEOUT, stdio: 'pipe',
    });
  } catch (err) {
    // Fetch failed (offline, timeout) — skip this cycle
    return;
  }

  // Check if base branch has new commits
  let currentSha;
  try {
    currentSha = execFileSync('git', ['rev-parse', `origin/${baseBranch}`], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
  } catch {
    return; // Can't determine SHA
  }

  if (currentSha === state.sha) {
    return; // No new commits
  }

  log(`New commits on origin/${baseBranch}: ${state.sha?.slice(0, 7) || 'initial'} -> ${currentSha.slice(0, 7)}`);

  // Sync all worktrees
  const syncResults = syncWorktrees(baseBranch);
  log(`Sync results: ${syncResults.synced} synced, ${syncResults.pending} pending, ${syncResults.upToDate} up-to-date, ${syncResults.errors.length} errors`);

  // Persist state
  writeState(currentSha, baseBranch, syncResults);

  // Broadcast to all running agents
  await broadcast(baseBranch, currentSha, syncResults);
}

// ============================================================================
// Worktree Cleanup (piggybacks on daemon — runs every 5 minutes)
// ============================================================================

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastCleanupAt = 0;

async function runWorktreeCleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  try {
    const mod = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'worktree-manager.js'));
    const cleaned = mod.cleanupMergedWorktrees();
    if (cleaned > 0) {
      log(`Worktree cleanup: removed ${cleaned} worktree(s)/orphan(s)`);
    }
  } catch (err) {
    log(`Worktree cleanup error: ${err.message}`);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

log('Preview watcher daemon starting');
log(`Project: ${PROJECT_DIR}`);
log(`Poll interval: ${POLL_INTERVAL_MS}ms`);

// Initial check + cleanup
checkAndSync().catch(err => log(`Initial check error: ${err.message}`));
runWorktreeCleanup().catch(err => log(`Initial cleanup error: ${err.message}`));

// Poll loop — freshness check every 30s, cleanup piggybacks every 5min
setInterval(() => {
  checkAndSync().catch(err => log(`Poll error: ${err.message}`));
  runWorktreeCleanup().catch(err => log(`Cleanup error: ${err.message}`));
}, POLL_INTERVAL_MS);

// Keep process alive
process.on('SIGTERM', () => {
  log('Preview watcher daemon shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Preview watcher daemon shutting down (SIGINT)');
  process.exit(0);
});
