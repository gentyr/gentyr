#!/usr/bin/env node
/**
 * pause-persistent-task-guard.js  (FIX-C-HOTFIX)
 *
 * PreToolUse hook on `mcp__persistent-task__pause_persistent_task`.
 *
 * Defense against the failure mode discovered on 2026-05-24 — two separate
 * persistent monitors (Dashboard plan-manager `e793fb74` and Stripe E2E
 * monitor `70ddc4cf`) called `pause_persistent_task` as a sleep substitute
 * to "wait for child agents to complete". Both got stuck for many hours
 * because the only recovery path for a `pause_persistent_task`-paused task
 * is `persistent_stale_pause_resume`, which was also broken by an
 * unrelated regression. Unlike `submit_bypass_request`, `pause_persistent_task`
 * doesn't create a `bypass_requests` row, so the SLA enforcer (FIX-31)
 * has nothing to act on.
 *
 * The original FIX-8 prompt only warned against `submit_bypass_request`;
 * the agent generalized in the wrong direction and reached for the next
 * available pause mechanism instead. This guard closes that escape hatch.
 *
 * This guard:
 *   1. Always allows interactive (non-spawned) sessions — the CTO can
 *      legitimately pause a task from their console.
 *   2. Always allows the global deputy-CTO monitor
 *      (`GENTYR_DEPUTY_CTO_MONITOR=true`) — it may legitimately pause
 *      child tasks during alignment monitoring.
 *   3. Always allows pauses whose `reason` starts with `"CTO-directed:"`
 *      — an opt-in prefix signaling the CTO explicitly asked for the pause.
 *   4. DENIES all other spawned-agent self-pauses, with a clear message
 *      pointing at the wait-pattern docs and instructing the agent to
 *      `summarize_work` + exit instead.
 *
 * Symmetric with bypass-pause-duration-guard.js (FIX-32). Together they
 * close both self-pause escape hatches.
 */

import fs from 'fs';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function approve(opts = {}) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
  if (opts.additionalContext) {
    out.hookSpecificOutput.additionalContext = opts.additionalContext;
  }
  if (opts.systemMessage) out.systemMessage = opts.systemMessage;
  emit(out);
}

function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // Malformed input — fail open so we don't break unrelated tools
  approve();
}

const toolName = input?.tool_name || '';
if (toolName !== 'mcp__persistent-task__pause_persistent_task') {
  approve();
}

const isSpawned =
  process.env.CLAUDE_SPAWNED_SESSION === 'true' ||
  process.env.CLAUDE_SPAWNED_SESSION === '1';

// Interactive (CTO) sessions: unrestricted.
if (!isSpawned) {
  approve();
}

// Global deputy-CTO monitor: allowed.
if (
  process.env.GENTYR_DEPUTY_CTO_MONITOR === 'true' ||
  process.env.GENTYR_DEPUTY_CTO_MONITOR === '1'
) {
  approve();
}

const args = input?.tool_input || {};
const reason = String(args.reason || '').trim();

// Explicit CTO-directed prefix is the opt-in escape hatch.
if (reason.startsWith('CTO-directed:')) {
  approve({
    additionalContext: [
      'pause-persistent-task-guard: allowed via "CTO-directed:" prefix.',
      'This prefix signals the CTO explicitly asked for the pause.',
      'It is your responsibility to ensure the CTO actually requested it.',
    ].join('\n'),
  });
}

// Deny: spawned agent trying to self-pause as a sleep substitute.
deny(
  [
    'pause_persistent_task is BLOCKED for spawned agents trying to self-pause.',
    '',
    `Your reason: "${reason || '(no reason given)'}"`,
    '',
    'WHY THIS IS BLOCKED:',
    '  pause_persistent_task is for CTO-directed pauses only. Using it to wait',
    '  for child agents, CI, or scheduled events is the same anti-pattern that',
    '  trapped two real persistent tasks for 6h+ and 32h+ on 2026-05-24:',
    '  the ONLY recovery path is `persistent_stale_pause_resume`, and any',
    '  single failure in that path leaves you stuck.',
    '',
    'CORRECT WAIT PATTERNS (these all work without pausing):',
    '',
    '  1. Waiting <5min for any condition:',
    '     → call summarize_work with a brief `last_summary`, then exit.',
    '       The next revival respawns you in <30s with full context.',
    '',
    '  2. Waiting 5–60min for CI / PR merge / child agent / demo:',
    '     → same pattern. summarize_work + exit. The next revival sees the',
    '       completed condition and proceeds. DO NOT pause.',
    '',
    '  3. Genuine blocker (missing access, conflicting CTO instructions,',
    '     external service down, ambiguity that needs CTO resolution):',
    '     → use submit_bypass_request WITHOUT pause_duration_minutes so the',
    '       CTO sees it on next briefing.',
    '',
    'ESCAPE HATCH (CTO-directed only):',
    '  If the CTO explicitly asked you to pause, prefix your reason with',
    '  "CTO-directed: <reason>" (verbatim). This guard then allows the pause.',
    '  Do NOT use this prefix as a workaround — the audit trail will show',
    '  whether the CTO actually requested it.',
    '',
    'ALSO NOTE:',
    '  - ScheduleWakeup does NOT survive pause_persistent_task. Once your',
    '    session ends, the wakeup is lost. Stop relying on it for revival.',
    '  - See agents/plan-manager.md and agents/persistent-monitor.md',
    '    "Wait Patterns" section for the full rules.',
  ].join('\n')
);
