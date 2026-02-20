#!/usr/bin/env node
/**
 * Quota Monitor - PostToolUse hook for mid-session quota detection
 *
 * Runs after every tool call, throttled to once per 5 minutes via state file.
 * Checks usage API for the active key and triggers rotation if usage >= 95%.
 *
 * For interactive sessions: triggers auto-restart with new credentials.
 * For automated sessions: writes signal to quota-interrupted-sessions.json
 *   for session-reviver to pick up.
 * When all accounts are exhausted: writes to paused-sessions.json and warns.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  checkKeyHealth,
  selectActiveKey,
  refreshExpiredToken,
  HIGH_USAGE_THRESHOLD,
  EXHAUSTED_THRESHOLD,
  EXPIRY_BUFFER_MS,
} from './key-sync.js';
import { registerHookExecution, HOOK_TYPES } from './agent-tracker.js';
import {
  discoverSessionId,
  getClaudePid,
  detectTerminal,
  generateRestartScript,
  shellEscape,
} from './slash-command-prefetch.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const THROTTLE_STATE_PATH = path.join(STATE_DIR, 'quota-monitor-state.json');
const PAUSED_SESSIONS_PATH = path.join(STATE_DIR, 'paused-sessions.json');

// Thresholds
const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const ROTATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes anti-loop
const PROACTIVE_THRESHOLD = 95; // Trigger rotation at 95%

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
  return { lastCheck: 0, lastRotation: 0 };
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
 * Write a paused-session record for when all accounts are exhausted.
 */
