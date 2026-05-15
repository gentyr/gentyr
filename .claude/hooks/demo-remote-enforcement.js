#!/usr/bin/env node
/**
 * PostToolUse Hook: Demo Remote Execution Enforcement
 *
 * Fires after mcp__playwright__run_demo and mcp__playwright__run_tests calls.
 * Enforces remote-first demo execution for spawned (non-interactive) agents.
 *
 * Two enforcement layers:
 *   1. Single-run remote enforcement: detects local run_demo when Fly.io is
 *      configured and the scenario is remote-eligible. Injects strong redirect.
 *   2. Sequential-run batch enforcement: detects multiple sequential run_demo
 *      calls that should be a single run_demo_batch call. Injects batch redirect.
 *
 * Exemptions:
 *   - Interactive (CTO) sessions — get softer guidance, never blocked
 *   - Chrome-bridge scenarios (require local Chrome)
 *   - Scenarios with remote_eligible=false in the DB
 *   - Explicit local: true passed with a documented reason
 *   - run_demo calls that already ran remotely (fly or steel)
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';

// Scope state file by session to avoid cross-agent false positives.
// CLAUDE_QUEUE_ID is injected by spawnQueueItem() for spawned agents.
// Falls back to PPID for interactive sessions.
const SESSION_KEY = process.env.CLAUDE_QUEUE_ID || `pid-${process.ppid}`;
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state', 'demo-remote-enforcement');
const STATE_FILE = path.join(STATE_DIR, `${SESSION_KEY}.json`);

// Rolling window for sequential call detection (10 minutes)
const SEQUENTIAL_WINDOW_MS = 10 * 60 * 1000;
// Threshold: after this many single run_demo calls in the window, inject batch guidance
const SEQUENTIAL_THRESHOLD = 2;

/**
 * Check if Fly.io is configured and enabled in services.json.
 */
function isFlyConfigured() {
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(servicesPath)) return false;
    const config = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    return !!(config.fly && config.fly.enabled !== false);
  } catch {
    return false;
  }
}

/**
 * Read and update sequential call tracking state.
 * Returns the count of recent local run_demo calls in the rolling window.
 * State is scoped per session (via CLAUDE_QUEUE_ID or PPID) to avoid
 * cross-agent false positives from concurrent demo agents.
 */
function trackSequentialCall() {
  const now = Date.now();
  let state = { calls: [] };
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    state = { calls: [] };
  }

  // Prune calls outside the window
  state.calls = (state.calls || []).filter(ts => (now - ts) < SEQUENTIAL_WINDOW_MS);
  // Add current call
  state.calls.push(now);

  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal
  }

  // Opportunistic cleanup: remove state files older than 1 hour (stale sessions)
  try {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const fp = path.join(STATE_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > ONE_HOUR_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // Non-fatal
  }

  return state.calls.length;
}

/**
 * Detect chrome-bridge usage from tool input or response.
 */
