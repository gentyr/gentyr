/**
 * gentyr migrate - Convert from .claude-framework to npm model
 *
 * @module commands/migrate
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { generateMcpJson, mergeSettings } from '../lib/config-gen.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

export default async function migrate() {
  const projectDir = process.cwd();

  // Verify node_modules/gentyr exists
  const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (!stat.isSymbolicLink() && !stat.isDirectory()) {
      throw new Error('not a symlink or directory');
    }
  } catch {
    console.error(`${RED}Error: node_modules/gentyr not found.${NC}`);
    console.error('');
    console.error('First link the framework:');
    console.error('  pnpm link ~/git/gentyr');
    console.error('');
    console.error('Then run migration:');
    console.error('  npx gentyr migrate');
    process.exit(1);
  }

  // Verify .claude-framework exists (this is a migration, not fresh install)
  const legacyPath = path.join(projectDir, '.claude-framework');
  if (!fs.existsSync(legacyPath)) {
    console.error(`${YELLOW}No .claude-framework found - nothing to migrate.${NC}`);
    console.error('If this is a fresh install, use: npx gentyr init');
    process.exit(0);
  }

  const frameworkDir = fs.realpathSync(npmPath);
  const frameworkRel = path.relative(projectDir, frameworkDir);
  const agents = getFrameworkAgents(frameworkDir);

  console.log(`${GREEN}Migrating from .claude-framework to node_modules/gentyr...${NC}`);
  console.log('');

  // 1. Remove old symlinks
  console.log(`${YELLOW}Removing old symlinks...${NC}`);
  const claudeDir = path.join(projectDir, '.claude');
  for (const name of ['commands', 'hooks', 'mcp', 'docs']) {
    const linkPath = path.join(claudeDir, name);
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.unlinkSync(linkPath);
        console.log(`  Removed: .claude/${name}`);
      }
    } catch {}
  }

  // Remove old agent symlinks
  const agentsDir = path.join(claudeDir, 'agents');
  try {
    if (fs.lstatSync(agentsDir).isSymbolicLink()) {
      // Legacy directory symlink
      fs.unlinkSync(agentsDir);
      console.log('  Removed: .claude/agents (directory symlink)');
    } else if (fs.statSync(agentsDir).isDirectory()) {
      // Individual symlinks
      for (const agent of agents) {
        const ap = path.join(agentsDir, agent);
        try {
          if (fs.lstatSync(ap).isSymbolicLink()) fs.unlinkSync(ap);
        } catch {}
      }
      console.log('  Removed old agent symlinks');
    }
  } catch {}

  // Remove old reporter symlinks
  const reportersDir = path.join(claudeDir, 'reporters');
  if (fs.existsSync(reportersDir)) {
    fs.rmSync(reportersDir, { recursive: true });
    console.log('  Removed: .claude/reporters/');
  }

  // 2. Re-create symlinks with new target paths
  console.log(`\n${YELLOW}Creating new symlinks via node_modules/gentyr...${NC}`);
  createDirectorySymlinks(projectDir, frameworkRel);
  createAgentSymlinks(projectDir, frameworkRel, agents, { preserveProjectAgents: true });
  createReporterSymlinks(projectDir, frameworkRel);

  // 3. Regenerate .mcp.json
  console.log(`\n${YELLOW}Regenerating .mcp.json...${NC}`);
  generateMcpJson(projectDir, frameworkDir, frameworkRel);

  // 4. Re-merge settings.json
  console.log(`\n${YELLOW}Merging settings.json...${NC}`);
  mergeSettings(projectDir, frameworkDir);

  // 5. Remove .claude-framework symlink
  console.log(`\n${YELLOW}Removing legacy .claude-framework symlink...${NC}`);
  try {
    fs.unlinkSync(legacyPath);
    console.log('  Removed .claude-framework');
  } catch (err) {
    console.log(`  ${YELLOW}Could not remove .claude-framework: ${err.message}${NC}`);
    console.log('  You can manually remove it: rm .claude-framework');
  }

  // 6. Write sync state
  const state = buildState(frameworkDir, 'npm');
  writeState(projectDir, state);

  console.log('');
  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}Migration complete!${NC}`);
  console.log(`${GREEN}========================================${NC}`);
  console.log('');
  console.log(`Framework version: ${state.version}`);
  console.log('Install model:     node_modules/gentyr (npm)');
  console.log('');
  console.log('The .claude-framework symlink has been removed.');
  console.log('All paths now resolve through node_modules/gentyr.');
}
