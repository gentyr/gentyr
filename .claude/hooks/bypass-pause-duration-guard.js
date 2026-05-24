#!/usr/bin/env node
/**
 * bypass-pause-duration-guard.js  (FIX-32)
 *
 * PreToolUse hook on `mcp__agent-tracker__submit_bypass_request`.
 *
 * Defense-in-depth against the failure mode discovered in plan c0781f93
 * (Dashboard Overhaul): the plan-manager used `submit_bypass_request` with
 * `pause_duration_minutes=60` as a sleep substitute after the no-sleep guard
 * blocked `sleep 120`. The bypass tool description does not warn against this
 * misuse, and the timed_pause_auto_resume infrastructure failed (SQL bug),
 * leaving the plan-manager paused for >3 hours past its auto-resume deadline.
 *
 * This guard:
 *   1. HARD-DENIES any pause_duration_minutes > 60 unless the agent provides
 *      explicit CTO pre-approval (via record_cto_decision with
 *      decision_type='long_bypass' and a matching verbatim "CTO_PRE_APPROVED"
 *      token in the bypass summary).
 *   2. For SPAWNED sessions, injects an `additionalContext` reminder pointing
 *      at the "wait patterns" agent prompt section — even if the request is
 *      allowed through, the agent sees clear guidance to prefer exit+revival
 *      over self-pause for waits under 5 minutes.
 *   3. Interactive (non-spawned) sessions are unrestricted.
 *
 * The plan's SLA invariant — "no plan paused >1h without CTO approval" — is
 * enforced at three layers: agent prompts (guidance), this hook (input
 * validation), and the bypass_sla_enforcer block in hourly-automation.js
 * (recovery). This is the input-validation layer.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_PAUSE_MINUTES_WITHOUT_APPROVAL = 60;

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

function deny(reason, opts = {}) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  if (opts.systemMessage) out.systemMessage = opts.systemMessage;
  emit(out);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // Malformed input — fail open so we don't break unrelated tools
  approve();
}

const toolName = input?.tool_name || '';
if (toolName !== 'mcp__agent-tracker__submit_bypass_request') {
  // Only this specific tool — fast-exit for everything else
  approve();
}

const args = input?.tool_input || {};
const requested = Number(args.pause_duration_minutes);

// No pause_duration_minutes means indefinite pause → CTO will see it on next
// briefing; that's the correct path, allow.
if (!Number.isFinite(requested) || requested <= 0) {
  approve();
}

const isSpawned =
  process.env.CLAUDE_SPAWNED_SESSION === 'true' ||
  process.env.CLAUDE_SPAWNED_SESSION === '1';

// Hard cap: anything > 60 minutes requires explicit CTO pre-approval.
if (requested > MAX_PAUSE_MINUTES_WITHOUT_APPROVAL) {
  // Check for a matching cto_decisions row.
  let approved = false;
  try {
    const bypassDbPath = path.join(
      PROJECT_DIR,
      '.claude',
      'state',
      'bypass-requests.db'
    );
    if (fs.existsSync(bypassDbPath)) {
      const db = new Database(bypassDbPath, { readonly: true });
      db.pragma('busy_timeout = 1000');
      try {
        const summary = String(args.summary || '');
        // Look for a recent (last 30 min) long_bypass decision whose verbatim
        // text appears as a substring of the bypass summary.
        const candidates = db
          .prepare(
            `SELECT verbatim_text FROM cto_decisions
             WHERE decision_type = 'long_bypass'
               AND status IN ('verified', 'audit_passed', 'consumed')
               AND created_at >= datetime('now', '-30 minutes')`
          )
          .all();
        for (const row of candidates) {
          const verbatim = String(row.verbatim_text || '').trim();
          if (
            verbatim &&
            verbatim.length >= 8 &&
            summary.includes(verbatim)
          ) {
            approved = true;
            break;
          }
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Fail closed on DB error — long bypasses are rare; better to deny + ask
    // CTO than to allow an unverified > 60min self-pause.
    approved = false;
  }

  if (!approved) {
    deny(
      [
        `Bypass duration ${requested}m exceeds the 60-minute self-pause cap.`,
        '',
        'Tasks must not be paused for more than 60 minutes without explicit',
        'CTO pre-approval. Two correct options:',
        '',
        '1. Use a shorter pause_duration_minutes (≤60) — the timed-pause',
        '   auto-resume + bypass_sla_enforcer will recover within minutes',
        '   regardless of any single-path failure.',
        '',
        '2. Omit pause_duration_minutes entirely — the CTO will see this',
        '   request on their next interactive session briefing and resolve',
        '   it with full context.',
        '',
        '3. For genuinely long, CTO-approved waits, request approval first:',
        '   the CTO must call record_cto_decision({ decision_type:',
        "   'long_bypass', verbatim_text: '<token>' }) and you must include",
        "   the verbatim '<token>' string in your bypass summary.",
        '',
        'See: agents/plan-manager.md "Wait patterns" section.',
      ].join('\n')
    );
  }
}

// For spawned sessions, inject a non-blocking nudge about the wait pattern
// alternatives. This is the "guidance" tier — even if the request is allowed
// through, the agent sees clear text about preferring exit+revival.
if (isSpawned) {
  approve({
    additionalContext: [
      'NUDGE — bypass duration check:',
      '',
      `You are requesting a ${requested}-minute self-pause via submit_bypass_request.`,
      '',
      'Wait pattern reminder:',
      '  - Waiting <5min  → end your cycle, summarize_work, exit. Revival',
      '                     respawns you in <30s. DO NOT submit_bypass_request.',
      '  - Waiting 5–60m  → end your cycle, summarize_work, exit. The next',
      '                     revival catches the CI/PR/demo result. Avoid',
      '                     submit_bypass_request unless something is',
      '                     genuinely blocked.',
      '  - Genuine blocker → submit_bypass_request WITHOUT pause_duration_minutes',
      '                     so the CTO sees it on next briefing.',
      '',
      'If this request is just a sleep substitute, cancel it and use the',
      'exit + revival pattern instead — that path is faster, cheaper, and',
      'cannot accidentally hold the task hostage past auto_resume_at.',
    ].join('\n'),
  });
}

// Default: allow.
approve();
