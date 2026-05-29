#!/usr/bin/env node
/**
 * PostToolUse Hook: CTO Per-Turn Worktree Advisory (Fix 9)
 *
 * Fires after Task tool calls in interactive lockdown-off CTO sessions.
 *
 * Purpose: nudge the agent toward the per-turn worktree model. The
 * architectural ideal is one worktree PER TURN; today the CTO has just
 * one shared `cto-interactive-<sid8>` root worktree which accumulates
 * orphaned state across turns. This advisory hook surfaces the per-turn
 * primitive (`lib/cto-turn-worktree.js`) and the basename detection so
 * the AI can consciously choose to isolate turns.
 *
 * Non-blocking: emits `additionalContext` only when the Task was issued
 * with a `cwd` that points at the session's ROOT cto-interactive worktree
 * (not at an already-provisioned per-turn worktree).
 *
 * PostToolUse hooks MUST always exit 0 (the tool has already run).
 *
 * @version 1.0.0
 */

import path from 'path';
import {
  getActiveTurnWorktree,
  getRootCtoWorktree,
  isRootCtoBasename,
} from './lib/cto-turn-worktree.js';

const NOOP = JSON.stringify({ continue: true });

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }));
}

let event;
try {
  event = JSON.parse(await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf || '{}'));
  }));
} catch {
  process.stdout.write(NOOP);
  process.exit(0);
}

// Only fire on Task tool calls
if (event?.tool_name !== 'Task') {
  process.stdout.write(NOOP);
  process.exit(0);
}

// Only fire in interactive (non-spawned) sessions
if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  process.stdout.write(NOOP);
  process.exit(0);
}

const taskCwd = event?.tool_input?.cwd || '';
const subagentType = event?.tool_input?.subagent_type || '';
const sessionId = event?.session_id || '';

// Read-only / non-pipeline sub-agents: skip the nudge entirely. The
// per-turn model is for the six-step pipeline; lightweight Explore/Plan
// /investigator calls don't need a fresh worktree.
const SKIP_AGENTS = new Set(['Explore', 'Plan', 'investigator']);
if (SKIP_AGENTS.has(subagentType)) {
  process.stdout.write(NOOP);
  process.exit(0);
}

const rootWorktree = getRootCtoWorktree(sessionId);
if (!rootWorktree) {
  // Lockdown is on, or no root cto-interactive worktree recorded.
  process.stdout.write(NOOP);
  process.exit(0);
}

// If the Task targeted somewhere other than the CTO root worktree,
// silent. Includes per-turn worktrees (which contain the root path as a
// prefix but with a longer basename).
const cwdBase = taskCwd ? path.basename(taskCwd) : '';
if (!isRootCtoBasename(cwdBase)) {
  // Either no cwd was passed (then this Task ran in the parent session's
  // cwd, which is fine), or it was already routed to a per-turn worktree.
  process.stdout.write(NOOP);
  process.exit(0);
}

// Task targeted the ROOT cto-interactive worktree. Surface the per-turn
// alternative so the AI is aware it exists.
const active = getActiveTurnWorktree(sessionId);
if (active && active.worktreePath) {
  // A per-turn worktree IS active. Steer subsequent steps to use it.
  emit([
    '### CTO Per-Turn Worktree (Fix 9)',
    '',
    `A per-turn worktree is already active for this turn:`,
    `  cwd: ${active.worktreePath}`,
    `  branch: ${active.branch || '(unknown)'}`,
    '',
    'Subsequent pipeline steps in this turn should pass that path as `cwd`,',
    'not the root cto-interactive worktree. This isolates each pipeline turn',
    'and lets GENTYR auto-clean the worktree after the PR merges.',
  ].join('\n'));
  process.exit(0);
}

emit([
  '### CTO Per-Turn Worktree (Fix 9)',
  '',
  `This Task ran in the session’s ROOT cto-interactive worktree (${rootWorktree}).`,
  '',
  'Architectural ideal (Fix 9): each pipeline TURN gets its own fresh',
  '`cto-interactive-<sid8>-<turn>` worktree off the base branch, so concurrent',
  'turns can’t collide and orphaned state doesn’t accumulate across turns.',
  '',
  'For the rest of THIS turn, keep using the same cwd so all six pipeline steps',
  'share state. For the NEXT turn, prefer provisioning a fresh worktree.',
  '',
  '(The lifecycle ledger lives at .claude/state/cto-turn-worktrees.jsonl;',
  'plan-merge-tracker.js auto-marks `pr_merged=true` on PR merge so cleanup',
  'automation can prune merged turn worktrees.)',
].join('\n'));
