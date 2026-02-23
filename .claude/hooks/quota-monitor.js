#!/usr/bin/env node
/**
 * Quota Monitor - PostToolUse hook for mid-session quota detection
 *
 * Runs after every tool call, throttled via adaptive interval based on usage:
 *   - Usage < 70%: 5-min interval
 *   - Usage 70-85%: 2-min interval
 *   - Usage 85-95%: 1-min interval
 *   - Usage >= 95%: 30-sec interval
 *
 * Tracks usage velocity (rate of change per minute) over a rolling 5-sample
 * window. Predictive rotation triggers when projected to hit 100% within 1.5x
 * the current check interval (only when velocity > 0).
 *
 * Checks usage API for the active key and triggers rotation if usage >= 95%
 * or predictive threshold is met.
 *
 * On rotation: writes new credentials to Keychain and continues for ALL sessions.
 *   Adoption occurs via rotation proxy (immediate) or at token expiry (SRA).
 * When all accounts are exhausted: warns the user.
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  checkKeyHealth,
  selectActiveKey,
  refreshExpiredToken,
  readKeychainCredentials,
  generateKeyId,
  HIGH_USAGE_THRESHOLD,
  EXHAUSTED_THRESHOLD,
  EXPIRY_BUFFER_MS,
  ROTATION_AUDIT_LOG_PATH,
  appendRotationAudit,
} from './key-sync.js';
import { registerHookExecution, HOOK_TYPES } from './agent-tracker.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const THROTTLE_STATE_PATH = path.join(STATE_DIR, 'quota-monitor-state.json');

// Thresholds
const ROTATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes anti-loop
const PROACTIVE_THRESHOLD = 95; // Trigger rotation at 95%
const USAGE_HISTORY_MAX = 5; // Rolling window size for velocity tracking

// Adaptive interval tiers: usage% -> check interval
const ADAPTIVE_INTERVALS = [
  { maxUsage: 70,  intervalMs: 5 * 60 * 1000 },   // < 70%: 5 min
  { maxUsage: 85,  intervalMs: 2 * 60 * 1000 },   // 70-85%: 2 min
  { maxUsage: 95,  intervalMs: 60 * 1000 },        // 85-95%: 1 min
  { maxUsage: Infinity, intervalMs: 30 * 1000 },   // >= 95%: 30 sec
];

/**
 * Determine the adaptive check interval based on current usage percentage.
 */
function getAdaptiveInterval(usagePercent) {
  for (const tier of ADAPTIVE_INTERVALS) {
    if (usagePercent < tier.maxUsage) {
      return tier.intervalMs;
    }
  }
  // Fallback: tightest interval
  return ADAPTIVE_INTERVALS[ADAPTIVE_INTERVALS.length - 1].intervalMs;
}

/**
 * Compute usage velocity (percentage points per minute) from usage history.
 * Returns 0 if insufficient data points (need at least 2).
 */
function computeVelocity(usageHistory) {
  if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
    return 0;
  }
  const oldest = usageHistory[0];
  const newest = usageHistory[usageHistory.length - 1];
  const timeDeltaMs = newest.timestamp - oldest.timestamp;
  if (timeDeltaMs <= 0) {
    return 0;
  }
  const timeDeltaMin = timeDeltaMs / (60 * 1000);
  return (newest.usage - oldest.usage) / timeDeltaMin;
}

/**
 * Read throttle state from disk.
 */
function readThrottleState() {
  try {
    if (fs.existsSync(THROTTLE_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(THROTTLE_STATE_PATH, 'utf8'));
    }
  } catch {
    // Ignore
  }
  return { lastCheck: 0, lastRotation: 0, currentIntervalMs: ADAPTIVE_INTERVALS[0].intervalMs, usageHistory: [] };
}

/**
 * Write throttle state to disk.
 */
