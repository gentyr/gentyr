#!/usr/bin/env node
/**
 * PreToolUse Hook: PR Base Guard (Fix 6 of toasty-skipping-penguin plan)
 *
 * Blocks bare `gh pr create` (no `--head`/`--base` flags) when:
 *   1. Effective CWD is the main tree, AND
 *   2. The main tree's current branch is in the protected set
 *      (main / staging / preview in target projects, main in gentyr).
 *
 * Why: when an agent runs `cd /path/to/main-tree && gh pr create --title foo`,
 * gh defaults to opening `<current-branch> → <repo-default-branch>`, which
 * is almost never what the agent intended. In xy session a5b87d5f this
 * produced PR #3818 = preview → main when the agent intended
 * feature/cto-sidebar-layout-fix → preview. The CTO had to manually close
 * and re-open the PR.
 *
 * Recovery message (and autonomous self-correction):
 *   - Tells the agent to either `cd` into the feature worktree first
 *     OR pass explicit `--head <feature> --base <target>` flags.
 *   - Records a trip entry to `.claude/state/pr-base-guard-trip.jsonl`
 *     so PostToolUse / observability can correlate.
 *
 * Fast-exit paths:
 *   - GENTYR_PROMOTION_PIPELINE=true (legitimate promoter on main tree)
 *   - Tool is not Bash
 *   - Command does not include `gh pr create`
 *   - Command already passes BOTH --head and --base
 *
 * SECURITY: This hook should be root-owned via `npx gentyr protect`.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const TRIP_LOG = path.join(STATE_DIR, 'pr-base-guard-trip.jsonl');

// Protected branches by repo flavor. The gentyr repo only uses `main`;
// target projects use the full 4-stage chain. We accept the union — if a
// branch isn't in this set the guard fires nothing.
const PROTECTED_BRANCHES = new Set(['main', 'preview', 'staging']);

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

/**
 * Simple quote-aware tokenizer.
 * Borrowed pattern from main-tree-commit-guard.js — kept inline to avoid a
 * lib dep so this hook can run standalone in any worktree.
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of str) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Split on `&&` / `;` / `||` while respecting quotes. Returns the
 * sub-commands in order so we can simulate `cd X && gh pr create ...`.
 */
function splitOnAnd(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble && (
      (ch === '&' && command[i + 1] === '&') ||
      (ch === '|' && command[i + 1] === '|') ||
      ch === ';'
    )) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += (ch === ';') ? 1 : 2;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Resolve the effective CWD after sequentially applying any `cd` sub-commands.
 * Returns the absolute path of the directory the `gh pr create` would run in.
 */
function resolveEffectiveCwd(command, startCwd) {
  let cwd = startCwd;
  for (const sub of splitOnAnd(command)) {
    const toks = tokenize(sub);
    if (toks[0] === 'cd' && toks[1]) {
      const target = toks[1];
      cwd = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
    }
  }
  return cwd;
}

function commandHasGhPrCreate(command) {
  // Use a simple substring match first as a fast-exit.
  if (!command.includes('gh ') || !command.includes('pr create')) return false;
  // Confirm via tokens that `gh pr create` actually appears as a contiguous trio.
  for (const sub of splitOnAnd(command)) {
    const toks = tokenize(sub);
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i] === 'gh' && toks[i + 1] === 'pr' && toks[i + 2] === 'create') return true;
    }
  }
  return false;
}

function commandHasFlag(command, ...flags) {
  for (const sub of splitOnAnd(command)) {
    const toks = tokenize(sub);
    for (const t of toks) {
      for (const f of flags) {
        if (t === f || t.startsWith(`${f}=`)) return true;
      }
    }
  }
  return false;
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, stdio: 'pipe',
    }).trim();
  } catch {
    return '';
  }
}

function recordTrip(entry) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(TRIP_LOG, JSON.stringify(entry) + '\n');
  } catch { /* non-fatal */ }
}

async function main() {
  // Fast-exit: promotion pipeline is legitimately allowed to create from any cwd.
  if (process.env.GENTYR_PROMOTION_PIPELINE === 'true') return allow();

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try { event = JSON.parse(input); } catch { return allow(); }

  if (event?.tool_name !== 'Bash') return allow();
  const command = event?.tool_input?.command;
  if (!command || typeof command !== 'string') return allow();
  if (!commandHasGhPrCreate(command)) return allow();

  const startCwd = process.cwd();
  const rawEffective = resolveEffectiveCwd(command, startCwd);
  // Normalize symlinks (macOS /var ↔ /private/var, etc.) on both sides so
  // we don't false-allow because PROJECT_DIR and the actual cwd disagree
  // on which form they use.
  let effectiveCwd;
  let projectReal;
  try { effectiveCwd = fs.realpathSync(rawEffective); } catch { effectiveCwd = rawEffective; }
  try { projectReal = fs.realpathSync(PROJECT_DIR); } catch { projectReal = PROJECT_DIR; }

  const worktreesPrefix = path.join(projectReal, '.claude', 'worktrees') + path.sep;
  if (effectiveCwd === projectReal || effectiveCwd === projectReal + path.sep) {
    // We're in the main tree — continue to branch check.
  } else if (effectiveCwd.startsWith(worktreesPrefix)) {
    // Inside a worktree — `gh pr create` here is safe; the worktree's
    // current branch is the feature branch by construction.
    return allow();
  } else if (!effectiveCwd.startsWith(projectReal + path.sep)) {
    // Outside the project entirely (e.g., /tmp). Out of scope.
    return allow();
  }

  // Effective cwd is the main tree. Read its current branch.
  const branch = currentBranch(effectiveCwd);
  if (!branch || !PROTECTED_BRANCHES.has(branch)) {
    // Either we couldn't read the branch (fail-open) or it's not protected.
    return allow();
  }

  // At this point: main tree on a protected branch. Require explicit flags.
  const hasHead = commandHasFlag(command, '--head', '-H');
  const hasBase = commandHasFlag(command, '--base', '-B');
  if (hasHead && hasBase) return allow();

  // Block with autonomous self-correction guidance.
  const reason = [
    `Refusing bare \`gh pr create\` from the main tree on protected branch \`${branch}\`.`,
    '',
    `Without \`--head\`/\`--base\`, gh defaults to \`${branch} → <repo-default>\`, which`,
    'is almost never what you intended. (xy session a5b87d5f PR #3818 hit this exact',
    'footgun — preview → main when feature → preview was meant; the PR had to be',
    'closed and re-opened.)',
    '',
    'Two correct forms:',
    '  A) Run from the feature worktree (preferred):',
    `       cd <feature-worktree> && gh pr create --title "..." --body "..."`,
    '  B) Or pass explicit flags from anywhere:',
    `       gh pr create --head <feature-branch> --base <target> --title "..." --body "..."`,
    '',
    `In gentyr, <target> is \`main\`. In target projects with a 4-stage chain,`,
    '<target> is usually `preview`.',
  ].join('\n');

  recordTrip({
    ts: new Date().toISOString(),
    effective_cwd: effectiveCwd,
    branch,
    command_preview: command.slice(0, 200),
    had_head: hasHead,
    had_base: hasBase,
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

main().catch(() => allow());
