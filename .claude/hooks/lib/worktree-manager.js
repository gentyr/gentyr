#!/usr/bin/env node
/**
 * Worktree Manager for GENTYR Feature Branch Workflow
 *
 * Manages git worktrees for parallel agent development. Each feature branch
 * gets its own worktree provisioned with symlinks to shared GENTYR config
 * (hooks, agents, commands, MCP servers) while maintaining worktree-specific
 * CLAUDE.md and .mcp.json.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const WORKTREES_DIR = path.join(PROJECT_DIR, '.claude', 'worktrees');

/** Default execSync options for all git commands */
const GIT_OPTS = { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe' };

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Sanitize a branch name for use as a directory name.
 * Replaces `/` with `-` and strips non-alphanumeric characters except `-`.
 *
 * @param {string} branchName - Raw git branch name
 * @returns {string} Filesystem-safe directory name
 */
function sanitizeBranchName(branchName) {
  return branchName.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Create a symlink, skipping if the link already exists and points to the
 * correct target. Throws on unexpected errors.
 *
 * @param {string} target - Symlink target (absolute path)
 * @param {string} linkPath - Where to create the symlink
 */
function safeSymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Verify existing link points to the right target
      const existing = fs.readlinkSync(linkPath);
      if (existing !== target) {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(target, linkPath);
      }
      return;
    }
    throw err;
  }
}

// ============================================================================
// Worktree Provisioning
// ============================================================================

/**
 * Provision a worktree directory with GENTYR configuration.
 *
 * - Generates a worktree-specific `.mcp.json` with absolute paths
 * - Symlinks shared config directories (hooks, agents, commands, MCP servers)
 * - Copies `CLAUDE.md` (copy, not symlink, so worktree edits stay isolated)
 *
 * @param {string} worktreePath - Absolute path to the worktree directory
 */
export function provisionWorktree(worktreePath) {
  // --- .mcp.json: rewrite CLAUDE_PROJECT_DIR env values to absolute path ---
  const mainMcpPath = path.join(PROJECT_DIR, '.mcp.json');
  if (fs.existsSync(mainMcpPath)) {
    const mcpConfig = JSON.parse(fs.readFileSync(mainMcpPath, 'utf8'));

    // Walk every server entry and replace "." values for CLAUDE_PROJECT_DIR
    if (mcpConfig.mcpServers) {
      for (const serverName of Object.keys(mcpConfig.mcpServers)) {
        const server = mcpConfig.mcpServers[serverName];
        if (server.env && server.env.CLAUDE_PROJECT_DIR === '.') {
          server.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
        }
      }
    }

    fs.writeFileSync(
      path.join(worktreePath, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
  }

  // --- framework symlink: check which install model is active and replicate it ---
  const npmFramework = path.join(PROJECT_DIR, 'node_modules', 'gentyr');
  const legacyFramework = path.join(PROJECT_DIR, '.claude-framework');
  if (fs.existsSync(npmFramework)) {
    const worktreeNmDir = path.join(worktreePath, 'node_modules');
    fs.mkdirSync(worktreeNmDir, { recursive: true });
    safeSymlink(fs.realpathSync(npmFramework), path.join(worktreeNmDir, 'gentyr'));
  } else if (fs.existsSync(legacyFramework)) {
    safeSymlink(legacyFramework, path.join(worktreePath, '.claude-framework'));
  }

  // --- .claude directory and shared sub-resources ---
  const worktreeClaudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(worktreeClaudeDir, { recursive: true });

  const sharedLinks = ['settings.json', 'agents', 'hooks', 'commands', 'mcp'];
  for (const name of sharedLinks) {
    const target = path.join(PROJECT_DIR, '.claude', name);
    if (fs.existsSync(target)) {
      safeSymlink(target, path.join(worktreeClaudeDir, name));
    }
  }

  // --- .husky symlink ---
  const huskyDir = path.join(PROJECT_DIR, '.husky');
  if (fs.existsSync(huskyDir)) {
    safeSymlink(huskyDir, path.join(worktreePath, '.husky'));
  }

  // --- CLAUDE.md copy (not symlink) ---
  const claudeMdSrc = path.join(PROJECT_DIR, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(worktreePath, 'CLAUDE.md'));
  }
}

// ============================================================================
// Worktree Lifecycle
// ============================================================================

/**
 * Create a git worktree for a feature branch and provision it with GENTYR config.
 *
 * If the worktree already exists, returns immediately without re-provisioning.
 *
 * @param {string} branchName - Git branch name (e.g. "feature/new-widget")
 * @param {string} [baseBranch='preview'] - Branch to base the new branch on
 * @returns {{ path: string, branch: string, created: boolean }}
 */
export function createWorktree(branchName, baseBranch = 'preview') {
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);

  // If worktree already exists, return early
  if (fs.existsSync(worktreePath)) {
    return { path: worktreePath, branch: branchName, created: false };
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Fetch the base branch (non-fatal if it fails, e.g. offline)
  try {
    execSync(`git fetch origin ${baseBranch} --quiet`, GIT_OPTS);
  } catch {
    // Non-fatal: base branch may already be up-to-date locally
  }

  // Create the branch if it does not exist yet
  try {
    execSync(`git rev-parse --verify ${branchName}`, GIT_OPTS);
  } catch {
    execSync(`git branch ${branchName} origin/${baseBranch}`, GIT_OPTS);
  }

  // Add the worktree
  execSync(`git worktree add ${worktreePath} ${branchName}`, GIT_OPTS);

  // Provision with GENTYR config
  provisionWorktree(worktreePath);

  return { path: worktreePath, branch: branchName, created: true };
}

/**
 * Remove a worktree and optionally delete the branch.
 *
 * @param {string} branchName - Branch whose worktree should be removed
 */
export function removeWorktree(branchName) {
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);

  execSync(`git worktree remove ${worktreePath} --force`, GIT_OPTS);

  // Attempt to delete the branch (non-fatal: branch may have unmerged work)
  try {
    execSync(`git branch -d ${branchName}`, GIT_OPTS);
  } catch {
    // Branch not fully merged or already deleted - that is fine
  }
}