function isChromeBridgeScenario(toolInput, responseText) {
  const testFile = toolInput?.test_file || '';
  if (/chrome-bridge|ext-|extension|platform-fixture/i.test(testFile)) return true;
  if (/chrome.bridge|chrome_bridge|chromeBridge/i.test(responseText)) return true;
  return false;
}

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(data);
    const toolName = hookInput.tool_name ?? '';

    // Only process run_demo calls (not run_demo_batch — batch is already correct behavior)
    if (toolName !== 'mcp__playwright__run_demo') {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Fast exit if Fly.io not configured — nothing to enforce
    if (!isFlyConfigured()) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const toolInput = hookInput.tool_input || {};
    const toolResponse = hookInput.tool_response;
    const responseText = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse || '');
    const responseParsed = (() => {
      if (!toolResponse) return null;
      if (typeof toolResponse === 'object') return toolResponse;
      try { return JSON.parse(toolResponse); } catch { return null; }
    })();

    // Determine if the demo ran remotely. The server emits execution_target as
    // one of 'local' | 'fly' | 'steel'. Treat 'fly' and 'steel' as remote.
    // Do NOT fall back to fly_machine_id / steel_session_id presence — those
    // fields may be absent on Fly runs that failed before machine allocation,
    // which would otherwise be misclassified as local.
    const target = responseParsed?.execution_target;
    const ranRemotely = target === 'fly' || target === 'steel';
    const ranLocally = !ranRemotely;

    // Skip if already running remotely — correct behavior
    if (ranRemotely) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Skip chrome-bridge scenarios — must run locally
    if (isChromeBridgeScenario(toolInput, responseText)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Skip if remote_eligible=false was detected in the response
    if (responseParsed?.remote_eligible === false ||
        responseText.includes('"remote_eligible":false') ||
        responseText.includes('"remote_eligible": false')) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Read actual maxConcurrentMachines from services.json
    let maxMachines = 10;
    try {
      const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
      if (fs.existsSync(servicesPath)) {
        const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
        if (services?.fly?.maxConcurrentMachines) {
          maxMachines = services.fly.maxConcurrentMachines;
        }
      }
    } catch { /* non-fatal — use default */ }

    // Track sequential calls for batch detection
    const recentCallCount = trackSequentialCall();

    const parts = [];

    // --- Layer 1: Local execution when remote is available ---
    if (ranLocally) {
      if (IS_SPAWNED) {
        // CRITICAL enforcement for spawned agents — this should not happen since
        // the server-side check in run_demo blocks `local: true` for spawned sessions
        // (via demo-local-guard.js) and the default routing is Fly.io.
        // If we see a local run from a spawned agent, the server-side guard was bypassed
        // or the scenario is structurally local (remote_eligible=false / chrome-bridge).
        parts.push(
          'CRITICAL — LOCAL DEMO BY SPAWNED AGENT DETECTED: This demo ran locally from a spawned session.',
          'Spawned agents are NEVER allowed to run demos locally unless the scenario is structurally local',
          '(remote_eligible=false in user-feedback.db, or chrome-bridge / extension scenario).',
          'The default routing for run_demo is Fly.io — passing no flags routes to Fly.io.',
          'For stealth scenarios pass `stealth: true` (routes to Steel.dev).',
          'Do NOT attempt to run demos locally again. Either:',
          '  1. Call run_demo({}) (default — routes to Fly.io), or',
          '  2. Call run_demo({ stealth: true }) for stealth scenarios, or',
          '  3. Call run_demo_batch({ project, scenario_ids }) for concurrent execution across Fly.io machines, or',
          '  4. Report this as a bug — the server-side enforcement was bypassed.',
          'This result should not be trusted. Re-run with the default Fly.io routing.',
        );
      } else {
        // Soft guidance for interactive (CTO) sessions
        parts.push(
          'Note: This demo ran locally. Fly.io is configured — the default run_demo routing',
          'sends to Fly.io for identical video recordings without local resource contention.',
        );
      }
    }

    // --- Layer 2: Sequential single-run detection (should use batch) ---
    if (recentCallCount >= SEQUENTIAL_THRESHOLD) {
      if (IS_SPAWNED) {
        // STRONG enforcement for spawned agents
        parts.push(
          '',
          `BATCH EXECUTION REQUIRED: You have called run_demo ${recentCallCount} times in the last 10 minutes.`,
          'Sequential single-scenario runs are inefficient. Use run_demo_batch instead:',
          '',
          '  run_demo_batch({',
          '    project: "demo",',
          '    scenario_ids: ["<id1>", "<id2>", ...],',
          '    recorded: true',
          '  })',
          '',
          'run_demo_batch defaults to Fly.io routing and runs scenarios CONCURRENTLY across multiple machines',
          `(up to ${maxMachines} at a time). This is dramatically faster than sequential single calls.`,
          'Switch to batch execution immediately.',
        );
      } else {
        // Soft guidance for CTO sessions
        parts.push(
          '',
          `Tip: You have run ${recentCallCount} individual demos recently.`,
          'Consider run_demo_batch for concurrent execution across Fly.io machines.',
        );
      }
    }

    if (parts.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: parts.join('\n'),
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch {
    // PostToolUse hooks must never block
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}, 4000);
