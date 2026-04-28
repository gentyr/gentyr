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
import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { detectBaseBranch as detectBaseBranchShared } from './feature-branch-helper.js';
import { allocatePortBlock, releasePortBlock, cleanupStaleAllocations } from './port-allocator.js';
import { killProcessesInDirectory } from './process-tree.js';

// Lazy-loaded Database for suspended worktree check
let _Database = null;
try {
  _Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[worktree-manager] Warning: better-sqlite3 not available for suspended worktree check:', err.message);
  // Non-fatal: suspended worktree skip is best-effort
}

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
  } catch (_) { /* cleanup - failure expected */}

  const legacyPath = path.join(dir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
  }

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
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
  }

  return null;
}

// ============================================================================
// Build Artifact Copying
// ============================================================================

/**
 * Expand a glob pattern with single-level * wildcards against the filesystem.
 * Returns an array of absolute paths to directories that exist in baseDir.
 *
 * @param {string} baseDir - Absolute path to the main tree
 * @param {string} pattern - Relative glob pattern (e.g., "packages/{star}/dist")
 * @returns {string[]} Array of absolute paths that exist
 */
function expandArtifactGlob(baseDir, pattern) {
  const segments = pattern.split('/');
  // Guard against path traversal
  if (segments.some(s => s === '..')) return [];
  let candidates = [baseDir];

  for (const segment of segments) {
    const nextCandidates = [];
    for (const dir of candidates) {
      if (segment.includes('*')) {
        // Wildcard segment: enumerate directory entries and filter
        const regexStr = segment
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*');
        const regex = new RegExp(`^${regexStr}$`);
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && regex.test(entry.name)) {
              nextCandidates.push(path.join(dir, entry.name));
            }
          }
        } catch (_) { /* directory doesn't exist or isn't readable */ }
      } else {
        const next = path.join(dir, segment);
        try {
          if (fs.statSync(next).isDirectory()) {
            nextCandidates.push(next);
          }
        } catch (_) { /* doesn't exist */ }
      }
    }
    candidates = nextCandidates;
  }

  return candidates;
}

/**
 * Copy build artifact directories from the main tree to a worktree.
 *
 * @param {string} mainDir - Absolute path to the main project tree (PROJECT_DIR)
 * @param {string} worktreePath - Absolute path to the target worktree
 * @param {string[]} patterns - Array of glob patterns from worktreeArtifactCopy
 * @param {boolean} isStrict - Whether to throw on errors (strict provisioning mode)
 * @returns {{ copied: number, skipped: number, errors: string[] }}
 */
function copyBuildArtifacts(mainDir, worktreePath, patterns, isStrict) {
  let copied = 0;
  let skipped = 0;
  const errors = [];

  for (const pattern of patterns) {
    const sourceDirs = expandArtifactGlob(mainDir, pattern);
    if (sourceDirs.length === 0) {
      skipped++;
      continue;
    }

    for (const srcDir of sourceDirs) {
      const relPath = path.relative(mainDir, srcDir);
      const destDir = path.join(worktreePath, relPath);

      try {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(destDir), { recursive: true });

        // Remove existing dest if present (idempotent re-provisioning)
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true, force: true });
        }

        fs.cpSync(srcDir, destDir, { recursive: true });
        copied++;
      } catch (err) {
        const msg = `artifact-copy: failed to copy ${relPath}: ${err.message?.slice(0, 150)}`;
        errors.push(msg);
        if (isStrict) {
          throw new Error(`[worktree-manager] STRICT: ${msg}`);
        }
        console.error(`[worktree-manager] Warning: ${msg}`);
      }
    }
  }

  if (copied > 0) {
    console.error(`[worktree-manager] artifact-copy: copied ${copied} artifact director${copied === 1 ? 'y' : 'ies'} to ${worktreePath}`);
  }

  return { copied, skipped, errors };
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
 * - Runs package manager install unless `options.skipInstall` is true or
 *   `node_modules` is already populated (re-provisioning guard)
 *
 * @param {string} worktreePath - Absolute path to the worktree directory
 * @param {object} [options]
 * @param {boolean} [options.skipInstall=false] - Skip package manager install
 */
