/**
 * Key Sync - Shared module for multi-source credential detection and rotation state management
 *
 * Discovers Claude API keys from multiple sources (env var, macOS Keychain,
 * credentials file) and maintains a user-level rotation state registry at
 * ~/.claude/api-key-rotation.json shared across all projects.
 *
 * Used by:
 * - api-key-watcher.js (SessionStart hook) - key sync + health checks + rotation
 * - hourly-automation.js (10-min timer / WatchPaths) - key sync only
 * - credential-sync-hook.js (PreToolUse, throttled) - key sync only
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

// Paths
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
const ROTATION_LOG_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.log');
const OLD_PROJECT_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');

// Constants
const MAX_LOG_ENTRIES = 100;
const OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = 'claude-code';

/**
 * Generate a stable key ID from an access token.
 * Uses SHA256 hash (first 16 chars) for privacy.
 * @param {string} accessToken
 * @returns {string}
 */
export function generateKeyId(accessToken) {
  const cleanToken = accessToken
    .replace(/^sk-ant-oat01-/, '')
    .replace(/^sk-ant-/, '');

  const hash = crypto.createHash('sha256').update(cleanToken).digest('hex');
  return hash.substring(0, 16);
}

/**
 * Read credentials from all available sources.
 * Returns an array of credential objects, one per source that has data.
 *
 * Priority order (all returned, not short-circuited):
 * 1. Environment variable CLAUDE_CODE_OAUTH_TOKEN
 * 2. macOS Keychain
 * 3. ~/.claude/.credentials.json
 *
 * @returns {Array<{accessToken: string, refreshToken?: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string, source: string}>}
 */
export function readCredentialSources() {
  const sources = [];
  const now = Date.now();

  // Source 1: Environment variable override
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) {
    sources.push({
      accessToken: envToken,
      source: 'env',
    });
  }

  // Source 2: macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const { username } = os.userInfo();
      const raw = execFileSync('security', [
        'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
      ], { encoding: 'utf8', timeout: 3000 }).trim();
      const creds = JSON.parse(raw);
      if (creds?.claudeAiOauth?.accessToken) {
        const oauth = creds.claudeAiOauth;
        if (!oauth.expiresAt || oauth.expiresAt > now) {
          sources.push({
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
            subscriptionType: oauth.subscriptionType,
            rateLimitTier: oauth.rateLimitTier,
            source: 'keychain',
          });
        }
      }
    } catch {
      // Keychain not available (locked, no entry, or non-macOS)
    }
  }

  // Source 3: Credentials file
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds?.claudeAiOauth?.accessToken) {
        const oauth = creds.claudeAiOauth;
        sources.push({
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          subscriptionType: oauth.subscriptionType,
          rateLimitTier: oauth.rateLimitTier,
          source: 'file',
        });
      }
    } catch {
      // File unreadable
    }
  }

  return sources;
}

/**
 * Read the rotation state file (user-level).
 * On first run, migrates from project-level if available.
 * @returns {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}}
 */
export function readRotationState() {
  const defaultState = {
    version: 1,
    active_key_id: null,
    keys: {},
    rotation_log: []
  };

  // Try user-level state first
  if (fs.existsSync(ROTATION_STATE_PATH)) {
    try {
      const content = fs.readFileSync(ROTATION_STATE_PATH, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.version === 1 && typeof parsed.keys === 'object') {
        // Migrate: merge any project-level keys not in user-level
        if (fs.existsSync(OLD_PROJECT_STATE_PATH)) {
          try {
            const oldState = JSON.parse(fs.readFileSync(OLD_PROJECT_STATE_PATH, 'utf8'));
            if (oldState?.keys) {
              let merged = false;
              for (const [id, keyData] of Object.entries(oldState.keys)) {
                if (!parsed.keys[id]) {
                  parsed.keys[id] = keyData;
                  merged = true;
                } else {
                  const existing = parsed.keys[id];
                  if (keyData.last_health_check && (!existing.last_health_check || keyData.last_health_check > existing.last_health_check)) {
                    parsed.keys[id] = { ...existing, ...keyData };
                    merged = true;
                  }
                }
              }
              if (merged) {
                writeRotationState(parsed);
              }
            }
          } catch {
            // Ignore old state errors
          }
        }
        return parsed;
      }
    } catch {
      // Fall through to default
    }
  }

  // Migration: copy project-level state to user-level
  if (fs.existsSync(OLD_PROJECT_STATE_PATH)) {
    try {
      const content = fs.readFileSync(OLD_PROJECT_STATE_PATH, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.version === 1 && typeof parsed.keys === 'object') {
        writeRotationState(parsed);
        return parsed;
      }
    } catch {
      // Ignore migration errors
    }
  }

  return defaultState;
}

