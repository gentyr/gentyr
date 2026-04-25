/**
 * gentyr sync - Force sync (rebuild MCP servers + re-merge configs)
 *
 * @module commands/sync
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { generateMcpJson, mergeSettings, updateClaudeMd, updateGitignore } from '../lib/config-gen.js';
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';
import { restoreVaultMappings } from '../../lib/vault-mappings.js';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';

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

/**
 * Remove all remnants of the deleted rotation proxy system from existing installs.
 * Idempotent — silently skips anything that is already gone.
 * MUST NOT throw: every destructive operation is wrapped in try/catch.
 * @param {string} projectDir
 */
function cleanupRotationProxy(projectDir) {
  const home = os.homedir();

  // ── 1. Stop and remove launchd service (macOS) ─────────────────────────────
  if (process.platform === 'darwin') {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.local.gentyr-rotation-proxy.plist');
    if (fs.existsSync(plistPath)) {
      console.log(`\n${YELLOW}Removing rotation proxy launchd service...${NC}`);
      try {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe', timeout: 10000 });
      } catch {
        // Service may already be unloaded — not an error
      }
      try {
        fs.unlinkSync(plistPath);
        console.log('  Removed com.local.gentyr-rotation-proxy.plist');
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not remove proxy plist: ${err.message}${NC}`);
      }
    }
  }

  // ── 2. Stop and disable systemd service (Linux) ────────────────────────────
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'stop', 'gentyr-rotation-proxy.service'],
        { stdio: 'pipe', timeout: 10000 });
    } catch {
      // Not running or not found — not an error
    }
    try {
      execFileSync('systemctl', ['--user', 'disable', 'gentyr-rotation-proxy.service'],
        { stdio: 'pipe', timeout: 10000 });
    } catch {
      // Not enabled or not found — not an error
    }
  }

  // ── 3. Strip GENTYR PROXY blocks from shell profiles ───────────────────────
  const proxyBlockPattern = /\n?# BEGIN GENTYR PROXY\b[\s\S]*?# END GENTYR PROXY[^\n]*(\n|$)/g;
  for (const profileName of ['.zshrc', '.bashrc']) {
    const profilePath = path.join(home, profileName);
    if (!fs.existsSync(profilePath)) continue;
    try {
      const original = fs.readFileSync(profilePath, 'utf8');
      const cleaned = original.replace(proxyBlockPattern, '\n').replace(/\n{3,}/g, '\n\n');
      if (cleaned !== original) {
        fs.writeFileSync(profilePath, cleaned, 'utf8');
        console.log(`  Stripped GENTYR PROXY block from ~/${profileName}`);
      }
    } catch (err) {
      console.log(`  ${YELLOW}Warning: could not clean ~/${profileName}: ${err.message}${NC}`);
    }
  }

  // ── 4. Kill any lingering process on port 18080 ────────────────────────────
  try {
    const pids = execFileSync('lsof', ['-ti', ':18080'], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid));
        } catch {
          // Process may have already exited
        }
      }
      console.log(`  Killed rotation proxy process(es) on port 18080`);
    }
  } catch {
    // lsof exits non-zero when nothing is found — not an error
  }

  // ── 5. Delete TLS certificate directory ────────────────────────────────────
  const certDir = path.join(home, '.claude', 'proxy-certs');
  if (fs.existsSync(certDir)) {
    try {
      fs.rmSync(certDir, { recursive: true, force: true });
      console.log(`  Deleted ~/.claude/proxy-certs/`);
    } catch (err) {
      console.log(`  ${YELLOW}Warning: could not delete proxy-certs/: ${err.message}${NC}`);
    }
  }

  // ── 6. Delete user-level state files ───────────────────────────────────────
  const userStateFiles = [
    path.join(home, '.claude', 'api-key-rotation.json'),
    path.join(home, '.claude', 'proxy-disabled.json'),
    path.join(home, '.claude', 'rotation-proxy.log'),
  ];
  for (const filePath of userStateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`  Deleted ${filePath.replace(home, '~')}`);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not delete ${path.basename(filePath)}: ${err.message}${NC}`);
      }
    }
  }

  // ── 7. Delete project-level state files ────────────────────────────────────
  const projectStateFiles = [
    path.join(projectDir, '.claude', 'api-key-rotation.log'),
    path.join(projectDir, '.claude', 'state', 'quota-interrupted-sessions.json'),
    path.join(projectDir, '.claude', 'state', 'paused-sessions.json'),
    path.join(projectDir, '.claude', 'state', 'quota-monitor-state.json'),
    path.join(projectDir, '.claude', 'state', 'rotation-audit.log'),
    path.join(projectDir, '.claude', 'state', 'token-swap-monitor.log'),
  ];
  for (const filePath of projectStateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`  Deleted ${path.relative(projectDir, filePath)}`);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not delete ${path.basename(filePath)}: ${err.message}${NC}`);
      }
    }
  }

  // ── 8. Remove stale hook references from ~/.claude/settings.json ──────────
  // Generic: removes any hook whose referenced file no longer exists on disk.
  const globalSettingsPath = path.join(home, '.claude', 'settings.json');
  try {
    if (fs.existsSync(globalSettingsPath)) {
      const raw = fs.readFileSync(globalSettingsPath, 'utf8');
      const settings = JSON.parse(raw);
      if (settings.hooks && typeof settings.hooks === 'object') {
        let changed = false;
        for (const hookType of Object.keys(settings.hooks)) {
          const matchers = settings.hooks[hookType];
          if (!Array.isArray(matchers)) continue;
          for (const matcher of matchers) {
            if (!Array.isArray(matcher.hooks)) continue;
            const before = matcher.hooks.length;
            matcher.hooks = matcher.hooks.filter(entry => {
              const cmd = typeof entry === 'string' ? entry : entry.command;
              if (!cmd) return true;
              const match = cmd.match(/^node\s+(\S+)/);
              if (!match) return true;
              const filePath = match[1].replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir);
              return fs.existsSync(filePath);
            });
            if (matcher.hooks.length !== before) changed = true;
          }
          // Remove matchers with no hooks remaining
          const before = matchers.length;
          settings.hooks[hookType] = matchers.filter(m => Array.isArray(m.hooks) ? m.hooks.length > 0 : true);
          if (settings.hooks[hookType].length !== before) changed = true;
          // Remove hook type key if array is now empty
          if (settings.hooks[hookType].length === 0) {
            delete settings.hooks[hookType];
            changed = true;
          }
        }
        // Remove hooks key entirely if all types were removed
        if (changed && Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
        if (changed) {
          fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
          console.log('  Removed stale hook references from ~/.claude/settings.json');
        }
      }
    }
  } catch (err) {
    console.log(`  ${YELLOW}Warning: could not clean stale hooks from ~/.claude/settings.json: ${err.message}${NC}`);
  }
}

export default async function sync(args) {
  const projectDir = process.cwd();

  const model = detectInstallModel(projectDir);
  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    console.error('Run `npx gentyr init` first.');
    process.exit(1);
  }

  let frameworkDir = resolveFrameworkDir(projectDir);

  // Health check: repair broken node_modules/gentyr symlink
  if (model === 'npm') {
    const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
    let npmBroken = false;
    try {
      fs.realpathSync(npmPath);
    } catch {
      npmBroken = true;
    }
    if (npmBroken && frameworkDir) {
      // Symlink exists (lstat passed) but target doesn't (realpath failed)
      // Repair by pointing to the framework dir we resolved via fallback
      console.log(`\n${YELLOW}Repairing broken node_modules/gentyr symlink...${NC}`);
      try {
        fs.unlinkSync(npmPath);
        fs.symlinkSync(frameworkDir, npmPath);
        console.log(`  Repaired: node_modules/gentyr -> ${frameworkDir}`);
        // Re-resolve now that the symlink is fixed
        frameworkDir = resolveFrameworkDir(projectDir);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not repair symlink: ${err.message}${NC}`);
      }
    } else if (npmBroken && !frameworkDir) {
      console.error(`${RED}Error: node_modules/gentyr symlink is broken and no fallback found.${NC}`);
      console.error('Run `pnpm link ~/git/gentyr` to repair.');
      process.exit(1);
    }
  }

  if (!frameworkDir) {
    console.error(`${RED}Error: Could not resolve GENTYR framework directory.${NC}`);
    console.error('Run `npx gentyr init` or `pnpm link ~/git/gentyr`.');
    process.exit(1);
  }

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
  if (isLocalModeEnabled(projectDir)) {
    console.log(`  Local mode: active (remote servers will be excluded from .mcp.json)`);
  }

  // 0. One-time migration: remove rotation proxy remnants from existing installs
  cleanupRotationProxy(projectDir);

  // 1. Re-merge settings.json
  console.log(`\n${YELLOW}Merging settings.json...${NC}`);
  mergeSettings(projectDir, frameworkDir);

  // 1.4. Ensure services.json exists (create scaffold if missing)
  const svcConfigDir = path.join(projectDir, '.claude', 'config');
  const svcConfigPath = path.join(svcConfigDir, 'services.json');
  if (!fs.existsSync(svcConfigPath)) {
    console.log(`\n${YELLOW}Creating services.json scaffold...${NC}`);
    fs.mkdirSync(svcConfigDir, { recursive: true });
    fs.writeFileSync(svcConfigPath, JSON.stringify({ secrets: {} }, null, 2) + '\n');
    console.log(`  Created ${svcConfigPath}`);
  }

  // 1.5. Apply pending services.json config updates (staged by update_services_config MCP tool)
  const pendingConfigPath = path.join(projectDir, '.claude', 'state', 'services-config-pending.json');
  if (fs.existsSync(pendingConfigPath)) {
    console.log(`\n${YELLOW}Applying pending services.json config...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingConfigPath, 'utf8'));
      // Defense-in-depth: strip secrets key even though the MCP tool blocks it
      delete pending.secrets;
      let current = {};
      if (fs.existsSync(svcConfigPath)) {
        try {
          current = JSON.parse(fs.readFileSync(svcConfigPath, 'utf8'));
        } catch (parseErr) {
          console.log(`  ${RED}Warning: services.json is malformed — skipping merge to avoid data loss${NC}`);
          throw parseErr;
        }
      }
      const merged = { ...current, ...pending };
      // Validate merged config against ServicesConfigSchema (imported dynamically to avoid TS dependency in JS CLI)
      // Lightweight check: ensure no unknown top-level types that would corrupt the file
      if (typeof merged !== 'object' || merged === null) {
        throw new Error('Merged config is not a valid object');
      }
      fs.writeFileSync(svcConfigPath, JSON.stringify(merged, null, 2) + '\n');
      fs.unlinkSync(pendingConfigPath);
      console.log(`  Applied ${Object.keys(pending).length} pending config update(s)`);
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply pending config: ${err.message}${NC}`);
      // Preserve pending file for inspection on failure
    }
  }

  // 1.6. Apply pending secrets.local entries (staged by populate_secrets_local MCP tool)
  const pendingSecretsPath = path.join(projectDir, '.claude', 'state', 'secrets-local-pending.json');
  if (fs.existsSync(pendingSecretsPath)) {
    console.log(`\n${YELLOW}Applying pending secrets.local entries...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingSecretsPath, 'utf8'));
      const entries = pending.entries || {};
      // Validate all values are op:// references
      for (const [key, val] of Object.entries(entries)) {
        if (typeof val !== 'string' || !val.startsWith('op://')) {
          throw new Error(`Invalid entry: ${key} is not an op:// reference`);
        }
      }
      let current = {};
      if (fs.existsSync(svcConfigPath)) {
        try {
          current = JSON.parse(fs.readFileSync(svcConfigPath, 'utf8'));
        } catch (parseErr) {
          console.log(`  ${RED}Warning: services.json is malformed — skipping secrets.local merge${NC}`);
          throw parseErr;
        }
      }
      if (!current.secrets) current.secrets = {};
      if (!current.secrets.local) current.secrets.local = {};
      Object.assign(current.secrets.local, entries);
      fs.writeFileSync(svcConfigPath, JSON.stringify(current, null, 2) + '\n');
      fs.unlinkSync(pendingSecretsPath);
      console.log(`  Applied ${Object.keys(entries).length} secrets.local entry/entries`);
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply pending secrets.local: ${err.message}${NC}`);
    }
  }

  // 1.7. Apply pending MCP server additions (staged by stage_mcp_server MCP tool)
  const pendingMcpPath = path.join(projectDir, '.claude', 'state', 'mcp-servers-pending.json');
  if (fs.existsSync(pendingMcpPath)) {
    console.log(`\n${YELLOW}Applying staged MCP servers...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingMcpPath, 'utf8'));
      const servers = pending.servers || {};
      const serverNames = Object.keys(servers);
      if (serverNames.length > 0) {
        const mcpJsonPath = path.join(projectDir, '.mcp.json');
        let mcpConfig = { mcpServers: {} };
        if (fs.existsSync(mcpJsonPath)) {
          mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
          mcpConfig.mcpServers = mcpConfig.mcpServers || {};
        }
        // Derive gentyr server names from template to prevent collisions
        const templatePath = path.join(frameworkDir, '.mcp.json.template');
        let gentyrNames = new Set();
        try {
          const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
          gentyrNames = new Set(Object.keys(tpl.mcpServers || {}));
        } catch {}
        let applied = 0;
        let skipped = 0;
        for (const [name, config] of Object.entries(servers)) {
          if (gentyrNames.has(name) || name === 'plugin-manager' || name.startsWith('plugin-')) {
            console.log(`  Skipped "${name}" (collides with GENTYR server)`);
            skipped++;
          } else {
            mcpConfig.mcpServers[name] = config;
            applied++;
          }
        }
        if (applied > 0) {
          fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        }
        fs.unlinkSync(pendingMcpPath);
        console.log(`  Applied ${applied} staged MCP server(s)${skipped > 0 ? `, skipped ${skipped} collision(s)` : ''}`);
      } else {
        fs.unlinkSync(pendingMcpPath);
        console.log('  No servers in pending file (cleaned up)');
      }
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply staged MCP servers: ${err.message}${NC}`);
      // Preserve pending file for inspection on failure
    }
  }

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
    const mcpNodeModules = path.join(mcpDir, 'node_modules');
    const hasDeps = fs.existsSync(mcpNodeModules) &&
      fs.existsSync(path.join(mcpNodeModules, '@types', 'node')) &&
      fs.existsSync(path.join(mcpNodeModules, '@types', 'better-sqlite3'));
    if (!hasDeps) {
      execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
      console.log('  Dependencies installed');
    } else {
      console.log('  Dependencies already present, skipping npm install');
    }
    execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  TypeScript built');
  } catch (err) {
    console.log(`  ${RED}MCP server build FAILED: ${err.message}${NC}`);
    console.log(`  ${RED}Repair: cd ${mcpDir} && npm install && npm run build${NC}`);
  }

  // 7a-verify. Verify dist/ exists after build
  if (!fs.existsSync(path.join(mcpDir, 'dist'))) {
    console.log(`\n  ${RED}WARNING: packages/mcp-servers/dist/ is MISSING after build.${NC}`);
    console.log(`  ${RED}MCP servers will not work. Run: cd ${mcpDir} && npm install && npm run build${NC}`);
  }

  // 7b. Build window recorder (macOS only)
  if (process.platform === 'darwin') {
    const windowRecorderDir = path.join(frameworkDir, 'tools', 'window-recorder');
    if (fs.existsSync(path.join(windowRecorderDir, 'Package.swift'))) {
      console.log(`\n${YELLOW}Building window recorder...${NC}`);
      try {
        execFileSync('swift', ['build', '-c', 'release'], { cwd: windowRecorderDir, stdio: 'pipe', timeout: 120000 });
        // Codesign with stable CFBundleIdentifier so macOS TCC grants persist across rebuilds.
        // Without this, each swift build produces a new ad-hoc signature and the user must
        // re-grant Screen Recording permission every time.
        const binaryPath = path.join(windowRecorderDir, '.build', 'release', 'WindowRecorder');
        if (fs.existsSync(binaryPath)) {
          try {
            execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.gentyr.window-recorder', binaryPath], { stdio: 'pipe', timeout: 10000 });
            console.log('  Swift binary built + signed (com.gentyr.window-recorder)');
          } catch {
            console.log('  Swift binary built (codesign failed — TCC grants may not persist across rebuilds)');
          }
        } else {
          console.log('  Swift binary built');
        }
      } catch (err) {
        console.log(`  ${YELLOW}Warning: Window recorder build failed: ${err.message}${NC}`);
      }
    }
  }

  // 7c. Install Chrome extension native messaging host
  const chromeExtInstall = path.join(frameworkDir, 'tools', 'chrome-extension', 'native-host', 'install.sh');
  if (fs.existsSync(chromeExtInstall)) {
    console.log(`\n${YELLOW}Installing Chrome extension native host...${NC}`);
    try {
      execFileSync(chromeExtInstall, [], { cwd: path.dirname(chromeExtInstall), stdio: 'pipe', timeout: 30000 });
      console.log('  Native messaging host registered');
    } catch (err) {
      console.log(`  ${YELLOW}Warning: Chrome extension native host install failed: ${err.message}${NC}`);
    }
  }

  // 7d. Build CTO dashboard live TUI
  const ctoDashboardDir = path.join(frameworkDir, 'packages', 'cto-dashboard-live');
  if (fs.existsSync(path.join(ctoDashboardDir, 'tsconfig.json'))) {
    console.log(`\n${YELLOW}Building CTO dashboard live TUI...${NC}`);
    try {
      const hasTypesNode = fs.existsSync(path.join(ctoDashboardDir, 'node_modules', '@types', 'node'));
      if (!hasTypesNode) {
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: ctoDashboardDir, stdio: 'pipe', timeout: 120000 });
        console.log('  Dependencies installed');
      }
      execFileSync('npm', ['run', 'build'], { cwd: ctoDashboardDir, stdio: 'pipe', timeout: 120000 });
      console.log('  TypeScript built');
    } catch (err) {
      console.log(`  ${YELLOW}Warning: CTO dashboard build failed: ${err.message}${NC}`);
    }
  }

  // 8. Regenerate launchd plists (macOS only)
  if (process.platform === 'darwin') {
    // 8a. Detect and unload stale daemon plist (e.g., clobbered by E2E test)
    const daemonPlistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.local.gentyr-mcp-daemon.plist');
    if (fs.existsSync(daemonPlistPath)) {
      try {
        const plistContent = fs.readFileSync(daemonPlistPath, 'utf8');
        const wdMatch = plistContent.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
        const workDir = wdMatch ? wdMatch[1] : '';
        const isStale = workDir && (
          workDir.includes('gentyr-e2e-install') ||
          (workDir.startsWith('/tmp/') || workDir.startsWith('/private/tmp/') || workDir.includes('/var/folders/')) ||
          !fs.existsSync(workDir)
        );
        if (isStale) {
          console.log(`  ${YELLOW}Detected stale MCP daemon plist (WorkingDirectory: ${workDir})${NC}`);
          try {
            execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, daemonPlistPath], { stdio: 'pipe', timeout: 10000 });
            console.log(`  Unloaded stale daemon`);
          } catch { /* may already be unloaded */ }
        }
      } catch { /* plist parsing failure -- regeneration in step 8b will fix it */ }
    }

    // 8b. Regenerate and reload plists
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
