#!/usr/bin/env node
/**
 * Rotation Stress-Test Monitor
 *
 * Comprehensive monitoring for multi-account credential rotation under heavy
 * workload. Polls 8 data sources at 3 cadences, detects 6 failure conditions,
 * captures forensic snapshots, and outputs status lines + summary tables.
 *
 * Data sources:
 *   Keychain, rotation state, rotation log, stop-hook debug log,
 *   hourly automation log, agent tracker, quota-interrupted sessions,
 *   paused sessions
 *
 * Run:  node scripts/rotation-stress-monitor.mjs
 * Stop: Ctrl+C (prints final summary)
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ============================================================================
// Constants & Paths
// ============================================================================

const HOME = os.homedir();
const TARGET_DIR = path.join(HOME, 'git/target-project');
const TARGET_CLAUDE_DIR = path.join(TARGET_DIR, '.claude');
const TARGET_STATE_DIR = path.join(TARGET_CLAUDE_DIR, 'state');

const ROTATION_STATE_PATH = path.join(HOME, '.claude', 'api-key-rotation.json');
const ROTATION_LOG_PATH = path.join(TARGET_CLAUDE_DIR, 'api-key-rotation.log');
const STOP_HOOK_DEBUG_PATH = path.join(TARGET_CLAUDE_DIR, 'hooks', 'stop-hook-debug.log');
const HOURLY_AUTOMATION_LOG_PATH = path.join(TARGET_CLAUDE_DIR, 'hourly-automation.log');
const AGENT_TRACKER_PATH = path.join(TARGET_STATE_DIR, 'agent-tracker-history.json');
const QUOTA_INTERRUPTED_PATH = path.join(TARGET_STATE_DIR, 'quota-interrupted-sessions.json');
const PAUSED_SESSIONS_PATH = path.join(TARGET_STATE_DIR, 'paused-sessions.json');
const LOG_FILE = path.join(TARGET_STATE_DIR, 'rotation-stress-monitor.log');
const FORENSICS_DIR = path.join(HOME, '.claude', 'state', 'rotation-forensics');

const EXPIRY_BUFFER_MS = 600_000; // 10 min — matches key-sync.js
const MAX_CONCURRENT_AGENTS = 5;

// Poll cadences
const FAST_INTERVAL_MS = 30_000;   // 30s: keychain, state, processes, logs
const MEDIUM_INTERVAL_MS = 60_000; // 60s: agent tracker, sessions
const SUMMARY_INTERVAL_MS = 300_000; // 5 min: detailed table

// Failure detection thresholds
const KC_MISMATCH_THRESHOLD_MS = 300_000; // 5 min
const INSTANT_CRASH_THRESHOLD_MS = 60_000; // 1 min
const ROTATION_LOOP_WINDOW_MS = 600_000;   // 10 min
const ROTATION_LOOP_MIN_SWITCHES = 2;
const FORENSIC_COOLDOWN_MS = 300_000; // 5 min

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

// ============================================================================
// Monitor State (in-memory between polls)
// ============================================================================

const state = {
  // Keychain tracking
  kc: { lastId: null, mismatchSince: null },
  // Rotation tracking
  rotation: { lastActiveKeyId: null, rotationLogLineCount: 0 },
  // Log tailing by byte offset
  logOffsets: {
    stopHookDebug: 0,
    hourlyAutomation: 0,
    rotationLog: 0,
  },
  // Session tracking
  sessions: {
    lastAgentSnapshot: null,
    birthTimes: new Map(), // pid -> spawnTime
  },
  // Failure tracking
  failures: {
    recentSwitches: [], // [{from, to, timestamp}]
    lastForensicAt: 0,
  },
  // Rolling stats (1-hour ring buffers)
  stats: {
    events: [],   // [{type, timestamp}]
    spawned: [],  // [{pid, timestamp}]
    died: [],     // [{pid, timestamp}]
    rotations: { switches: [], exhaustions: [], refreshes: [], invalidGrants: [] },
  },
  // Poll counters
  pollCount: 0,
  startedAt: Date.now(),
};

// ============================================================================
// Utilities
// ============================================================================

function generateKeyId(accessToken) {
  const clean = accessToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
  return crypto.createHash('sha256').update(clean).digest('hex').substring(0, 16);
}

function fmtDuration(ms) {
  if (ms < 0) return '-' + fmtDuration(-ms);
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  return `${mins}m`;
}

function fmtTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(11, 19);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function trimOldEntries(arr, windowMs = 3600_000) {
  const cutoff = Date.now() - windowMs;
  while (arr.length > 0 && arr[0].timestamp < cutoff) arr.shift();
}

function redactToken(token) {
  if (!token || typeof token !== 'string') return null;
  return token.substring(0, 20) + '...[REDACTED]';
}

// ============================================================================
// Logging
// ============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function log(msg, { color, toFile = true } = {}) {
  const ts = fmtTimestamp(Date.now());
  const plainMsg = stripAnsi(msg);
  const plain = `[${ts}] ${plainMsg}`;
  if (color) {
    console.log(`${C.dim}[${ts}]${C.reset} ${color}${msg}${C.reset}`);
  } else {
    console.log(`[${ts}] ${msg}`);
  }
  if (toFile) {
    try {
      ensureDir(path.dirname(LOG_FILE));
      fs.appendFileSync(LOG_FILE, plain + '\n');
    } catch { /* non-fatal */ }
  }
}

