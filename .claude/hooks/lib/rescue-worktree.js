// Helpers for rescueAbandonedWorktrees() in hourly-automation.js.
//
// The rescue mechanism previously had an unsafe prompt that did
// `git push` + `gh pr merge --squash` without first integrating
// new commits from origin/<base>. When a worktree's branch-point
// was days behind preview, the squash-merge could overwrite
// recently-merged work on preview (incident 2026-05-22, PRs #3419 / #3420).
//
// This module gives the rescue path two things:
//   1. `computeWorktreeDivergence` — measures how far the worktree
//      has diverged from its base branch and how fresh the dirty
//      files are, so we can tell "crashed mid-edit" from "stale orphan".
//   2. `buildRescuePrompt` — generates a prompt that mandates a
//      pre-rescue base-sync (fetch + merge --no-edit), opens a DRAFT
//      PR with full divergence stats in the body, and never auto-merges.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GIT_TIMEOUT_MS = 5000;

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the rescue base branch for a worktree.
 * Mirrors the prompt's existing fallback logic: prefer origin/preview,
 * fall back to origin/main. Returns the bare branch name (no "origin/").
 */
export function resolveBaseBranch(cwd) {
  const previewSha = runGit(['rev-parse', '--verify', 'origin/preview'], cwd);
  if (previewSha) return 'preview';
  const mainSha = runGit(['rev-parse', '--verify', 'origin/main'], cwd);
  if (mainSha) return 'main';
  return null;
}

/**
 * Compute divergence stats between a worktree's HEAD and origin/<base>.
 * All fields are best-effort — any inner failure leaves that field null
 * so the rescue prompt can still render (degraded but not blocked).
 *
 * @param {string} wtPath - absolute path to the worktree
 * @param {string} baseBranch - bare base branch name (e.g. "preview")
 * @returns {{
 *   baseBranch: string,
 *   commitsAhead: number|null,
 *   commitsBehind: number|null,
 *   filesChanged: number|null,
 *   linesChanged: number|null,
 *   branchAgeHours: number|null,
 *   dirtyFileNewestMtimeMs: number|null,
 *   dirtyFileOldestMtimeMs: number|null,
 *   dirtyFileCount: number,
 *   probableCase: 'fresh_crash'|'stale_orphan'|'unknown',
 * }}
 */
