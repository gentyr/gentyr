#!/usr/bin/env node
/**
 * Token Swap Monitor - Comprehensive telemetry for credential rotation
 *
 * Polls Keychain state, credentials file, rotation state, quota-monitor
 * throttle state, and process counts every 30 seconds. Logs compact
 * one-liners and emits diagnostic alerts for desync, staleness,
 * velocity warnings, duplicates, exhaustion, expiry, and missing
 * refresh tokens.
 *
 * Every 5 minutes, performs deep health checks via the Anthropic API
 * and compares live usage against stored state.
 *
 * Logs to both stdout and .claude/state/token-swap-monitor.log.
 *
 * Run:   node scripts/monitor-token-swap.mjs
 * Stop:  Ctrl+C (prints final summary)
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import {
  readRotationState,
  writeRotationState,
  selectActiveKey,
  generateKeyId,
  checkKeyHealth,
  logRotationEvent,
  updateActiveCredentials,
  readKeychainCredentials,
  EXPIRY_BUFFER_MS,
  HIGH_USAGE_THRESHOLD,
} from '../.claude/hooks/key-sync.js';

// ============================================================================
// Constants & Paths
// ============================================================================

const HOME = os.homedir();
const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LOG_FILE = path.join(STATE_DIR, 'token-swap-monitor.log');
const CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');
const THROTTLE_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'quota-monitor-state.json');

const POLL_INTERVAL_MS = 30_000;       // 30 seconds
const DEEP_CHECK_INTERVAL_MS = 300_000; // 5 minutes

// Diagnostic thresholds
const STALE_HEALTH_CHECK_MS = 600_000;  // 10 min - health check data considered stale
const VELOCITY_WARNING_PCT = 15;        // warn if usage jumped 15%+ in one poll cycle

// Audit mode (--audit flag)
const AUDIT_MODE = process.argv.includes('--audit');
const ROTATION_AUDIT_LOG_PATH = path.join(STATE_DIR, 'rotation-audit.log');

// Actuation mode (--act flag)
const ACT_MODE = process.argv.includes('--act');
const ACTUATION_COOLDOWN_MS = 300_000;       // 5 min between actuation rotations
const DESYNC_CONSECUTIVE_THRESHOLD = 3;      // 3 polls (90s) before auto-fix

// ============================================================================
// Monitor State
// ============================================================================

const monitorState = {
  pollCount: 0,
  startedAt: Date.now(),
  lastDeepCheck: 0,
  previousUsageSnapshots: new Map(), // keyId -> { five_hour, seven_day, seven_day_sonnet, timestamp }
  alertCounts: {
    DESYNC: 0,
    STALE_DATA: 0,
    VELOCITY_WARNING: 0,
    DUPLICATE_ACCOUNT: 0,
    ALL_EXHAUSTED: 0,
    TOKEN_EXPIRED: 0,
    NO_REFRESH_TOKEN: 0,
    ACT_ROTATION: 0,
    ACT_DESYNC_FIX: 0,
  },
  shutdownRequested: false,
  // Actuation state
  lastActuationRotation: 0,           // timestamp of last actuation-triggered rotation
  consecutiveDesyncCount: 0,          // consecutive polls with KC-vs-ACTIVE desync
  lastDesyncKeyId: null,              // keychain key ID during last desync (to detect pattern change)
};

// ============================================================================
// Logging
// ============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    ensureDir(path.dirname(LOG_FILE));
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Non-fatal: log file write failed
  }
}

function logAlert(alertType, details) {
  monitorState.alertCounts[alertType] = (monitorState.alertCounts[alertType] || 0) + 1;
  log(`ALERT [${alertType}] ${details}`);
}

// ============================================================================
// Data Readers
// ============================================================================

/**
 * Read the Keychain token and return key ID + metadata.
 * Returns null if Keychain is unavailable.
 */
function readKeychainState() {
  if (process.platform !== 'darwin') return null;
  try {
    const { username } = os.userInfo();
    const raw = execFileSync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (oauth && oauth.accessToken) {
      return {
        keyId: generateKeyId(oauth.accessToken),
        expiresAt: oauth.expiresAt || null,
        subscriptionType: oauth.subscriptionType || null,
        rateLimitTier: oauth.rateLimitTier || null,
        hasRefreshToken: !!oauth.refreshToken,
      };
    }
  } catch {
    // Keychain locked or no entry
  }
  return null;
}

