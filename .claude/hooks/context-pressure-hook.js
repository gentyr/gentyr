#!/usr/bin/env node
/**
 * PostToolUse Hook: Context Pressure Monitor
 *
 * Monitors spawned agent sessions for context window usage and time since
 * last compaction. Injects tiered nudges (suggestion → warning → critical)
 * advising agents to compact via `request_self_compact`.
 *
 * Token detection: reads last 16KB of session JSONL, extracts the most recent
 * `message.usage` entry, calculates context tokens as:
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Fast-exits for non-spawned sessions (zero overhead for interactive CTO).
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCooldown } from './config-reader.js';
import { getSessionContextTokens } from './lib/compact-session.js';

// ============================================================================
// Fast-exit: only runs in spawned sessions
// ============================================================================

const isSpawned = process.env.CLAUDE_SPAWNED_SESSION === 'true';
const AGENT_ID = process.env.CLAUDE_AGENT_ID;

if (!isSpawned || !AGENT_ID) {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// ============================================================================
// Environment & Constants
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_PATH = path.join(STATE_DIR, `context-pressure-${AGENT_ID}.json`);

// Thresholds (configurable via automation-config.json)
const SUGGESTION_TOKENS = getCooldown('context_pressure_suggestion_tokens', 200000);
const WARNING_TOKENS = getCooldown('context_pressure_warning_tokens', 300000);
const CRITICAL_TOKENS = getCooldown('context_pressure_critical_tokens', 400000);
const SUGGESTION_MINUTES = getCooldown('context_pressure_suggestion_minutes', 15);
const WARNING_MINUTES = getCooldown('context_pressure_warning_minutes', 30);
const CRITICAL_MINUTES = getCooldown('context_pressure_critical_minutes', 60);
const NUDGE_COOLDOWN_MS = getCooldown('context_pressure_nudge_cooldown_minutes', 5) * 60 * 1000;

// ============================================================================
// Output helpers
// ============================================================================

function approve() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

function approveWithContext(message) {
  process.stdout.write(JSON.stringify({
    decision: 'approve',
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
  process.exit(0);
}

// ============================================================================
// State management
// ============================================================================

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastCompactAt: null, lastNudgeTier: null, lastNudgeAt: 0, sessionStartAt: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmpPath = STATE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state) + '\n');
    fs.renameSync(tmpPath, STATE_PATH);
  } catch {
    // Non-fatal
  }
}

// ============================================================================
// Session file discovery
// ============================================================================

/**
 * Find the session JSONL file for the current agent.
 * Looks up agent-tracker-history.json for the session ID, then resolves the file.
 */
