/**
 * gentyr protect / gentyr unprotect - Enable/disable root-owned file protection
 *
 * @module commands/protect
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, detectInstallModel } from '../lib/resolve-framework.js';

/** Validate a username/group to prevent command injection. */
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function assertSafeName(name, label) {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid ${label}: "${name}"`);
  }
}

/** Run a command via sudo (prompts user for password if needed). */
function sudoExec(cmd, args, opts = {}) {
  execFileSync('sudo', [cmd, ...args], { stdio: 'inherit', ...opts });
}

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

/**
 * Get the resolved hooks directory (follows symlinks).
 * @param {string} projectDir
 * @returns {string}
 */
function getHooksDir(projectDir) {
  const hooksPath = path.join(projectDir, '.claude', 'hooks');
  try {
    if (fs.lstatSync(hooksPath).isSymbolicLink()) {
      return fs.realpathSync(hooksPath);
    }
  } catch {}
  return hooksPath;
}

/**
 * Get the current user.
 * @returns {string}
 */
function getOriginalUser() {
  const user = process.env.USER || 'unknown';
  assertSafeName(user, 'username');
  return user;
}

/**
 * Get the original user's group.
 * @returns {string}
 */
function getOriginalGroup() {
  const user = getOriginalUser();
  try {
    const group = execFileSync('id', ['-gn', user], { encoding: 'utf8', stdio: 'pipe' }).trim();
    assertSafeName(group, 'group');
    return group;
  } catch {
    return process.platform === 'darwin' ? 'staff' : user;
  }
}

/**
 * Apply root-owned protection to critical files.
 * @param {string} projectDir
 */
function doProtect(projectDir) {
  const hooksPath = path.join(projectDir, '.claude', 'hooks');
  const hooksDir = getHooksDir(projectDir);
  const rootGroup = process.platform === 'darwin' ? 'wheel' : 'root';

  console.log(`${YELLOW}Enabling protection (sudo will prompt for password)...${NC}`);

  const criticalHooks = [
    'pre-commit-review.js',
    'bypass-approval-hook.js',
    'block-no-verify.js',
    'protected-action-gate.js',
    'protected-action-approval-hook.js',
    'credential-file-guard.js',
    'secret-leak-detector.js',
    'protected-actions.json',
    'branch-checkout-guard.js',
    'git-wrappers/git',
  ];

  // Detect if hooks is a symlink (linked project). If so, copy critical hooks
  // to a local directory so root-owning them doesn't affect the framework source.
  let isSymlinked = false;
  try {
    isSymlinked = fs.lstatSync(hooksPath).isSymbolicLink();
  } catch {}

  const hooksProtectedDir = path.join(projectDir, '.claude', 'hooks-protected');
  let protectedHooksDir = hooksDir;

  if (isSymlinked) {
    // Create local copy directory for root-owned hooks
    fs.mkdirSync(hooksProtectedDir, { recursive: true });
    let copied = 0;
    for (const hook of criticalHooks) {
      const src = path.join(hooksDir, hook);
      const dst = path.join(hooksProtectedDir, hook);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied++;
      }
    }
    protectedHooksDir = hooksProtectedDir;
    console.log(`  Copied ${copied} critical hooks to .claude/hooks-protected/`);
  }

  const files = [
    path.join(protectedHooksDir, 'pre-commit-review.js'),
    path.join(protectedHooksDir, 'bypass-approval-hook.js'),
    path.join(protectedHooksDir, 'block-no-verify.js'),
    path.join(protectedHooksDir, 'protected-action-gate.js'),
    path.join(protectedHooksDir, 'protected-action-approval-hook.js'),
    path.join(protectedHooksDir, 'credential-file-guard.js'),
    path.join(protectedHooksDir, 'secret-leak-detector.js'),
    path.join(protectedHooksDir, 'protected-actions.json'),
    path.join(protectedHooksDir, 'branch-checkout-guard.js'),
    path.join(protectedHooksDir, 'git-wrappers', 'git'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'protection-key'),
    path.join(projectDir, '.mcp.json'),
    path.join(projectDir, '.claude', 'config', 'services.json'),
    path.join(projectDir, 'eslint.config.js'),
    path.join(projectDir, '.husky', 'pre-commit'),
    path.join(projectDir, 'package.json'),
  ];

  // Protect directories that should block agent file creation/deletion.
  // .claude/hooks/ is NOT protected as a directory — git needs write access for atomic
  // file operations (checkout, merge, stash). Individual critical files inside are still
  // root-owned. The unlink+recreate gap is closed by the husky tamper check + SessionStart check.
  //
  // .claude/ directory is NOT root-owned — git stash/checkout/merge need to create/unlink
  // files inside it. Symlink target verification (pre-commit + SessionStart) replaces
  // directory ownership as the anti-tampering mechanism for .claude/hooks.
  const dirs = [
    path.join(projectDir, '.husky'),
  ];

  // Write state BEFORE protecting directories (user needs write access to .claude/)
  const statePayload = {
    protected: true,
    timestamp: new Date().toISOString(),
    modified_by: getOriginalUser(),
    criticalHooks,
  };
  if (isSymlinked) {
    statePayload.hooksProtectedDir = '.claude/hooks-protected';
  }
  const stateFile = path.join(projectDir, '.claude', 'protection-state.json');
  fs.writeFileSync(stateFile, JSON.stringify(statePayload, null, 2) + '\n');
  sudoExec('chmod', ['644', stateFile]);

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      sudoExec('chown', [`root:${rootGroup}`, dir]);
      sudoExec('chmod', ['1755', dir]);
      console.log(`  Protected dir: ${dir}`);
    }
  }

  // Migration: if .claude/ is currently root-owned, restore user ownership.
  // This undoes the old protection model that broke git stash/checkout/merge.
  const claudeDir = path.join(projectDir, '.claude');
  try {
    const stat = fs.statSync(claudeDir);
    if (stat.uid === 0) {
      const originalUser = getOriginalUser();
      const originalGroup = getOriginalGroup();
      sudoExec('chown', [`${originalUser}:${originalGroup}`, claudeDir]);
      sudoExec('chmod', ['755', claudeDir]);
      console.log(`  Migrated .claude/ to user ownership (was root-owned)`);
    }
  } catch {}

  for (const file of files) {
    if (fs.existsSync(file)) {
      sudoExec('chown', [`root:${rootGroup}`, file]);
      if (file.includes('.husky/')) {
        sudoExec('chmod', ['755', file]);
      } else {
        sudoExec('chmod', ['644', file]);
      }
      console.log(`  Protected: ${file}`);
    }
  }

  console.log(`${GREEN}Protection enabled. Agents cannot modify critical files.${NC}`);
}

/**
 * Disable root-owned protection.
 * @param {string} projectDir
 */
function doUnprotect(projectDir) {
  const hooksDir = getHooksDir(projectDir);
  const originalUser = getOriginalUser();
  const originalGroup = getOriginalGroup();

  console.log(`${YELLOW}Disabling protection (sudo will prompt for password)...${NC}`);

  // Detect copy-on-protect directory (linked projects)
  const hooksProtectedDir = path.join(projectDir, '.claude', 'hooks-protected');
  const hasLocalCopies = fs.existsSync(hooksProtectedDir);
  const hooksOwnershipDir = hasLocalCopies ? hooksProtectedDir : hooksDir;

  const files = [
    path.join(hooksOwnershipDir, 'pre-commit-review.js'),
    path.join(hooksOwnershipDir, 'bypass-approval-hook.js'),
    path.join(hooksOwnershipDir, 'block-no-verify.js'),
    path.join(hooksOwnershipDir, 'protected-action-gate.js'),
    path.join(hooksOwnershipDir, 'protected-action-approval-hook.js'),
    path.join(hooksOwnershipDir, 'credential-file-guard.js'),
    path.join(hooksOwnershipDir, 'secret-leak-detector.js'),
    path.join(hooksOwnershipDir, 'protected-actions.json'),
    path.join(hooksOwnershipDir, 'branch-checkout-guard.js'),
    path.join(hooksOwnershipDir, 'git-wrappers', 'git'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'TESTING.md'),
    path.join(projectDir, '.claude', 'protection-key'),
    path.join(projectDir, 'eslint.config.js'),
    path.join(projectDir, '.husky', 'pre-commit'),
    path.join(projectDir, '.husky', 'post-commit'),
    path.join(projectDir, '.husky', 'pre-push'),
    path.join(projectDir, '.mcp.json'),
    path.join(projectDir, 'package.json'),
  ];

  const dirs = [
    path.join(projectDir, '.husky'),
  ];

  const ownership = `${originalUser}:${originalGroup}`;

  for (const file of files) {
    if (fs.existsSync(file)) {
      sudoExec('chown', [ownership, file]);
      sudoExec('chmod', ['644', file]);
      console.log(`  Unprotected: ${file}`);
    }
  }

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      sudoExec('chown', [ownership, dir]);
      sudoExec('chmod', ['755', dir]);
      console.log(`  Unprotected dir: ${dir}`);
    }
  }

  // Bulk-fix remaining root-owned files
  // Skip framework hooksDir when using local copies (avoid touching framework source)
  const fixDirs = [
    [path.join(projectDir, '.husky'), 1],
    [path.join(projectDir, '.claude'), 1],
    [path.join(projectDir, '.claude', 'state'), 1],
  ];
  if (!hasLocalCopies) {
    fixDirs.push([hooksDir, 2]);  // covers lib/, __tests__/
  }
  for (const [dir, depth] of fixDirs) {
    if (fs.existsSync(dir)) {
      try {
        sudoExec('find', [dir, '-maxdepth', String(depth), '-type', 'f', '-user', 'root', '-exec', 'chown', ownership, '{}', ';']);
      } catch {}
    }
  }

  // Remove copy-on-protect directory after unprotecting its files
  if (hasLocalCopies) {
    fs.rmSync(hooksProtectedDir, { recursive: true, force: true });
    console.log(`  Removed .claude/hooks-protected/`);
  }

  // Fix agents directory
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  if (fs.existsSync(agentsDir)) {
    sudoExec('chown', [ownership, agentsDir]);
    sudoExec('chmod', ['755', agentsDir]);
    try {
      sudoExec('find', [agentsDir, '-maxdepth', '1', '-user', 'root', '-exec', 'chown', '-h', ownership, '{}', ';']);
    } catch {}
  }

  // Fix reporters directory
  const reportersDir = path.join(projectDir, '.claude', 'reporters');
  if (fs.existsSync(reportersDir)) {
    sudoExec('chown', [ownership, reportersDir]);
    sudoExec('chmod', ['755', reportersDir]);
    try {
      sudoExec('find', [reportersDir, '-maxdepth', '1', '-user', 'root', '-exec', 'chown', '-h', ownership, '{}', ';']);
    } catch {}
  }

  // Fix framework build directories
  const frameworkDir = resolveFrameworkDir(projectDir);
  if (frameworkDir) {
    for (const subdir of ['packages/mcp-servers/dist', 'packages/mcp-servers/node_modules', 'node_modules']) {
      const dir = path.join(frameworkDir, subdir);
      if (fs.existsSync(dir)) {
        sudoExec('chown', ['-R', ownership, dir]);
        console.log(`  Unprotected dir: ${dir}`);
      }
    }
  }

  // Write state (directories are now user-owned so we can write directly)
  fs.writeFileSync(path.join(projectDir, '.claude', 'protection-state.json'), JSON.stringify({
    protected: false,
    timestamp: new Date().toISOString(),
    modified_by: originalUser,
  }, null, 2) + '\n');

  console.log(`${GREEN}Protection disabled.${NC}`);
}

export default async function protect(args) {
  const projectDir = process.cwd();

  const model = detectInstallModel(projectDir);
  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    process.exit(1);
  }

  // Check for --mode unprotect (set by CLI dispatcher for 'gentyr unprotect')
  const isUnprotect = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'unprotect';

  if (isUnprotect) {
    doUnprotect(projectDir);
  } else {
    doProtect(projectDir);
  }
}