/**
 * Read the credentials file and return key ID + metadata.
 * Returns null if file is missing or unreadable.
 */
function readCredentialsFile() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const oauth = creds.claudeAiOauth;
    if (oauth && oauth.accessToken) {
      return {
        keyId: generateKeyId(oauth.accessToken),
        expiresAt: oauth.expiresAt || null,
        subscriptionType: oauth.subscriptionType || null,
        rateLimitTier: oauth.rateLimitTier || null,
        hasRefreshToken: !!oauth.refreshToken,
      };
    }
  } catch {
    // File unreadable
  }
  return null;
}

/**
 * Read the quota-monitor throttle state.
 * Returns { lastCheck, lastRotation } or null.
 */
function readThrottleState() {
  try {
    if (!fs.existsSync(THROTTLE_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(THROTTLE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Count running claude processes.
 * Returns the count of matching processes.
 */
function countClaudeProcesses() {
  try {
    const output = execFileSync('pgrep', ['-f', 'claude --'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (!output) return 0;
    return output.split('\n').filter(line => line.trim()).length;
  } catch {
    // pgrep returns exit code 1 when no processes match
    return 0;
  }
}

// ============================================================================
// Format Helpers
// ============================================================================

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '?';
  const negative = ms < 0;
  const absMs = Math.abs(ms);
  const totalSec = Math.round(absMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${negative ? '-' : ''}${hours}h${String(remainMins).padStart(2, '0')}m`;
  }
  return `${negative ? '-' : ''}${mins}m${String(secs).padStart(2, '0')}s`;
}

function shortId(id) {
  if (!id || typeof id !== 'string') return 'NONE    ';
  return id.slice(0, 8);
}

// ============================================================================
// Diagnostic Alerts
// ============================================================================

/**
 * Run all diagnostic checks against current state.
 */
function runDiagnostics(keychainState, fileState, rotationState) {
  const now = Date.now();

  // DESYNC: Keychain key ID differs from active key ID in rotation state
  if (keychainState && rotationState && rotationState.active_key_id) {
    const kcShort = keychainState.keyId;
    const activeId = rotationState.active_key_id;
    // generateKeyId returns 16 chars; rotation state stores 16 chars
    if (kcShort !== activeId) {
      logAlert('DESYNC', `KC=${shortId(kcShort)} != ACTIVE=${shortId(activeId)} -- Keychain out of sync with rotation state`);

      // Track consecutive desyncs for actuation
      if (monitorState.lastDesyncKeyId === kcShort) {
        monitorState.consecutiveDesyncCount++;
      } else {
        monitorState.consecutiveDesyncCount = 1;
        monitorState.lastDesyncKeyId = kcShort;
      }

      // ACT: Auto-fix DESYNC after 3 consecutive polls (~90s)
      if (ACT_MODE && monitorState.consecutiveDesyncCount >= DESYNC_CONSECUTIVE_THRESHOLD) {
        const activeKeyData = rotationState.keys[activeId];
        if (activeKeyData) {
          log(`ACT [DESYNC_FIX] Writing active key ${shortId(activeId)} to Keychain after ${monitorState.consecutiveDesyncCount} consecutive desyncs`);
          updateActiveCredentials(activeKeyData);
          monitorState.consecutiveDesyncCount = 0;
          monitorState.lastDesyncKeyId = null;
          monitorState.alertCounts.ACT_DESYNC_FIX++;
        }
      }
    } else {
      // No desync — reset counter
      monitorState.consecutiveDesyncCount = 0;
      monitorState.lastDesyncKeyId = null;
    }
  }

  // DESYNC: Credentials file key ID differs from Keychain
  if (keychainState && fileState && keychainState.keyId !== fileState.keyId) {
    logAlert('DESYNC', `KC=${shortId(keychainState.keyId)} != FILE=${shortId(fileState.keyId)} -- credentials file out of sync with Keychain`);
  }

  if (!rotationState || !rotationState.keys) return;

  const keys = rotationState.keys;
  const keyEntries = Object.entries(keys);

  // STALE_DATA: Health check data older than threshold
  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid') continue;
    if (keyData.last_health_check) {
      const age = now - keyData.last_health_check;
      if (age > STALE_HEALTH_CHECK_MS) {
        logAlert('STALE_DATA', `Key ${shortId(keyId)} health check is ${fmtDuration(age)} old`);
      }
    }
  }

  // VELOCITY_WARNING: Usage jumped significantly since last poll
  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid' || !keyData.last_usage) continue;
    const prev = monitorState.previousUsageSnapshots.get(keyId);
    if (prev) {
      for (const bucket of ['five_hour', 'seven_day', 'seven_day_sonnet']) {
        const currentVal = keyData.last_usage[bucket] || 0;
        const prevVal = prev[bucket] || 0;
        const delta = currentVal - prevVal;
        if (delta >= VELOCITY_WARNING_PCT) {
          logAlert('VELOCITY_WARNING', `Key ${shortId(keyId)} ${bucket} jumped ${prevVal.toFixed(1)}% -> ${currentVal.toFixed(1)}% (+${delta.toFixed(1)}%)`);
        }
      }
    }
    // Store current snapshot for next cycle
    monitorState.previousUsageSnapshots.set(keyId, {
      five_hour: keyData.last_usage.five_hour || 0,
      seven_day: keyData.last_usage.seven_day || 0,
      seven_day_sonnet: keyData.last_usage.seven_day_sonnet || 0,
      timestamp: now,
    });
  }

  // DUPLICATE_ACCOUNT: Multiple keys with same account_email
  const emailMap = new Map();
  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid') continue;
    const email = keyData.account_email;
    if (email) {
      if (!emailMap.has(email)) {
        emailMap.set(email, []);
      }
      emailMap.get(email).push(keyId);
    }
  }
  for (const [email, keyIds] of emailMap) {
    if (keyIds.length > 1) {
      const ids = keyIds.map(id => shortId(id)).join(', ');
      logAlert('DUPLICATE_ACCOUNT', `Account ${email} has ${keyIds.length} keys: [${ids}]`);
    }
  }

  // ALL_EXHAUSTED: Every key is exhausted or invalid
  const activeKeys = keyEntries.filter(([, k]) => k.status === 'active');
  if (activeKeys.length === 0 && keyEntries.length > 0) {
    const exhaustedCount = keyEntries.filter(([, k]) => k.status === 'exhausted').length;
    const invalidCount = keyEntries.filter(([, k]) => k.status === 'invalid').length;
    const expiredCount = keyEntries.filter(([, k]) => k.status === 'expired').length;
    logAlert('ALL_EXHAUSTED', `No active keys! exhausted=${exhaustedCount} invalid=${invalidCount} expired=${expiredCount}`);
  }

  // TOKEN_EXPIRED: Active key's token has expired
  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid') continue;
    if (keyData.expiresAt && keyData.expiresAt < now) {
      logAlert('TOKEN_EXPIRED', `Key ${shortId(keyId)} expired ${fmtDuration(now - keyData.expiresAt)} ago`);
    }
  }

  // NO_REFRESH_TOKEN: Key has no refresh token (cannot auto-refresh)
  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid') continue;
    if (!keyData.refreshToken) {
      logAlert('NO_REFRESH_TOKEN', `Key ${shortId(keyId)} has no refresh token -- cannot auto-refresh on expiry`);
    }
  }
}

// ============================================================================
// Poll: Regular (30s)
// ============================================================================

function poll() {
  monitorState.pollCount++;
  const now = Date.now();

  // Read all data sources
  const keychainState = readKeychainState();
  const fileState = readCredentialsFile();
  const rotationState = readRotationState();
  const throttleState = readThrottleState();
  const processCount = countClaudeProcesses();

  // Build compact status line
  const kcId = keychainState ? shortId(keychainState.keyId) : 'NONE    ';
  const fileId = fileState ? shortId(fileState.keyId) : 'NONE    ';
  const activeId = rotationState?.active_key_id ? shortId(rotationState.active_key_id) : 'NONE    ';

  // Account usage from active key
  let usageStr = 'no data';
  if (rotationState?.active_key_id && rotationState.keys[rotationState.active_key_id]) {
    const activeKey = rotationState.keys[rotationState.active_key_id];
    if (activeKey.last_usage) {
      const u = activeKey.last_usage;
      usageStr = `5h:${(u.five_hour || 0).toFixed(1)}% 7d:${(u.seven_day || 0).toFixed(1)}% son:${(u.seven_day_sonnet || 0).toFixed(1)}%`;
    }
  }

  // Velocity: compute max delta since last poll
  let velocityStr = 'n/a';
  if (rotationState?.active_key_id) {
    const prev = monitorState.previousUsageSnapshots.get(rotationState.active_key_id);
    const activeKey = rotationState.keys[rotationState.active_key_id];
    if (prev && activeKey?.last_usage) {
      const deltas = [
        (activeKey.last_usage.five_hour || 0) - (prev.five_hour || 0),
        (activeKey.last_usage.seven_day || 0) - (prev.seven_day || 0),
        (activeKey.last_usage.seven_day_sonnet || 0) - (prev.seven_day_sonnet || 0),
      ];
      const maxDelta = Math.max(...deltas);
      velocityStr = maxDelta > 0 ? `+${maxDelta.toFixed(1)}%` : `${maxDelta.toFixed(1)}%`;
    }
  }

  // Key counts
  let keyCountStr = '0/0/0';
  if (rotationState?.keys) {
    const keys = Object.values(rotationState.keys);
    const active = keys.filter(k => k.status === 'active').length;
    const exhausted = keys.filter(k => k.status === 'exhausted').length;
    const invalid = keys.filter(k => k.status === 'invalid').length;
    keyCountStr = `${active}ok/${exhausted}exh/${invalid}inv`;
  }

  // Throttle info
  let throttleStr = '';
  if (throttleState) {
    const lastCheckAge = throttleState.lastCheck ? fmtDuration(now - throttleState.lastCheck) : '?';
    throttleStr = ` qm_last=${lastCheckAge}`;
  }

  // Selected key from selectActiveKey
  let selectedStr = '';
  if (rotationState) {
    const selected = selectActiveKey(rotationState);
    if (selected && selected !== rotationState.active_key_id) {
      selectedStr = ` SUGGEST=${shortId(selected)}`;
    }
  }

  log(`KC=${kcId} FILE=${fileId} ACTIVE=${activeId} | ${usageStr} | vel=${velocityStr} | keys=${keyCountStr} procs=${processCount}${throttleStr}${selectedStr}`);

  // Run diagnostics
  runDiagnostics(keychainState, fileState, rotationState);
}

// ============================================================================
// Deep Check (every 5 minutes)
// ============================================================================

async function deepCheck() {
  log('--- DEEP CHECK START ---');
  const rotationState = readRotationState();
  if (!rotationState || !rotationState.keys) {
    log('--- DEEP CHECK END (no rotation state) ---');
    return;
  }

  const now = Date.now();
  let stateModified = false;

  // Collect unique accounts (by account_email or key ID) to avoid redundant API calls
  // Track which account_email maps to which keyIds for usage propagation
  const checked = new Set();
  const emailToKeyIds = new Map(); // account_email -> [keyId, ...]
  const keyEntries = Object.entries(rotationState.keys);

  for (const [keyId, keyData] of keyEntries) {
    if (keyData.status === 'invalid') {
      log(`  [${shortId(keyId)}] SKIP (invalid)`);
      continue;
    }

    // Deduplicate by account_email if available
    const dedupeKey = keyData.account_email || keyId;
    if (checked.has(dedupeKey)) {
      log(`  [${shortId(keyId)}] SKIP (duplicate account: ${keyData.account_email || 'unknown'})`);
      // Track for usage propagation
      if (keyData.account_email) {
        if (!emailToKeyIds.has(keyData.account_email)) emailToKeyIds.set(keyData.account_email, []);
        emailToKeyIds.get(keyData.account_email).push(keyId);
      }
      continue;
    }
    checked.add(dedupeKey);

    // Track for usage propagation
    if (keyData.account_email) {
      if (!emailToKeyIds.has(keyData.account_email)) emailToKeyIds.set(keyData.account_email, []);
      emailToKeyIds.get(keyData.account_email).push(keyId);
    }

    // Call checkKeyHealth for this key
    const health = await checkKeyHealth(keyData.accessToken);
    if (!health.valid) {
      log(`  [${shortId(keyId)}] API ERROR: ${health.error}`);
      continue;
    }

    // Compare API usage vs stored usage
    const apiUsage = health.usage;
    const storedUsage = keyData.last_usage;

    let driftStr = 'no stored data';
    if (storedUsage) {
      const drifts = [];
      for (const bucket of ['five_hour', 'seven_day', 'seven_day_sonnet']) {
        const apiVal = apiUsage[bucket] || 0;
        const storedVal = storedUsage[bucket] || 0;
        const drift = apiVal - storedVal;
        if (Math.abs(drift) >= 0.5) {
          drifts.push(`${bucket}:${drift > 0 ? '+' : ''}${drift.toFixed(1)}%`);
        }
      }
      driftStr = drifts.length > 0 ? drifts.join(' ') : 'aligned';
    }

    const email = keyData.account_email || 'unknown';
    log(`  [${shortId(keyId)}] ${email} | API: 5h:${(apiUsage.five_hour || 0).toFixed(1)}% 7d:${(apiUsage.seven_day || 0).toFixed(1)}% son:${(apiUsage.seven_day_sonnet || 0).toFixed(1)}% | drift: ${driftStr}`);

    // ALWAYS: Write fresh health data back to rotation state.
    // This keeps stored data fresh even when hooks aren't running, so hooks in
    // OTHER projects benefit from up-to-date usage information.
    keyData.last_usage = apiUsage;
    keyData.last_health_check = now;
    stateModified = true;

    // Propagate to all keys sharing the same account_email
    if (keyData.account_email && emailToKeyIds.has(keyData.account_email)) {
      for (const siblingId of emailToKeyIds.get(keyData.account_email)) {
        if (siblingId !== keyId && rotationState.keys[siblingId]) {
          rotationState.keys[siblingId].last_usage = apiUsage;
          rotationState.keys[siblingId].last_health_check = now;
        }
      }
    }
  }

  // ACT: Deep-check-triggered rotation
  if (ACT_MODE && (now - monitorState.lastActuationRotation) >= ACTUATION_COOLDOWN_MS) {
    const activeId = rotationState.active_key_id;
    const activeKeyData = activeId && rotationState.keys[activeId];

    if (activeKeyData?.last_usage) {
      const maxUsage = Math.max(
        activeKeyData.last_usage.five_hour || 0,
        activeKeyData.last_usage.seven_day || 0,
        activeKeyData.last_usage.seven_day_sonnet || 0
      );

      if (maxUsage >= HIGH_USAGE_THRESHOLD) {
        // Try selectActiveKey first
        let targetId = selectActiveKey(rotationState);

        // If selectActiveKey returns same key (stale data), directly find lowest-usage alt on different account
        if (targetId === activeId || !targetId) {
          const activeUuid = activeKeyData.account_uuid;
          const alternatives = Object.entries(rotationState.keys)
            .filter(([id, k]) =>
              id !== activeId &&
              k.status === 'active' &&
              k.last_usage &&
              k.account_uuid !== activeUuid
            )
            .sort((a, b) => {
              const aMax = Math.max(a[1].last_usage.five_hour || 0, a[1].last_usage.seven_day || 0, a[1].last_usage.seven_day_sonnet || 0);
              const bMax = Math.max(b[1].last_usage.five_hour || 0, b[1].last_usage.seven_day || 0, b[1].last_usage.seven_day_sonnet || 0);
              return aMax - bMax;
            });

          if (alternatives.length > 0) {
            const altMax = Math.max(
              alternatives[0][1].last_usage.five_hour || 0,
              alternatives[0][1].last_usage.seven_day || 0,
              alternatives[0][1].last_usage.seven_day_sonnet || 0
            );
            if (altMax < maxUsage) {
              targetId = alternatives[0][0];
            }
          }
        }

        if (targetId && targetId !== activeId) {
          const targetKeyData = rotationState.keys[targetId];
          const prevId = activeId;
          rotationState.active_key_id = targetId;
          targetKeyData.last_used_at = now;
          updateActiveCredentials(targetKeyData);

          logRotationEvent(rotationState, {
            timestamp: now,
            event: 'key_switched',
            key_id: targetId,
            reason: 'monitor_actuation_high_usage',
            previous_key: prevId,
            usage_snapshot: activeKeyData.last_usage,
          });

          monitorState.lastActuationRotation = now;
          monitorState.alertCounts.ACT_ROTATION++;
          stateModified = true;
          log(`ACT [ROTATION] ${shortId(prevId)} (${maxUsage.toFixed(1)}%) -> ${shortId(targetId)} | reason=high_usage`);
        }
      }
    }
  }

  // Write updated state if anything changed
  if (stateModified) {
    writeRotationState(rotationState);
    log('  [STATE] Wrote fresh health data to rotation state');
  }

  log('--- DEEP CHECK END ---');
}

// ============================================================================
// Audit Report (--audit)
// ============================================================================

async function runAuditReport() {
  console.log('=== Rotation Health Audit Report ===\n');

  // 1. Rotation audit log (last 20 entries)
  console.log('--- Recent Rotations ---');
  try {
    if (fs.existsSync(ROTATION_AUDIT_LOG_PATH)) {
      const lines = fs.readFileSync(ROTATION_AUDIT_LOG_PATH, 'utf8').trim().split('\n');
      const recent = lines.slice(-20);
      let rotationCount = 0;
      let auditCount = 0;
      let passCount = 0;
      let matchCount = 0;
      for (const line of recent) {
        console.log(`  ${line}`);
        if (line.includes('] ROTATION ')) rotationCount++;
        if (line.includes('] AUDIT ')) {
          auditCount++;
          if (line.includes('health=PASS')) passCount++;
          if (line.includes('keychain=MATCH')) matchCount++;
        }
      }
      console.log(`\n  Totals (last ${recent.length} entries): ${rotationCount} rotations, ${auditCount} audits`);
      if (auditCount > 0) {
        console.log(`  Health pass rate: ${Math.round(passCount / auditCount * 100)}% (${passCount}/${auditCount})`);
        console.log(`  Keychain match rate: ${Math.round(matchCount / auditCount * 100)}% (${matchCount}/${auditCount})`);
      }
    } else {
      console.log('  (no rotation-audit.log found)');
    }
  } catch {
    console.log('  (error reading rotation-audit.log)');
  }

  // 2. Pending audit from throttle state
  console.log('\n--- Pending Audit ---');
  try {
    if (fs.existsSync(THROTTLE_STATE_PATH)) {
      const throttle = JSON.parse(fs.readFileSync(THROTTLE_STATE_PATH, 'utf8'));
      if (throttle.pendingAudit) {
        const pa = throttle.pendingAudit;
        if (pa.verifiedAt) {
          console.log(`  Last audit verified at: ${new Date(pa.verifiedAt).toISOString()}`);
          console.log(`  Keychain: ${pa.keychainMatch ? 'MATCH' : 'MISMATCH'} | Health: ${pa.healthCheckPassed ? 'PASS' : 'FAIL'}`);
        } else {
          const age = fmtDuration(Date.now() - pa.rotatedAt);
          console.log(`  UNVERIFIED rotation pending (${age} old)`);
          console.log(`  From: ${shortId(pa.fromKeyId)} -> To: ${shortId(pa.toKeyId)}`);
        }
      } else {
        console.log('  (no pending audit)');
      }
    } else {
      console.log('  (no quota-monitor-state.json)');
    }
  } catch {
    console.log('  (error reading throttle state)');
  }

  // 3. Current rotation state
  console.log('\n--- Current State ---');
  const rotationState = readRotationState();
  if (rotationState && rotationState.keys) {
    const activeId = rotationState.active_key_id;
    console.log(`  Active key: ${shortId(activeId)}`);

    for (const [keyId, keyData] of Object.entries(rotationState.keys)) {
      const isActive = keyId === activeId ? ' (ACTIVE)' : '';
      const status = keyData.status || 'unknown';
      const expiresIn = keyData.expiresAt ? fmtDuration(keyData.expiresAt - Date.now()) : 'unknown';
      const lastCheck = keyData.last_health_check ? fmtDuration(Date.now() - keyData.last_health_check) + ' ago' : 'never';
      let usageStr = 'no data';
      if (keyData.last_usage) {
        const u = keyData.last_usage;
        usageStr = `5h:${(u.five_hour || 0).toFixed(1)}% 7d:${(u.seven_day || 0).toFixed(1)}% son:${(u.seven_day_sonnet || 0).toFixed(1)}%`;
      }
      console.log(`  [${shortId(keyId)}]${isActive} status=${status} expires=${expiresIn} checked=${lastCheck} usage=${usageStr}`);
    }
  } else {
    console.log('  (no rotation state)');
  }

  // 4. Keychain state
  console.log('\n--- Keychain ---');
  const keychainCreds = readKeychainCredentials();
  if (keychainCreds?.claudeAiOauth?.accessToken) {
    const kcKeyId = generateKeyId(keychainCreds.claudeAiOauth.accessToken);
    const kcMatch = rotationState?.active_key_id === kcKeyId;
    const expiresIn = keychainCreds.claudeAiOauth.expiresAt
      ? fmtDuration(keychainCreds.claudeAiOauth.expiresAt - Date.now())
      : 'unknown';
    console.log(`  Key: ${shortId(kcKeyId)} | Active match: ${kcMatch ? 'YES' : 'NO (DESYNC)'} | Expires in: ${expiresIn}`);
  } else {
    console.log('  (no Keychain credentials found)');
  }

  // 5. Alerts
  console.log('\n--- Alerts ---');
  let alertCount = 0;

  // Check for unverified audit
  try {
    if (fs.existsSync(THROTTLE_STATE_PATH)) {
      const throttle = JSON.parse(fs.readFileSync(THROTTLE_STATE_PATH, 'utf8'));
      if (throttle.pendingAudit && !throttle.pendingAudit.verifiedAt) {
        const age = Date.now() - throttle.pendingAudit.rotatedAt;
        if (age > 10 * 60 * 1000) {
          console.log(`  WARN: Unverified rotation is ${fmtDuration(age)} old (expected verification within 10 min)`);
          alertCount++;
        }
      }
    }
  } catch { /* ignore */ }

  // Check for stale health data
  if (rotationState?.active_key_id) {
    const activeKey = rotationState.keys[rotationState.active_key_id];
    if (activeKey?.last_health_check) {
      const age = Date.now() - activeKey.last_health_check;
      if (age > 15 * 60 * 1000) {
        console.log(`  WARN: Active key health data is ${fmtDuration(age)} old (stale after 15m)`);
        alertCount++;
      }
    }
  }

  // Check for Keychain desync
  if (keychainCreds?.claudeAiOauth?.accessToken && rotationState?.active_key_id) {
    const kcKeyId = generateKeyId(keychainCreds.claudeAiOauth.accessToken);
    if (kcKeyId !== rotationState.active_key_id) {
      console.log(`  CRIT: Keychain key (${shortId(kcKeyId)}) does not match active key (${shortId(rotationState.active_key_id)})`);
      alertCount++;
    }
  }

  if (alertCount === 0) {
    console.log('  (none)');
  }

  console.log('');
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  // Dispatch --audit mode
  if (AUDIT_MODE) {
    await runAuditReport();
    return;
  }

  ensureDir(STATE_DIR);

  log('');
  log('=== Token Swap Monitor ===');
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s | Deep check: ${DEEP_CHECK_INTERVAL_MS / 1000}s`);
  log(`Log: ${LOG_FILE}`);
  log(`Project: ${PROJECT_DIR}`);
  log(`Expiry buffer: ${EXPIRY_BUFFER_MS / 1000}s`);
  log(`Actuation mode: ${ACT_MODE ? 'ENABLED (--act)' : 'disabled (observation only)'}`);
  log('');

  // Initial poll
  poll();

  // Initial deep check
  monitorState.lastDeepCheck = Date.now();
  await deepCheck();

  // SIGINT handler
  process.on('SIGINT', () => {
    if (monitorState.shutdownRequested) {
      process.exit(1);
    }
    monitorState.shutdownRequested = true;

    log('');
    log('=== Token Swap Monitor Shutting Down ===');
    const uptime = fmtDuration(Date.now() - monitorState.startedAt);
    log(`Uptime: ${uptime} | Polls: ${monitorState.pollCount}`);
    log('Alert totals:');
    for (const [alertType, count] of Object.entries(monitorState.alertCounts)) {
      if (count > 0) {
        log(`  ${alertType}: ${count}`);
      }
    }
    const totalAlerts = Object.values(monitorState.alertCounts).reduce((sum, c) => sum + c, 0);
    if (totalAlerts === 0) {
      log('  (none)');
    }
    log('');
    process.exit(0);
  });

  // Main polling loop
  const timer = setInterval(async () => {
    if (monitorState.shutdownRequested) {
      clearInterval(timer);
      return;
    }

    poll();

    // Deep check every 5 minutes
    const now = Date.now();
    if (now - monitorState.lastDeepCheck >= DEEP_CHECK_INTERVAL_MS) {
      monitorState.lastDeepCheck = now;
      await deepCheck();
    }
  }, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