function findAgentSessionFile() {
  try {
    // Try agent-tracker-history.json first
    const historyPath = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, 'utf8');
      const history = JSON.parse(raw);
      const agents = Array.isArray(history) ? history : (history.agents || []);
      const agent = agents.find(a => a.id === AGENT_ID);
      if (agent?.sessionId) {
        const projectPath = '-' + PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
        const sessionDir = path.join(process.env.HOME || '', '.claude', 'projects', projectPath);
        const filePath = path.join(sessionDir, `${agent.sessionId}.jsonl`);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
  } catch {
    // Fall through
  }

  // Fallback: scan recent JSONL files for agent ID marker
  try {
    const projectPath = '-' + PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
    const sessionDir = path.join(process.env.HOME || '', '.claude', 'projects', projectPath);
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        try {
          const stat = fs.statSync(path.join(sessionDir, f));
          return { name: f, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10); // Check only 10 most recent

    for (const file of files) {
      const filePath = path.join(sessionDir, file.name);
      // Read first 4KB to check for agent ID
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        const head = buf.toString('utf8', 0, bytesRead);
        if (head.includes(AGENT_ID)) return filePath;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Non-fatal
  }

  return null;
}

/**
 * Extract context token count from session JSONL using shared module.
 */
function getContextTokens(sessionFilePath) {
  const result = getSessionContextTokens(sessionFilePath);
  return result?.totalContextTokens ?? null;
}

// ============================================================================
// Tier determination
// ============================================================================

function determineTier(contextTokens, minutesSinceCompact) {
  // Token-based triggers: fire on token count alone
  // Time-based triggers: require at least half the suggestion token threshold
  //   (prevents nudging brand-new sessions with trivial context)
  const minForTimeTrigger = Math.floor(SUGGESTION_TOKENS / 2);

  // Check critical first (highest priority)
  if (contextTokens >= CRITICAL_TOKENS ||
      (minutesSinceCompact >= CRITICAL_MINUTES && contextTokens >= minForTimeTrigger)) {
    return 'critical';
  }
  if (contextTokens >= WARNING_TOKENS ||
      (minutesSinceCompact >= WARNING_MINUTES && contextTokens >= minForTimeTrigger)) {
    return 'warning';
  }
  if (contextTokens >= SUGGESTION_TOKENS ||
      (minutesSinceCompact >= SUGGESTION_MINUTES && contextTokens >= minForTimeTrigger)) {
    return 'suggestion';
  }
  return null;
}

function formatTokens(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

const TIER_MESSAGES = {
  suggestion: (tokens, minutes) =>
    `[CONTEXT PRESSURE: SUGGESTION] Your session context is at ${formatTokens(tokens)} tokens (${Math.round(minutes)} minutes since last compact). Consider calling mcp__agent-tracker__request_self_compact() soon to keep context lean and maintain response quality.`,

  warning: (tokens, minutes) =>
    `[CONTEXT PRESSURE: WARNING] Your session context has reached ${formatTokens(tokens)} tokens (${Math.round(minutes)} minutes since last compact). Compact ASAP — context degradation affects response quality. Call mcp__agent-tracker__request_self_compact() to initiate compaction. Finish your current tool call, then compact.`,

  critical: (tokens, minutes) =>
    `[CONTEXT PRESSURE: CRITICAL] Your session context is at ${formatTokens(tokens)} tokens (${Math.round(minutes)} minutes since last compact). STOP what you are doing and compact NOW. Call mcp__agent-tracker__request_self_compact() immediately, then call summarize_work and exit. Continuing without compaction risks context overflow and wasted work.`,
};

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Consume stdin (PostToolUse contract)
  let _input = '';
  for await (const chunk of process.stdin) {
    _input += chunk;
  }

  // Read state for cooldown check
  const state = readState();
  const now = Date.now();

  // Quick cooldown check before expensive file I/O
  if (state.lastNudgeAt && (now - state.lastNudgeAt) < NUDGE_COOLDOWN_MS) {
    approve();
    return;
  }

  // Find session file
  const sessionFile = findAgentSessionFile();
  if (!sessionFile) {
    approve();
    return;
  }

  // Get context tokens
  const contextTokens = getContextTokens(sessionFile);
  if (contextTokens === null) {
    approve();
    return;
  }

  // Calculate time since last compact
  // If no lastCompactAt in state, use sessionStartAt or default to 0 (will trigger time-based)
  let lastCompactTime;
  if (state.lastCompactAt) {
    lastCompactTime = new Date(state.lastCompactAt).getTime();
  } else if (state.sessionStartAt) {
    lastCompactTime = new Date(state.sessionStartAt).getTime();
  } else {
    // First run — set session start to now, don't trigger time-based yet
    state.sessionStartAt = new Date().toISOString();
    lastCompactTime = now;
    writeState(state);
    approve();
    return;
  }

  const minutesSinceCompact = (now - lastCompactTime) / (60 * 1000);

  // Determine tier
  const tier = determineTier(contextTokens, minutesSinceCompact);
  if (!tier) {
    approve();
    return;
  }

  // Tier escalation check: reset cooldown if tier is higher than last nudge
  const tierOrder = { suggestion: 1, warning: 2, critical: 3 };
  const currentTierLevel = tierOrder[tier];
  const lastTierLevel = tierOrder[state.lastNudgeTier] || 0;

  if (currentTierLevel <= lastTierLevel && state.lastNudgeAt && (now - state.lastNudgeAt) < NUDGE_COOLDOWN_MS) {
    // Same or lower tier within cooldown — skip
    approve();
    return;
  }

  // Update state and emit nudge
  state.lastNudgeTier = tier;
  state.lastNudgeAt = now;
  writeState(state);

  const message = TIER_MESSAGES[tier](contextTokens, minutesSinceCompact);
  approveWithContext(message);
}

main();
