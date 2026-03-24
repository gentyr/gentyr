/**
 * gentyr sync - Force sync (rebuild MCP servers + re-merge configs)
 *
 * @module commands/sync
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { generateMcpJson, mergeSettings, updateClaudeMd, updateGitignore } from '../lib/config-gen.js';
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';
import { restoreVaultMappings } from '../../lib/vault-mappings.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

/**
 * Check if the project is currently protected.
 * @param {string} projectDir
 * @returns {boolean}
 */
function isProtected(projectDir) {
  try {
    const stateFile = path.join(projectDir, '.claude', 'protection-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state.protected === true;
  } catch {
    return false;
  }
}

/**
 * Run `npx gentyr unprotect` as a subprocess (reuses the full unprotect logic).
 * @param {string} projectDir
 */
function runUnprotect(projectDir) {
  console.log(`\n${YELLOW}Temporarily disabling protection for sync...${NC}`);
  const cliEntry = path.resolve(import.meta.dirname, '..', 'index.js');
  execFileSync(process.execPath, [cliEntry, 'unprotect'], {
    cwd: projectDir, stdio: 'inherit', timeout: 60000,
  });
}

/**
 * Run `npx gentyr protect` as a subprocess (reuses the full protect logic).
 * @param {string} projectDir
 */
function runProtect(projectDir) {
  console.log(`\n${YELLOW}Re-enabling protection...${NC}`);
  const cliEntry = path.resolve(import.meta.dirname, '..', 'index.js');
  execFileSync(process.execPath, [cliEntry, 'protect'], {
    cwd: projectDir, stdio: 'inherit', timeout: 60000,
  });
}

export default async function sync(args) {
  const projectDir = process.cwd();

  const model = detectInstallModel(projectDir);
  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    console.error('Run `npx gentyr init` first.');
    process.exit(1);
  }

  const frameworkDir = resolveFrameworkDir(projectDir);
  const frameworkRel = resolveFrameworkRelative(projectDir);
  const agents = getFrameworkAgents(frameworkDir);

  // Auto-unprotect if needed so sync can write to root-owned files
  const wasProtected = isProtected(projectDir);
  if (wasProtected) {
    runUnprotect(projectDir);
  }

  // Wrap sync body in try/finally to guarantee re-protect on any failure
  try {

  console.log(`${GREEN}Syncing GENTYR...${NC}`);

  // 1. Re-merge settings.json
  console.log(`\n${YELLOW}Merging settings.json...${NC}`);
  mergeSettings(projectDir, frameworkDir);

  // 2. Regenerate .mcp.json
  console.log(`\n${YELLOW}Regenerating .mcp.json...${NC}`);
  generateMcpJson(projectDir, frameworkDir, frameworkRel);

  // 3. Update CLAUDE.md
  console.log(`\n${YELLOW}Updating CLAUDE.md...${NC}`);
  updateClaudeMd(projectDir, frameworkDir);

  // 4. Repair directory symlinks
  console.log(`\n${YELLOW}Repairing directory symlinks...${NC}`);
  createDirectorySymlinks(projectDir, frameworkRel);
  createReporterSymlinks(projectDir, frameworkRel);

  // 5. Sync agent symlinks
  console.log(`\n${YELLOW}Syncing agent symlinks...${NC}`);
  createAgentSymlinks(projectDir, frameworkRel, agents);

  // 5a. Migration: restore user ownership of .claude/ if root-owned
  const claudeDir = path.join(projectDir, '.claude');
  try {
    const stat = fs.statSync(claudeDir);
    if (stat.uid === 0) {
      console.log(`\n${YELLOW}Migrating .claude/ directory ownership...${NC}`);
      const user = process.env.USER || 'unknown';
      let group;
      try {
        group = execFileSync('id', ['-gn', user], { encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        group = process.platform === 'darwin' ? 'staff' : user;
      }
      try {
        execFileSync('sudo', ['chown', `${user}:${group}`, claudeDir], { stdio: 'inherit' });
        execFileSync('sudo', ['chmod', '755', claudeDir], { stdio: 'inherit' });
        console.log('  Restored user ownership of .claude/ (was root-owned)');
      } catch {
        console.log(`  ${YELLOW}Warning: could not restore .claude/ ownership (sudo may be needed)${NC}`);
      }
    }
  } catch {}

  // 5b. Update .gitignore
  console.log(`\n${YELLOW}Updating .gitignore...${NC}`);
  updateGitignore(projectDir);

  // 5c. Auto-untrack files that are now gitignored
  try {
    const tracked = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '.claude/'], {
      cwd: projectDir, encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    }).trim();
    if (tracked) {
      const files = tracked.split('\n').filter(Boolean);
      console.log(`  Untracking ${files.length} now-gitignored file(s)...`);
      execFileSync('git', ['rm', '--cached', '--quiet', ...files], {
        cwd: projectDir, encoding: 'utf8', stdio: 'pipe', timeout: 10000,
      });
      console.log(`  Untracked: ${files.join(', ')}`);
    }
  } catch {
    // Non-fatal — may not be a git repo or no tracked files match
  }

  // 5d. Recreate vault-mappings.json if missing (try backup restore first)
  const vaultMappingsPath = path.join(claudeDir, 'vault-mappings.json');
  if (!fs.existsSync(vaultMappingsPath)) {
    console.log(`\n${YELLOW}Recreating vault-mappings.json...${NC}`);
    const restored = restoreVaultMappings(projectDir);
    if (restored) {
      console.log('  Restored vault-mappings.json from backup');
    } else {
      fs.writeFileSync(vaultMappingsPath, JSON.stringify({ provider: '1password', mappings: {} }, null, 2), 'utf8');
      console.log('  Created empty vault-mappings.json scaffold');
    }
  }

  // 6. Sync husky hooks
  console.log(`\n${YELLOW}Syncing husky hooks...${NC}`);
  const huskyDir = path.join(frameworkDir, 'husky');
  const projectHuskyDir = path.join(projectDir, '.husky');
  if (fs.existsSync(huskyDir) && fs.existsSync(projectHuskyDir)) {
    for (const hook of fs.readdirSync(huskyDir)) {
      const src = path.join(huskyDir, hook);
      const dst = path.join(projectHuskyDir, hook);
      try {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
        console.log(`  Synced: .husky/${hook}`);
      } catch {
        console.log(`  ${YELLOW}Skipped .husky/${hook} (not writable)${NC}`);
      }
    }
  }

  // 7. Rebuild MCP servers
  console.log(`\n${YELLOW}Rebuilding MCP servers...${NC}`);
  const mcpDir = path.join(frameworkDir, 'packages', 'mcp-servers');
  try {
    const hasTypesNode = fs.existsSync(path.join(mcpDir, 'node_modules', '@types', 'node'));
    if (!hasTypesNode) {
      execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
      console.log('  Dependencies installed');
    } else {
      console.log('  Dependencies already present, skipping npm install');
    }
    execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  TypeScript built');
  } catch (err) {
    console.log(`  ${YELLOW}Warning: MCP server build failed: ${err.message}${NC}`);
  }

  // 7b. Build window recorder (macOS only)
  if (process.platform === 'darwin') {
    const windowRecorderDir = path.join(frameworkDir, 'tools', 'window-recorder');
    if (fs.existsSync(path.join(windowRecorderDir, 'Package.swift'))) {
      console.log(`\n${YELLOW}Building window recorder...${NC}`);
      try {
        execFileSync('swift', ['build', '-c', 'release'], { cwd: windowRecorderDir, stdio: 'pipe', timeout: 120000 });
        console.log('  Swift binary built');
      } catch (err) {
        console.log(`  ${YELLOW}Warning: Window recorder build failed: ${err.message}${NC}`);
      }
    }
  }

  // 8. Regenerate launchd plists (macOS only)
  if (process.platform === 'darwin') {
    const script = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
    if (fs.existsSync(script)) {
      console.log(`\n${YELLOW}Updating automation services...${NC}`);
      try {
        execFileSync(script, ['setup', '--path', projectDir], { stdio: 'inherit', timeout: 60000 });
      } catch {
        console.log(`  ${YELLOW}Automation service update failed (non-fatal)${NC}`);
      }
    }
  }

  // 9. Write state
  const state = buildState(frameworkDir, model);
  writeState(projectDir, state);

  console.log('');
  console.log(`${GREEN}Sync complete (v${state.version})${NC}`);

  } finally {
    // Re-protect if it was protected before sync (even if sync threw)
    if (wasProtected) {
      runProtect(projectDir);
    }
  }
}
