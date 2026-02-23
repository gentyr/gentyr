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

// Rotation thresholds (API returns utilization as 0-100 percentages)
export const HIGH_USAGE_THRESHOLD = 90;  // 90%
export const EXHAUSTED_THRESHOLD = 100;  // 100%
export const EXPIRY_BUFFER_MS = 600_000; // 10 min — pre-expiry window for proactive refresh and restartless swap
export const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000; // 15 min — usage data older than this is treated as unknown
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
const ROTATION_LOG_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.log');
const OLD_PROJECT_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');

// Constants
const MAX_LOG_ENTRIES = 100;
const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';

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
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number}|'invalid_grant'|null>}
 */
export async function refreshExpiredToken(keyData) {
  if (!keyData.refreshToken || keyData.status === 'invalid') return null;

  try {
    const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: keyData.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
    });

    if (!response.ok) {
      if (response.status === 400) {
        try {
          const errBody = await response.json();
          if (errBody.error === 'invalid_grant') return 'invalid_grant';
        } catch { /* treat as transient */ }
      }
      return null;
    }
    const data = await response.json();

    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || keyData.refreshToken,
      expiresAt: data.expires_in ? (Date.now() + data.expires_in * 1000) : (Date.now() + 3600 * 1000),
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
        account_uuid: null,
        account_email: null,
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

  // Attempt token refresh for expired keys AND non-active keys approaching expiry.
  // Proactive refresh keeps standby tokens fresh so SRA()/r6T() always has a valid replacement.
  // Safe: refreshing one account's token does NOT revoke another account's in-memory token.
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    const isExpired = keyData.expiresAt && keyData.expiresAt < now;
    const isApproachingExpiry = keyData.expiresAt && keyData.expiresAt > now && keyData.expiresAt < now + EXPIRY_BUFFER_MS && keyId !== state.active_key_id;
    if ((isExpired || isApproachingExpiry) && keyData.status !== 'invalid') {
      const refreshed = await refreshExpiredToken(keyData);
      if (refreshed === 'invalid_grant') {
        keyData.status = 'invalid';
        logRotationEvent(state, {
          timestamp: now,
          event: 'key_removed',
          key_id: keyId,
          reason: 'refresh_token_invalid_grant',
        });
        logFn(`[key-sync] Refresh token revoked for key ${keyId.slice(0, 8)}... — marked invalid`);
      } else if (refreshed) {
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

  // Resolve account profiles for keys missing account_uuid.
  // This ensures keys added by hourly automation, token refresh, or credential sync
  // get their profile resolved without waiting for an interactive SessionStart.
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.account_uuid) continue;
    if (keyData.status !== 'active' && keyData.status !== 'exhausted') continue;
    try {
      const profile = await fetchAccountProfile(keyData.accessToken);
      if (profile) {
        keyData.account_uuid = profile.account_uuid;
        keyData.account_email = profile.email;
        logFn(`[key-sync] Resolved profile for key ${keyId.slice(0, 8)}...: ${profile.email}`);
      }
    } catch {
      // Non-fatal — profile will be retried on next sync
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

  // Deduplicate keys sharing the same account before swap logic runs.
  // Must run before pre-expiry swap to prevent swapping to a key that gets merged away.
  const dedup = deduplicateKeys(state);
  if (dedup.merged > 0) {
    logFn(`[key-sync] Deduplicated ${dedup.merged} key(s) by account_uuid`);
  }

  // Pre-expiry restartless swap: if the active key is near expiry, write a valid standby
  // to Keychain so Claude Code's SRA()/r6T() picks it up without requiring a restart.
  // This is critical for idle sessions — hourly-automation calls syncKeys() every 10 min
  // even when no Claude Code process is making API calls.
  const activeKey = state.active_key_id && state.keys[state.active_key_id];
  if (activeKey && activeKey.expiresAt && activeKey.expiresAt < now + EXPIRY_BUFFER_MS) {
    const standby = Object.entries(state.keys).find(([id, k]) =>
      id !== state.active_key_id &&
      k.status === 'active' &&
      k.expiresAt && k.expiresAt > now + EXPIRY_BUFFER_MS
    );
    if (standby) {
      const [newKeyId, newKeyData] = standby;
      const previousKeyId = state.active_key_id;
      state.active_key_id = newKeyId;
      newKeyData.last_used_at = now;
      updateActiveCredentials(newKeyData);
      logRotationEvent(state, {
        timestamp: now,
        event: 'key_switched',
        key_id: newKeyId,
        reason: 'pre_expiry_restartless_swap',
        previous_key: previousKeyId,
      });
      logFn(`[key-sync] Pre-expiry restartless swap: ${previousKeyId.slice(0, 8)} → ${newKeyId.slice(0, 8)}`);
    }
  }

  // Garbage-collect dead keys
  pruneDeadKeys(state, logFn);

  writeRotationState(state);
  return result;
}

/**
 * Garbage-collect dead keys from the rotation state.
 * Removes all keys with status === 'invalid' immediately (invalid keys have
 * permanently revoked refresh tokens and cannot recover). Never prunes the
 * active key. Also removes orphaned rotation_log entries referencing pruned keys.
 *
 * @param {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}} state
 * @param {function} [log] - Optional log function
 */
export function pruneDeadKeys(state, log) {
  const logFn = log || (() => {});
  const prunedKeyIds = [];

  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status !== 'invalid') continue;
    if (keyId === state.active_key_id) continue;

    prunedKeyIds.push(keyId);
  }

  if (prunedKeyIds.length === 0) return;

  // Log account_auth_failed only for accounts losing their LAST viable key
  const prunedSet = new Set(prunedKeyIds);
  const emittedAccounts = new Set();
  for (const keyId of prunedKeyIds) {
    const keyData = state.keys[keyId];
    const email = keyData?.account_email || null;
    const dedupeKey = email || keyId;

    // Skip if we've already emitted for this account
    if (emittedAccounts.has(dedupeKey)) continue;

    // Check if any other non-pruned key belongs to the same account
    const hasOtherViableKey = Object.entries(state.keys).some(([otherId, otherData]) => {
      if (otherId === keyId || prunedSet.has(otherId)) return false;
      if (otherData.status === 'invalid' || otherData.status === 'expired') return false;
      if (!email) return false; // Can't match by email if this key has none
      return otherData.account_email === email;
    });

    if (!hasOtherViableKey) {
      logRotationEvent(state, {
        timestamp: Date.now(),
        event: 'account_auth_failed',
        key_id: keyId,
        reason: 'invalid_key_pruned',
        account_email: email,
      });
      logFn(`[key-sync] Account auth failed for ${email || keyId.slice(0, 8) + '...'} (invalid key pruned)`);
      emittedAccounts.add(dedupeKey);
    }
  }

  for (const keyId of prunedKeyIds) {
    delete state.keys[keyId];
    logFn(`[key-sync] Pruned dead key ${keyId.slice(0, 8)}... (invalid, gc'd)`);
  }

  // Remove orphaned rotation_log entries (preserve account_auth_failed events)
  state.rotation_log = state.rotation_log.filter(
    entry => !entry.key_id || !prunedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
  );
}

