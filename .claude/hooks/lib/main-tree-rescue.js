// Helpers for the `repair_main_tree_drift` MCP tool.
//
// When the CTO runs `pnpm demo:local` (or any command that detaches HEAD)
// or leaves uncommitted work in the main tree, the `preview-watcher.js`
// daemon refuses to fast-forward `origin/preview` into the main tree —
// breaking HMR for `pnpm demo:preview` until a human manually unblocks it.
//
// This module powers an MCP-triggered repair flow that:
//   1. Detects the drift state (live, with a fallback to the watcher's
//      cached `.claude/state/main-tree-drift.json`).
//   2. Builds a rescue-agent prompt that salvages any orphaned work to a
//      draft PR (mirroring the abandoned-worktree rescue pattern) before
//      restoring the main tree to the base branch.
//
// The rescue agent is spawned with `GENTYR_MAIN_TREE_REPAIR=true` so the
// main-tree-commit-guard and branch-checkout-guard allow the operations
// it needs (commit, checkout -b, pull --ff-only).

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  computeWorktreeDivergence,
  resolveBaseBranch,
} from './rescue-worktree.js';

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

function readDriftStateFile(projectDir) {
  try {
    const stateFile = path.join(projectDir, '.claude', 'state', 'main-tree-drift.json');
    if (!fs.existsSync(stateFile)) return null;
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectMidMerge(gitDir) {
  // git stores in-progress state under .git/{MERGE_HEAD,REBASE_HEAD,rebase-merge,rebase-apply}
  // For the main tree, .git is a directory we can probe directly.
  const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  for (const m of markers) {
    if (fs.existsSync(path.join(gitDir, m))) return true;
  }
  return false;
}

/**
 * Inspect the main tree for drift conditions.
 *
 * Returns a shape compatible with the existing main-tree-drift.json fields,
 * augmented with live `detached` and `divergence` fields. Falls back to the
 * watcher's cached state file for any field we cannot recompute live.
 *
 * @param {string} projectDir - absolute path to the project root
 * @returns {{
 *   drifted: boolean,
 *   currentBranch: string|null,
 *   baseBranch: string|null,
 *   dirty: boolean,
 *   midMerge: boolean,
 *   detached: boolean,
 *   divergence: object|null,
 *   stateSource: 'live'|'cached'|'mixed',
 * }}
 */
export function detectMainTreeDrift(projectDir) {
  const gitPath = path.join(projectDir, '.git');
  let gitDir = null;
  try {
    const stat = fs.lstatSync(gitPath);
    if (stat.isDirectory()) gitDir = gitPath;
  } catch {
    // No .git — not a repo; nothing to do.
  }

  if (!gitDir) {
    return {
      drifted: false,
      currentBranch: null,
      baseBranch: null,
      dirty: false,
      midMerge: false,
      detached: false,
      divergence: null,
      stateSource: 'live',
    };
  }

  const cached = readDriftStateFile(projectDir);

  // Live branch detection. `git branch --show-current` is empty on detached HEAD.
  const liveBranch = runGit(['branch', '--show-current'], projectDir);
  const detached = liveBranch === '' || liveBranch === null;
  const currentBranch = detached
    ? (runGit(['rev-parse', '--short', 'HEAD'], projectDir) || 'HEAD')
    : liveBranch;

  const baseBranch = resolveBaseBranch(projectDir);

  // Dirty check — porcelain output non-empty means working tree has changes.
  const status = runGit(['status', '--porcelain'], projectDir);
  const dirty = status !== null && status.length > 0;

  const midMerge = detectMidMerge(gitDir);

  // Divergence stats best-effort. computeWorktreeDivergence works on any git
  // working dir, not just worktrees — it just runs git commands in `cwd`.
  let divergence = null;
  if (baseBranch) {
    try {
      divergence = computeWorktreeDivergence(projectDir, baseBranch);
    } catch {
      divergence = null;
    }
  }

  // Drift = a state the preview-watcher CANNOT auto-correct on its own.
  //
  //   - Dirty + on base branch: NOT drift. The CTO is actively editing on the
  //     base branch (normal in the gentyr repo). The watcher's "already on
  //     base branch → no-op" gate short-circuits before it would refuse.
  //   - Wrong branch + clean: NOT drift. The watcher will `git checkout
  //     <baseBranch> && git pull --ff-only` itself on the next tick.
  //   - Wrong branch + dirty: drift — watcher cannot checkout without
  //     losing uncommitted work.
  //   - Detached HEAD (any): drift — watcher cannot checkout without losing
  //     the detached commits.
  //   - Mid-merge / mid-rebase (any): drift — watcher cannot pull while a
  //     merge is in progress.
  const onBase = currentBranch === baseBranch && !detached;
  const drifted = Boolean(
    baseBranch && (
      detached
      || midMerge
      || (!onBase && dirty)
    )
  );

  const stateSource = cached ? 'mixed' : 'live';

  return {
    drifted,
    currentBranch,
    baseBranch,
    dirty,
    midMerge,
    detached,
    divergence,
    stateSource,
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
    `- Dirty files: ${stats.dirtyFileCount}`,
    `- Newest dirty file mtime: ${formatAge(stats.dirtyFileNewestMtimeMs ? Date.now() - stats.dirtyFileNewestMtimeMs : null)}`,
    `- Oldest dirty file mtime: ${formatAge(stats.dirtyFileOldestMtimeMs ? Date.now() - stats.dirtyFileOldestMtimeMs : null)}`,
    `- Probable case: **${stats.probableCase}**`,
  ];
  return lines.join('\n');
}

/**
 * Build the main-tree-repair agent prompt.
 *
 * Hard rules baked in:
 *   - MUST end with main tree on the base branch (preview/main).
 *   - NEVER auto-merges the rescue PR — always opens as draft.
 *   - On merge conflicts or non-fast-forward, files a bypass request and exits.
 *   - Salvages BOTH detached commits (via checkout -b) AND dirty work (via commit).
 */
export function buildMainTreeRescuePrompt({
  agentId,
  projectDir,
  baseBranch,
  currentBranch,
  dirty,
  midMerge,
  detached,
  divergence,
  reason,
}) {
  const baseDisplay = baseBranch ?? 'preview';
  const statsBlock = formatStats(divergence);
  const reasonBlock = reason ? `\nRepair was requested with reason: ${reason}\n` : '';

  return `[Automation][rescue-main-tree][AGENT:${agentId}] You are a project-manager repairing main-tree drift in: ${projectDir}

## Context

The main working tree has drifted from its base branch, blocking the
preview-watcher daemon from fast-forwarding \`origin/${baseDisplay}\` into
the tree. While the tree stays drifted, \`pnpm demo:preview\` (and any
other dev process running in the main tree) will not see new commits
merged to \`${baseDisplay}\` — HMR is broken until this is fixed.
${reasonBlock}
Detected state:
- Current branch: \`${currentBranch ?? 'unknown'}\`${detached ? ' **(detached HEAD)**' : ''}
- Expected base: \`origin/${baseDisplay}\`
- Working tree dirty: ${dirty ? '**YES**' : 'no'}
- Mid-merge / mid-rebase: ${midMerge ? '**YES**' : 'no'}

Divergence snapshot at repair time:
${statsBlock}

## Mission

Restore the main tree to \`${baseDisplay}\` so the preview-watcher can
resume. **Preserve any orphaned work** by salvaging it to a rescue branch
with a DRAFT PR — never discard work without human review.

The standard main-tree guards (\`main-tree-commit-guard\`, \`branch-checkout-guard\`)
have been temporarily bypassed for this session via the
\`GENTYR_MAIN_TREE_REPAIR=true\` env var. Use this authority narrowly:
ONLY the operations described below. No feature edits. No cleanup of
unrelated files. No commits unrelated to the rescue branch.

### Step 1 — Inspect

\`\`\`
git status
git rev-parse --abbrev-ref HEAD
git log -3 --oneline
\`\`\`

Confirm the state matches what was passed in above. If the tree is
already clean and on \`${baseDisplay}\`, run
\`mcp__agent-tracker__summarize_work\` reporting "no drift detected"
and exit immediately — do not proceed.

### Step 2 — Abort any in-progress merge/rebase

If \`MERGE_HEAD\` / \`REBASE_HEAD\` / a rebase directory exists, abort it:

\`\`\`
git merge --abort 2>/dev/null || true
git rebase --abort 2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true
git revert --abort 2>/dev/null || true
\`\`\`

If the abort fails for any reason, **do not attempt to resolve manually**.
Call \`mcp__agent-tracker__submit_bypass_request\` with
\`category: "scope"\` summarizing the conflict, then exit.

### Step 3 — Salvage orphaned work to a rescue branch

If EITHER the tree is dirty OR HEAD is detached on a commit that is
not reachable from \`origin/${baseDisplay}\`, salvage:

\`\`\`
TS=$(date -u +%Y%m%dT%H%M%SZ)
RESCUE_BRANCH="rescue/main-tree-$TS"
git checkout -b "$RESCUE_BRANCH"
\`\`\`

Then capture any dirty work:

\`\`\`
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Rescue: salvage main-tree work before drift repair

Captured by repair_main_tree_drift while restoring main tree to origin/${baseDisplay}.
See PR body for divergence snapshot."
fi
\`\`\`

Push and open a **DRAFT** PR with the divergence stats in the body:

\`\`\`
git push -u origin "$RESCUE_BRANCH"
gh pr create --draft --base "${baseDisplay}" --head "$RESCUE_BRANCH" \\
  --title "Rescue (draft): main-tree drift repair $TS" \\
  --body "$(cat <<'EOF'
Automated rescue of main-tree work captured during a drift repair.

This PR is intentionally a **DRAFT**. The repair automation does not
auto-merge — a human or deputy-CTO must verify the changes are wanted
and not duplicating already-merged commits before marking it ready.

### Why this PR exists

The main working tree at the project root had drifted from its base
branch (detached HEAD, dirty working tree, or both). The
\`repair_main_tree_drift\` MCP tool spawned this rescue session to
restore the main tree so the preview-watcher could resume — but did
not want to discard any in-progress work, so it captured everything
to this branch.

### Divergence snapshot at repair time
${statsBlock}

### What to check before marking ready
1. Confirm the listed files are still wanted and not superseded on \`${baseDisplay}\`.
2. If \`probable case\` is \`stale_orphan\`, strongly consider closing this PR.
3. If the commit message is unhelpful (rescue salvages mixed state), edit it before marking ready.
EOF
)"
\`\`\`

If \`git push\` fails (e.g., branch already exists remotely), append a
short hex suffix and retry once. If the second push fails, file a
bypass request and exit.

### Step 4 — Restore the main tree to the base branch

\`\`\`
git checkout ${baseDisplay}
git pull --ff-only origin ${baseDisplay}
\`\`\`

- If \`git pull --ff-only\` fails (non-fast-forward — meaning local
  \`${baseDisplay}\` has commits not on origin), **do NOT force**.
  Call \`mcp__agent-tracker__submit_bypass_request\` with
  \`category: "scope"\` summarizing the divergence and exit. The
  CTO must decide whether to reset, rebase, or investigate.

### Step 5 — Verify

\`\`\`
git status
git rev-parse --abbrev-ref HEAD
\`\`\`

The tree MUST be clean and on \`${baseDisplay}\`. If either check
fails, file a bypass request explaining what's still off and exit
without claiming success.

### Step 6 — Hand off

DO NOT run \`gh pr merge\`. The repair path never auto-merges.

If you opened a rescue PR, notify the deputy-CTO via
\`mcp__agent-reports__report_to_deputy_cto\` (or the project's report
tool) with the PR URL, the divergence snapshot above, and the probable
case classification.

Summarize what you did (or why you bailed) and exit.`;
}