// ============================================================================
// Worktree Queries
// ============================================================================

/**
 * List all GENTYR-managed worktrees (those under WORKTREES_DIR).
 *
 * @returns {Array<{ path: string, branch: string, head: string }>}
 */
export function listWorktrees() {
  let output;
  try {
    output = execSync('git worktree list --porcelain', GIT_OPTS);
  } catch {
    return [];
  }

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/feature/foo -> feature/foo
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === '') {
      if (current.path) {
        worktrees.push(current);
      }
      current = {};
    }
  }
  // Handle trailing entry without final blank line
  if (current.path) {
    worktrees.push(current);
  }

  // Only return worktrees managed by GENTYR (under WORKTREES_DIR)
  return worktrees.filter((wt) => wt.path.startsWith(WORKTREES_DIR));
}

/**
 * Get the filesystem path for a branch's worktree, or null if it doesn't exist.
 *
 * @param {string} branchName - Branch name to look up
 * @returns {string|null}
 */
export function getWorktreePath(branchName) {
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);
  return fs.existsSync(worktreePath) ? worktreePath : null;
}

/**
 * Check whether a worktree exists for the given branch.
 *
 * @param {string} branchName - Branch name to check
 * @returns {boolean}
 */
export function isWorktreeAvailable(branchName) {
  return getWorktreePath(branchName) !== null;
}

// ============================================================================
// Maintenance
// ============================================================================

/**
 * Remove worktrees whose branches have been fully merged to `origin/preview`.
 *
 * @returns {number} Count of worktrees cleaned up
 */
export function cleanupMergedWorktrees() {
  // Fetch latest preview state (non-fatal)
  try {
    execSync('git fetch origin preview --quiet', GIT_OPTS);
  } catch {
    // Offline or remote unavailable
  }

  let mergedOutput;
  try {
    mergedOutput = execSync('git branch --merged origin/preview', GIT_OPTS);
  } catch {
    return 0;
  }

  const mergedBranches = new Set(
    mergedOutput
      .split('\n')
      .map((line) => line.replace(/^\*?\s+/, '').trim())
      .filter(Boolean),
  );

  const managed = listWorktrees();
  let cleaned = 0;

  for (const wt of managed) {
    if (wt.branch && mergedBranches.has(wt.branch)) {
      try {
        removeWorktree(wt.branch);
        cleaned++;
      } catch (err) {
        // Log but continue cleaning other worktrees
        console.error(`[worktree-manager] Failed to remove merged worktree ${wt.branch}: ${err.message}`);
      }
    }
  }

  return cleaned;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  createWorktree,
  provisionWorktree,
  removeWorktree,
  listWorktrees,
  getWorktreePath,
  isWorktreeAvailable,
  cleanupMergedWorktrees,
};
