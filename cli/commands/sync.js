/**
 * gentyr sync - Force sync (rebuild MCP servers + re-merge configs)
 *
 * @module commands/sync
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { generateMcpJson, mergeSettings, updateClaudeMd } from '../lib/config-gen.js';
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

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
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  Dependencies installed');
    execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  TypeScript built');
  } catch (err) {
    console.log(`  ${YELLOW}Warning: MCP server build failed: ${err.message}${NC}`);
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
}
