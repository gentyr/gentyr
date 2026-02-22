/**
 * gentyr status - Show installation state
 *
 * @module commands/status
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { readState, readFrameworkVersion, computeConfigHash, computeClaudeMdHash } from '../lib/state.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

export default async function status() {
  const projectDir = process.cwd();
  const model = detectInstallModel(projectDir);

  console.log('GENTYR Installation Status');
  console.log('==========================');
  console.log('');

  if (!model) {
    console.log(`${RED}Not installed${NC}`);
    console.log('');
    console.log('To install:');
    console.log('  pnpm link ~/git/gentyr');
    console.log('  npx gentyr init');
    process.exit(0);
  }

  const frameworkDir = resolveFrameworkDir(projectDir);
  const frameworkRel = resolveFrameworkRelative(projectDir);
  const state = readState(projectDir);
  const currentVersion = readFrameworkVersion(frameworkDir);

  console.log(`Install model:    ${model === 'npm' ? GREEN + 'npm (node_modules/gentyr)' : YELLOW + 'legacy (.claude-framework)'} ${NC}`);
  console.log(`Framework path:   ${frameworkDir}`);
  console.log(`Relative path:    ${frameworkRel}`);
  console.log(`Current version:  ${currentVersion}`);
  console.log('');

  if (state) {
    const synced = state.version === currentVersion;
    console.log(`Last synced:      ${state.lastSync || 'unknown'}`);
    console.log(`Synced version:   ${state.version} ${synced ? GREEN + '(up to date)' : RED + '(outdated - run npx gentyr sync)'} ${NC}`);

    // Check config hash
    const currentHash = computeConfigHash(frameworkDir);
    const configMatch = state.configHash === currentHash;
    console.log(`Config hash:      ${configMatch ? GREEN + 'match' : YELLOW + 'differs (run npx gentyr sync)'} ${NC}`);

    // Check CLAUDE.md hash
    const currentMdHash = computeClaudeMdHash(frameworkDir);
    const mdMatch = state.claudeMdHash === currentMdHash;
    console.log(`CLAUDE.md hash:   ${mdMatch ? GREEN + 'match' : YELLOW + 'differs'} ${NC}`);

    console.log(`Agents:           ${state.agentList?.length || 0} framework agents`);
    console.log(`State version:    ${state.stateFilesVersion}`);
  } else {
    console.log(`${YELLOW}No sync state found - run npx gentyr sync${NC}`);
  }

  // Check protection state
  console.log('');
  const protectionState = path.join(projectDir, '.claude', 'protection-state.json');
  try {
    const ps = JSON.parse(fs.readFileSync(protectionState, 'utf8'));
    const isProtected = ps.protected === true;
    console.log(`Protection:       ${isProtected ? GREEN + 'enabled' : 'disabled'} ${NC}`);
    if (ps.timestamp) console.log(`Last changed:     ${ps.timestamp}`);
    if (ps.modified_by) console.log(`Modified by:      ${ps.modified_by}`);
  } catch {
    console.log('Protection:       unknown');
  }

  // Check symlinks
  console.log('');
  console.log('Symlinks:');
  for (const name of ['commands', 'hooks', 'mcp', 'docs']) {
    const linkPath = path.join(projectDir, '.claude', name);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(linkPath);
        console.log(`  .claude/${name} -> ${target} ${GREEN}OK${NC}`);
      } else {
        console.log(`  .claude/${name} ${YELLOW}(real directory, not symlink)${NC}`);
      }
    } catch {
      console.log(`  .claude/${name} ${RED}MISSING${NC}`);
    }
  }

  // Check MCP servers dist
  console.log('');
  const distDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'dist');
  if (fs.existsSync(distDir)) {
    const srcDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'src');
    try {
      const srcMtime = getNewestMtime(srcDir);
      const distMtime = getNewestMtime(distDir);
      const stale = srcMtime > distMtime;
      console.log(`MCP servers:      ${stale ? YELLOW + 'stale (run npx gentyr sync)' : GREEN + 'up to date'} ${NC}`);
    } catch {
      console.log(`MCP servers:      ${GREEN}built${NC}`);
    }
  } else {
    console.log(`MCP servers:      ${RED}not built (run npx gentyr sync)${NC}`);
  }
}

/**
 * Get the newest mtime in a directory (recursive).
 * @param {string} dir
 * @returns {number}
 */
function getNewestMtime(dir) {
  let newest = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestMtime(full));
    } else {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}
