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
// Framework Resolution
// ============================================================================

/**
 * Resolve the absolute path to the GENTYR framework directory.
 * Supports npm link, legacy symlink, and .claude/hooks symlink fallback.
 *
 * @param {string} dir - Absolute path to the project directory
 * @returns {string|null}
 */
function resolveFrameworkDir(dir) {
  // 1. node_modules/gentyr (npm model)
  const npmPath = path.join(dir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(npmPath);
    }
  } catch {}

  // 2. .claude-framework (legacy model)
  const legacyPath = path.join(dir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch {}

  // 3. Follow .claude/hooks symlink
  const hooksPath = path.join(dir, '.claude', 'hooks');
  try {
    const stat = fs.lstatSync(hooksPath);
    if (stat.isSymbolicLink()) {
      const realHooks = fs.realpathSync(hooksPath);
      const candidate = path.resolve(realHooks, '..', '..');
      if (fs.existsSync(path.join(candidate, 'version.json'))) {
        return candidate;
      }
    }
  } catch {}

  return null;
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
  // --- .mcp.json: rewrite relative paths to absolute for worktree context ---
  const mainMcpPath = path.join(PROJECT_DIR, '.mcp.json');
  if (fs.existsSync(mainMcpPath)) {
    const mcpConfig = JSON.parse(fs.readFileSync(mainMcpPath, 'utf8'));

    if (mcpConfig.mcpServers) {
      for (const serverName of Object.keys(mcpConfig.mcpServers)) {
        const server = mcpConfig.mcpServers[serverName];
        // Rewrite CLAUDE_PROJECT_DIR env
        if (server.env && server.env.CLAUDE_PROJECT_DIR === '.') {
          server.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
        }
        // Resolve relative args paths to absolute (they're relative to main project, not worktree)
        if (Array.isArray(server.args)) {
          server.args = server.args.map(arg => {
            if (typeof arg === 'string' && (arg.startsWith('../') || arg.startsWith('./'))) {
              return path.resolve(PROJECT_DIR, arg);
            }
            return arg;
          });
        }
      }
    }

    fs.writeFileSync(
      path.join(worktreePath, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
  }

  // --- framework symlink: resolve real path (resilient to node_modules pruning) ---
  const frameworkDir = resolveFrameworkDir(PROJECT_DIR);
  if (frameworkDir) {
    // Always create node_modules/gentyr symlink for consistent resolution
    const worktreeNmDir = path.join(worktreePath, 'node_modules');
    fs.mkdirSync(worktreeNmDir, { recursive: true });
    safeSymlink(frameworkDir, path.join(worktreeNmDir, 'gentyr'));

    // Also create .claude-framework for legacy model compatibility
    const legacyPath = path.join(PROJECT_DIR, '.claude-framework');
    try {
      if (fs.lstatSync(legacyPath).isSymbolicLink() || fs.statSync(legacyPath).isDirectory()) {
        safeSymlink(frameworkDir, path.join(worktreePath, '.claude-framework'));
      }
    } catch {}
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
