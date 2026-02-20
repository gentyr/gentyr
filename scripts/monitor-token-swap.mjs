#!/usr/bin/env node
/**
 * Token Swap Monitor — watches for restartless credential rotation.
 *
 * Monitors:
 * 1. Keychain token identity (should be 8decb61e / jonathan3)
 * 2. Credentials file token identity
 * 3. ~/git/target-project claude session process liveness
 * 4. Rotation log for new events
 * 5. API health of both tokens
 *
 * Run: node scripts/monitor-token-swap.mjs
 * Stop: Ctrl+C
 */
import { execFileSync } from 'child_process';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Config
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const KEYCHAIN_TOKEN_ID = 'f586be32';   // jonathan3 (refreshed; should be in Keychain)
const MEMORY_TOKEN_ID = 'ed512f26';     // jonathan2 (in xy session's memory)
const MEMORY_TOKEN_EXPIRES = new Date('2026-02-20T20:17:08.095Z');
const JV_TRIGGER_TIME = new Date(MEMORY_TOKEN_EXPIRES.getTime() - 300_000); // 5 min before
const LOG_FILE = path.join(os.homedir(), 'git/gentyr/.claude/state/token-swap-monitor.log');
const ROTATION_LOG = path.join(os.homedir(), 'git/gentyr/.claude/api-key-rotation.log');
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');

let lastRotationLogSize = 0;
let lastRotationLogLines = 0;

function generateKeyId(accessToken) {
  const clean = accessToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
  return crypto.createHash('sha256').update(clean).digest('hex').substring(0, 16);
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function getKeychainToken() {
  try {
    const { username } = os.userInfo();
    const raw = execFileSync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        keyId: generateKeyId(oauth.accessToken),
        expiresAt: oauth.expiresAt,
        token: oauth.accessToken.slice(0, 20),
      };
    }
  } catch {}
  return null;
}

function getFileToken() {
  try {
    if (!fs.existsSync(CREDS_PATH)) return null;
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        keyId: generateKeyId(oauth.accessToken),
        expiresAt: oauth.expiresAt,
      };
    }
  } catch {}
  return null;
}

function getXySessionProcesses() {
  try {
    const output = execSync(
      "ps aux | grep 'claude' | grep -v grep | grep 'target-project' | awk '{print $2}'",
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    return output ? output.split('\n').length : 0;
  } catch {
    return 0;
  }
}

function getNewRotationLogEntries() {
  try {
    if (!fs.existsSync(ROTATION_LOG)) return [];
    const content = fs.readFileSync(ROTATION_LOG, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length > lastRotationLogLines) {
      const newLines = lines.slice(lastRotationLogLines);
      lastRotationLogLines = lines.length;
      return newLines;
    }
    lastRotationLogLines = lines.length;
  } catch {}
  return [];
}

function getRotationStateEvents() {
  try {
    if (!fs.existsSync(ROTATION_STATE_PATH)) return [];
    const state = JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf8'));
    return {
      activeKey: state.active_key_id?.slice(0, 8),
      totalKeys: Object.keys(state.keys).length,
      activeKeys: Object.values(state.keys).filter(k => k.status === 'active').length,
      lastEvent: state.rotation_log?.[0],
    };
  } catch {}
  return null;
}

async function checkTokenHealth(token) {
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'claude-code/2.1.34',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    return response.status;
  } catch {
    return 'error';
  }
}

async function poll() {
  const now = new Date();
  const timeToExpiry = Math.round((MEMORY_TOKEN_EXPIRES - now) / 60000);
  const timeToJv = Math.round((JV_TRIGGER_TIME - now) / 60000);

  // Check Keychain
  const kc = getKeychainToken();
  const kcId = kc?.keyId?.slice(0, 8) || 'NONE';
  const kcChanged = kcId !== KEYCHAIN_TOKEN_ID;

  // Check credentials file
  const fc = getFileToken();
  const fcId = fc?.keyId?.slice(0, 8) || 'NONE';

  // Check xy session
  const xyProcesses = getXySessionProcesses();

  // Check rotation state
  const rotState = getRotationStateEvents();

  // Check for new rotation log entries
  const newEntries = getNewRotationLogEntries();

  // Status line
  let status = `Keychain=${kcId} File=${fcId} XY_procs=${xyProcesses} Expiry=${timeToExpiry}min jv()=${timeToJv}min`;

  if (kcChanged) {
    status += ' *** KEYCHAIN TOKEN CHANGED! ***';
  }

  if (timeToExpiry <= 5 && timeToExpiry > 0) {
    status += ' ⚡ jv() WINDOW ACTIVE — SRA() should fire on next API call';
  } else if (timeToExpiry <= 0) {
    status += ' 💀 TOKEN EXPIRED — 401 will trigger r6T() on next API call';
  }

  log(status);

  // Log new rotation events
  for (const entry of newEntries) {
    log(`  🔄 ROTATION EVENT: ${entry}`);
  }

  // Health check every 5 minutes when close to expiry
  if (timeToExpiry <= 10 && timeToExpiry >= -5) {
    log('  Running token health checks...');

    // Read actual tokens for health check
    try {
      const state = JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf8'));

      // Find memory token
      const memKey = Object.entries(state.keys).find(([id]) => id.startsWith(MEMORY_TOKEN_ID));
      if (memKey) {
        const [, keyData] = memKey;
        if (keyData.accessToken && keyData.accessToken !== 'undefined') {
          const memHealth = await checkTokenHealth(keyData.accessToken);
          log(`  Memory token (${MEMORY_TOKEN_ID}): HTTP ${memHealth}`);
        }
      }

      // Find keychain token
      const kcKey = Object.entries(state.keys).find(([id]) => id.startsWith(KEYCHAIN_TOKEN_ID));
      if (kcKey) {
        const [, keyData] = kcKey;
        if (keyData.accessToken && keyData.accessToken !== 'undefined') {
          const kcHealth = await checkTokenHealth(keyData.accessToken);
          log(`  Keychain token (${KEYCHAIN_TOKEN_ID}): HTTP ${kcHealth}`);
        }
      }
    } catch {}
  }

  // Alert if xy session died
  if (xyProcesses === 0) {
    log('  ⚠️  NO XY SESSION PROCESSES FOUND — session may have died');
  }
}

// Initial setup
log('=== Token Swap Monitor Started ===');
log(`Memory token:   ${MEMORY_TOKEN_ID} (jonathan2) — expires ${MEMORY_TOKEN_EXPIRES.toISOString()}`);
log(`Keychain token: ${KEYCHAIN_TOKEN_ID} (jonathan3) — should be adopted when memory token expires`);
log(`jv() trigger:   ${JV_TRIGGER_TIME.toISOString()} (5 min before expiry)`);
log(`Poll interval:  ${POLL_INTERVAL_MS / 1000}s`);
log(`Log file:       ${LOG_FILE}`);
log('');

// Initialize rotation log line count
try {
  if (fs.existsSync(ROTATION_LOG)) {
    lastRotationLogLines = fs.readFileSync(ROTATION_LOG, 'utf8').trim().split('\n').length;
  }
} catch {}

// Run immediately, then poll
await poll();
setInterval(poll, POLL_INTERVAL_MS);