// ============================================================================
// Health Check & Key Selection (shared with api-key-watcher, quota-monitor, stop-hook)
// ============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

/**
 * Check the health/usage of a key via Anthropic API.
 * @param {string} accessToken
 * @returns {Promise<{valid: boolean, usage: {five_hour: number, seven_day: number, seven_day_sonnet: number} | null, raw?: object, error?: string}>}
 */
export async function checkKeyHealth(accessToken) {
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (response.status === 401) {
      return { valid: false, usage: null, error: 'unauthorized' };
    }

    if (!response.ok) {
      return { valid: false, usage: null, error: `http_${response.status}` };
    }

    const data = await response.json();

    return {
      valid: true,
      usage: {
        five_hour: data.five_hour?.utilization ?? 0,
        seven_day: data.seven_day?.utilization ?? 0,
        seven_day_sonnet: data.seven_day_sonnet?.utilization ?? 0,
      },
      raw: data,
    };
  } catch (err) {
    return { valid: false, usage: null, error: err.message };
  }
}

/**
 * Select the best key to use based on current usage levels.
 * Groups keys by account_uuid first: for each unique account, picks the key
 * with the freshest token (highest expiresAt). Keys without account_uuid are
 * treated as unique (each is its own "account"). Then applies existing
 * threshold logic between account-representative keys.
 *
 * Returns the key ID of the best key, or null if all keys are exhausted.
 * @param {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}} state
 * @returns {string|null}
 */
