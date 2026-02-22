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
 * Get the original (non-root) user when running under sudo.
 * @returns {string}
 */
function getOriginalUser() {
  const user = process.env.SUDO_USER || process.env.USER || 'unknown';
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
  if (process.getuid() !== 0) {
    console.error(`${RED}Error: protection requires sudo${NC}`);
    console.error(`Usage: sudo npx gentyr protect`);
    process.exit(1);
  }

  const hooksDir = getHooksDir(projectDir);
  const rootGroup = process.platform === 'darwin' ? 'wheel' : 'root';

  console.log(`${YELLOW}Enabling protection...${NC}`);

  const files = [
    path.join(hooksDir, 'pre-commit-review.js'),
    path.join(hooksDir, 'bypass-approval-hook.js'),
    path.join(hooksDir, 'block-no-verify.js'),
    path.join(hooksDir, 'protected-action-gate.js'),
    path.join(hooksDir, 'protected-action-approval-hook.js'),
    path.join(hooksDir, 'credential-file-guard.js'),
    path.join(hooksDir, 'secret-leak-detector.js'),
    path.join(hooksDir, 'protected-actions.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'protection-key'),
    path.join(projectDir, '.mcp.json'),
    path.join(projectDir, '.claude', 'config', 'services.json'),
    path.join(projectDir, 'eslint.config.js'),
    path.join(projectDir, '.husky', 'pre-commit'),
    path.join(projectDir, 'package.json'),
  ];

  const dirs = [
    path.join(projectDir, '.husky'),
    path.join(projectDir, '.claude'),
    hooksDir,
  ];

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      execFileSync('chown', [`root:${rootGroup}`, dir], { stdio: 'pipe' });
      execFileSync('chmod', ['1755', dir], { stdio: 'pipe' });
      console.log(`  Protected dir: ${dir}`);
    }
  }

  for (const file of files) {
    if (fs.existsSync(file)) {
      execFileSync('chown', [`root:${rootGroup}`, file], { stdio: 'pipe' });
      if (file.includes('.husky/')) {
        execFileSync('chmod', ['755', file], { stdio: 'pipe' });
      } else {
        execFileSync('chmod', ['644', file], { stdio: 'pipe' });
      }
      console.log(`  Protected: ${file}`);
    }
  }

  // Write state
  const stateFile = path.join(projectDir, '.claude', 'protection-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    protected: true,
    timestamp: new Date().toISOString(),
    modified_by: getOriginalUser(),
  }, null, 2) + '\n');
  execFileSync('chmod', ['644', stateFile], { stdio: 'pipe' });

  console.log(`${GREEN}Protection enabled. Agents cannot modify critical files.${NC}`);
}

/**
 * Disable root-owned protection.
 * @param {string} projectDir
 */
function doUnprotect(projectDir) {
  if (process.getuid() !== 0) {
    console.error(`${RED}Error: unprotection requires sudo${NC}`);
    console.error(`Usage: sudo npx gentyr unprotect`);
    process.exit(1);
  }

  const hooksDir = getHooksDir(projectDir);
  const originalUser = getOriginalUser();
  const originalGroup = getOriginalGroup();

  console.log(`${YELLOW}Disabling protection...${NC}`);

  const files = [
    path.join(hooksDir, 'pre-commit-review.js'),
    path.join(hooksDir, 'bypass-approval-hook.js'),
    path.join(hooksDir, 'block-no-verify.js'),
    path.join(hooksDir, 'protected-action-gate.js'),
    path.join(hooksDir, 'protected-action-approval-hook.js'),
    path.join(hooksDir, 'credential-file-guard.js'),
    path.join(hooksDir, 'secret-leak-detector.js'),
    path.join(hooksDir, 'protected-actions.json'),
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
    path.join(projectDir, '.claude'),
    hooksDir,
  ];

  const ownership = `${originalUser}:${originalGroup}`;

  for (const file of files) {
    if (fs.existsSync(file)) {
      execFileSync('chown', [ownership, file], { stdio: 'pipe' });
      execFileSync('chmod', ['644', file], { stdio: 'pipe' });
      console.log(`  Unprotected: ${file}`);
    }
  }

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      execFileSync('chown', [ownership, dir], { stdio: 'pipe' });
      execFileSync('chmod', ['755', dir], { stdio: 'pipe' });
      console.log(`  Unprotected dir: ${dir}`);
    }
  }

  // Bulk-fix remaining root-owned files
  const fixDirs = [
    [path.join(projectDir, '.husky'), 1],
    [path.join(projectDir, '.claude'), 1],
    [path.join(projectDir, '.claude', 'state'), 1],
  ];
  for (const [dir, depth] of fixDirs) {
    if (fs.existsSync(dir)) {
      try {
        execFileSync('find', [dir, '-maxdepth', String(depth), '-type', 'f', '-user', 'root', '-exec', 'chown', ownership, '{}', ';'], { stdio: 'pipe' });
      } catch {}
    }
  }

  // Fix agents directory
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  if (fs.existsSync(agentsDir)) {
    execFileSync('chown', [ownership, agentsDir], { stdio: 'pipe' });
    execFileSync('chmod', ['755', agentsDir], { stdio: 'pipe' });
    try {
      execFileSync('find', [agentsDir, '-maxdepth', '1', '-user', 'root', '-exec', 'chown', '-h', ownership, '{}', ';'], { stdio: 'pipe' });
    } catch {}
  }

  // Fix reporters directory
  const reportersDir = path.join(projectDir, '.claude', 'reporters');
  if (fs.existsSync(reportersDir)) {
    execFileSync('chown', [ownership, reportersDir], { stdio: 'pipe' });
    execFileSync('chmod', ['755', reportersDir], { stdio: 'pipe' });
    try {
      execFileSync('find', [reportersDir, '-maxdepth', '1', '-user', 'root', '-exec', 'chown', '-h', ownership, '{}', ';'], { stdio: 'pipe' });
    } catch {}
  }

  // Fix framework build directories
  const frameworkDir = resolveFrameworkDir(projectDir);
  if (frameworkDir) {
    for (const subdir of ['packages/mcp-servers/dist', 'packages/mcp-servers/node_modules', 'node_modules']) {
      const dir = path.join(frameworkDir, subdir);
      if (fs.existsSync(dir)) {
        execFileSync('chown', ['-R', ownership, dir], { stdio: 'pipe' });
        console.log(`  Unprotected dir: ${dir}`);
      }
    }
  }

  // Write state
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