/**
 * Write the rotation state file (user-level).
 * @param {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}} state
 */
export function writeRotationState(state) {
  try {
    const dir = path.dirname(ROTATION_STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ROTATION_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`[key-sync] Failed to write rotation state: ${err.message}`);
  }
}

/**
 * Log a rotation event to both state and human-readable log file.
 * @param {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}} state
 * @param {{timestamp: number, event: string, key_id: string, reason?: string, usage_snapshot?: Object}} entry
 */
export function logRotationEvent(state, entry) {
  state.rotation_log.unshift(entry);
  if (state.rotation_log.length > MAX_LOG_ENTRIES) {
    state.rotation_log = state.rotation_log.slice(0, MAX_LOG_ENTRIES);
  }

  try {
    const timestamp = new Date(entry.timestamp).toISOString();
    let line = `[${timestamp}] ${entry.event}: key=${entry.key_id.slice(0, 8)}...`;

    if (entry.reason) {
      line += ` reason=${entry.reason}`;
    }

    if (entry.usage_snapshot) {
      const u = entry.usage_snapshot;
      line += ` usage=(5h:${Math.round(u.five_hour)}%, 7d:${Math.round(u.seven_day)}%, sonnet:${Math.round(u.seven_day_sonnet)}%)`;
    }

    fs.appendFileSync(ROTATION_LOG_PATH, line + '\n', 'utf8');
  } catch {
    // Ignore log file errors
  }
}

/**
 * Update the active credentials in the appropriate store.
 * Writes to both file and keychain (if on macOS) for consistency.
 * @param {object} keyData - Key data with accessToken, refreshToken, etc.
 */
export function updateActiveCredentials(keyData) {
  // Update credentials file
  try {
    let creds = {};
    if (fs.existsSync(CREDENTIALS_PATH)) {
      creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    }

    creds.claudeAiOauth = {
      ...creds.claudeAiOauth,
      accessToken: keyData.accessToken,
      refreshToken: keyData.refreshToken,
      expiresAt: keyData.expiresAt,
      subscriptionType: keyData.subscriptionType,
      rateLimitTier: keyData.rateLimitTier,
    };

    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf8');
  } catch (err) {
    console.error(`[key-sync] Failed to write credentials file: ${err.message}`);
  }

  // Update macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const { username } = os.userInfo();
      let keychainCreds = {};

      // Read existing keychain data to preserve other fields
      try {
        const raw = execFileSync('security', [
          'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
        ], { encoding: 'utf8', timeout: 3000 }).trim();
        keychainCreds = JSON.parse(raw);
      } catch {
        // No existing keychain entry
      }

      keychainCreds.claudeAiOauth = {
        ...keychainCreds.claudeAiOauth,
        accessToken: keyData.accessToken,
        refreshToken: keyData.refreshToken,
        expiresAt: keyData.expiresAt,
        subscriptionType: keyData.subscriptionType,
        rateLimitTier: keyData.rateLimitTier,
      };

      execFileSync('security', [
        'add-generic-password', '-U',
        '-s', 'Claude Code-credentials',
        '-a', username,
        '-w', JSON.stringify(keychainCreds),
      ], { encoding: 'utf8', timeout: 3000 });
    } catch {
      // Keychain update failed - non-fatal, file was already updated
    }
  }
}

/**
 * Attempt to refresh an expired OAuth token.
 * @param {object} keyData - Key data with refreshToken
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number}|null>}
 */
