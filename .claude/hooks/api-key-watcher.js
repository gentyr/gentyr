#!/usr/bin/env node
/**
 * API Key Rotation Hook
 *
 * Runs on SessionStart to track multiple Claude API keys and automatically
 * rotate between them based on utilization thresholds.
 *
 * Features:
 * - Captures new keys from all sources (env var, macOS Keychain, credentials file)
 * - Monitors usage via Anthropic Usage API
 * - Rotates to lower-utilization keys when current key hits 90%+ usage
 * - Attempts OAuth token refresh for expired keys
 * - Logs all rotation events for debugging
 *
 * Storage:
 * - ~/.claude/api-key-rotation.json - Tracked keys and state (user-level, cross-project)
 * - <project>/.claude/api-key-rotation.log - Human-readable event log (project-level)
 *
 * @version 2.0.0
 */

import { fileURLToPath } from 'url';
import { registerHookExecution, HOOK_TYPES } from './agent-tracker.js';
import {
  syncKeys,
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  refreshExpiredToken,
  checkKeyHealth,
  selectActiveKey,
  fetchAccountProfile,
  HIGH_USAGE_THRESHOLD,
  EXHAUSTED_THRESHOLD,
} from './key-sync.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();

  // Skip for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    registerHookExecution({
      hookType: HOOK_TYPES.API_KEY_WATCHER,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'spawned_session' }
    });
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
    return;
  }

  // Step 1: Sync keys from all credential sources (env, keychain, file)
  const syncResult = await syncKeys();

  // Step 2: Read the synced rotation state for health checks + rotation
  const state = readRotationState();
  const now = Date.now();

  if (Object.keys(state.keys).length === 0) {
    // No keys tracked, nothing to do
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
    return;
  }

  // Step 3: Run health checks on all tracked keys (with token refresh for expired)
  const healthCheckPromises = Object.entries(state.keys).map(async ([keyId, keyData]) => {
    // Skip invalid keys
    if (keyData.status === 'invalid') {
      return { keyId, result: null };
    }

    // Check if token is expired - attempt refresh first
    if (keyData.expiresAt && keyData.expiresAt < now) {
      if (keyData.status !== 'expired') {
        const refreshed = await refreshExpiredToken(keyData);
        if (refreshed === 'invalid_grant') {
          keyData.status = 'invalid';
          logRotationEvent(state, {
            timestamp: now,
            event: 'key_removed',
            key_id: keyId,
            reason: 'refresh_token_invalid_grant',
          });
          return { keyId, result: null };
        } else if (refreshed) {
          keyData.accessToken = refreshed.accessToken;
          keyData.refreshToken = refreshed.refreshToken;
          keyData.expiresAt = refreshed.expiresAt;
          keyData.status = 'active';
          logRotationEvent(state, {
            timestamp: now,
            event: 'key_added',
            key_id: keyId,
            reason: 'token_refreshed_during_health_check',
          });
        } else {
          keyData.status = 'expired';
          logRotationEvent(state, {
            timestamp: now,
            event: 'key_removed',
            key_id: keyId,
            reason: 'token_expired',
          });
          return { keyId, result: null };
        }
      } else {
        return { keyId, result: null };
      }
    }

    // Run health check
    const result = await checkKeyHealth(keyData.accessToken);

    // Fetch account profile if not already known (non-blocking)
    if (result.valid && !keyData.account_uuid) {
      const profile = await fetchAccountProfile(keyData.accessToken);
      if (profile) {
        keyData.account_uuid = profile.account_uuid;
        keyData.account_email = profile.email;
      }
    }

    return { keyId, result };
  });

  const healthResults = await Promise.all(healthCheckPromises);

  // Process health check results
  for (const { keyId, result } of healthResults) {
    if (!result) continue;

    const keyData = state.keys[keyId];
    keyData.last_health_check = now;

    if (!result.valid) {
      keyData.status = 'invalid';
      logRotationEvent(state, {
        timestamp: now,
        event: 'key_removed',
        key_id: keyId,
        reason: `health_check_failed_${result.error}`,
      });
    } else if (result.usage) {
      keyData.last_usage = {
        ...result.usage,
        checked_at: now,
      };

      // Check if exhausted
      const isExhausted = result.usage.five_hour >= EXHAUSTED_THRESHOLD ||
                          result.usage.seven_day >= EXHAUSTED_THRESHOLD ||
                          result.usage.seven_day_sonnet >= EXHAUSTED_THRESHOLD;

      if (isExhausted && keyData.status !== 'exhausted') {
        keyData.status = 'exhausted';
        logRotationEvent(state, {
          timestamp: now,
          event: 'key_exhausted',
          key_id: keyId,
          reason: 'hit_100_percent',
          usage_snapshot: result.usage,
        });
      } else if (!isExhausted && keyData.status === 'exhausted') {
        keyData.status = 'active';
      }

      logRotationEvent(state, {
        timestamp: now,
        event: 'health_check',
        key_id: keyId,
        usage_snapshot: result.usage,
      });
    }
  }

  // Step 4: Select the best key
  const selectedKeyId = selectActiveKey(state);

  // Check if we need to switch keys
  if (selectedKeyId && selectedKeyId !== state.active_key_id) {
    const previousKeyId = state.active_key_id;
    state.active_key_id = selectedKeyId;

    const selectedKey = state.keys[selectedKeyId];
    selectedKey.last_used_at = now;

    logRotationEvent(state, {
      timestamp: now,
      event: 'key_switched',
      key_id: selectedKeyId,
      reason: previousKeyId ? `switched_from_${previousKeyId.slice(0, 8)}` : 'initial_selection',
      usage_snapshot: selectedKey.last_usage ? {
        five_hour: selectedKey.last_usage.five_hour,
        seven_day: selectedKey.last_usage.seven_day,
        seven_day_sonnet: selectedKey.last_usage.seven_day_sonnet,
      } : undefined,
    });

    // Update credentials in all stores if switching to a different key
    if (previousKeyId) {
      updateActiveCredentials(selectedKey);
    }
  } else if (!state.active_key_id && selectedKeyId) {
    // First time setting active key
    state.active_key_id = selectedKeyId;
    state.keys[selectedKeyId].last_used_at = now;
  }

  // Save state
  writeRotationState(state);

  // Build notification message — only count keys that responded to health checks,
  // deduplicated per account (prefer account_uuid, fall back to usage fingerprint).
  const respondingKeys = Object.entries(state.keys)
    .filter(([_, k]) => k.last_usage && (k.status === 'active' || k.status === 'exhausted'));

  // Deduplicate by account: prefer account_uuid, fall back to usage fingerprint
  const seen = new Set();
  const uniqueAccounts = respondingKeys.filter(([_, k]) => {
    const dedupeKey = k.account_uuid || `fp:${k.last_usage.seven_day}:${k.last_usage.seven_day_sonnet}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });

  const accountCount = uniqueAccounts.length;
  let message = null;

  if (accountCount > 1) {
    const activeKey = state.keys[state.active_key_id];
    const usage = activeKey?.last_usage;

    if (usage) {
      const maxUsage = Math.max(usage.five_hour, usage.seven_day, usage.seven_day_sonnet);
      message = `Accounts: ${accountCount} tracked | Active: ${state.active_key_id.slice(0, 8)}... (${Math.round(maxUsage)}% max usage)`;
    } else {
      message = `Accounts: ${accountCount} tracked | Active: ${state.active_key_id.slice(0, 8)}...`;
    }
  }

  registerHookExecution({
    hookType: HOOK_TYPES.API_KEY_WATCHER,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: {
      keyCount: accountCount,
      switched: selectedKeyId !== state.active_key_id,
      keysAdded: syncResult.keysAdded,
      tokensRefreshed: syncResult.tokensRefreshed,
    }
  });

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: !message,
    ...(message && { systemMessage: message }),
  }));
}

main().catch(err => {
  console.error(`[api-key-watcher] Error: ${err.message}`);

  registerHookExecution({
    hookType: HOOK_TYPES.API_KEY_WATCHER,
    status: 'failure',
    durationMs: 0,
    metadata: { error: err.message }
  });

  // Don't block on errors
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: true,
  }));
});