function writePausedSession(record) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }

    let data = { sessions: [] };
    if (fs.existsSync(PAUSED_SESSIONS_PATH)) {
      data = JSON.parse(fs.readFileSync(PAUSED_SESSIONS_PATH, 'utf8'));
      if (!Array.isArray(data.sessions)) data.sessions = [];
    }

    // Don't duplicate
    const existingIdx = data.sessions.findIndex(
      s => s.sessionId === record.sessionId
    );
    if (existingIdx >= 0) {
      data.sessions[existingIdx] = record;
    } else {
      data.sessions.push(record);
    }

    // Clean up entries older than 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    data.sessions = data.sessions.filter(s => s.pausedAt > cutoff);

    fs.writeFileSync(PAUSED_SESSIONS_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Find the earliest reset time across all keys.
 */
function findEarliestReset(state) {
  let earliest = null;
  for (const [, keyData] of Object.entries(state.keys)) {
    const resetsAt = keyData.last_usage?.resets_at;
    if (resetsAt) {
      for (const bucket of ['five_hour', 'seven_day', 'seven_day_sonnet']) {
        const resetAt = resetsAt[bucket];
        if (resetAt) {
          const resetMs = new Date(resetAt).getTime();
          if (!earliest || resetMs < earliest) {
            earliest = resetMs;
          }
        }
      }
    }
  }
  return earliest;
}

async function main() {
  const startTime = Date.now();
  const isAutomated = process.env.CLAUDE_SPAWNED_SESSION === 'true';

  // Step 1: Check throttle
  const throttle = readThrottleState();
  if (startTime - throttle.lastCheck < CHECK_INTERVAL_MS) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
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
  }

  writeRotationState(state);

  // Step 4b: Refresh expired tokens AND proactively refresh non-active tokens
  // approaching expiry. Keeps standby tokens perpetually fresh so SRA()/r6T()
  // always finds a valid replacement in Keychain.
  // Safe: refreshing Account B's token does NOT revoke Account A's in-memory token.
  const now4b = Date.now();
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status === 'invalid') continue;
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

  // Step 5: Check if rotation is needed
  const maxUsage = Math.max(
    health.usage.five_hour,
    health.usage.seven_day,
    health.usage.seven_day_sonnet
  );

  if (maxUsage < PROACTIVE_THRESHOLD) {
    // Usage is fine, no action needed
    writeThrottleState(throttle);
    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { maxUsage: Math.round(maxUsage), action: 'none' },
    });
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Usage >= 95%, attempt rotation
  const selectedKeyId = selectActiveKey(state);

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
      reason: `quota_monitor_${Math.round(maxUsage)}pct`,
      usage_snapshot: health.usage,
    });

    updateActiveCredentials(selectedKey);
    writeRotationState(state);

    throttle.lastRotation = startTime;
    writeThrottleState(throttle);

    registerHookExecution({
      hookType: HOOK_TYPES.QUOTA_MONITOR,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { maxUsage: Math.round(maxUsage), action: 'rotated', from: previousKeyId.slice(0, 8), to: selectedKeyId.slice(0, 8) },
    });

    if (!isAutomated) {
      // Interactive session: auto-restart with new credentials
      try {
        const claudePid = getClaudePid();
        const sessionId = discoverSessionId();
        const terminal = detectTerminal();
        const script = generateRestartScript(claudePid, sessionId, PROJECT_DIR, terminal);
        const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
        child.unref();

        process.stdout.write(JSON.stringify({
          continue: false,
          stopReason: `Account rotated (${Math.round(maxUsage)}% usage). Restarting with fresh credentials...`,
        }));
        return;
      } catch {
        // Restart failed, continue with rotated credentials anyway
        process.stdout.write(JSON.stringify({
          continue: true,
          systemMessage: `Account rotated to ${selectedKeyId.slice(0, 8)}... (${Math.round(maxUsage)}% usage on previous). Credentials updated mid-session.`,
        }));
        return;
      }
    } else {
      // Automated session: restart with fresh credentials so Claude Code picks up new token
      try {
        const sessionId = discoverSessionId();
        const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
        const spawnArgs = [
          '--resume', sessionId,
          '--dangerously-skip-permissions',
          '--mcp-config', mcpConfig,
          '--output-format', 'json',
        ];
        const child = spawn('claude', spawnArgs, {
          cwd: PROJECT_DIR,
          stdio: 'ignore',
          detached: true,
          env: (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_OAUTH_TOKEN; return e; })(),
        });
        child.unref();

        if (child.pid) {
          process.stdout.write(JSON.stringify({
            continue: false,
            stopReason: `Account rotated (${Math.round(maxUsage)}% usage). Restarting automated session with fresh credentials (PID ${child.pid}).`,
          }));
          return;
        }
      } catch {
        // Spawn failed — fall back to continue with rotated creds on disk
      }

      // Fallback: continue with warning (creds on disk updated but may be cached in memory)
      process.stdout.write(JSON.stringify({
        continue: true,
        systemMessage: `Account rotated to ${selectedKeyId.slice(0, 8)}... (${Math.round(maxUsage)}% usage on previous). Warning: credentials updated on disk but may be cached in memory.`,
      }));
      return;
    }
  }

  // No better key available
  if (!selectedKeyId || selectedKeyId === state.active_key_id) {
    if (isExhausted) {
      // All keys exhausted
      const earliestReset = findEarliestReset(state);
      const resetInfo = earliestReset
        ? `Earliest reset: ${new Date(earliestReset).toLocaleString()}`
        : 'Reset times unknown';

      const accountCount = Object.values(state.keys).filter(
        k => k.status === 'active' || k.status === 'exhausted'
      ).length;

      // Write paused session record
      let sessionId = null;
      try {
        sessionId = discoverSessionId();
      } catch {
        // Can't discover session ID
      }

      writePausedSession({
        sessionId,
        agentId: process.env.CLAUDE_AGENT_ID || null,
        projectDir: PROJECT_DIR,
        pausedAt: startTime,
        earliestReset: earliestReset || startTime + 5 * 60 * 60 * 1000,
        type: isAutomated ? 'automated' : 'interactive',
      });

      writeThrottleState(throttle);

      registerHookExecution({
        hookType: HOOK_TYPES.QUOTA_MONITOR,
        status: 'success',
        durationMs: Date.now() - startTime,
        metadata: { maxUsage: Math.round(maxUsage), action: 'all_exhausted', accountCount },
      });

      process.stdout.write(JSON.stringify({
        continue: true,
        systemMessage: `All ${accountCount} accounts exhausted. ${resetInfo}. Session will auto-resume when quota resets.`,
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
