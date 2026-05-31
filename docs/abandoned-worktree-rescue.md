# The Abandoned Worktree Rescue subsystem

## The problem it solves

GENTYR runs many agents in parallel, each in its own git worktree at `.claude/worktrees/<branch>/`. An agent's normal lifecycle is: spawn → write code → commit → push → open PR → wait CI → merge → remove worktree. The framework tracks every spawned session in `session-queue.db` so it knows which worktrees are "owned."

But agents die. Process crashes, OOM kills, the broadcaster's parent session timing out, `npx gentyr sync` recycling everything, a network blip during a long demo. When that happens you can be left with a worktree that:
- has uncommitted file edits the agent had made
- has no live session attached
- isn't going to be picked up by anything else

Two failure modes if you ignore it:
- **Lost work.** A code-writer just spent 20 minutes implementing something, the process died right before commit, the uncommitted diff sits there forever and eventually some cleanup automation deletes the worktree.
- **Worktree clutter.** Even if the work is worthless, you accumulate dirty worktrees that block other tools (stale port allocations, worktree-exclusivity guards, disk space).

The rescue subsystem exists to handle the first case — salvage the work before it's discarded.

## How it works (pre-fix shape, for context)

In `hourly-automation.js`, every 15 minutes a function called `rescueAbandonedWorktrees()` runs. Conceptually:

1. List all worktrees under `.claude/worktrees/`.
2. For each one, decide: is this *abandoned*?
   - Skip `cto-interactive*` (yours).
   - Skip if no uncommitted changes (nothing to rescue).
   - Skip if `session-queue.db` shows an active session attached.
   - Skip if `interactive-sessions.json` shows a live CTO heartbeat on it.
   - Skip if `lsof +D` shows any process with files open in it (fail-closed on errors — assume in use).
3. If it survived all those skips, spawn a `project-manager` agent with `cwd: worktreePath` and a prompt that says: "commit, push, open PR to preview, self-merge with `--squash --delete-branch`."

The cleanup automation (`reapStaleWorktrees`, `cleanupMergedWorktrees`) handles removing the worktree afterward.

This is the surrounding machinery. Sibling subsystems handle the other corner cases:
- `reapStaleWorktrees()` — removes *clean* worktrees that are >4h old (no work to save).
- `cleanupMergedWorktrees()` — removes worktrees whose branch has already been merged.
- `reapOrphanProcesses()` — kills processes whose CWD is a deleted worktree.
- `reapSyncPass()` — reactive cleanup when a dead PID is detected mid-drain.

Rescue is specifically the path for "dirty + apparently abandoned."

## The bug we just fixed

The detection layer is reasonable — it makes a real effort to not hijack live work. But the prompt it handed the spawned `project-manager` was unsafe. It said:

```
1. git status / git diff
2. git add <files>
3. git commit
4. git push
5. gh pr create --base preview
6. gh pr merge --squash --delete-branch
```

Nowhere in those steps did it fetch the latest `origin/preview` or check whether the branch had drifted. So when:
- a worktree was created days ago against `preview@SHA-A`
- `preview` since moved forward to `SHA-B` with multiple intervening merges
- the worktree still has some dirty files (mostly noise — formatting, lockfile diffs, leftover stubs)

…the rescue would commit those stale files, push, and `--squash --delete-branch` them straight into `preview`, replacing whatever was there with the old version of the file. That's what produced the consumer-project incident: PR #3419 wiped a `pnpm-workspace.yaml` change and a `package.json` change that had been merged earlier that morning, breaking CI for ~25 min.

The detection layer can't tell the difference between:
- **Case A**: agent crashed mid-edit, work is genuinely new and lost-if-not-rescued.
- **Case B**: worktree is days stale, dirty files are noise on top of obsolete code, "rescuing" them overwrites recent work.

Both look identical: dirty worktree, no live session, no processes.

## What the fix changes

Three structural changes, all in the rescue **prompt** + a new helper module (`.claude/hooks/lib/rescue-worktree.js`):

1. **Mandatory pre-rescue base-sync.** The agent is now required to `git fetch origin <base> && git merge origin/<base> --no-edit` *before* it stages or pushes anything. If the merge conflicts (which is what Case B looks like — your stale files conflict with recent work on the base), the agent must `git merge --abort` and exit after writing a note for the CTO in `last_summary`, instead of trying to resolve blindly. This converts the silent-overwrite failure into a clear "I need help" signal.

2. **No more auto-merge.** The PR is opened with `gh pr create --draft` and the agent exits. The "self-merge" step is gone entirely. A human or the deputy-CTO triage flow decides whether the PR is real work worth merging. Worst case is now a noisy PR queue, not corrupted base branches.

3. **Rich PR body for review.** A new `computeWorktreeDivergence()` function measures, at enqueue time: commits ahead/behind the base, files/lines changed, branch HEAD age, dirty file mtimes (newest and oldest), and a probable-case heuristic (`fresh_crash` if newest dirty mtime <30 min and base hasn't moved much, `stale_orphan` if mtime >4h or behind >20 commits). All of that is rendered into the PR body so a reviewer can see "behind 42 commits, probable case: stale_orphan" and immediately close the PR rather than merge it.

The toggle that controls whether rescue runs at all (`abandonedWorktreeRescueEnabled`) is left at default-on — the mechanism is repaired, not removed.

## Why it's structured the way it is

The deeper lesson the bug taught: **the rescue path was making a destructive decision (squash-merge) based on a non-destructive signal (worktree appears abandoned)**. The decision and the signal need to be matched in reversibility.

Detection is best-effort and can have false positives — and that's fine, because the action it gates is now non-destructive (open a draft PR). Real destructive action (merging) is now gated by an independent human/triage decision that *can* see the divergence data and make an informed call. That's the same pattern GENTYR uses elsewhere: PreToolUse hooks block dangerous actions outright, but recoverable actions are allowed and then audited after the fact.