export function provisionWorktree(worktreePath, options = {}) {
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

    // Inject CLAUDE_WORKTREE_DIR and port env vars for worktree-aware MCP servers.
    // 'secret-sync' is only included when present in the config — in local prototyping
    // mode it is excluded from .mcp.json and must not receive port env injection.
    const configuredServerNames = new Set(Object.keys(mcpConfig.mcpServers));
    const worktreeAwareServers = ['playwright', 'secret-sync', 'agent-reports'].filter(s =>
      [...configuredServerNames].some(name => name.includes(s))
    );
    let ports = null;
    try {
      ports = allocatePortBlock(worktreePath);
    } catch (err) {
      console.error(`[worktree-manager] CRITICAL: port allocation failed for ${worktreePath}: ${err.message}. Worktree will have NO isolated ports — demos will default to port 3000 and likely show blank pages.`);
    }

    for (const serverName of configuredServerNames) {
      const server = mcpConfig.mcpServers[serverName];
      if (!server.env) continue;
      // Match servers by name containing the worktree-aware identifiers
      const isWorktreeAware = worktreeAwareServers.some(s => serverName.includes(s));
      if (isWorktreeAware) {
        server.env.CLAUDE_WORKTREE_DIR = worktreePath;
        if (ports) {
          server.env.PLAYWRIGHT_WEB_PORT = String(ports.webPort);
          server.env.PLAYWRIGHT_BACKEND_PORT = String(ports.backendPort);
          server.env.PLAYWRIGHT_BRIDGE_PORT = String(ports.bridgePort);
        }
        // Inject GENTYR_REPORT_TIER for agent-reports server based on base branch.
        // Agents branching from staging get staging-tier reports; all others get preview-tier.
        // This can be overridden via extraEnv passed to enqueueSession().
        if (serverName.includes('agent-reports') && options.baseBranch) {
          server.env.GENTYR_REPORT_TIER = options.baseBranch === 'staging' ? 'staging' : 'preview';
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
    } catch (err) {
      console.error('[worktree-manager] Warning:', err.message);
    }
  }

  // --- .claude directory and shared sub-resources ---
  const worktreeClaudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(worktreeClaudeDir, { recursive: true });

  const sharedLinks = ['settings.json', 'hooks', 'commands', 'mcp', 'config'];
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
  } catch (_) { /* cleanup - failure expected */} // ENOENT is fine

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
      } catch (_) { /* cleanup - failure expected */} // ENOENT -- proceed to create

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
      } catch (err) {
        console.error('[worktree-manager] Warning:', err.message);
      } // Skip individual agent errors
    }
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
  } // Main agents dir doesn't exist -- skip

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

  // --- Load services.json config for install/build settings ---
  let servicesConfig = null;
  if (!options?.skipInstall) {
    try {
      const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
      if (fs.existsSync(configPath)) {
        servicesConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (_) { /* services.json parse error — non-fatal */ }
  }

  const isStrict = servicesConfig?.worktreeProvisioningMode === 'strict';

  // --- Build artifact copy (BEFORE install) ---
  // Copy pre-built dist/ directories from the main tree to avoid a full build.
  // Must run before install so pnpm can create proper bin symlinks.
  if (!options?.skipInstall && servicesConfig?.worktreeArtifactCopy) {
    const patterns = servicesConfig.worktreeArtifactCopy;
    if (Array.isArray(patterns) && patterns.length > 0) {
      copyBuildArtifacts(PROJECT_DIR, worktreePath, patterns, isStrict);
    }
  }

  // --- Package manager install ---
  if (!options?.skipInstall) {
    const lockFiles = [
      { file: 'pnpm-lock.yaml', cmd: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'] },
      { file: 'yarn.lock', cmd: ['yarn', 'install', '--frozen-lockfile'] },
      { file: 'bun.lockb', cmd: ['bun', 'install', '--frozen-lockfile'] },
      { file: 'package-lock.json', cmd: ['npm', 'ci'] },
    ];

    // Skip if node_modules already populated (re-provisioning)
    const nmDir = path.join(worktreePath, 'node_modules');
    const hasNodeModules = fs.existsSync(nmDir) && fs.readdirSync(nmDir).length > 5;

    if (!hasNodeModules) {
      const rawTimeout = servicesConfig?.worktreeInstallTimeout;
      const installTimeout = (typeof rawTimeout === 'number' && rawTimeout >= 10000 && rawTimeout <= 600000)
        ? rawTimeout
        : 120000;
      for (const { file, cmd } of lockFiles) {
        if (fs.existsSync(path.join(worktreePath, file))) {
          try {
            execSync(cmd.join(' '), {
              cwd: worktreePath,
              encoding: 'utf8',
              timeout: installTimeout,
              stdio: 'pipe',
            });
            console.error(`[worktree-manager] Installed dependencies via ${cmd[0]} in ${worktreePath}`);
            // Store lockfile hash so syncWorktreeDeps skips until lockfile actually changes
            try {
              const lockfilePath = path.join(worktreePath, file);
              const hash = crypto.createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex').slice(0, 16);
              const hashDir = path.join(worktreePath, '.claude', 'state');
              fs.mkdirSync(hashDir, { recursive: true });
              fs.writeFileSync(path.join(hashDir, 'lockfile-hash'), hash);
            } catch { /* non-fatal */ }
          } catch (err) {
            if (isStrict) {
              throw new Error(`[worktree-manager] STRICT: ${cmd[0]} install failed in ${worktreePath}: ${err.message?.slice(0, 300)}`);
            }
            console.error(`[worktree-manager] Warning: ${cmd[0]} install failed (non-fatal): ${err.message}`);
          }
          break; // Only run one package manager
        }
      }
    }
  }

  // --- Workspace build ---
  // Worktrees only get source files — dist/ dirs are gitignored.
  // If configured in services.json, run a build command to produce build artifacts.
  if (!options?.skipInstall && servicesConfig) {
    const buildCmd = servicesConfig.worktreeBuildCommand;
    if (buildCmd) {
      const healthCheck = servicesConfig.worktreeBuildHealthCheck;
      let needsBuild = true;
      if (healthCheck) {
        try {
          execSync(healthCheck, { cwd: worktreePath, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
          needsBuild = false;
        } catch (_) { /* needs build */ }
      }
      if (needsBuild) {
        if (!servicesConfig.worktreeArtifactCopy || servicesConfig.worktreeArtifactCopy.length === 0) {
          console.error(`[worktree-manager] HINT: Running full build in worktree. Configure worktreeArtifactCopy in services.json to copy pre-built artifacts instead (seconds vs minutes). Use update_services_config MCP tool.`);
        }
        try {
          execSync(buildCmd, { cwd: worktreePath, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
          console.error(`[worktree-manager] Built workspace packages in ${worktreePath}`);
        } catch (err) {
          if (isStrict) {
            throw new Error(`[worktree-manager] STRICT: workspace build failed in ${worktreePath}: ${err.message?.slice(0, 300)}`);
          }
          console.error(`[worktree-manager] Warning: workspace build failed (non-fatal): ${err.message?.slice(0, 200)}`);
        }
      }
    }
  }
}

// ============================================================================
// Post-Merge Dependency Sync
// ============================================================================

/**
 * Sync dependencies in a worktree after a git merge/pull that may have changed
 * the lockfile. Detects lockfile changes by comparing a hash stored at install
 * time. If the lockfile changed, runs the package manager install + build.
 *
 * This ensures agents in worktrees NEVER need to manually install deps.
 * Called from: preview-watcher.js, checkAndSyncWorktree(), hourly-automation.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {object} [options]
 * @param {number} [options.timeout] - Install timeout in ms (default: from services.json or 120000)
 * @returns {{ synced: boolean, reason?: string }}
 */
export function syncWorktreeDeps(worktreePath, options = {}) {
  const HASH_FILE = path.join(worktreePath, '.claude', 'state', 'lockfile-hash');

  // Detect which lockfile exists
  const lockFiles = [
    { file: 'pnpm-lock.yaml', cmd: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'] },
    { file: 'yarn.lock', cmd: ['yarn', 'install', '--frozen-lockfile'] },
    { file: 'bun.lockb', cmd: ['bun', 'install', '--frozen-lockfile'] },
    { file: 'package-lock.json', cmd: ['npm', 'ci'] },
  ];

  let lockfilePath = null;
  let installCmd = null;
  for (const { file, cmd } of lockFiles) {
    const candidate = path.join(worktreePath, file);
    if (fs.existsSync(candidate)) {
      lockfilePath = candidate;
      installCmd = cmd;
      break;
    }
  }

  if (!lockfilePath || !installCmd) {
    return { synced: false, reason: 'no lockfile found' };
  }

  // Hash the current lockfile
  let currentHash;
  try {
    currentHash = crypto.createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex').slice(0, 16);
  } catch {
    // If crypto fails, always install as a safety measure
    currentHash = 'unknown-' + Date.now();
  }

  // Compare with stored hash
  let storedHash = null;
  try {
    storedHash = fs.readFileSync(HASH_FILE, 'utf8').trim();
  } catch { /* no stored hash — first sync */ }

  if (storedHash === currentHash) {
    return { synced: false, reason: 'lockfile unchanged' };
  }

  // Lockfile changed (or first sync) — install deps
  let servicesConfig = null;
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (fs.existsSync(configPath)) {
      servicesConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch { /* non-fatal */ }

  const rawTimeout = options.timeout ?? servicesConfig?.worktreeInstallTimeout;
  const installTimeout = (typeof rawTimeout === 'number' && rawTimeout >= 10000 && rawTimeout <= 600000)
    ? rawTimeout : 120000;

  try {
    execSync(installCmd.join(' '), {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: installTimeout,
      stdio: 'pipe',
    });
    console.error(`[worktree-manager] syncWorktreeDeps: installed deps in ${worktreePath}`);
  } catch (err) {
    console.error(`[worktree-manager] syncWorktreeDeps: install failed in ${worktreePath}: ${err.message?.slice(0, 200)}`);
    return { synced: false, reason: `install failed: ${err.message?.slice(0, 100)}` };
  }

  // Copy fresh artifacts from main tree (after install, before build check)
  if (servicesConfig?.worktreeArtifactCopy) {
    const patterns = servicesConfig.worktreeArtifactCopy;
    if (Array.isArray(patterns) && patterns.length > 0) {
      try {
        copyBuildArtifacts(PROJECT_DIR, worktreePath, patterns, false);
      } catch (err) {
        console.error(`[worktree-manager] syncWorktreeDeps: artifact copy failed (non-fatal): ${err.message?.slice(0, 200)}`);
      }
    }
  }

  // Run build if health check fails
  if (servicesConfig?.worktreeBuildCommand) {
    const healthCheck = servicesConfig.worktreeBuildHealthCheck;
    let needsBuild = true;
    if (healthCheck) {
      try {
        execSync(healthCheck, { cwd: worktreePath, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        needsBuild = false;
      } catch { /* needs build */ }
    }
    if (needsBuild) {
      try {
        execSync(servicesConfig.worktreeBuildCommand, {
          cwd: worktreePath,
          encoding: 'utf8',
          timeout: 300000,
          stdio: 'pipe',
        });
        console.error(`[worktree-manager] syncWorktreeDeps: built workspace in ${worktreePath}`);
      } catch (err) {
        console.error(`[worktree-manager] syncWorktreeDeps: build failed (non-fatal): ${err.message?.slice(0, 200)}`);
      }
    }
  }

  // Store the hash for next time
  try {
    const hashDir = path.dirname(HASH_FILE);
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(HASH_FILE, currentHash);
  } catch { /* non-fatal */ }

  return { synced: true };
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
 * @param {boolean} [options.skipFetch=false] - Skip git fetch entirely. Deprecated — prefer fetchTimeout.
 * @param {number} [options.fetchTimeout] - Timeout in ms for git fetch. If omitted, uses GIT_OPTS default.
 *   Use fetchTimeout: 10000 for latency-critical paths instead of skipFetch.
 * @returns {{ path: string, branch: string, created: boolean }}
 */
export function createWorktree(branchName, baseBranch, options = {}) {
  if (!baseBranch) {
    baseBranch = detectBaseBranchShared(PROJECT_DIR);
  }
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);

  // If worktree already exists, check if it's valid or an orphaned remnant
  if (fs.existsSync(worktreePath)) {
    const hasGitFile = fs.existsSync(path.join(worktreePath, '.git'));
    const hasMcpJson = fs.existsSync(path.join(worktreePath, '.mcp.json'));
    if (hasGitFile && hasMcpJson) {
      return { path: worktreePath, branch: branchName, created: false };
    }
    // Orphaned remnant (no .git or no .mcp.json) — remove and recreate
    try {
      if (hasGitFile) {
        execSync(`git worktree remove ${worktreePath} --force`, GIT_OPTS);
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
      console.error(`[worktree-manager] Removed orphaned directory at ${worktreePath}, recreating`);
    } catch (err) {
      console.error(`[worktree-manager] Warning: failed to clean orphan at ${worktreePath}: ${err.message}`);
      return { path: worktreePath, branch: branchName, created: false };
    }
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Fetch the base branch (non-fatal if it fails, e.g. offline or timeout)
  // skipFetch: legacy option — skips fetch entirely (deprecated, prefer fetchTimeout)
  // fetchTimeout: latency-critical paths can pass a short timeout (e.g. 10000ms) instead of skipping
  if (!options.skipFetch) {
    try {
      const fetchOpts = { ...GIT_OPTS };
      if (options.fetchTimeout) {
        fetchOpts.timeout = options.fetchTimeout;
      }
      execSync(`git fetch origin ${baseBranch} --quiet`, fetchOpts);
    } catch (err) {
      console.error('[worktree-manager] Warning:', err.message);
      // Non-fatal: base branch may already be up-to-date locally, or fetch timed out
    }
  }

  // Create the branch if it does not exist yet
  try {
    execSync(`git rev-parse --verify ${branchName}`, GIT_OPTS);
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
    execSync(`git branch ${branchName} origin/${baseBranch}`, GIT_OPTS);
  }

  // Add the worktree
  execSync(`git worktree add ${worktreePath} ${branchName}`, GIT_OPTS);

  // Provision with GENTYR config (strict mode may throw on install/build failure)
  try {
    provisionWorktree(worktreePath, { skipInstall: options.skipInstall, baseBranch });
  } catch (err) {
    // Strict provisioning failed — clean up the broken worktree
    console.error(`[worktree-manager] Provisioning failed, removing worktree: ${err.message}`);
    try { releasePortBlock(worktreePath); } catch (_) { /* best-effort */ }
    try {
      execSync(`git worktree remove ${worktreePath} --force`, GIT_OPTS);
    } catch (_) { /* best-effort cleanup */ }
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (_) { /* best-effort cleanup */ }
    throw err;
  }

  // Verify worktree base is fresh (informational, non-fatal)
  let behindBy = 0;
  try {
    const countStr = execFileSync('git', ['rev-list', `${branchName}..origin/${baseBranch}`, '--count'], {
      ...GIT_OPTS,
      cwd: worktreePath,
    }).trim();
    behindBy = parseInt(countStr, 10) || 0;
    if (behindBy > 0) {
      console.error(`[worktree-manager] WARNING: new worktree is ${behindBy} commit(s) behind origin/${baseBranch}`);
    }
  } catch {
    // Non-fatal — freshness check failure doesn't block worktree creation
  }

  return { path: worktreePath, branch: branchName, created: true, behindBy };
}

/**
 * Check if a PID is alive (process exists and is signalable).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAliveCheck(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Remove a worktree and optionally delete the branch.
 *
 * @param {string} branchName - Branch whose worktree should be removed
 * @param {object} [options]
 * @param {boolean} [options.force] - Bypass the session-queue safety guard (for callers that already verified safety)
 */
export function removeWorktree(branchName, options = {}) {
  const sanitized = sanitizeBranchName(branchName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);

  // Session-queue guard: refuse to remove worktrees with active sessions (Bug #6 defense).
  // Callers that already do their own safety checks pass { force: true } to bypass.
  if (!options.force && _Database) {
    const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
    if (fs.existsSync(queueDbPath)) {
      let queueDb;
      try {
        queueDb = new _Database(queueDbPath, { readonly: true });
        queueDb.pragma('busy_timeout = 3000');
        const normalizedPath = worktreePath.replace(/\/+$/, '');
        const activeSession = queueDb.prepare(
          "SELECT id, title, status, pid FROM queue_items WHERE status IN ('running', 'queued', 'spawning', 'suspended') AND (worktree_path = ? OR cwd = ?)"
        ).get(normalizedPath, normalizedPath);
        if (activeSession) {
          // Verify the session's PID is actually alive (avoid blocking on stale DB entries)
          const pidAlive = activeSession.pid ? isPidAliveCheck(activeSession.pid) : true; // fail-closed: assume alive if no PID
          if (pidAlive) {
            throw new Error(
              `[worktree-manager] BLOCKED: Cannot remove worktree ${worktreePath} — active session ${activeSession.id} ` +
              `("${activeSession.title}", status: ${activeSession.status}, pid: ${activeSession.pid}). ` +
              `Use removeWorktree(branch, { force: true }) to bypass.`
            );
          }
        }
      } catch (err) {
        if (err.message.includes('BLOCKED')) throw err; // Re-throw our own guard error
        console.error(`[worktree-manager] Warning: session-queue guard check failed (proceeding with removal): ${err.message}`);
      } finally {
        if (queueDb) try { queueDb.close(); } catch (_) { /* cleanup */ }
      }
    }
  }

  // Release allocated port block before removing worktree
  try {
    releasePortBlock(worktreePath);
  } catch (err) {
    console.error('[worktree-manager] Warning: port release failed:', err.message);
  }

  // Kill all processes with open files in this worktree before removal
  try {
    const { killed, errors } = killProcessesInDirectory(worktreePath);
    if (killed.length > 0) {
      console.error(`[worktree-manager] Killed ${killed.length} process group(s) in ${worktreePath}: ${killed.join(', ')}`);
      // Brief wait for processes to release file handles
      const waitUntil = Date.now() + 1000;
      while (Date.now() < waitUntil) { /* busy-wait 1s */ }
    }
    for (const err of errors) {
      console.error(`[worktree-manager] Warning: ${err}`);
    }
  } catch (err) {
    console.error(`[worktree-manager] Warning: process cleanup failed: ${err.message}`);
  }

  // Before removing, check if core.hooksPath points into this worktree and reset
  try {
    const hooksPath = execSync('git config --local --get core.hooksPath', GIT_OPTS).trim();
    if (hooksPath && path.resolve(PROJECT_DIR, hooksPath).startsWith(worktreePath)) {
      execSync('git config --local core.hooksPath .husky', GIT_OPTS);
    }
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
    // No hooksPath set or git error — nothing to reset
  }

  execSync(`git worktree remove ${worktreePath} --force`, GIT_OPTS);

  // Clean up any orphaned directories left behind (untracked files like .claude/state/)
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      console.error('[worktree-manager] Warning: orphan dir cleanup failed:', err.message);
    }
  }

  // Attempt to delete the branch (non-fatal: branch may have unmerged work)
  try {
    execSync(`git branch -d ${branchName}`, GIT_OPTS);
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
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
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
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
 * Fail-closed: returns true (assume in use) on lsof errors/timeouts.
 * Only returns false when lsof confirms no processes (exit code 1, empty stdout).
 *
 * @param {string} worktreePath - Absolute path to the worktree directory
 * @returns {boolean} true if active processes are detected or lsof is inconclusive
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
  } catch (err) {
    // lsof exit code 1 with empty stdout means "no processes found" — safe to clean up.
    // Any other error (timeout, permission, unexpected) — fail-closed: assume in use.
    if (err.status === 1 && (!err.stdout || err.stdout.trim().length === 0)) {
      return false;
    }
    console.error(`[worktree-manager] isWorktreeInUse: lsof error for ${worktreePath}, assuming in use (fail-closed): ${err.message}`);
    return true;
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
  const baseBranch = detectBaseBranchShared(PROJECT_DIR);

  // Fetch latest base branch state (non-fatal)
  try {
    execSync(`git fetch origin ${baseBranch} --quiet`, GIT_OPTS);
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
    // Offline or remote unavailable
  }

  let mergedOutput;
  try {
    mergedOutput = execSync(`git branch --merged origin/${baseBranch}`, GIT_OPTS);
  } catch (err) {
    console.error('[worktree-manager] Warning:', err.message);
    return 0;
  }

  const mergedBranches = new Set(
    mergedOutput
      .split('\n')
      .map((line) => line.replace(/^\*?\s+/, '').trim())
      .filter(Boolean),
  );

  // Get worktree paths of active queue items (running, queued, spawning, suspended) to avoid cleaning them up
  const suspendedWorktreePaths = new Set();
  if (_Database) {
    const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
    if (fs.existsSync(queueDbPath)) {
      let queueDb;
      try {
        queueDb = new _Database(queueDbPath, { readonly: true });
        queueDb.pragma('busy_timeout = 3000');
        const suspendedRows = queueDb.prepare(
          "SELECT cwd, metadata, worktree_path FROM queue_items WHERE status IN ('running', 'queued', 'spawning', 'suspended')"
        ).all();
        for (const row of suspendedRows) {
          if (row.cwd) {
            suspendedWorktreePaths.add(row.cwd);
          }
          // Check explicit worktree_path column
          if (row.worktree_path) {
            suspendedWorktreePaths.add(row.worktree_path);
          }
          // Also check metadata for worktreePath
          if (row.metadata) {
            try {
              const meta = JSON.parse(row.metadata);
              if (meta.worktreePath) {
                suspendedWorktreePaths.add(meta.worktreePath);
              }
            } catch (err) {
              console.error('[worktree-manager] Warning: could not parse active queue item metadata:', err.message);
            }
          }
        }
      } catch (err) {
        console.error('[worktree-manager] Warning: could not read active worktrees from queue DB:', err.message);
        // Non-fatal: continue without the suspended worktree check
      } finally {
        if (queueDb) {
          try { queueDb.close(); } catch (_) { /* cleanup - failure expected */}
        }
      }
    }
  }

  const managed = listWorktrees();
  let cleaned = 0;

  for (const wt of managed) {
    if (wt.branch && mergedBranches.has(wt.branch)) {
      // Skip worktrees that have active sessions (running, queued, spawning, or suspended)
      if (wt.path && suspendedWorktreePaths.size > 0) {
        const hasActiveSession = [...suspendedWorktreePaths].some(
          sw => wt.path === sw || wt.path.startsWith(sw + '/') || sw.startsWith(wt.path + '/')
        );
        if (hasActiveSession) {
          console.log(`[worktree-manager] Skipping ${wt.branch} — linked to an active session in session-queue`);
          continue;
        }
      }

      // Safety check: skip worktrees with active processes to prevent CWD corruption
      if (wt.path && isWorktreeInUse(wt.path)) {
        console.log(`[worktree-manager] Skipping ${wt.branch} — active session(s) detected in ${wt.path}`);
        continue;
      }

      // Safety check: skip worktrees with uncommitted changes
      if (wt.path) {
        try {
          const dirtyStatus = execSync('git status --porcelain', {
            cwd: wt.path, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          if (dirtyStatus.length > 0) {
            console.log(`[worktree-manager] Skipping ${wt.branch} — has uncommitted changes (${dirtyStatus.split('\n').length} files)`);
            continue;
          }
        } catch (err) {
          // If git status fails, skip removal (fail safe — don't destroy what we can't inspect)
          console.log(`[worktree-manager] Skipping ${wt.branch} — git status failed: ${err.message}`);
          continue;
        }
      }

      try {
        removeWorktree(wt.branch, { force: true }); // force: safety already verified above (session-queue + lsof + git status)
        cleaned++;
      } catch (err) {
        // Log but continue cleaning other worktrees
        console.error(`[worktree-manager] Failed to remove merged worktree ${wt.branch}: ${err.message}`);
      }
    }
  }

  // Safety net: clean up port allocations for worktree paths that no longer exist.
  // Catches cases where worktrees were removed by paths that bypassed removeWorktree().
  try {
    const staleRemoved = cleanupStaleAllocations();
    if (staleRemoved > 0) {
      console.log(`[worktree-manager] Cleaned ${staleRemoved} stale port allocation(s)`);
    }
  } catch (err) {
    console.error('[worktree-manager] Warning: stale port allocation cleanup failed:', err.message);
  }

  // Scan for orphaned directories that are NOT registered git worktrees.
  // These are remnants from `git worktree remove` leaving behind untracked dirs.
  if (fs.existsSync(WORKTREES_DIR)) {
    try {
      const registeredPaths = new Set(managed.map(wt => wt.path));
      for (const entry of fs.readdirSync(WORKTREES_DIR)) {
        const dirPath = path.join(WORKTREES_DIR, entry);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        if (registeredPaths.has(dirPath)) continue; // real worktree, skip
        // Not a registered worktree — check if it's truly orphaned
        const hasGitFile = fs.existsSync(path.join(dirPath, '.git'));
        if (hasGitFile) continue; // has .git file, might be valid but unlisted — skip to be safe
        // No .git file = definitely orphaned remnant. Check for active processes before removing (fail-closed).
        let orphanHasProcesses = false;
        try {
          const lsofResult = execFileSync('lsof', ['+D', dirPath, '-t'], {
            encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (lsofResult.trim().length > 0) orphanHasProcesses = true;
        } catch (lsofErr) {
          // lsof exit code 1 with empty stdout = no processes found — safe to proceed.
          // Any other error (timeout, permission, etc.) = fail-closed: skip removal.
          if (lsofErr.status === 1 && (!lsofErr.stdout || lsofErr.stdout.trim().length === 0)) {
            orphanHasProcesses = false;
          } else {
            orphanHasProcesses = true;
          }
        }
        if (orphanHasProcesses) continue;
        fs.rmSync(dirPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch (err) {
      console.error('[worktree-manager] Warning: orphan directory scan failed:', err.message);
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