export function computeWorktreeDivergence(wtPath, baseBranch) {
  const baseRef = `origin/${baseBranch}`;

  // Try to bound staleness: fetch the base (short timeout, non-fatal).
  // We do not fail the rescue if this fails — the agent re-fetches inside
  // its session anyway. This just makes the displayed numbers fresher.
  try {
    execFileSync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
      cwd: wtPath,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal; we'll measure against whatever ref we have.
  }

  const aheadStr = runGit(['rev-list', '--count', `${baseRef}..HEAD`], wtPath);
  const behindStr = runGit(['rev-list', '--count', `HEAD..${baseRef}`], wtPath);
  const commitsAhead = aheadStr !== null ? Number(aheadStr) : null;
  const commitsBehind = behindStr !== null ? Number(behindStr) : null;

  // Diff stats against base — what the rescue would actually publish.
  let filesChanged = null;
  let linesChanged = null;
  const diffStat = runGit(['diff', '--shortstat', `${baseRef}...HEAD`], wtPath);
  if (diffStat) {
    const fileMatch = diffStat.match(/(\d+) files? changed/);
    const insertMatch = diffStat.match(/(\d+) insertions?/);
    const deleteMatch = diffStat.match(/(\d+) deletions?/);
    filesChanged = fileMatch ? Number(fileMatch[1]) : 0;
    linesChanged = (insertMatch ? Number(insertMatch[1]) : 0)
      + (deleteMatch ? Number(deleteMatch[1]) : 0);
  }

  // Branch age: time since HEAD commit.
  const headTsStr = runGit(['log', '-1', '--format=%ct', 'HEAD'], wtPath);
  const branchAgeHours = headTsStr
    ? Math.round((Date.now() / 1000 - Number(headTsStr)) / 36) / 100
    : null;

  // Dirty file mtimes: how recently was the working tree touched?
  // Critical signal for distinguishing "crashed mid-edit" (fresh mtimes)
  // from "stale orphan" (mtimes hours/days old).
  //
  // We must NOT use the trim-by-default runGit() helper here: porcelain
  // entries start with a status code pair like " M" (modified-in-worktree),
  // and .trim() would strip that leading space and corrupt the offset for
  // the filename slice below.
  let statusOut = null;
  try {
    statusOut = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: wtPath,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: 'pipe',
    });
  } catch {
    statusOut = null;
  }
  let dirtyFileNewestMtimeMs = null;
  let dirtyFileOldestMtimeMs = null;
  let dirtyFileCount = 0;
  if (statusOut) {
    const entries = statusOut.split('\0').filter(Boolean);
    for (const entry of entries) {
      // Porcelain format: 2-char status code, space, then the path.
      const filePath = entry.length > 3 ? entry.slice(3) : null;
      if (!filePath) continue;
      const absPath = path.join(wtPath, filePath);
      try {
        const stat = fs.statSync(absPath);
        const mt = stat.mtimeMs;
        dirtyFileCount++;
        if (dirtyFileNewestMtimeMs === null || mt > dirtyFileNewestMtimeMs) {
          dirtyFileNewestMtimeMs = mt;
        }
        if (dirtyFileOldestMtimeMs === null || mt < dirtyFileOldestMtimeMs) {
          dirtyFileOldestMtimeMs = mt;
        }
      } catch {
        // File might have been deleted or be a submodule entry; ignore.
      }
    }
  }

  // Heuristic case classification — informational only, NOT a gate.
  // Fresh crash: newest dirty mtime within 30 min AND base not far ahead.
  // Stale orphan: newest dirty mtime > 4h OR base > 20 commits ahead.
  let probableCase = 'unknown';
  const newestAgeMs = dirtyFileNewestMtimeMs
    ? Date.now() - dirtyFileNewestMtimeMs
    : null;
  const isFresh = newestAgeMs !== null && newestAgeMs < 30 * 60 * 1000;
  const isStale = (newestAgeMs !== null && newestAgeMs > 4 * 60 * 60 * 1000)
    || (commitsBehind !== null && commitsBehind > 20);
  if (isStale) probableCase = 'stale_orphan';
  else if (isFresh) probableCase = 'fresh_crash';

  return {
    baseBranch,
    commitsAhead,
    commitsBehind,
    filesChanged,
    linesChanged,
    branchAgeHours,
    dirtyFileNewestMtimeMs,
    dirtyFileOldestMtimeMs,
    dirtyFileCount,
    probableCase,
  };
}

function formatAge(ms) {
  if (ms === null || ms === undefined) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 2.4) / 10;
  return `${days}d ago`;
}

function formatStats(stats) {
  if (!stats) return '_(divergence stats unavailable)_';
  const lines = [
    `- Base branch: \`origin/${stats.baseBranch}\``,
    `- Commits ahead of base: ${stats.commitsAhead ?? 'unknown'}`,
    `- Commits behind base: ${stats.commitsBehind ?? 'unknown'}`,
    `- Files changed vs base: ${stats.filesChanged ?? 'unknown'}`,
    `- Lines changed vs base: ${stats.linesChanged ?? 'unknown'}`,
    `- Branch HEAD age: ${stats.branchAgeHours !== null ? `${stats.branchAgeHours}h` : 'unknown'}`,
    `- Dirty files in worktree: ${stats.dirtyFileCount}`,
    `- Newest dirty file mtime: ${formatAge(stats.dirtyFileNewestMtimeMs ? Date.now() - stats.dirtyFileNewestMtimeMs : null)}`,
    `- Oldest dirty file mtime: ${formatAge(stats.dirtyFileOldestMtimeMs ? Date.now() - stats.dirtyFileOldestMtimeMs : null)}`,
    `- Probable case: **${stats.probableCase}**`,
  ];
  return lines.join('\n');
}

/**
 * Build the rescue agent prompt.
 *
 * Three behavior changes vs. the legacy prompt:
 *
 *   (a) Mandatory base-sync: agent MUST run
 *       `git fetch origin <base> && git merge origin/<base> --no-edit`
 *       BEFORE staging anything. On conflict the agent files a bypass
 *       request and exits rather than committing a half-merged state.
 *
 *   (c) No auto-merge: the PR is opened as a DRAFT and the agent exits.
 *       Triage decides whether to merge. This removes the destructive
 *       failure mode from the rescue path entirely — the worst case is
 *       a noisy PR queue, not an overwritten preview.
 *
 *   (PR body) Divergence stats are rendered into the PR body so a
 *       reviewer can spot a Case-B "stale orphan" rescue at a glance.
 */
