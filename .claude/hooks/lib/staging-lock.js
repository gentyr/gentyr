/**
 * Staging Lock — shared module for reading/writing the staging lock state.
 *
 * During a production release, staging is locked to prevent new merges from
 * contaminating the release candidate. The lock state is persisted as a JSON
 * file at .claude/state/staging-lock.json.
 *
 * The local state file is the primary enforcement mechanism. GitHub branch
 * protection updates are best-effort (non-fatal) — they provide a secondary
 * guard but are not required for the hook to function.
 *
 * @module lib/staging-lock
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Paths
// ============================================================================

/**
 * Resolve the staging lock state file path.
 *
 * @param {string} [projectDir]
 * @returns {string}
 */
function lockFilePath(projectDir = PROJECT_DIR) {
  return path.join(projectDir, '.claude', 'state', 'staging-lock.json');
}

// ============================================================================
// GitHub Repo Resolution
// ============================================================================

/** @type {{ owner: string, name: string } | null} */
let _repoCache = null;

/**
 * Get the GitHub owner/repo for the current project via `gh repo view`.
 * Result is cached for the lifetime of the process.
 *
 * @param {string} projectDir
 * @returns {{ owner: string, name: string } | null}
 */
function getGitHubRepo(projectDir) {
  if (_repoCache) return _repoCache;
  try {
    const raw = execFileSync('gh', ['repo', 'view', '--json', 'owner,name'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    const parsed = JSON.parse(raw);
    if (parsed.owner?.login && parsed.name) {
      _repoCache = { owner: parsed.owner.login, name: parsed.name };
    }
    return _repoCache;
  } catch (err) {
    // Non-fatal — GitHub API is best-effort
    try { process.stderr.write(`[staging-lock] Warning: failed to resolve GitHub repo: ${err.message}\n`); } catch (_) { /* ignore */ }
    return null;
  }
}

// ============================================================================
// State File I/O
// ============================================================================

/**
 * Read the current staging lock state.
 *
 * Returns `{ locked: false }` if the state file does not exist or is unreadable.
 *
 * @param {string} [projectDir]
 * @returns {{ locked: boolean, locked_at?: string, locked_by?: string, release_id?: string, reason?: string }}
 */
export function getStagingLockState(projectDir = PROJECT_DIR) {
  const filePath = lockFilePath(projectDir);
  try {
    if (!fs.existsSync(filePath)) {
      return { locked: false };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const state = JSON.parse(raw);
    if (typeof state !== 'object' || state === null) {
      return { locked: false };
    }
    return state;
  } catch (err) {
    // G001 fail-closed: if lock file exists but is unreadable/corrupted, assume locked
    try { process.stderr.write(`[staging-lock] Warning: failed to read lock state: ${err.message} — failing closed (assuming locked)\n`); } catch (_) { /* ignore */ }
    return { locked: true, reason: 'lock_file_unreadable', error: err.message };
  }
}

/**
 * Check if staging is currently locked.
 *
 * @param {string} [projectDir]
 * @returns {boolean}
 */
export function isStagingLocked(projectDir = PROJECT_DIR) {
  const state = getStagingLockState(projectDir);
  return state.locked === true;
}

// ============================================================================
// GitHub Branch Protection
// ============================================================================

/**
 * Set GitHub branch protection on staging to block all merges.
 * Best-effort — logs a warning on failure but does not throw.
 *
 * @param {string} projectDir
 */
function setGitHubBranchProtection(projectDir) {
  const repo = getGitHubRepo(projectDir);
  if (!repo) return;

  try {
    execFileSync('gh', [
      'api',
      `repos/${repo.owner}/${repo.name}/branches/staging/protection`,
      '-X', 'PUT',
      '-f', 'required_pull_request_reviews[required_approving_review_count]=6',
      '-f', 'restrictions[users][]=',
      '-f', 'restrictions[teams][]=',
      '-F', 'enforce_admins=true',
    ], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch (err) {
    try { process.stderr.write(`[staging-lock] Warning: failed to set GitHub branch protection: ${err.message}\n`); } catch (_) { /* ignore */ }
  }
}

/**
 * Remove GitHub branch protection from staging.
 * Best-effort — logs a warning on failure but does not throw.
 *
 * @param {string} projectDir
 */
function removeGitHubBranchProtection(projectDir) {
  const repo = getGitHubRepo(projectDir);
  if (!repo) return;

  try {
    execFileSync('gh', [
      'api',
      `repos/${repo.owner}/${repo.name}/branches/staging/protection`,
      '-X', 'DELETE',
    ], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch (err) {
    try { process.stderr.write(`[staging-lock] Warning: failed to remove GitHub branch protection: ${err.message}\n`); } catch (_) { /* ignore */ }
  }
}

// ============================================================================
// Lock / Unlock
// ============================================================================

/**
 * Lock staging for a production release.
 *
 * Writes the lock state file and optionally sets GitHub branch protection
 * to block merges to staging.
 *
 * @param {string} releaseId - Unique identifier for the release
 * @param {object} [options]
 * @param {boolean} [options.lockGitHub=true] - Whether to set GitHub branch protection
 * @param {string} [options.projectDir] - Project directory override
 * @param {string} [options.reason] - Human-readable reason for the lock
 * @returns {Promise<void>}
 */
export async function lockStaging(releaseId, options = {}) {
  const {
    lockGitHub = true,
    projectDir = PROJECT_DIR,
    reason = 'Production release in progress',
  } = options;

  if (!releaseId || typeof releaseId !== 'string') {
    throw new Error('[staging-lock] lockStaging requires a non-empty releaseId string');
  }

  const filePath = lockFilePath(projectDir);
  const dir = path.dirname(filePath);

  // Ensure state directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const state = {
    locked: true,
    locked_at: new Date().toISOString(),
    locked_by: 'cto',
    release_id: releaseId,
    reason,
  };

  // Write state file — this is the primary enforcement mechanism
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  // Best-effort GitHub branch protection
  if (lockGitHub) {
    setGitHubBranchProtection(projectDir);
  }
}

/**
 * Unlock staging after a production release completes or is aborted.
 *
 * Clears the lock state file and optionally removes GitHub branch protection.
 *
 * @param {string} releaseId - Release identifier (for audit trail / validation)
 * @param {object} [options]
 * @param {boolean} [options.unlockGitHub=true] - Whether to remove GitHub branch protection
 * @param {string} [options.projectDir] - Project directory override
 * @returns {Promise<void>}
 */
export async function unlockStaging(releaseId, options = {}) {
  const {
    unlockGitHub = true,
    projectDir = PROJECT_DIR,
  } = options;

  if (!releaseId || typeof releaseId !== 'string') {
    throw new Error('[staging-lock] unlockStaging requires a non-empty releaseId string');
  }

  const filePath = lockFilePath(projectDir);

  // Verify the lock belongs to this release (if file exists)
  const currentState = getStagingLockState(projectDir);
  if (currentState.locked && currentState.release_id && currentState.release_id !== releaseId) {
    throw new Error(
      `[staging-lock] Cannot unlock: staging is locked by release '${currentState.release_id}', ` +
      `but unlock was requested for release '${releaseId}'`
    );
  }

  // Clear the state file
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    throw new Error(`[staging-lock] Failed to remove lock state file: ${err.message}`);
  }

  // Best-effort GitHub branch protection removal
  if (unlockGitHub) {
    removeGitHubBranchProtection(projectDir);
  }
}
