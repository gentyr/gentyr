#!/usr/bin/env node
/**
 * PostToolUse Hook: Stale-Wait Watchdog
 *
 * Detects agents that are alive (making tool calls) but stuck in a polling/waiting
 * loop without advancing through pipeline stages. Three-stage escalation:
 *   Stage 1 (8 min): Inject nudge context
 *   Stage 2 (13 min): Send instruction-tier signal
 *   Stage 3 (18 min): File deputy-CTO report
 *
 * Fast-exit for interactive sessions, persistent monitors, gate agents, and audit agents.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { getCooldown } from './config-reader.js';

// Fast exits: only spawned sessions with an agent ID
if (process.env.CLAUDE_SPAWNED_SESSION !== 'true' || !process.env.CLAUDE_AGENT_ID) {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

// Persistent monitors, gate agents, and audit agents poll by design — skip them
if (process.env.GENTYR_PERSISTENT_MONITOR === 'true') {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

const AGENT_ID = process.env.CLAUDE_AGENT_ID;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const PROGRESS_DIR = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress');
const WATCHDOG_DIR = path.join(PROJECT_DIR, '.claude', 'state', 'stale-wait-watchdog');
const PROGRESS_FILE = path.join(PROGRESS_DIR, `${AGENT_ID}.json`);
const WATCHDOG_FILE = path.join(WATCHDOG_DIR, `${AGENT_ID}.json`);

// Configurable thresholds via automation-config.json
const STALE_DETECTION_MINUTES = getCooldown('stale_wait_detection_minutes', 8);
const ESCALATION_MINUTES = getCooldown('stale_wait_escalation_minutes', 5);
const REPORT_MINUTES = ESCALATION_MINUTES * 2; // Double the escalation interval for final report
const TOOL_CALL_THRESHOLD = getCooldown('stale_wait_tool_call_threshold', 20);

// Tools that don't count as "real progress" — polling/waiting/signal-checking tools
const NON_PROGRESS_TOOLS = new Set([
  'mcp__agent-tracker__get_session_signals',
  'mcp__agent-tracker__acknowledge_signal',
  'mcp__agent-tracker__get_comms_log',
  'mcp__agent-tracker__peek_session',
  'mcp__agent-tracker__get_session_queue_status',
  'mcp__workstream__list_dependencies',
  'mcp__workstream__get_queue_context',
  'mcp__workstream__get_change_log',
  'mcp__persistent-task__get_persistent_task',
  'mcp__persistent-task__get_persistent_task_summary',
  'mcp__persistent-task__inspect_persistent_task',
  'mcp__todo-db__list_tasks',
]);

const NOOP = JSON.stringify({});

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => resolve(data));
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function isSleepCommand(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const cmd = typeof toolInput === 'string' ? toolInput : toolInput?.command || '';
  return /^\s*sleep\s+\d/.test(cmd);
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  // Check if this tool call is "non-progress"
  const isNonProgress = NON_PROGRESS_TOOLS.has(toolName) || isSleepCommand(toolName, toolInput);

  // Read progress file
  const progress = readJson(PROGRESS_FILE);
  if (!progress) {
    // No progress file yet — agent just started, skip
    process.stdout.write(NOOP);
    return;
  }

  const now = Date.now();
  const lastStageChangeAt = progress.lastStageChangeAt ? new Date(progress.lastStageChangeAt).getTime() : now;
  const toolCallsSinceStageChange = progress.toolCallsSinceStageChange || 0;
  const minutesSinceStageChange = (now - lastStageChangeAt) / 60000;

  // Not stale yet — check both time and tool call thresholds
  if (minutesSinceStageChange < STALE_DETECTION_MINUTES || toolCallsSinceStageChange < TOOL_CALL_THRESHOLD) {
    // If the current tool IS a progress tool, reset any watchdog state
    if (!isNonProgress) {
      try { fs.unlinkSync(WATCHDOG_FILE); } catch {}
    }
    process.stdout.write(NOOP);
    return;
  }

  // If this tool call IS a progress tool, the agent broke out of the loop — reset
  if (!isNonProgress) {
    try { fs.unlinkSync(WATCHDOG_FILE); } catch {}
    process.stdout.write(NOOP);
    return;
  }

  // === STALE DETECTED ===
  // Read or create watchdog state
  let watchdog = readJson(WATCHDOG_FILE) || {
    firstDetectedAt: new Date().toISOString(),
    nudgeSentAt: null,
    escalatedAt: null,
    reportedAt: null,
    toolCallsSinceStageChange,
    lastProgressStage: progress.pipeline?.currentStage || 'unknown',
  };

  const firstDetected = new Date(watchdog.firstDetectedAt).getTime();
  const minutesSinceDetection = (now - firstDetected) / 60000;

  // Stage 3: Report to deputy-CTO (after REPORT_MINUTES since first detection)
  if (minutesSinceDetection >= REPORT_MINUTES && !watchdog.reportedAt) {
    watchdog.reportedAt = new Date().toISOString();
    writeJson(WATCHDOG_FILE, watchdog);

    process.stdout.write(JSON.stringify({
      additionalContext: `[STALE-WAIT ESCALATION -- FINAL WARNING]\n` +
        `You have been stuck for ${Math.round(minutesSinceStageChange)} minutes without advancing.\n` +
        `${toolCallsSinceStageChange} tool calls made, all non-progress (signal reads, sleeps, polls).\n` +
        `If you cannot proceed, call submit_bypass_request to alert the CTO.\n` +
        `If your blocker was resolved, STOP POLLING and resume your primary work NOW.`,
    }));
    return;
  }

  // Stage 2: Send instruction signal (after ESCALATION_MINUTES since first detection)
  if (minutesSinceDetection >= ESCALATION_MINUTES && !watchdog.escalatedAt) {
    watchdog.escalatedAt = new Date().toISOString();
    writeJson(WATCHDOG_FILE, watchdog);

    // Import and send signal (best-effort, dynamic import to keep fast path lightweight)
    try {
      const { sendSignal } = await import('./lib/session-signals.js');
      sendSignal({
        fromAgentId: 'system-watchdog',
        fromAgentType: 'system',
        fromTaskTitle: 'Stale-Wait Watchdog',
        toAgentId: AGENT_ID,
        toAgentType: 'unknown',
        tier: 'instruction',
        type: 'STALE_WAIT_ESCALATION',
        message: `You appear stuck in a wait loop for ${Math.round(minutesSinceStageChange)} minutes. Re-check your blockers immediately. If they are resolved, proceed with work. If genuinely blocked, call submit_bypass_request.`,
        projectDir: PROJECT_DIR,
      });
    } catch (err) {
      // Non-fatal — signal send failure should not block the hook
    }

    process.stdout.write(JSON.stringify({
      additionalContext: `[STALE-WAIT DETECTION -- INSTRUCTION SENT]\n` +
        `An instruction-tier signal has been sent to you because you appear stuck.\n` +
        `${Math.round(minutesSinceStageChange)} minutes without stage progress. ${toolCallsSinceStageChange} non-progress tool calls.\n` +
        `IMMEDIATELY verify your blockers are still active. If resolved, proceed with work.`,
    }));
    return;
  }

  // Stage 1: Initial nudge (first detection)
  if (!watchdog.nudgeSentAt) {
    watchdog.nudgeSentAt = new Date().toISOString();
    writeJson(WATCHDOG_FILE, watchdog);

    const taskId = process.env.GENTYR_TODO_TASK_ID || '<your_task_id>';

    process.stdout.write(JSON.stringify({
      additionalContext: `[STALE-WAIT DETECTION -- CHECK YOUR BLOCKERS]\n` +
        `You have made ${toolCallsSinceStageChange} tool calls over ${Math.round(minutesSinceStageChange)} minutes without advancing your pipeline stage.\n` +
        `If waiting on a dependency, verify it is still active:\n` +
        `  mcp__workstream__list_dependencies({ task_id: "${taskId}", status: "active" })\n` +
        `  mcp__agent-tracker__get_session_signals({ agent_id: "${AGENT_ID}", status: "pending" })\n` +
        `If your blocker was resolved or superseded, proceed with your primary work NOW.\n` +
        `If genuinely blocked, acknowledge this and continue waiting.`,
    }));
    return;
  }

  // Between stages — just pass through
  process.stdout.write(NOOP);
}

main().catch(() => {
  process.stdout.write(NOOP);
});