export function buildRescuePrompt({ agentId, wtPath, wtBranch, baseBranch, stats }) {
  const baseDisplay = baseBranch ?? 'preview';
  const statsBlock = formatStats(stats);
  return `[Automation][rescue-project-manager][AGENT:${agentId}] You are a project-manager rescuing potentially-abandoned work in a worktree.

## Context

A previous agent left uncommitted changes in this worktree at: ${wtPath}
Branch: ${wtBranch}
Detected base branch: origin/${baseDisplay}

Divergence snapshot at rescue time:
${statsBlock}

## Mission — read carefully, the steps are ordered for a reason

The rescue automation now distinguishes between two cases:

  (A) Genuine crash mid-edit — your job is to preserve the new work.
  (B) Stale orphan — the worktree is days out of date and its dirty state
      is mostly noise; merging it would overwrite recent work on the base.

To keep both cases safe, you MUST integrate the latest base branch
**before** publishing anything, and you MUST NOT auto-merge.

### Step 1 — Inspect

1. \`git status\` — confirm there are still uncommitted changes.
2. \`git diff\` — understand what changed; cross-check against the
   divergence snapshot above. If \`commits behind base\` is large or the
   probable case is \`stale_orphan\`, treat the diff with extra skepticism:
   the files you would commit may already be superseded on \`origin/${baseDisplay}\`.

### Step 2 — Mandatory base-sync BEFORE staging anything

\`\`\`
git fetch origin ${baseDisplay}
git merge origin/${baseDisplay} --no-edit
\`\`\`

- If merge succeeds cleanly: continue.
- If merge fails with conflicts: do NOT attempt to resolve them blindly.
  Run \`git merge --abort\`, then call
  \`mcp__agent-tracker__submit_bypass_request\` with
  \`category: "scope"\`, summary describing the conflict, and exit.
  Do NOT push, do NOT open a PR, do NOT auto-resolve.

This step is non-negotiable — it surfaces the Case-B "stale orphan"
problem as a conflict instead of silently overwriting recent work.

### Step 3 — Stage and commit

1. \`git add <specific files>\` (never \`git add .\`).
2. Commit with a descriptive message that mentions the worktree branch
   and the divergence snapshot above.

### Step 4 — Push and open a DRAFT PR (do NOT merge)

\`\`\`
git push -u origin HEAD
BASE=$(git rev-parse --verify origin/preview 2>/dev/null && echo preview || echo main)
\`\`\`

Then create the PR as a **draft** with the divergence snapshot in the body:

\`\`\`
gh pr create --draft --base "$BASE" --head "$(git branch --show-current)" \\
  --title "Rescue (draft): ${wtBranch}" \\
  --body "$(cat <<'EOF'
Automated rescue of potentially-abandoned worktree changes.

This PR is intentionally a **DRAFT**. The rescue automation no longer
auto-merges, because doing so previously overwrote recently-merged work
when the source worktree was stale. A human or deputy-CTO must verify
the changes are wanted and not duplicating already-merged commits
before marking it ready and merging.

### Divergence snapshot at rescue time
${statsBlock}

### What to check before marking ready
1. Confirm the listed files are still wanted and not superseded on the base branch.
2. Confirm the line-count and probable-case classification match expectations.
3. If \`probable case\` is \`stale_orphan\`, strongly consider closing this PR and discarding the worktree instead of merging.
EOF
)"
\`\`\`

### Step 5 — Hand off and exit

DO NOT run \`gh pr merge\`. The rescue path no longer auto-merges.

Notify the deputy-CTO so the PR gets triaged. The exact tool is
\`mcp__agent-reports__report_to_deputy_cto\` (or whichever report tool
is wired in this project); include the PR URL, the divergence snapshot
above, and the probable case classification.

DO NOT remove the worktree directory — cleanup automation handles it
after the PR is decided. Your job is only to safely capture the work,
hand it off for review, and exit.

Summarize what you did (or why you bailed) and exit.`;
}
