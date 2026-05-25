#!/usr/bin/env node
/**
 * audit-lane-guard.js
 *
 * PreToolUse hook that enforces the audit lane as a hard read-only sandbox.
 *
 * Auditors (universal-auditor, plan-auditor, authorization-auditor) are
 * verification agents only. They MUST render exactly one verdict tool call
 * and exit. They MUST NOT edit files, spawn sub-agents, create PRs, or
 * wait in shell loops.
 *
 * On 2026-05-24 a universal-auditor for a Supabase migration task went
 * completely off-script: it called Edit 5×, spawned 5 Task() sub-agents
 * (investigator/code-reviewer/project-manager/user-alignment), opened
 * PR #3539 on an unrelated G001 issue, and then sat in a backgrounded
 * `until [ ... = MERGED ]; do sleep 15; done` loop for 10+ hours
 * waiting for its own PR to merge. The original audit was never rendered.
 *
 * Four layers failed to stop it: the agent's allowedTools list (not gate-
 * enforced), the 8-min TTL (only checked on queued items, not running),
 * the prompt's "render one verdict then exit" instruction, and the absence
 * of any audit-lane guard. This hook is layer 3 — the PreToolUse gate.
 *
 * The hook fast-exits for non-audit-lane sessions (env var check is O(1)).
 *
 * Detection: TWO signals, either is sufficient (defense-in-depth):
 *   1. `GENTYR_SESSION_LANE === 'audit'` (injected by session-queue's spawn)
 *   2. First user message in the session JSONL starts with
 *      `[Automation][universal-auditor]`, `[Automation][plan-auditor]`, or
 *      `[Automation][authorization-auditor]` (transcript_path inspection)
 *
 * Denials:
 *   - Edit / Write / NotebookEdit
 *   - Task (sub-agent spawn — auditors are leaf nodes)
 *   - Bash commands matching code-modifying or PR-mutation patterns
 *   - Bash commands using sleep/until/while/for as wait loops, especially
 *     when combined with run_in_background: true
 *
 * Allowances:
 *   - All Read / Glob / Grep
 *   - Read-only Bash (gh pr view, gh pr checks, git log/diff/status/show,
 *     test, cat, find, curl, pnpm test, etc.)
 *   - All MCP audit-verdict tools and MCP read tools
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
  approve();
}

// --------------------------------------------------------------------
// Audit-lane detection
// --------------------------------------------------------------------

const laneEnv = (process.env.GENTYR_SESSION_LANE || '').toLowerCase();
let isAuditLane = laneEnv === 'audit';

// Second signal: inspect the session JSONL's first user message for the
// auditor marker. Cheap (one fs.readFileSync of head of the file).
if (!isAuditLane) {
  const transcriptPath = input?.transcript_path;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.slice(0, bytes).toString('utf8');
      if (
        head.includes('[Automation][universal-auditor]') ||
        head.includes('[Automation][plan-auditor]') ||
        head.includes('[Automation][authorization-auditor]')
      ) {
        isAuditLane = true;
      }
    } catch {
      /* non-fatal */
    }
  }
}

if (!isAuditLane) {
  // Not an audit-lane session — let it through.
  approve();
}

// --------------------------------------------------------------------
// Audit-lane enforcement
// --------------------------------------------------------------------

const toolName = input?.tool_name || '';
const args = input?.tool_input || {};

const HARD_RULES_REMINDER = [
  '',
  'AUDIT-LANE HARD RULES (you cannot violate these):',
  '  1. You may NOT call Edit, Write, NotebookEdit, or Task.',
  '  2. You may NOT spawn sub-agents (auditors are leaf nodes).',
  '  3. You may NOT call code-modifying Bash commands (git commit/push/add,',
  '     gh pr create/merge, git stash/reset/checkout/rebase/merge/clean).',
  '  4. You may NOT use sleep/until/while/for loops as wait mechanisms.',
  '  5. If you find a real code issue, render *_audit_fail with the finding',
  '     in failure_reason + evidence. DO NOT fix it yourself.',
  '  6. Render ONE verdict (task_audit_pass/fail, pt_audit_pass/fail,',
  '     verification_audit_pass/fail, or cto_decision_audit_pass/fail)',
  '     and exit. You have 8 minutes.',
].join('\n');

// Tool-level denies
if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
  deny(
    [
      `audit-lane-guard: ${toolName} is BLOCKED for audit-lane sessions.`,
      '',
      'Auditors verify, they do not modify. If you found a real code issue,',
      'render the appropriate *_audit_fail tool with the finding as evidence.',
      'The completing agent (or next revival) will fix it — that is not your job.',
      HARD_RULES_REMINDER,
    ].join('\n')
  );
}

if (toolName === 'Task') {
  deny(
    [
      'audit-lane-guard: Task (sub-agent spawn) is BLOCKED for audit-lane sessions.',
      '',
      'Auditors are leaf nodes by design — they cannot spawn sub-agents.',
      'If you need additional verification, do it yourself with Read/Glob/Grep/Bash.',
      'If you cannot verify without delegating, that is a FAIL: render *_audit_fail',
      'with reason="cannot verify without delegating, scope too large".',
      HARD_RULES_REMINDER,
    ].join('\n')
  );
}

// --------------------------------------------------------------------
// Bash pattern enforcement
// --------------------------------------------------------------------