function logAlert(severity, fc, details) {
  const color = severity === 'CRITICAL' ? C.bgRed + C.white : C.bgYellow + C.white;
  const prefix = severity === 'CRITICAL' ? '!!! CRITICAL' : '!! WARNING';
  log(`${prefix} [${fc}] ${details}`, { color });
}

// ============================================================================
// Data Readers
// ============================================================================

function getKeychainToken() {
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
        expiresAt: oauth.expiresAt,
        tier: oauth.rateLimitTier || oauth.subscriptionType || '?',
        raw: oauth,
      };
    }
  } catch { /* keychain not available */ }
  return null;
}

function readRotationState() {
  return readJsonSafe(ROTATION_STATE_PATH);
}

function readAgentTracker() {
  return readJsonSafe(AGENT_TRACKER_PATH);
}

function getTargetProcesses() {
  try {
    const output = execSync(
      "ps aux | grep '[c]laude' | grep 'target-project'",
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    if (!output) return [];
    return output.split('\n').map(line => {
      const parts = line.split(/\s+/);
      return { pid: parseInt(parts[1], 10), cmd: parts.slice(10).join(' ') };
    }).filter(p => p.pid > 0);
  } catch { return []; }
}

/**
 * Tail new bytes from a file since last read.
 * Returns new text and updates the offset in state.logOffsets.
 */
function tailNewBytes(filePath, offsetKey) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    const lastOffset = state.logOffsets[offsetKey];

    if (currentSize <= lastOffset) {
      // File may have been truncated/rotated
      if (currentSize < lastOffset) state.logOffsets[offsetKey] = 0;
      return '';
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const readSize = Math.min(currentSize - lastOffset, 32768); // max 32KB per read
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, lastOffset);
      state.logOffsets[offsetKey] = lastOffset + readSize;
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch { return ''; }
}

// ============================================================================
// Panels: Account Summary, Session Deltas, Exhaustion Estimate
// ============================================================================

function buildAccountSummary(rotState) {
  if (!rotState || !rotState.keys) return {};
  const now = Date.now();
  const byEmail = {};

  for (const [id, k] of Object.entries(rotState.keys)) {
    const email = k.account_email || 'unknown';
    if (!byEmail[email]) byEmail[email] = { keys: [], totalKeys: 0, validKeys: 0, maxUsage: 0, nearestExpiry: Infinity };
    byEmail[email].totalKeys++;
    if (k.status === 'invalid') {
      byEmail[email].keys.push({ id, status: k.status, tier: k.rateLimitTier, expiresIn: null, usage: null });
      continue; // skip for stats
    }
    byEmail[email].validKeys++;

    const expiresIn = k.expiresAt ? k.expiresAt - now : null;
    if (expiresIn !== null && expiresIn < byEmail[email].nearestExpiry) {
      byEmail[email].nearestExpiry = expiresIn;
    }

    const usage = k.last_usage;
    if (usage) {
      const max = Math.max(usage.five_hour || 0, usage.seven_day || 0, usage.seven_day_sonnet || 0);
      if (max > byEmail[email].maxUsage) byEmail[email].maxUsage = max;
    }

    byEmail[email].keys.push({
      id,
      status: k.status,
      tier: k.rateLimitTier || '?',
      expiresIn,
      usage,
      isActive: id === rotState.active_key_id,
    });
  }

  return byEmail;
}