export function selectActiveKey(state) {
  const now = Date.now();
  const validKeys = Object.entries(state.keys)
    .filter(([_, key]) => key.status === 'active' || key.status === 'exhausted')
    .map(([id, key]) => ({ id, key, usage: key.last_usage }));

  if (validKeys.length === 0) return null;

  // Freshness gate: null out usage for keys with stale health data (>15 min old).
  // Effect: stale keys pass "usable" filter (not proven exhausted), block "allAbove90"
  // early-return, and are excluded from comparison logic. Net: system stays put with
  // stale data rather than making uninformed switches.
  for (const entry of validKeys) {
    const lastCheck = entry.key.last_health_check;
    if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
      entry.usage = null;
    }
  }

  // Group by account_uuid. Keys without account_uuid are each treated as unique.
  const accountGroups = new Map();
  for (const entry of validKeys) {
    const uuid = entry.key.account_uuid;
    if (!uuid) {
      // No account_uuid — treat as its own unique group
      accountGroups.set(`__no_uuid__${entry.id}`, [entry]);
    } else {
      if (!accountGroups.has(uuid)) {
        accountGroups.set(uuid, []);
      }
      accountGroups.get(uuid).push(entry);
    }
  }

  // For each account group, pick the representative: key with freshest token (highest expiresAt).
  // If expiresAt is missing/null, treat as 0 (least fresh).
  const representatives = [];
  for (const entries of accountGroups.values()) {
    if (entries.length === 1) {
      representatives.push(entries[0]);
    } else {
      entries.sort((a, b) => (b.key.expiresAt || 0) - (a.key.expiresAt || 0));
      representatives.push(entries[0]);
    }
  }

  // Filter out keys at 100% in ANY category (unusable)
  const usableKeys = representatives.filter(({ usage }) => {
    if (!usage) return true; // No data yet, assume usable
    return usage.five_hour < EXHAUSTED_THRESHOLD &&
           usage.seven_day < EXHAUSTED_THRESHOLD &&
           usage.seven_day_sonnet < EXHAUSTED_THRESHOLD;
  });

  if (usableKeys.length === 0) return null; // All keys exhausted

  // Check if ALL usable keys are above 90% in at least one category
  const allAbove90 = usableKeys.every(({ usage }) => {
    if (!usage) return false;
    return usage.five_hour >= HIGH_USAGE_THRESHOLD ||
           usage.seven_day >= HIGH_USAGE_THRESHOLD ||
           usage.seven_day_sonnet >= HIGH_USAGE_THRESHOLD;
  });

  // Current key info
  const currentKey = state.active_key_id
    ? usableKeys.find(k => k.id === state.active_key_id)
    : null;

  if (allAbove90) {
    // All keys high usage: only switch when current is completely exhausted
    if (currentKey) {
      const currentUsage = currentKey.usage;
      if (currentUsage && (
        currentUsage.five_hour >= EXHAUSTED_THRESHOLD ||
        currentUsage.seven_day >= EXHAUSTED_THRESHOLD ||
        currentUsage.seven_day_sonnet >= EXHAUSTED_THRESHOLD
      )) {
        // Current key hit 100% somewhere, switch to another
        const otherKey = usableKeys.find(k => k.id !== state.active_key_id);
        return otherKey?.id ?? null;
      }
      return currentKey.id; // Stick with current
    }
  } else {
    // Some keys below 90%: switch when current reaches >=90% in any category
    if (currentKey?.usage) {
      const maxUsage = Math.max(
        currentKey.usage.five_hour,
        currentKey.usage.seven_day,
        currentKey.usage.seven_day_sonnet
      );

      if (maxUsage >= HIGH_USAGE_THRESHOLD) {
        // Find key with lowest max usage
        const sortedByUsage = usableKeys
          .filter(k => k.id !== state.active_key_id && k.usage)
          .sort((a, b) => {
            const aMax = Math.max(a.usage.five_hour, a.usage.seven_day, a.usage.seven_day_sonnet);
            const bMax = Math.max(b.usage.five_hour, b.usage.seven_day, b.usage.seven_day_sonnet);
            return aMax - bMax;
          });

        if (sortedByUsage.length > 0 && sortedByUsage[0].usage) {
          const altMax = Math.max(
            sortedByUsage[0].usage.five_hour,
            sortedByUsage[0].usage.seven_day,
            sortedByUsage[0].usage.seven_day_sonnet
          );
          if (altMax < HIGH_USAGE_THRESHOLD) {
            return sortedByUsage[0].id;
          }
        }
      }
    }
  }

  // Default: use current key or pick first usable
  return currentKey?.id ?? usableKeys[0]?.id ?? null;
}