if (toolName === 'Bash') {
  const cmd = String(args.command || '');
  const runInBackground = args.run_in_background === true;

  // Sleep / loop pattern detection. We don't try to outsmart shell quoting —
  // simple lowercase token matches are enough for the misuse mode we saw.
  const lowerCmd = cmd.toLowerCase();

  // (a) Wait-loop patterns. These are the sleep-substitute that hijacked the
  //     auditor for 10 hours. Block them whether or not run_in_background.
  const hasUntilLoop = /\buntil\s+\[/.test(cmd) || /\buntil\s+\(/.test(cmd);
  const hasWhileLoop = /\bwhile\s+\[/.test(cmd) || /\bwhile\s+\(/.test(cmd);
  const hasForSleep = /\bfor\s+.+\bdo\b.*\bsleep\b/s.test(cmd);
  const hasSleep = /(^|[;&|\s])sleep\s+\d+/.test(cmd);

  if (hasUntilLoop || hasWhileLoop || hasForSleep) {
    deny(
      [
        'audit-lane-guard: shell wait-loop (until/while/for+sleep) is BLOCKED.',
        '',
        `Your command: ${cmd.slice(0, 200)}${cmd.length > 200 ? '...' : ''}`,
        '',
        'This is the exact sleep-substitute anti-pattern that hijacked an auditor',
        'for 10+ hours on 2026-05-24 (waiting for its own PR to merge). If you',
        'need to wait for a PR / CI / demo to complete, FAIL the audit with the',
        'current state as evidence — the next revival cycle will re-audit.',
        HARD_RULES_REMINDER,
      ].join('\n')
    );
  }

  // (b) Bare sleep > 10s (especially when backgrounded). Auditors should never
  //     need to sleep — verification is synchronous.
  if (hasSleep) {
    const m = cmd.match(/(^|[;&|\s])sleep\s+(\d+)/);
    const seconds = m ? Number(m[2]) : 0;
    if (seconds > 10 || runInBackground) {
      deny(
        [
          `audit-lane-guard: sleep ${seconds}s${runInBackground ? ' (backgrounded)' : ''} is BLOCKED.`,
          '',
          'Auditors verify synchronously. If something is not ready to verify,',
          'render *_audit_fail with the current state. The next revival cycle',
          'will retry.',
          HARD_RULES_REMINDER,
        ].join('\n')
      );
    }
  }

  // (c) Code-modifying git/gh commands.
  const codeModifyingPatterns = [
    { re: /\bgh\s+pr\s+create\b/, label: 'gh pr create' },
    { re: /\bgh\s+pr\s+merge\b/, label: 'gh pr merge' },
    { re: /\bgh\s+pr\s+edit\b/, label: 'gh pr edit' },
    { re: /\bgh\s+pr\s+close\b/, label: 'gh pr close' },
    { re: /\bgh\s+pr\s+comment\b/, label: 'gh pr comment' },
    { re: /\bgh\s+pr\s+review\b/, label: 'gh pr review' },
    { re: /\bgh\s+issue\s+create\b/, label: 'gh issue create' },
    { re: /\bgh\s+issue\s+edit\b/, label: 'gh issue edit' },
    { re: /\bgh\s+release\s+create\b/, label: 'gh release create' },
    { re: /\bgit\s+commit\b/, label: 'git commit' },
    { re: /\bgit\s+push\b/, label: 'git push' },
    { re: /\bgit\s+add\b/, label: 'git add' },
    { re: /\bgit\s+stash\b/, label: 'git stash' },
    { re: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
    { re: /\bgit\s+checkout\b(?!\s+(?:HEAD|--|[a-f0-9]{6,40}\s|\S+\.))/, label: 'git checkout (branch switch)' },
    { re: /\bgit\s+switch\b/, label: 'git switch' },
    { re: /\bgit\s+rebase\b/, label: 'git rebase' },
    { re: /\bgit\s+merge\b/, label: 'git merge' },
    { re: /\bgit\s+clean\b/, label: 'git clean' },
    { re: /\bgit\s+worktree\s+(add|remove)\b/, label: 'git worktree mutation' },
    { re: /\bnpm\s+publish\b/, label: 'npm publish' },
    { re: /\bpnpm\s+publish\b/, label: 'pnpm publish' },
    { re: /\byarn\s+publish\b/, label: 'yarn publish' },
  ];

  for (const { re, label } of codeModifyingPatterns) {
    if (re.test(cmd)) {
      deny(
        [
          `audit-lane-guard: '${label}' is BLOCKED for audit-lane sessions.`,
          '',
          `Your command: ${cmd.slice(0, 200)}${cmd.length > 200 ? '...' : ''}`,
          '',
          'Auditors verify, they do not commit / push / merge / publish.',
          'If verification of a PR is needed, use `gh pr view` or `gh pr checks`',
          'to inspect state — those are read-only and allowed.',
          HARD_RULES_REMINDER,
        ].join('\n')
      );
    }
  }

  // Bash otherwise passes through (read-only verification: gh pr view,
  // git log/diff/status/show, curl, test, cat, find, pnpm test, etc.)
  // We deliberately do NOT allowlist Bash — auditors legitimately need wide
  // read access to verify. We blocklist the known-bad patterns above.
}

// All MCP tools, Read, Glob, Grep, and read-only Bash pass through.
approve();