function computeSessionDeltas(currentAgents, previousAgents) {
  if (!previousAgents) return { spawned: [], died: [] };
  const prevIds = new Set(previousAgents.map(a => a.id));
  const currIds = new Set(currentAgents.map(a => a.id));

  const spawned = currentAgents.filter(a => !prevIds.has(a.id));
  const died = previousAgents.filter(a => !currIds.has(a.id));
  return { spawned, died };
}

function estimateExhaustionTime(rotState) {
  if (!rotState || !rotState.active_key_id) return null;
  const ak = rotState.keys[rotState.active_key_id];
  if (!ak || !ak.last_usage) return null;

  // Use recent rotation log entries to estimate usage rate
  const recentEvents = state.stats.rotations.exhaustions;
  if (recentEvents.length >= 2) {
    const span = recentEvents[recentEvents.length - 1].timestamp - recentEvents[0].timestamp;
    if (span > 0) {
      const exhaustionsPerHour = (recentEvents.length / span) * 3600_000;
      // Rough: remaining keys / exhaustion rate
      const activeKeys = Object.values(rotState.keys).filter(k => k.status === 'active').length;
      if (exhaustionsPerHour > 0) return activeKeys / exhaustionsPerHour;
    }
  }

  // Fallback: use max usage percentage to extrapolate
  const maxUsage = Math.max(ak.last_usage.five_hour || 0, ak.last_usage.seven_day || 0, ak.last_usage.seven_day_sonnet || 0);
  if (maxUsage > 0 && maxUsage < 100) {
    // Very rough: linear extrapolation from current usage level
    const remainingPct = 100 - maxUsage;
    // Assume the last health check interval saw `maxUsage`% consumed over 5 hours (typical)
    const hoursRemaining = (remainingPct / maxUsage) * 5;
    return hoursRemaining;
  }

  return null;
}

// ============================================================================
// Failure Detection
// ============================================================================

function detectFailureConditions(kc, rotState, processes) {
  const now = Date.now();
  const failures = [];

  if (!rotState) return failures;

  // FC1: Rotation stuck — active key expired but Keychain not swapped
  if (rotState.active_key_id) {
    const ak = rotState.keys[rotState.active_key_id];
    if (ak && ak.expiresAt && ak.expiresAt < now) {
      if (kc && kc.keyId === rotState.active_key_id.slice(0, 16)) {
        failures.push({
          name: 'FC1',
          severity: 'CRITICAL',
          details: `Active key ${rotState.active_key_id.slice(0, 8)} expired ${fmtDuration(now - ak.expiresAt)} ago, still in Keychain`,
        });
      }
    }
  }

  // FC2: Reviver gap — dead agent with quota error not in quota-interrupted-sessions
  // Checked during medium poll when agent deltas are computed
  // (handled inline in pollMedium)

  // FC3: All dead — every key exhausted/invalid with no future reset
  const activeKeys = Object.values(rotState.keys).filter(k => k.status === 'active');
  if (activeKeys.length === 0) {
    const hasReset = Object.values(rotState.keys).some(k => {
      if (!k.last_usage?.resets_at) return false;
      return Object.values(k.last_usage.resets_at).some(r => r && new Date(r).getTime() > now);
    });
    if (!hasReset) {
      failures.push({
        name: 'FC3',
        severity: 'CRITICAL',
        details: `All keys exhausted/invalid with no known reset time`,
      });
    }
  }

  // FC4: Instant crash — agent PID dead within 1 min of spawn
  for (const [pid, spawnTime] of state.sessions.birthTimes.entries()) {
    if (now - spawnTime < INSTANT_CRASH_THRESHOLD_MS) continue; // too early to tell
    if (now - spawnTime < INSTANT_CRASH_THRESHOLD_MS * 2) {
      // Within 2 min of spawn — check if still alive
      const alive = processes.some(p => p.pid === pid);
      if (!alive) {
        failures.push({
          name: 'FC4',
          severity: 'HIGH',
          details: `Agent PID ${pid} died ${fmtDuration(now - spawnTime)} after spawn`,
        });
        state.sessions.birthTimes.delete(pid);
      }
    }
  }

  // FC5: Keychain mismatch — KC != active_key_id for >5 min
  if (kc && rotState.active_key_id) {
    const kcMatchesActive = kc.keyId === rotState.active_key_id.slice(0, 16) ||
                            kc.keyId === rotState.active_key_id;
    if (!kcMatchesActive) {
      if (!state.kc.mismatchSince) {
        state.kc.mismatchSince = now;
      } else if (now - state.kc.mismatchSince > KC_MISMATCH_THRESHOLD_MS) {
        failures.push({
          name: 'FC5',
          severity: 'HIGH',
          details: `KC=${kc.keyId.slice(0, 8)} != active=${rotState.active_key_id.slice(0, 8)} for ${fmtDuration(now - state.kc.mismatchSince)}`,
        });
      }
    } else {
      state.kc.mismatchSince = null;
    }
  }

  // FC6: Rotation loop — same key pair switching 2+ times in 10 min
  const recentSwitches = state.failures.recentSwitches.filter(s => now - s.timestamp < ROTATION_LOOP_WINDOW_MS);
  state.failures.recentSwitches = recentSwitches;
  if (recentSwitches.length >= ROTATION_LOOP_MIN_SWITCHES) {
    // Check if the same pair keeps repeating
    const pairs = {};
    for (const sw of recentSwitches) {
      const pair = [sw.from, sw.to].sort().join('<->');
      pairs[pair] = (pairs[pair] || 0) + 1;
    }
    for (const [pair, count] of Object.entries(pairs)) {
      if (count >= ROTATION_LOOP_MIN_SWITCHES) {
        failures.push({
          name: 'FC6',
          severity: 'MEDIUM',
          details: `Rotation loop detected: ${pair} switched ${count}x in ${fmtDuration(ROTATION_LOOP_WINDOW_MS)}`,
        });
      }
    }
  }

  return failures;
}