/**
 * Deduplicate keys sharing the same account_uuid.
 * For each group of keys with the same account_uuid, keeps the entry with the
 * freshest token (highest expiresAt). Copies last_usage and last_health_check
 * from the most recently health-checked entry. Keys without account_uuid are
 * left untouched. Should only be called after health checks have populated
 * account_uuid fields.
 *
 * If the active_key_id points to a key that gets merged away, updates
 * active_key_id to the surviving key.
 *
 * @param {{version: 1, active_key_id: string|null, keys: Object, rotation_log: Array}} state
 * @returns {{merged: number}} Number of keys removed by deduplication
 */
export function deduplicateKeys(state) {
  const result = { merged: 0 };

  // Group keys by account_uuid. Skip keys without one.
  const accountGroups = new Map();
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    const uuid = keyData.account_uuid;
    if (!uuid) continue;
    if (!accountGroups.has(uuid)) {
      accountGroups.set(uuid, []);
    }
    accountGroups.get(uuid).push({ id: keyId, data: keyData });
  }

  for (const [, entries] of accountGroups) {
    if (entries.length <= 1) continue;

    // Pick the entry with the freshest token (highest expiresAt)
    entries.sort((a, b) => (b.data.expiresAt || 0) - (a.data.expiresAt || 0));
    const survivor = entries[0];

    // Find the most recently health-checked entry for usage data
    const mostRecentlyChecked = entries
      .filter(e => e.data.last_health_check != null)
      .sort((a, b) => b.data.last_health_check - a.data.last_health_check)[0];

    if (mostRecentlyChecked && mostRecentlyChecked.id !== survivor.id) {
      if (mostRecentlyChecked.data.last_usage != null) {
        survivor.data.last_usage = mostRecentlyChecked.data.last_usage;
      }
      if (mostRecentlyChecked.data.last_health_check != null) {
        survivor.data.last_health_check = mostRecentlyChecked.data.last_health_check;
      }
    }

    // Remove all non-survivor entries
    for (let i = 1; i < entries.length; i++) {
      const removedId = entries[i].id;

      // If active_key_id pointed to a removed key, redirect to survivor
      if (state.active_key_id === removedId) {
        state.active_key_id = survivor.id;
      }

      delete state.keys[removedId];
      result.merged++;
    }
  }

  return result;
}

/**
 * Read credentials directly from macOS Keychain.
 * Returns the parsed credential object (with claudeAiOauth field) or null.
 * @returns {object|null}
 */
export function readKeychainCredentials() {
  if (process.platform !== 'darwin') return null;
  try {
    const { username } = os.userInfo();
    const raw = execFileSync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================================
// Account Profile Resolution
// ============================================================================

const PROFILE_API_URL = 'https://api.anthropic.com/api/oauth/profile';

/**
 * Fetch account profile to get account UUID and email for deduplication.
 * Uses the same OAuth Bearer auth as the usage endpoint.
 * @param {string} accessToken
 * @returns {Promise<{account_uuid: string, email: string}|null>}
 */
export async function fetchAccountProfile(accessToken) {
  try {
    const response = await fetch(PROFILE_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.account?.uuid && data.account?.email) {
      return {
        account_uuid: data.account.uuid,
        email: data.account.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Rotation audit log — structured event log for post-rotation health verification
const ROTATION_AUDIT_LOG_PATH = path.join(
  process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  '.claude', 'state', 'rotation-audit.log'
);

/**
 * Append a structured audit event to the rotation audit log.
 * Format: [ISO_TIMESTAMP] EVENT key1=val1 key2=val2
 *
 * @param {string} event - Event name (e.g. 'rotation_completed', 'adoption_verified')
 * @param {Object} details - Key-value pairs to include in the log line
 */
export function appendRotationAudit(event, details = {}) {
  const ts = new Date().toISOString();
  const sanitizedEvent = String(event).replace(/[\r\n]/g, ' ');
  const parts = [`[${ts}] ${sanitizedEvent}`];
  for (const [k, v] of Object.entries(details)) {
    parts.push(`${k}=${String(v).replace(/[\r\n]/g, ' ')}`);
  }
  const line = parts.join(' ');
  try {
    const dir = path.dirname(ROTATION_AUDIT_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(ROTATION_AUDIT_LOG_PATH, line + '\n', 'utf8');
  } catch (err) {
    console.error(`[key-sync] Failed to write rotation audit log: ${err.message}`);
  }
}

// Export paths for consumers
export { ROTATION_STATE_PATH, ROTATION_LOG_PATH, CREDENTIALS_PATH, OLD_PROJECT_STATE_PATH, ROTATION_AUDIT_LOG_PATH };
