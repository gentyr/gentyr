/**
 * gentyr proxy - Enable/disable the rotation proxy
 *
 * Usage:
 *   npx gentyr proxy disable   # Stop proxy, remove shell env, persist flag
 *   npx gentyr proxy enable    # Restart proxy, restore shell env
 *   npx gentyr proxy status    # Show current state (default)
 *   npx gentyr proxy           # Same as status
 *
 * @module commands/proxy
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

const HOME = process.env.HOME || '';
const STATE_PATH = path.join(HOME, '.claude', 'proxy-disabled.json');
const PROXY_PORT = parseInt(process.env.GENTYR_PROXY_PORT || '18080', 10);
const PLIST_LABEL = 'com.local.gentyr-rotation-proxy';
const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const SYSTEMD_SERVICE = 'gentyr-rotation-proxy.service';

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { disabled: false };
  }
}

function writeState(disabled) {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    disabled,
    timestamp: new Date().toISOString(),
  }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function isMacOS() {
  return process.platform === 'darwin';
}

// ---------------------------------------------------------------------------
// Service management
// ---------------------------------------------------------------------------

function stopProxyService() {
  if (isMacOS()) {
    if (fs.existsSync(PLIST_PATH)) {
      try {
        execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe', timeout: 10000 });
        console.log(`  Unloaded launchd service ${DIM}(${PLIST_LABEL})${NC}`);
      } catch {
        console.log(`  ${DIM}Service was not loaded${NC}`);
      }
    } else {
      console.log(`  ${DIM}No proxy plist found${NC}`);
    }
  } else {
    try {
      execFileSync('systemctl', ['--user', 'stop', SYSTEMD_SERVICE], { stdio: 'pipe', timeout: 10000 });
      execFileSync('systemctl', ['--user', 'disable', SYSTEMD_SERVICE], { stdio: 'pipe', timeout: 10000 });
      console.log(`  Stopped systemd service ${DIM}(${SYSTEMD_SERVICE})${NC}`);
    } catch {
      console.log(`  ${DIM}Service was not running${NC}`);
    }
  }
}

function startProxyService() {
  if (isMacOS()) {
    if (fs.existsSync(PLIST_PATH)) {
      try {
        execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'pipe', timeout: 10000 });
        console.log(`  Loaded launchd service ${DIM}(${PLIST_LABEL})${NC}`);
      } catch {
        console.log(`  ${YELLOW}Warning: Failed to load plist. Run 'npx gentyr sync' to regenerate.${NC}`);
      }
    } else {
      console.log(`  ${YELLOW}No proxy plist found. Run 'npx gentyr sync' to regenerate.${NC}`);
    }
  } else {
    try {
      execFileSync('systemctl', ['--user', 'enable', SYSTEMD_SERVICE], { stdio: 'pipe', timeout: 10000 });
      execFileSync('systemctl', ['--user', 'start', SYSTEMD_SERVICE], { stdio: 'pipe', timeout: 10000 });
      console.log(`  Started systemd service ${DIM}(${SYSTEMD_SERVICE})${NC}`);
    } catch {
      console.log(`  ${YELLOW}Warning: Failed to start service. Run 'npx gentyr sync' to regenerate.${NC}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shell profile management
// ---------------------------------------------------------------------------

function getShellProfile() {
  const profiles = [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')];
  return profiles.find(p => fs.existsSync(p));
}

function removeShellIntegration() {
  const profile = getShellProfile();
  if (!profile) {
    console.log(`  ${DIM}No shell profile found${NC}`);
    return;
  }

  let content = fs.readFileSync(profile, 'utf8');
  if (!content.includes('# BEGIN GENTYR PROXY')) {
    console.log(`  ${DIM}No proxy block in ${profile}${NC}`);
    return;
  }

  content = content.replace(/\n?# BEGIN GENTYR PROXY[\s\S]*?# END GENTYR PROXY\n?/g, '');
  fs.writeFileSync(profile, content);
  console.log(`  Removed proxy env from ${profile}`);
}

function restoreShellIntegration() {
  const profile = getShellProfile();
  if (!profile) {
    console.log(`  ${YELLOW}No shell profile found, skipping${NC}`);
    return;
  }

  const content = fs.readFileSync(profile, 'utf8');
  if (content.includes('# BEGIN GENTYR PROXY')) {
    console.log(`  ${DIM}Proxy env already in ${profile}${NC}`);
    return;
  }

  const block = `
# BEGIN GENTYR PROXY
# Rotation proxy for transparent credential rotation (added by GENTYR)
if curl -sf http://localhost:${PROXY_PORT}/__health > /dev/null 2>&1; then
  export HTTPS_PROXY=http://localhost:${PROXY_PORT}
  export HTTP_PROXY=http://localhost:${PROXY_PORT}
  export NO_PROXY=localhost,127.0.0.1
  export NODE_EXTRA_CA_CERTS="$HOME/.claude/proxy-certs/ca.pem"
fi
# END GENTYR PROXY
`;

  fs.appendFileSync(profile, block);
  console.log(`  Restored proxy env in ${profile}`);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

function checkProxyHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PROXY_PORT}/__health`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function doDisable() {
  const state = readState();
  if (state.disabled) {
    console.log(`${YELLOW}Proxy is already disabled.${NC}`);
    return;
  }

  console.log(`${YELLOW}Disabling rotation proxy...${NC}`);
  console.log('');

  // 1. Stop service
  stopProxyService();

  // 2. Remove shell integration
  removeShellIntegration();

  // 3. Persist state
  writeState(true);
  console.log('  Wrote disabled flag to ~/.claude/proxy-disabled.json');

  console.log('');
  console.log(`${GREEN}Rotation proxy disabled.${NC}`);
  console.log(`New shells and spawned agents will connect directly to api.anthropic.com.`);
  console.log(`${DIM}Note: Already-running shells still have HTTPS_PROXY set. Open a new shell or unset it:${NC}`);
  console.log(`${DIM}  unset HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS${NC}`);
  console.log('');
  console.log(`Run ${CYAN}npx gentyr proxy enable${NC} to restore.`);
}

async function doEnable() {
  const state = readState();
  if (!state.disabled) {
    console.log(`${YELLOW}Proxy is already enabled.${NC}`);
    return;
  }

  console.log(`${YELLOW}Enabling rotation proxy...${NC}`);
  console.log('');

  // 1. Clear disabled flag
  writeState(false);
  console.log('  Cleared disabled flag');

  // 2. Restore shell integration
  restoreShellIntegration();

  // 3. Start service
  startProxyService();

  // 4. Quick health check
  await new Promise(r => setTimeout(r, 1500));
  const health = await checkProxyHealth();
  if (health) {
    console.log(`  ${GREEN}Proxy responding${NC} (uptime: ${health.uptime}s, active key: ${health.activeKeyId || 'none'})`);
  } else {
    console.log(`  ${YELLOW}Proxy not yet responding — it may take a moment to start${NC}`);
  }

  console.log('');
  console.log(`${GREEN}Rotation proxy enabled.${NC}`);
  console.log(`${DIM}Note: Open a new shell to pick up HTTPS_PROXY, or run:${NC}`);
  console.log(`${DIM}  export HTTPS_PROXY=http://localhost:${PROXY_PORT} HTTP_PROXY=http://localhost:${PROXY_PORT} NO_PROXY=localhost,127.0.0.1${NC}`);
}

async function doStatus() {
  const state = readState();
  const health = await checkProxyHealth();

  console.log(`${CYAN}Rotation Proxy Status${NC}`);
  console.log('');

  // Flag state
  if (state.disabled) {
    console.log(`  State:    ${RED}DISABLED${NC}${state.timestamp ? ` (since ${state.timestamp})` : ''}`);
  } else {
    console.log(`  State:    ${GREEN}ENABLED${NC}`);
  }

  // Process health
  if (health) {
    console.log(`  Process:  ${GREEN}running${NC} (uptime: ${health.uptime}s, requests: ${health.requestCount})`);
    console.log(`  Key:      ${health.activeKeyId || 'none'}`);
  } else {
    console.log(`  Process:  ${RED}not running${NC}`);
  }

  // Service status
  if (isMacOS()) {
    const plistExists = fs.existsSync(PLIST_PATH);
    let loaded = false;
    if (plistExists) {
      try {
        const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
        loaded = out.includes(PLIST_LABEL);
      } catch {}
    }
    console.log(`  Service:  ${plistExists ? (loaded ? `${GREEN}loaded${NC}` : `${YELLOW}unloaded${NC}`) : `${DIM}no plist${NC}`}`);
  } else {
    try {
      const out = execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_SERVICE], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5000,
      }).trim();
      console.log(`  Service:  ${out === 'active' ? `${GREEN}active${NC}` : `${YELLOW}${out}${NC}`}`);
    } catch {
      console.log(`  Service:  ${DIM}not found${NC}`);
    }
  }

  // Shell integration
  const profile = getShellProfile();
  if (profile) {
    const content = fs.readFileSync(profile, 'utf8');
    const hasBlock = content.includes('# BEGIN GENTYR PROXY');
    console.log(`  Shell:    ${hasBlock ? `${GREEN}configured${NC}` : `${DIM}not configured${NC}`} (${profile})`);
  } else {
    console.log(`  Shell:    ${DIM}no profile found${NC}`);
  }

  // Current env
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (envProxy) {
    console.log(`  Env:      HTTPS_PROXY=${envProxy}`);
  } else {
    console.log(`  Env:      ${DIM}HTTPS_PROXY not set in this shell${NC}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default async function proxy(args) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'disable':
      await doDisable();
      break;
    case 'enable':
      await doEnable();
      break;
    case 'status':
    default:
      await doStatus();
      break;
  }
}
