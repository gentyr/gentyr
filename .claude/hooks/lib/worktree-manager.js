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
import { execSync, execFileSync } from 'child_process';

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
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        // Verify existing symlink points to the right target
        const existing = fs.readlinkSync(linkPath);
        if (existing === target) return;
        fs.unlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        // Real directory (e.g., git-tracked .husky/) — remove and replace with symlink
        fs.rmSync(linkPath, { recursive: true, force: true });
      } else {
        // Regular file — remove and replace
        fs.unlinkSync(linkPath);
      }
      fs.symlinkSync(target, linkPath);
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
  const npmPath = path.join(dir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(npmPath);
    }
  } catch {}

  const legacyPath = path.join(dir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch {}

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
  // --- .mcp.json: rewrite CLAUDE_PROJECT_DIR env values to absolute path ---
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

  const sharedLinks = ['settings.json', 'hooks', 'commands', 'mcp'];
  for (const name of sharedLinks) {
    const target = path.join(PROJECT_DIR, '.claude', name);
    if (fs.existsSync(target)) {
      safeSymlink(target, path.join(worktreeClaudeDir, name));
    }
  }

  // --- .claude/agents: individual file symlinks (not directory symlink) ---
  // Mirrors createAgentSymlinks() from cli/lib/symlinks.js.
  // Framework agents get symlinks; project-specific agents are copied for isolation.
  const worktreeAgentsDir = path.join(worktreeClaudeDir, 'agents');

  // If agents dir is a symlink (legacy or prior provision), replace with real dir
  try {
    const stat = fs.lstatSync(worktreeAgentsDir);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(worktreeAgentsDir);
    }
  } catch {} // ENOENT is fine

  fs.mkdirSync(worktreeAgentsDir, { recursive: true });

  // Provision agents from the main project's .claude/agents directory
  const mainAgentsDir = path.join(PROJECT_DIR, '.claude', 'agents');
  try {
    const mainAgents = fs.readdirSync(mainAgentsDir).filter(f => f.endsWith('.md'));
    for (const agent of mainAgents) {
      const mainAgentPath = path.join(mainAgentsDir, agent);
      const worktreeAgentPath = path.join(worktreeAgentsDir, agent);

      // Skip if already exists in worktree (idempotency)
      try {
        fs.lstatSync(worktreeAgentPath);
        continue;
      } catch {} // ENOENT -- proceed to create

      try {
        const mainStat = fs.lstatSync(mainAgentPath);
        if (mainStat.isSymbolicLink()) {
          // Framework agent: symlink to same absolute target
          const target = fs.readlinkSync(mainAgentPath);
          // Resolve relative targets to absolute
          const absoluteTarget = path.isAbsolute(target)
            ? target
            : path.resolve(path.dirname(mainAgentPath), target);
          fs.symlinkSync(absoluteTarget, worktreeAgentPath);
        } else {
          // Project-specific agent: copy for worktree isolation
          fs.copyFileSync(mainAgentPath, worktreeAgentPath);
        }
      } catch {} // Skip individual agent errors
    }
  } catch {} // Main agents dir doesn't exist -- skip

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
 * @param {string} [baseBranch] - Branch to base the new branch on. Auto-detected if omitted:
 *   uses 'preview' if origin/preview exists, otherwise 'main'.
 * @param {object} [options] - Options
 * @param {boolean} [options.skipFetch=false] - Skip git fetch for latency-critical paths.
 *   Callers should fire a background fetch after spawn if using this option.
 * @returns {{ path: string, branch: string, created: boolean }}
 */
export function createWorktree(branchName, baseBranch, options = {}) {
  if (!baseBranch) {
    try {
      execSync('git rev-parse --verify origin/preview', { ...GIT_OPTS, stdio: 'pipe' });
      baseBranch = 'preview';
    } catch {
      baseBranch = 'main';
    }
  }
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);

  // If worktree already exists, return early
  if (fs.existsSync(worktreePath)) {
    return { path: worktreePath, branch: branchName, created: false };
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Fetch the base branch (non-fatal if it fails, e.g. offline)
  // skipFetch: latency-critical paths (urgent-task-spawner, force-spawn) skip this
  // and fire a background fetch after spawn instead
  if (!options.skipFetch) {
    try {
      execSync(`git fetch origin ${baseBranch} --quiet`, GIT_OPTS);
    } catch {
      // Non-fatal: base branch may already be up-to-date locally
    }
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

  // Before removing, check if core.hooksPath points into this worktree and reset
  try {
    const hooksPath = execSync('git config --local --get core.hooksPath', GIT_OPTS).trim();
    if (hooksPath && path.resolve(PROJECT_DIR, hooksPath).startsWith(worktreePath)) {
      execSync('git config --local core.hooksPath .husky', GIT_OPTS);
    }
  } catch {
    // No hooksPath set or git error — nothing to reset
  }

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
// Active Session Detection
// ============================================================================

/**
 * Check if a worktree directory has active processes using it.
 * Uses `lsof` to detect open file descriptors in the directory.
 * Non-fatal: returns false (safe to clean) on any error.
 *
 * @param {string} worktreePath - Absolute path to the worktree directory
 * @returns {boolean} true if active processes are detected
 */
function isWorktreeInUse(worktreePath) {
  try {
    // lsof +D checks for open files in the directory recursively
    // Returns exit code 0 if matches found, 1 if not
    const result = execFileSync('lsof', ['+D', worktreePath, '-t'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim().length > 0;
  } catch {
    // lsof returned no results (exit 1) or failed — safe to clean up
    return false;
  }
}

// ============================================================================
// Maintenance
// ============================================================================

/**
 * Remove worktrees whose branches have been fully merged to the base branch.
 * Uses `origin/preview` if it exists, otherwise `origin/main`.
 * Skips worktrees that have active processes to prevent CWD corruption.
 *
 * @returns {number} Count of worktrees cleaned up
 */
export function cleanupMergedWorktrees() {
  // Detect base branch: preview for target projects, main for gentyr repo
  let baseBranch = 'preview';
  try {
    execSync('git rev-parse --verify origin/preview', { ...GIT_OPTS, stdio: 'pipe' });
  } catch {
    baseBranch = 'main';
  }

  // Fetch latest base branch state (non-fatal)
  try {
    execSync(`git fetch origin ${baseBranch} --quiet`, GIT_OPTS);
  } catch {
    // Offline or remote unavailable
  }

  let mergedOutput;
  try {
    mergedOutput = execSync(`git branch --merged origin/${baseBranch}`, GIT_OPTS);
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
      // Safety check: skip worktrees with active processes to prevent CWD corruption
      if (wt.path && isWorktreeInUse(wt.path)) {
        console.log(`[worktree-manager] Skipping ${wt.branch} — active session(s) detected in ${wt.path}`);
        continue;
      }
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