// ============================================================================
// Forensic Snapshot
// ============================================================================

function captureForensicSnapshot(failureConditions) {
  const now = Date.now();
  if (now - state.failures.lastForensicAt < FORENSIC_COOLDOWN_MS) return;
  state.failures.lastForensicAt = now;

  try {
    ensureDir(FORENSICS_DIR);

    const rotState = readRotationState();
    const redactedState = rotState ? JSON.parse(JSON.stringify(rotState)) : null;
    if (redactedState) {
      for (const k of Object.values(redactedState.keys)) {
        if (k.accessToken) k.accessToken = redactToken(k.accessToken);
        if (k.refreshToken) k.refreshToken = redactToken(k.refreshToken);
      }
    }

    // Agent tracker (last 50 agents + 50 hook executions)
    const tracker = readAgentTracker();
    const trackerSlice = tracker ? {
      agents: (tracker.agents || []).slice(-50),
      hookExecutions: (tracker.hookExecutions || []).slice(-50),
      stats: tracker.stats,
    } : null;

    // Rotation log tail (50 lines)
    let rotLogTail = '';
    try {
      const content = fs.readFileSync(ROTATION_LOG_PATH, 'utf8');
      const lines = content.trim().split('\n');
      rotLogTail = lines.slice(-50).join('\n');
    } catch { /* ok */ }

    // Process snapshot
    const processes = getTargetProcesses();

    // Keychain
    const kc = getKeychainToken();
    const kcSnapshot = kc ? { keyId: kc.keyId, expiresAt: kc.expiresAt, tier: kc.tier } : null;

    // Quota-interrupted + paused sessions
    const quotaInterrupted = readJsonSafe(QUOTA_INTERRUPTED_PATH);
    const paused = readJsonSafe(PAUSED_SESSIONS_PATH);

    // Stop-hook tail (5KB)
    let stopHookTail = '';
    try {
      const stat = fs.statSync(STOP_HOOK_DEBUG_PATH);
      const readSize = Math.min(5120, stat.size);
      const fd = fs.openSync(STOP_HOOK_DEBUG_PATH, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      stopHookTail = buf.toString('utf8');
    } catch { /* ok */ }

    const snapshot = {
      capturedAt: new Date(now).toISOString(),
      failureConditions,
      rotationState: redactedState,
      agentTracker: trackerSlice,
      rotationLogTail: rotLogTail,
      processes,
      keychain: kcSnapshot,
      quotaInterruptedSessions: quotaInterrupted,
      pausedSessions: paused,
      stopHookTail,
      monitorStats: {
        uptime: fmtDuration(now - state.startedAt),
        pollCount: state.pollCount,
        eventsLast1h: state.stats.events.length,
        spawnedLast1h: state.stats.spawned.length,
        diedLast1h: state.stats.died.length,
      },
    };

    const filename = new Date(now).toISOString().replace(/[:.]/g, '-') + '.json';
    fs.writeFileSync(path.join(FORENSICS_DIR, filename), JSON.stringify(snapshot, null, 2));
    log(`Forensic snapshot captured: ${filename}`, { color: C.magenta });
  } catch (err) {
    log(`Failed to capture forensic snapshot: ${err.message}`, { color: C.red });
  }
}

// ============================================================================
// Output: Status Line
// ============================================================================

function formatStatusLine(kc, rotState, processes, eventCount) {
  const now = Date.now();
  const kcId = kc ? kc.keyId.slice(0, 4) : 'NONE';
  const kcTier = kc ? (kc.tier === 'default_claude_max_20x' ? 'max' : kc.tier) : '?';
  const kcExpiry = kc ? fmtDuration(kc.expiresAt - now) : '?';

  const activeId = rotState?.active_key_id ? rotState.active_key_id.slice(0, 4) : '?';

  // Count keys by status
  let okCount = 0, exhCount = 0, invCount = 0;
  if (rotState) {
    for (const k of Object.values(rotState.keys)) {
      if (k.status === 'active') okCount++;
      else if (k.status === 'exhausted') exhCount++;
      else if (k.status === 'invalid') invCount++;
    }
  }

  const procCount = processes.length;

  // Agent count from tracker
  const tracker = readAgentTracker();
  let agentCount = 0;
  if (tracker?.agents) {
    const recentCutoff = now - 3600_000;
    agentCount = tracker.agents.filter(a => {
      const ts = new Date(a.spawnedAt || a.timestamp || 0).getTime();
      return ts > recentCutoff && !a.exitedAt;
    }).length;
  }

  const spawnedCount = state.stats.spawned.length;
  const diedCount = state.stats.died.length;

  return `KC=${kcId}(${kcTier},${kcExpiry}) active=${activeId} keys=${okCount}ok/${exhCount}exh/${invCount}inv procs=${procCount} agents=${agentCount}/${MAX_CONCURRENT_AGENTS} | events=${eventCount} spawned=${spawnedCount} died=${diedCount}`;
}

// ============================================================================
// Output: Summary Table
// ============================================================================

function formatSummaryTable(kc, rotState) {
  const now = Date.now();
  const lines = [];

  lines.push('');
  lines.push(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║             ROTATION STRESS-TEST MONITOR                    ║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════════╣${C.reset}`);

  // Per-account breakdown
  if (rotState) {
    const accounts = buildAccountSummary(rotState);
    for (const [email, acct] of Object.entries(accounts)) {
      const validKeys = acct.keys.filter(k => k.status !== 'invalid');
      if (validKeys.length === 0 && email !== 'unknown') {
        lines.push(`${C.dim}║ ${email.padEnd(35)} ${acct.totalKeys} keys (all invalid)${' '.repeat(5)}║${C.reset}`);
        continue;
      }

      const nearestExp = acct.nearestExpiry < Infinity ? fmtDuration(acct.nearestExpiry) : 'n/a';
      const usagePct = acct.maxUsage > 0 ? `${Math.round(acct.maxUsage)}%` : 'n/a';
      lines.push(`${C.bold}║ ${email.padEnd(35)} ${String(acct.validKeys).padStart(1)}/${String(acct.totalKeys).padStart(2)} keys  usage=${usagePct.padEnd(5)} exp=${nearestExp.padEnd(6)}║${C.reset}`);

      for (const k of validKeys) {
        const marker = k.isActive ? `${C.green}<<ACTIVE${C.reset}` : '';
        const statusColor = k.status === 'active' ? C.green : k.status === 'exhausted' ? C.red : C.yellow;
        const exp = k.expiresIn !== null ? fmtDuration(k.expiresIn) : 'n/a';
        const tier = (k.tier === 'default_claude_max_20x' ? 'max' : k.tier).slice(0, 6);
        lines.push(`║   ${k.id.slice(0, 8)} ${statusColor}${k.status.padEnd(10)}${C.reset} ${tier.padEnd(6)} exp=${exp.padEnd(7)} ${marker}`);
      }
    }
  }

  // Active key + Keychain alignment
  lines.push(`${C.cyan}╠══════════════════════════════════════════════════════════════╣${C.reset}`);
  const kcId = kc ? kc.keyId.slice(0, 8) : 'NONE';
  const activeId = rotState?.active_key_id ? rotState.active_key_id.slice(0, 8) : 'NONE';
  const aligned = kc && rotState?.active_key_id && (kc.keyId === rotState.active_key_id || kc.keyId === rotState.active_key_id.slice(0, 16));
  const alignIcon = aligned ? `${C.green}ALIGNED${C.reset}` : `${C.red}MISMATCH${C.reset}`;
  lines.push(`║ KC=${kcId}  Active=${activeId}  ${alignIcon}`);

  // Session stats
  lines.push(`${C.cyan}╠══════════════════════════════════════════════════════════════╣${C.reset}`);
  trimOldEntries(state.stats.spawned);
  trimOldEntries(state.stats.died);
  const processes = getTargetProcesses();
  lines.push(`║ Sessions (1h): spawned=${state.stats.spawned.length} completed=? died=${state.stats.died.length} running=${processes.length}/${MAX_CONCURRENT_AGENTS}`);

  // Rotation stats
  trimOldEntries(state.stats.rotations.switches);
  trimOldEntries(state.stats.rotations.exhaustions);
  trimOldEntries(state.stats.rotations.refreshes);
  trimOldEntries(state.stats.rotations.invalidGrants);
  lines.push(`║ Rotations (1h): switches=${state.stats.rotations.switches.length} exhaustions=${state.stats.rotations.exhaustions.length} refreshes=${state.stats.rotations.refreshes.length} invalid_grants=${state.stats.rotations.invalidGrants.length}`);

  // Exhaustion estimate
  const estHours = estimateExhaustionTime(rotState);
  const estStr = estHours !== null ? `~${estHours.toFixed(1)}h` : 'unknown';
  lines.push(`║ Est. time to full exhaustion: ${estStr}`);

  // Uptime
  lines.push(`${C.cyan}╠══════════════════════════════════════════════════════════════╣${C.reset}`);
  lines.push(`║ Uptime: ${fmtDuration(now - state.startedAt)}  Polls: ${state.pollCount}  Log: ${path.basename(LOG_FILE)}`);
  lines.push(`${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Event Processing from Rotation Log
// ============================================================================

function processRotationLogEvents(newText) {
  if (!newText) return 0;
  const now = Date.now();
  const lines = newText.split('\n').filter(l => l.trim());
  let eventCount = 0;

  for (const line of lines) {
    eventCount++;
    state.stats.events.push({ type: 'rotation_log', timestamp: now });

    // Detect event types for stats
    if (line.includes('key_switched')) {
      const fromMatch = line.match(/previous_key=(\w+)/);
      const toMatch = line.match(/key=(\w+)/);
      state.stats.rotations.switches.push({ timestamp: now });
      if (fromMatch && toMatch) {
        state.failures.recentSwitches.push({
          from: fromMatch[1], to: toMatch[1], timestamp: now,
        });
      }
      log(`  >> ${C.yellow}SWITCH${C.reset} ${line.slice(line.indexOf(']') + 2)}`, { color: C.yellow });
    } else if (line.includes('key_exhausted')) {
      state.stats.rotations.exhaustions.push({ timestamp: now });
      log(`  >> ${C.red}EXHAUSTED${C.reset} ${line.slice(line.indexOf(']') + 2)}`, { color: C.red });
    } else if (line.includes('token_refreshed') || line.includes('proactive_standby_refresh')) {
      state.stats.rotations.refreshes.push({ timestamp: now });
      log(`  >> ${C.green}REFRESH${C.reset} ${line.slice(line.indexOf(']') + 2)}`, { color: C.green });
    } else if (line.includes('invalid_grant')) {
      state.stats.rotations.invalidGrants.push({ timestamp: now });
      log(`  >> ${C.red}INVALID_GRANT${C.reset} ${line.slice(line.indexOf(']') + 2)}`, { color: C.red });
    } else if (line.includes('pre_expiry_restartless_swap')) {
      log(`  >> ${C.cyan}RESTARTLESS_SWAP${C.reset} ${line.slice(line.indexOf(']') + 2)}`, { color: C.cyan });
    } else {
      log(`  >> ${line.trim()}`);
    }
  }

  trimOldEntries(state.stats.events);
  trimOldEntries(state.stats.rotations.switches);
  trimOldEntries(state.stats.rotations.exhaustions);
  trimOldEntries(state.stats.rotations.refreshes);
  trimOldEntries(state.stats.rotations.invalidGrants);

  return eventCount;
}

// ============================================================================
// Poll Functions
// ============================================================================

function pollFast() {
  state.pollCount++;
  const now = Date.now();

  // 1. Keychain
  const kc = getKeychainToken();
  const kcId = kc ? kc.keyId : null;

  // Detect Keychain swap
  if (state.kc.lastId !== null && kcId !== state.kc.lastId) {
    log(`KC SWAP: ${(state.kc.lastId || '').slice(0, 8)} -> ${(kcId || '').slice(0, 8)}`, { color: C.magenta });
    state.stats.events.push({ type: 'kc_swap', timestamp: now });
  }
  state.kc.lastId = kcId;

  // 2. Rotation state
  const rotState = readRotationState();

  // Detect active key change
  if (rotState && state.rotation.lastActiveKeyId !== null && rotState.active_key_id !== state.rotation.lastActiveKeyId) {
    log(`ACTIVE KEY CHANGED: ${(state.rotation.lastActiveKeyId || '').slice(0, 8)} -> ${(rotState.active_key_id || '').slice(0, 8)}`, { color: C.magenta });
    state.stats.events.push({ type: 'active_key_change', timestamp: now });
  }
  if (rotState) state.rotation.lastActiveKeyId = rotState.active_key_id;

  // 3. Processes
  const processes = getTargetProcesses();

  // Track new PIDs (birth times)
  for (const p of processes) {
    if (!state.sessions.birthTimes.has(p.pid)) {
      state.sessions.birthTimes.set(p.pid, now);
      state.stats.spawned.push({ pid: p.pid, timestamp: now });
    }
  }

  // Detect dead PIDs
  const alivePids = new Set(processes.map(p => p.pid));
  for (const [pid, spawnTime] of state.sessions.birthTimes.entries()) {
    if (!alivePids.has(pid) && now - spawnTime > 5000) { // 5s grace
      state.stats.died.push({ pid, timestamp: now });
      state.sessions.birthTimes.delete(pid);
    }
  }

  // 4. Tail rotation log for new events
  const rotLogNew = tailNewBytes(ROTATION_LOG_PATH, 'rotationLog');
  const eventCount = processRotationLogEvents(rotLogNew);

  // 5. Tail stop-hook debug log (just track, don't print each line)
  const stopHookNew = tailNewBytes(STOP_HOOK_DEBUG_PATH, 'stopHookDebug');
  if (stopHookNew) {
    // Count interesting events
    const quotaDeathMatches = (stopHookNew.match(/quota.*death|rate_limit/gi) || []).length;
    if (quotaDeathMatches > 0) {
      log(`  stop-hook: ${quotaDeathMatches} quota-death events detected`, { color: C.yellow });
      state.stats.events.push({ type: 'stop_hook_quota_death', timestamp: now });
    }
  }

  // 6. Tail hourly automation log
  const hourlyNew = tailNewBytes(HOURLY_AUTOMATION_LOG_PATH, 'hourlyAutomation');
  if (hourlyNew) {
    const spawnMatches = hourlyNew.match(/Spawning agent/g);
    if (spawnMatches) {
      log(`  hourly-automation: ${spawnMatches.length} agent spawn(s)`, { color: C.cyan });
    }
    const syncMatches = hourlyNew.match(/key-sync/g);
    if (syncMatches) {
      log(`  hourly-automation: ${syncMatches.length} key-sync event(s)`, { color: C.blue });
    }
  }

  // 7. Failure detection
  const failures = detectFailureConditions(kc, rotState, processes);
  for (const fc of failures) {
    logAlert(fc.severity, fc.name, fc.details);
  }
  if (failures.length > 0) {
    captureForensicSnapshot(failures);
  }

  // 8. Status line
  const statusLine = formatStatusLine(kc, rotState, processes, eventCount);
  log(statusLine);
}

function pollMedium() {
  // Agent tracker deltas
  const tracker = readAgentTracker();
  if (tracker?.agents) {
    const currentAgents = tracker.agents;
    if (state.sessions.lastAgentSnapshot) {
      const deltas = computeSessionDeltas(currentAgents, state.sessions.lastAgentSnapshot);
      for (const a of deltas.spawned) {
        log(`  AGENT SPAWNED: ${a.id} type=${a.type || '?'}`, { color: C.green });
      }
      for (const a of deltas.died) {
        log(`  AGENT DIED: ${a.id} type=${a.type || '?'}`, { color: C.red });

        // FC2 check: if agent died recently and was a task agent, check if in quota-interrupted
        const qi = readJsonSafe(QUOTA_INTERRUPTED_PATH);
        const inQI = qi?.sessions?.some(s => s.agentId === a.id || s.sessionId === a.sessionId);
        if (!inQI && a.hookType === 'hourly-automation') {
          logAlert('HIGH', 'FC2', `Agent ${a.id} died but NOT in quota-interrupted-sessions.json`);
          captureForensicSnapshot([{ name: 'FC2', severity: 'HIGH', details: `Agent ${a.id} died without quota-interrupted entry` }]);
        }
      }
    }
    state.sessions.lastAgentSnapshot = currentAgents;
  }

  // Quota-interrupted sessions
  const qi = readJsonSafe(QUOTA_INTERRUPTED_PATH);
  if (qi?.sessions?.length > 0) {
    log(`  quota-interrupted: ${qi.sessions.length} session(s) awaiting revival`, { color: C.yellow });
  }

  // Paused sessions
  const paused = readJsonSafe(PAUSED_SESSIONS_PATH);
  if (paused?.sessions?.length > 0) {
    log(`  paused: ${paused.sessions.length} session(s) waiting for recovery`, { color: C.red });
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  ensureDir(path.dirname(LOG_FILE));

  log('');
  log(`${C.bold}=== Rotation Stress-Test Monitor ===${C.reset}`, { color: C.cyan });
  log(`Fast poll: ${FAST_INTERVAL_MS / 1000}s | Medium: ${MEDIUM_INTERVAL_MS / 1000}s | Summary: ${SUMMARY_INTERVAL_MS / 1000}s`);
  log(`Log: ${LOG_FILE}`);
  log(`Forensics: ${FORENSICS_DIR}`);
  log(`Target: ${TARGET_DIR}`);
  log('');

  // Initialize log offsets to current file sizes (don't replay old content)
  for (const [key, filePath] of [
    ['rotationLog', ROTATION_LOG_PATH],
    ['stopHookDebug', STOP_HOOK_DEBUG_PATH],
    ['hourlyAutomation', HOURLY_AUTOMATION_LOG_PATH],
  ]) {
    try {
      const stat = fs.statSync(filePath);
      state.logOffsets[key] = stat.size;
    } catch { state.logOffsets[key] = 0; }
  }

  // Initialize agent snapshot
  const tracker = readAgentTracker();
  if (tracker?.agents) {
    state.sessions.lastAgentSnapshot = tracker.agents;
  }

  // Initialize rotation state tracking
  const rotState = readRotationState();
  if (rotState) state.rotation.lastActiveKeyId = rotState.active_key_id;

  // Initialize keychain tracking
  const kc = getKeychainToken();
  state.kc.lastId = kc ? kc.keyId : null;

  // Initial poll
  pollFast();
  pollMedium();

  // Print initial summary
  const initKc = getKeychainToken();
  const initRotState = readRotationState();
  console.log(formatSummaryTable(initKc, initRotState));

  // Schedule polls
  let mediumCounter = 0;
  let summaryCounter = 0;

  const fastTimer = setInterval(() => {
    pollFast();

    mediumCounter += FAST_INTERVAL_MS;
    if (mediumCounter >= MEDIUM_INTERVAL_MS) {
      mediumCounter = 0;
      pollMedium();
    }

    summaryCounter += FAST_INTERVAL_MS;
    if (summaryCounter >= SUMMARY_INTERVAL_MS) {
      summaryCounter = 0;
      const kc = getKeychainToken();
      const rotState = readRotationState();
      console.log(formatSummaryTable(kc, rotState));
    }
  }, FAST_INTERVAL_MS);

  // SIGINT handler: print final summary
  process.on('SIGINT', () => {
    clearInterval(fastTimer);
    log('');
    log('=== Monitor Shutting Down ===', { color: C.cyan });

    const kc = getKeychainToken();
    const rotState = readRotationState();
    console.log(formatSummaryTable(kc, rotState));

    const uptime = fmtDuration(Date.now() - state.startedAt);
    log(`Uptime: ${uptime} | Polls: ${state.pollCount} | Events: ${state.stats.events.length}`);
    log(`Spawned: ${state.stats.spawned.length} | Died: ${state.stats.died.length}`);
    log(`Rotations: switches=${state.stats.rotations.switches.length} exhaustions=${state.stats.rotations.exhaustions.length} refreshes=${state.stats.rotations.refreshes.length}`);
    log('');

    process.exit(0);
  });
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
