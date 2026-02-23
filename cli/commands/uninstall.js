/**
 * gentyr uninstall - Remove GENTYR from a project
 *
 * @module commands/uninstall
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, detectInstallModel } from '../lib/resolve-framework.js';
import { removeSymlinks } from '../lib/symlinks.js';
import { getFrameworkAgents } from '../lib/state.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

export default async function uninstall() {
  const projectDir = process.cwd();
  const model = detectInstallModel(projectDir);

  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    process.exit(1);
  }

  const frameworkDir = resolveFrameworkDir(projectDir);
  const agents = frameworkDir ? getFrameworkAgents(frameworkDir) : [];

  // Unprotect first if needed
  const protectionFile = path.join(projectDir, '.claude', 'protection-state.json');
  try {
    const ps = JSON.parse(fs.readFileSync(protectionFile, 'utf8'));
    if (ps.protected) {
      // Run unprotect via our protect command (prompts for sudo internally)
      const { default: protect } = await import('./protect.js');
      await protect(['--mode', 'unprotect']);
      console.log('');
    }
  } catch {}

  console.log(`${YELLOW}Uninstalling GENTYR from ${projectDir}...${NC}`);
  console.log('');

  // Remove rotation proxy certs
  console.log(`${YELLOW}Removing rotation proxy certificates...${NC}`);
  if (frameworkDir) {
    const certScript = path.join(frameworkDir, 'scripts', 'generate-proxy-certs.sh');
    if (fs.existsSync(certScript)) {
      try { execFileSync(certScript, ['--remove'], { stdio: 'inherit', timeout: 30000 }); } catch {}
    }
  }

  // Remove proxy shell integration
  console.log(`\n${YELLOW}Removing rotation proxy shell integration...${NC}`);
  const home = process.env.HOME || '';
  for (const profile of [path.join(home, '.zshrc'), path.join(home, '.bashrc')]) {
    if (fs.existsSync(profile)) {
      let content = fs.readFileSync(profile, 'utf8');
      if (content.includes('# BEGIN GENTYR PROXY')) {
        content = content.replace(/\n?# BEGIN GENTYR PROXY[\s\S]*?# END GENTYR PROXY\n?/g, '');
        fs.writeFileSync(profile, content);
        console.log(`  Removed proxy env from ${profile}`);
      }
    }
  }

  // Remove OP shell integration
  console.log(`\n${YELLOW}Removing OP shell integration...${NC}`);
  for (const profile of [path.join(home, '.zshrc'), path.join(home, '.bashrc')]) {
    if (fs.existsSync(profile)) {
      let content = fs.readFileSync(profile, 'utf8');
      if (content.includes('# BEGIN GENTYR OP')) {
        content = content.replace(/\n?# BEGIN GENTYR OP[\s\S]*?# END GENTYR OP\n?/g, '');
        fs.writeFileSync(profile, content);
        console.log(`  Removed OP token from ${profile}`);
      }
    }
  }

  // Remove automation service
  console.log(`\n${YELLOW}Removing automation service...${NC}`);
  if (frameworkDir) {
    const autoScript = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
    if (fs.existsSync(autoScript)) {
      try { execFileSync(autoScript, ['remove', '--path', projectDir], { stdio: 'inherit', timeout: 30000 }); } catch {}
    }
  }

  // Remove symlinks
  console.log(`\n${YELLOW}Removing symlinks from .claude/...${NC}`);
  removeSymlinks(projectDir, agents);

  // Remove generated .mcp.json
  console.log(`\n${YELLOW}Removing generated files...${NC}`);
  const mcpJson = path.join(projectDir, '.mcp.json');
  if (fs.existsSync(mcpJson)) {
    try {
      const content = fs.readFileSync(mcpJson, 'utf8');
      if (content.includes('node_modules/gentyr') || content.includes('claude-framework')) {
        fs.unlinkSync(mcpJson);
        console.log('  Removed .mcp.json');
      }
    } catch {}
  }

  // Clean settings.json
  console.log(`\n${YELLOW}Cleaning settings.json...${NC}`);
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  if (frameworkDir && fs.existsSync(settingsPath)) {
    const mergeScript = path.join(frameworkDir, 'scripts', 'merge-settings.cjs');
    try {
      fs.accessSync(settingsPath, fs.constants.W_OK);
      execFileSync('node', [mergeScript, 'uninstall', settingsPath], { stdio: 'pipe', timeout: 10000 });
      console.log('  Cleaned settings.json');
    } catch {
      console.log(`  ${YELLOW}Skipped settings.json (not writable)${NC}`);
    }
  }

  // Clean CLAUDE.md
  console.log(`\n${YELLOW}Cleaning CLAUDE.md...${NC}`);
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  const markerStart = '<!-- GENTYR-FRAMEWORK-START -->';
  const markerEnd = '<!-- GENTYR-FRAMEWORK-END -->';
  if (fs.existsSync(claudeMd)) {
    try {
      fs.accessSync(claudeMd, fs.constants.W_OK);
      let content = fs.readFileSync(claudeMd, 'utf8');
      if (content.includes(markerStart)) {
        const startIdx = content.indexOf(markerStart);
        const endIdx = content.indexOf(markerEnd);
        if (startIdx !== -1 && endIdx !== -1) {
          content = content.substring(0, startIdx) + content.substring(endIdx + markerEnd.length);
          content = content.replace(/\n{3,}/g, '\n\n').trim();
          if (content.replace(/\s/g, '').length === 0) {
            fs.unlinkSync(claudeMd);
            console.log('  Removed empty CLAUDE.md');
          } else {
            fs.writeFileSync(claudeMd, content + '\n');
            console.log('  Removed GENTYR section from CLAUDE.md');
          }
        }
      } else {
        console.log('  No GENTYR section found in CLAUDE.md');
      }
    } catch {
      console.log(`  ${YELLOW}Skipped CLAUDE.md (not writable)${NC}`);
    }
  }

  // Remove husky hooks
  console.log(`\n${YELLOW}Removing husky hooks...${NC}`);
  for (const hook of ['pre-commit', 'post-commit', 'pre-push']) {
    const hookPath = path.join(projectDir, '.husky', hook);
    if (fs.existsSync(hookPath)) {
      try {
        const content = fs.readFileSync(hookPath, 'utf8');
        if (content.includes('.claude/hooks/')) {
          fs.unlinkSync(hookPath);
          console.log(`  Removed .husky/${hook}`);
        }
      } catch {}
    }
  }

  // Unset core.hooksPath
  try {
    const hooksPath = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: projectDir, encoding: 'utf8', stdio: 'pipe',
    }).trim();
    if (hooksPath === '.husky') {
      execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd: projectDir, stdio: 'pipe' });
      console.log('  Unset core.hooksPath');
    }
  } catch {}

  // Remove framework symlinks
  console.log('');
  if (model === 'legacy') {
    const legacyPath = path.join(projectDir, '.claude-framework');
    try {
      if (fs.lstatSync(legacyPath).isSymbolicLink()) {
        fs.unlinkSync(legacyPath);
        console.log('  Removed .claude-framework symlink');
      }
    } catch {}
  }

  // Remove sync state
  const statePath = path.join(projectDir, '.claude', 'gentyr-state.json');
  try { fs.unlinkSync(statePath); } catch {}

  console.log('');
  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}GENTYR uninstalled!${NC}`);
  console.log(`${GREEN}========================================${NC}`);
  console.log('');
  console.log('Note: Runtime data (.claude/*.db) has been preserved.');
  console.log('To also remove npm link: pnpm unlink gentyr');
}