export async function refreshExpiredToken(keyData) {
  if (!keyData.refreshToken || keyData.status === 'invalid') return null;

  try {
    const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: keyData.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();

    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || keyData.refreshToken,
      expiresAt: data.expires_at || (Date.now() + 3600 * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Sync keys from all credential sources into the rotation state.
 * Discovers new keys and updates existing tokens.
 *
 * @param {function} [log] - Optional log function
 * @returns {Promise<{keysAdded: number, keysUpdated: number, tokensRefreshed: number}>}
 */
export async function syncKeys(log) {
  const logFn = log || (() => {});
  const result = { keysAdded: 0, keysUpdated: 0, tokensRefreshed: 0 };

  const sources = readCredentialSources();
  if (sources.length === 0) {
    return result;
  }

  const state = readRotationState();
  const now = Date.now();

  // Process each credential source
  for (const cred of sources) {
    const keyId = generateKeyId(cred.accessToken);
    const isNewKey = !state.keys[keyId];

    if (isNewKey) {
      state.keys[keyId] = {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken || null,
        expiresAt: cred.expiresAt || null,
        subscriptionType: cred.subscriptionType || 'unknown',
        rateLimitTier: cred.rateLimitTier || 'unknown',
        added_at: now,
        last_used_at: null,
        last_health_check: null,
        last_usage: null,
        status: 'active',
      };

      logRotationEvent(state, {
        timestamp: now,
        event: 'key_added',
        key_id: keyId,
        reason: `new_key_from_${cred.source}_${cred.subscriptionType || 'unknown'}`,
      });

      result.keysAdded++;
      logFn(`[key-sync] New key discovered from ${cred.source}: ${keyId.slice(0, 8)}...`);
    } else {
      // Update existing key data (tokens may have been refreshed)
      const existingKey = state.keys[keyId];
      existingKey.accessToken = cred.accessToken;
      if (cred.refreshToken) existingKey.refreshToken = cred.refreshToken;
      if (cred.expiresAt) existingKey.expiresAt = cred.expiresAt;
      if (cred.subscriptionType) existingKey.subscriptionType = cred.subscriptionType;
      if (cred.rateLimitTier) existingKey.rateLimitTier = cred.rateLimitTier;

      // If the key was marked expired but we got fresh data, reactivate
      if (existingKey.status === 'expired' && cred.expiresAt && cred.expiresAt > now) {
        existingKey.status = 'active';
        logFn(`[key-sync] Reactivated key from ${cred.source}: ${keyId.slice(0, 8)}...`);
      }

      result.keysUpdated++;
    }
  }

  // Attempt token refresh for expired keys
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status !== 'expired' && keyData.expiresAt && keyData.expiresAt < now) {
      const refreshed = await refreshExpiredToken(keyData);
      if (refreshed) {
        keyData.accessToken = refreshed.accessToken;
        keyData.refreshToken = refreshed.refreshToken;
        keyData.expiresAt = refreshed.expiresAt;
        keyData.status = 'active';
        result.tokensRefreshed++;
        logFn(`[key-sync] Refreshed expired token for key ${keyId.slice(0, 8)}...`);

        logRotationEvent(state, {
          timestamp: now,
          event: 'key_added',
          key_id: keyId,
          reason: 'token_refreshed',
        });
      } else {
        keyData.status = 'expired';
        logRotationEvent(state, {
          timestamp: now,
          event: 'key_removed',
          key_id: keyId,
          reason: 'token_expired_refresh_failed',
        });
      }
    }
  }

  // Set initial active key if none set
  if (!state.active_key_id) {
    const firstActive = Object.entries(state.keys).find(([_, k]) => k.status === 'active');
    if (firstActive) {
      state.active_key_id = firstActive[0];
      state.keys[firstActive[0]].last_used_at = now;
    }
  }

  writeRotationState(state);
  return result;
}

// Export paths for consumers
export { ROTATION_STATE_PATH, ROTATION_LOG_PATH, CREDENTIALS_PATH, OLD_PROJECT_STATE_PATH };