function writeThrottleState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(THROTTLE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Verify a pending rotation audit: check Keychain match and key health.
 * Writes results to throttle state and audit log.
 */
async function verifyPendingAudit(throttle) {
  const audit = throttle.pendingAudit;
  if (!audit || audit.verifiedAt) return;

  const now = Date.now();
  const keychainCreds = readKeychainCredentials();
  let keychainMatch = false;
  if (keychainCreds?.claudeAiOauth?.accessToken) {
    const keychainKeyId = generateKeyId(keychainCreds.claudeAiOauth.accessToken);
    keychainMatch = keychainKeyId === audit.toKeyId;
  }

  const state = readRotationState();
  const targetKey = state.keys?.[audit.toKeyId];
  let healthCheckPassed = false;
  if (targetKey?.accessToken) {
    const health = await checkKeyHealth(targetKey.accessToken);
    healthCheckPassed = health.valid;
  }

  audit.verifiedAt = now;
  audit.keychainMatch = keychainMatch;
  audit.healthCheckPassed = healthCheckPassed;

  const adoptionTimeSec = Math.round((now - audit.rotatedAt) / 1000);
  appendRotationAudit('AUDIT', {
    to: audit.toKeyId.slice(0, 8),
    keychain: keychainMatch ? 'MATCH' : 'MISMATCH',
    health: healthCheckPassed ? 'PASS' : 'FAIL',
    adoption_time: adoptionTimeSec + 's',
  });
}

async function main() {
  const startTime = Date.now();
  const isAutomated = process.env.CLAUDE_SPAWNED_SESSION === 'true';

  // Step 1: Check throttle (adaptive interval)
  const throttle = readThrottleState();

  const currentIntervalMs = throttle.currentIntervalMs || ADAPTIVE_INTERVALS[0].intervalMs;
  if (startTime - throttle.lastCheck < currentIntervalMs) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Step 1b: Verify pending rotation audit from previous cycle
  if (throttle.pendingAudit && !throttle.pendingAudit.verifiedAt) {
    await verifyPendingAudit(throttle);
    writeThrottleState(throttle);
  }

  // Step 2: Anti-loop - skip if we rotated very recently
  if (startTime - throttle.lastRotation < ROTATION_COOLDOWN_MS) {
    throttle.lastCheck = startTime;
    writeThrottleState(throttle);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Step 3: Read rotation state, get active key
  const state = readRotationState();
  if (!state.active_key_id || !state.keys[state.active_key_id]) {
    throttle.lastCheck = startTime;
    writeThrottleState(throttle);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const activeKeyData = state.keys[state.active_key_id];

  // Step 4: Check usage via API
  const health = await checkKeyHealth(activeKeyData.accessToken);
  throttle.lastCheck = startTime;

  if (!health.valid) {
    writeThrottleState(throttle);
    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'failure',
      durationMs: Date.now() - startTime,
      metadata: { error: health.error },
    });
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Update usage data in state (store only needed fields, not full raw response)
  activeKeyData.last_health_check = startTime;
  activeKeyData.last_usage = {
    ...health.usage,
    checked_at: startTime,
    resets_at: {
      five_hour: health.raw?.five_hour?.resets_at || null,
      seven_day: health.raw?.seven_day?.resets_at || null,
      seven_day_sonnet: health.raw?.seven_day_sonnet?.resets_at || null,
    },
  };

  // Check if exhausted
  const isExhausted = health.usage.five_hour >= EXHAUSTED_THRESHOLD ||
                      health.usage.seven_day >= EXHAUSTED_THRESHOLD ||
                      health.usage.seven_day_sonnet >= EXHAUSTED_THRESHOLD;

  if (isExhausted && activeKeyData.status !== 'exhausted') {
    activeKeyData.status = 'exhausted';
    logRotationEvent(state, {
      timestamp: startTime,
      event: 'key_exhausted',
      key_id: state.active_key_id,
      reason: 'quota_monitor_detected',
      usage_snapshot: health.usage,
    });
  } else if (!isExhausted && activeKeyData.status === 'exhausted') {
    activeKeyData.status = 'active';
    logRotationEvent(state, {
      timestamp: startTime,
      event: 'account_quota_refreshed',
      key_id: state.active_key_id,
      reason: 'usage_dropped_below_100',
      account_email: activeKeyData.account_email || null,
    });
  }

  writeRotationState(state);

  // Step 4b: Refresh expired tokens AND proactively refresh non-active tokens
  // approaching expiry. Keeps standby tokens perpetually fresh so SRA()/r6T()
  // always finds a valid replacement in Keychain.
  // Safe: refreshing Account B's token does NOT revoke Account A's in-memory token.
  const now4b = Date.now();
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status === 'invalid' || keyData.status === 'tombstone') continue;
    const isExpired = keyData.status === 'expired' && keyData.expiresAt && keyData.expiresAt < now4b;
    const isApproachingExpiry = keyId !== state.active_key_id && keyData.expiresAt && keyData.expiresAt > now4b && keyData.expiresAt < now4b + EXPIRY_BUFFER_MS;
    if (isExpired || isApproachingExpiry) {
      try {
        const refreshed = await refreshExpiredToken(keyData);
        if (refreshed === 'invalid_grant') {
          keyData.status = 'invalid';
          logRotationEvent(state, {
            timestamp: now4b,
            event: 'key_removed',
            key_id: keyId,
            reason: 'refresh_token_invalid_grant',
          });
        } else if (refreshed) {
          keyData.accessToken = refreshed.accessToken;
          keyData.refreshToken = refreshed.refreshToken;
          keyData.expiresAt = refreshed.expiresAt;
          keyData.status = 'active';
          logRotationEvent(state, {
            timestamp: now4b,
            event: isExpired ? 'key_added' : 'key_refreshed',
            key_id: keyId,
            reason: isExpired ? 'token_refreshed_by_quota_monitor' : 'proactive_standby_refresh',
          });
        }
      } catch {
        // Non-fatal: key stays in current status
      }
    }
  }
  writeRotationState(state);

  // Step 4c: Pre-expiry restartless swap — if the active key is near expiry,
  // write a valid standby to Keychain so Claude Code's SRA()/r6T() picks it up.
  // NO restart needed: SRA() fires at jv() (5 min before expiry), clears in-memory cache,
  // re-reads from Keychain, and adopts the standby token seamlessly.
  if (activeKeyData.expiresAt && activeKeyData.expiresAt < now4b + EXPIRY_BUFFER_MS) {
    const standby = Object.entries(state.keys).find(([id, k]) =>
      id !== state.active_key_id &&
      k.status === 'active' &&
      k.expiresAt && k.expiresAt > now4b + EXPIRY_BUFFER_MS
    );
    if (standby) {
      const [newKeyId, newKeyData] = standby;
      const previousKeyId = state.active_key_id;
      state.active_key_id = newKeyId;
      newKeyData.last_used_at = now4b;
      updateActiveCredentials(newKeyData);
      logRotationEvent(state, {
        timestamp: now4b,
        event: 'key_switched',
        key_id: newKeyId,
        reason: 'pre_expiry_restartless_swap',
        previous_key: previousKeyId,
      });
      writeRotationState(state);
      // No restart — Claude Code adopts the Keychain token via SRA()/r6T()
    }
  }

  // Step 5: Compute maxUsage, update velocity tracking, set adaptive interval
  const maxUsage = Math.max(
    health.usage.five_hour,
    health.usage.seven_day,
    health.usage.seven_day_sonnet
  );

  // Step 5a0: Fire account_nearly_depleted event when approaching threshold
  // Uses 5-hour cooldown per key to avoid re-firing every check cycle
  if (maxUsage >= PROACTIVE_THRESHOLD && !isExhausted) {
    const nearlyDepletedKeys = throttle.nearlyDepletedKeys || {};
    const keyLastFired = nearlyDepletedKeys[state.active_key_id] || 0;
    const NEARLY_DEPLETED_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 hours
    if (startTime - keyLastFired >= NEARLY_DEPLETED_COOLDOWN_MS) {
      logRotationEvent(state, {
        timestamp: startTime,
        event: 'account_nearly_depleted',
        key_id: state.active_key_id,
        reason: `usage_at_${Math.round(maxUsage)}pct`,
        usage_snapshot: health.usage,
        account_email: activeKeyData.account_email || null,
      });
      writeRotationState(state);
      nearlyDepletedKeys[state.active_key_id] = startTime;
      throttle.nearlyDepletedKeys = nearlyDepletedKeys;
    }
  }

  // Step 5a: Update usage history (rolling window for velocity tracking)
  const usageHistory = Array.isArray(throttle.usageHistory) ? [...throttle.usageHistory] : [];
  usageHistory.push({ usage: maxUsage, timestamp: startTime });
  while (usageHistory.length > USAGE_HISTORY_MAX) {
    usageHistory.shift();
  }
  throttle.usageHistory = usageHistory;

  // Step 5b: Compute velocity (percentage points per minute)
  const velocity = computeVelocity(usageHistory);

  // Step 5c: Update adaptive interval based on current usage
  throttle.currentIntervalMs = getAdaptiveInterval(maxUsage);

  // Step 5d: Predictive rotation — if velocity > 0 and projected to hit 100%
  // before 1.5x the next check interval, rotate immediately
  let predictiveRotation = false;
  if (velocity > 0 && maxUsage < PROACTIVE_THRESHOLD) {
    const remainingPercent = 100 - maxUsage;
    const minutesToExhaustion = remainingPercent / velocity;
    const msToExhaustion = minutesToExhaustion * 60 * 1000;
    const predictionHorizon = throttle.currentIntervalMs * 1.5;
    if (msToExhaustion < predictionHorizon) {
      predictiveRotation = true;
    }
  }

  if (maxUsage < PROACTIVE_THRESHOLD && !predictiveRotation) {
    // Usage is fine and no predictive trigger, no action needed
    writeThrottleState(throttle);
    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { maxUsage: Math.round(maxUsage), action: 'none', velocity: Math.round(velocity * 100) / 100, intervalMs: throttle.currentIntervalMs },
    });
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Usage >= threshold or predictive trigger, attempt rotation
  const rotationReason = predictiveRotation
    ? `quota_monitor_predictive_${Math.round(maxUsage)}pct_vel${Math.round(velocity * 100) / 100}`
    : `quota_monitor_${Math.round(maxUsage)}pct`;

  // For predictive rotation, selectActiveKey may refuse to switch (usage < 90%),
  // so directly find the lowest-usage alternative key as a fallback.
  let selectedKeyId = selectActiveKey(state);
  if (predictiveRotation && (!selectedKeyId || selectedKeyId === state.active_key_id)) {
    // Bypass selectActiveKey: find any active key on a different account with lower usage
    const currentAccountUuid = state.keys[state.active_key_id]?.account_uuid;
    const alternatives = Object.entries(state.keys)
      .filter(([id, k]) => id !== state.active_key_id && k.status === 'active')
      .filter(([, k]) => !currentAccountUuid || k.account_uuid !== currentAccountUuid)
      .map(([id, k]) => {
        const u = k.last_usage;
        const altMax = u ? Math.max(u.five_hour, u.seven_day, u.seven_day_sonnet) : 0;
        return { id, maxUsage: altMax };
      })
      .sort((a, b) => a.maxUsage - b.maxUsage);
    if (alternatives.length > 0 && alternatives[0].maxUsage < maxUsage) {
      selectedKeyId = alternatives[0].id;
    }
  }

  if (selectedKeyId && selectedKeyId !== state.active_key_id) {
    // Found a better key - rotate
    const previousKeyId = state.active_key_id;
    state.active_key_id = selectedKeyId;
    const selectedKey = state.keys[selectedKeyId];
    selectedKey.last_used_at = startTime;

    logRotationEvent(state, {
      timestamp: startTime,
      event: 'key_switched',
      key_id: selectedKeyId,
      reason: rotationReason,
      usage_snapshot: health.usage,
      velocity: Math.round(velocity * 100) / 100,
      predictive: predictiveRotation,
    });

    updateActiveCredentials(selectedKey);
    writeRotationState(state);

    throttle.lastRotation = startTime;

    // Step 6: Schedule post-rotation audit for next invocation
    throttle.pendingAudit = {
      rotatedAt: startTime,
      fromKeyId: previousKeyId,
      toKeyId: selectedKeyId,
      reason: rotationReason,
      sessionType: isAutomated ? 'automated' : 'interactive',
      verifiedAt: null,
      keychainMatch: null,
      healthCheckPassed: null,
    };

    // Log rotation event to audit log
    appendRotationAudit('ROTATION', {
      from: previousKeyId.slice(0, 8),
      to: selectedKeyId.slice(0, 8),
      reason: rotationReason,
      sessionType: isAutomated ? 'automated' : 'interactive',
    });

    writeThrottleState(throttle);

    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { maxUsage: Math.round(maxUsage), action: predictiveRotation ? 'predictive_rotated' : 'rotated', velocity: Math.round(velocity * 100) / 100, intervalMs: throttle.currentIntervalMs, from: previousKeyId.slice(0, 8), to: selectedKeyId.slice(0, 8) },
    });

    // All sessions: seamless rotation via rotation proxy.
    // Credentials written to Keychain via updateActiveCredentials() above.
    // Rotation proxy adopts immediately; SRA() picks up at token expiry.
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: `Account rotated to ${selectedKeyId.slice(0, 8)}... (${Math.round(maxUsage)}% usage on previous). Credentials written to Keychain. Rotation proxy will use new key immediately.`,
    }));
    return;
  }

  // No better key available
  if (!selectedKeyId || selectedKeyId === state.active_key_id) {
    if (isExhausted) {
      // All keys exhausted — warn the user
      const accountCount = Object.values(state.keys).filter(
        k => k.status === 'active' || k.status === 'exhausted'
      ).length;

      writeThrottleState(throttle);

      registerHookExecution({
        hookType: HOOK_TYPES.QUOTA_MONITOR,
        status: 'success',
        durationMs: Date.now() - startTime,
        metadata: { maxUsage: Math.round(maxUsage), action: 'all_exhausted', accountCount },
      });

      process.stdout.write(JSON.stringify({
        continue: true,
        systemMessage: `All ${accountCount} accounts exhausted. Quota will reset automatically — no action needed.`,
      }));
      return;
    }

    // High usage but not exhausted, no better key
    writeThrottleState(throttle);
    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { maxUsage: Math.round(maxUsage), action: 'warning' },
    });
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }
}

main().catch(err => {
  registerHookExecution({
    hookType: HOOK_TYPES.QUOTA_MONITOR,
    status: 'failure',
    durationMs: 0,
    metadata: { error: err.message },
  });
  // Don't block on errors
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
