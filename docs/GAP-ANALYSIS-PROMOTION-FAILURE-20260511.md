# Gap Analysis: Preview-to-Staging Promotion Failure (May 10-11, 2026)

## Executive Summary

A CTO-initiated preview-to-staging promotion (`/promote-to-staging`) was triggered on May 10 at 22:03 UTC. The preview-promoter agent was correctly spawned via `trigger_preview_promotion` (PR #646 fix working as intended), but died within 1 second of spawning without writing any JSONL output. The promotion never executed its 6-step quality pipeline. No automatic recovery occurred. The automation's cooldown timer blocked retries for 47.75 hours.

**Root cause chain:**
1. The `automation/preview-promotion` worktree had broken relative symlinks (`.claude/settings.json -> .claude/settings.json` — circular)
2. Claude Code crashed on startup when it couldn't read the settings file (ENOENT)
3. The revival daemon skipped the dead promoter because it had no `taskId` in metadata
4. The `promotion_retry_check` (PR #647) cleared the SHA gate but couldn't bypass the cooldown timer
5. A double-multiplication bug in `getCooldown()` inflated the cooldown to 47.75 hours

## Detailed Timeline

### Phase 1: Earlier Promotion Attempt (May 10, 12:43-16:29 UTC)

| Time | Event | Session | Outcome |
|------|-------|---------|---------|
| 12:43 | CTO runs `/promote-to-staging` (pre-PR #646) | Interactive | Agent deviates — creates PROJECT-MANAGER task instead of spawning preview-promoter |
| 12:44 | Task-runner agent spawned for promotion | sq-mozrla9d | Runs in own worktree, exhausts 585KB context on investigator/alignment sub-agents |
| ~14:00 | Agent creates continuation task 9c32a995 | — | Continuation task bypasses preview-promoter pipeline entirely |
| 14:33 | Automation fires `preview_promotion` | sq-mozvihc8 | Spawns in broken promotion worktree. **Large Promotion Guard** fires (5153 lines). Reports and exits. Sets cooldown. |
| 15:23 | Force-spawn of continuation task | sq-mozxagqn | Agent `mozxagt8` starts working in a DIFFERENT worktree (feature/ branch) |
| 15:51 | Revival attempt in promotion worktree | sq-mozyaim4 | **Dies immediately** — broken settings.json symlink |
| 15:53 | Second revival in promotion worktree | sq-mozycbqj | **Dies immediately** — same cause |
| 16:05 | `npx gentyr sync` runs | — | Kills all running sessions, spawns revivals |
| 16:05 | Sync-revived sessions spawn | sq-mozysdr3, sq-mozysemy | mozysdsm starts in feature/ worktree (working symlinks) |
| 16:15 | mozysdsm merges staging INTO preview | — | **Wrong direction** — pollutes preview branch |
| 16:25 | CTO's second `/promote-to-staging` call | sq-mozzib8h | Correctly uses `trigger_preview_promotion`. Spawns `agent-mozzibbj` in broken promotion worktree. **Dies in 3 seconds.** |
| 16:26 | Revival daemon detects dead promoter | — | "No taskId for agent agent-mozzibbj, skipping revival" |
| 16:28 | mozysdsm pushes staging promotion commit | — | `5e24970a7` — 14 commits promoted. **Promotion succeeds via zombie session.** |
| 16:29 | CTO kills 3 zombie sessions | sq-mozysdr3, sq-mozysemy, sq-mozzj6nv | Killed 34 seconds AFTER the successful staging commit |

### Phase 2: Overnight Promotion Attempt (May 10, 22:03 UTC)

| Time | Event | Session | Outcome |
|------|-------|---------|---------|
| 22:03:27 | CTO runs `/promote-to-staging` again | Interactive | `trigger_preview_promotion` correctly called. 13 new commits detected. |
| 22:03:27 | Preview-promoter spawned | sq-mp0bknck | Agent `mp0bknf4` spawns in broken promotion worktree (PID 21662) |
| 22:03:28 | **Agent dies** (1 second) | — | Broken `.claude/settings.json` symlink → ENOENT → Claude crash. No JSONL written. |
| 22:03:28 | Revival daemon fires | — | "No taskId for agent agent-mp0bknf4-b1429c6b, skipping revival" → `revival_candidate: false` |

### Phase 3: Cooldown Lockout (May 11, 00:00-09:21+ UTC)

| Time | Event | Outcome |
|------|-------|---------|
| Ongoing | Hourly automation cycles | `preview_promotion` cooldown blocks: "2865m until next run" (47.75 hours from 14:33 May 10) |
| 09:21 | `promotion_retry_check` fires | SHA cleared (no active promotion, drift exists). But cooldown timer NOT reset. |
| ~14:18 May 12 | Earliest automatic retry | 47.75 hours after the Large Promotion Guard set the cooldown on May 10 14:33 |

## Root Cause Analysis

### Root Cause 1: Broken Worktree Symlinks (Primary Fatal Cause)

**What happened:** The `automation/preview-promotion` worktree was provisioned before the current code that creates absolute symlinks. It has 5 broken relative symlinks:

```
.claude/settings.json -> .claude/settings.json   (circular — resolves to .claude/.claude/settings.json)
.claude/hooks        -> .claude/hooks             (broken)
.claude/commands     -> .claude/commands           (broken)
.claude/mcp          -> .claude/mcp               (broken)
.claude/config       -> .claude/config             (broken)
```

Claude Code reads `.claude/settings.json` on startup to load hook configurations. The circular symlink resolves to a nonexistent path → ENOENT → crash before any JSONL output.

**Why GENTYR didn't catch it:**
- `createWorktree()` returns `{created: false}` when the worktree directory exists with `.git` and `.mcp.json` — **no re-provisioning occurs**
- The freshness system (5-layer) syncs git commits but does NOT validate symlink integrity
- The stale worktree reaper only removes CLEAN worktrees (>4 hours old). This worktree has dirty files (`CLAUDE.md` modified, `.claude/config` untracked) → classified as dirty → skipped
- The abandoned worktree rescue targets dirty worktrees with no active session, but the rescue may not have triggered for this ancient worktree
- CWD validation in `spawnQueueItem()` checks if the directory exists (it does) — doesn't validate internal symlinks

**Gap:** No symlink health check in `createWorktree()` for existing worktrees.

### Root Cause 2: No Revival Path for Promoter Sessions

**What happened:** Both dead promoters (`agent-mozzibbj` and `agent-mp0bknf4`) were detected by the revival daemon within seconds. But the daemon explicitly skips sessions without a `metadata.taskId`:

```
revival-daemon.log: "No taskId for agent agent-mp0bknf4-b1429c6b, skipping revival"
```

Promoter sessions spawned by `trigger_preview_promotion` and `spawnPreviewPromotion()` are enqueued WITHOUT a `taskId` because they intentionally bypass the task system (PR #646 design: direct `enqueueSession()` instead of `create_task`).

**Why GENTYR didn't catch it:**
- Revival daemon (`scripts/revival-daemon.js`): only revives sessions with `metadata.taskId`
- Session reviver (`session-reviver.js`): same — queries by `taskId`
- `drainQueue()` Step 1d (non-persistent revival): requires `taskId` or `persistentTaskId`
- `promotion_retry_check` (PR #647): clears SHA but doesn't directly spawn a new promoter

**Gap:** Promoter sessions have no recovery mechanism when they crash. The design intentionally bypassed tasks for correctness (PR #646), but didn't add an alternative revival path.

### Root Cause 3: Double-Multiplied Cooldown (47.75 Hours)

**What happened:** The `preview_promotion` cooldown was calculated as:

```
effective.preview_promotion (573) × rate_multiplier (5) = 2865 minutes = 47.75 hours
```

The `automation-config.json` stores `effective.preview_promotion: 573` — this is an adjusted value written by the automation rate optimizer. Then `getCooldown()` reads this value and multiplies it again by the rate multiplier (5x for 'low' rate, which is the default when `automation-rate.json` doesn't exist).

The Large Promotion Guard halt at 14:33 UTC May 10 set `lastPreviewPromotionCheck`, starting a 47.75-hour cooldown window.

**Gap:** Either the `effective` values should already incorporate the rate multiplier (making getCooldown's multiplication redundant), or the base value is being inflated. The result — a 47.75-hour cooldown for a promotion system that should retry within 30 minutes — is clearly wrong.

### Root Cause 4: `promotion_retry_check` Only Clears SHA, Not Cooldown

**What happened:** PR #647 added `promotion_retry_check` to detect failed promotions and allow retry. It correctly clears `lastPreviewPromotionSha` when no active promotion exists and drift is detected. But the primary gate is NOT the SHA — it's the cooldown timer (`lastPreviewPromotionCheck`), which `promotion_retry_check` does not reset.

```
09:21 UTC May 11:
  SHA: null (cleared by promotion_retry_check ✓)
  Cooldown: "Preview promotion cooldown active. 1738m until next run" (NOT cleared ✗)
```

**Gap:** `promotion_retry_check` should also reset `lastPreviewPromotionCheck` when the most recent promotion failed/died immediately (not just clear the SHA).

### Root Cause 5: Dead Promoter Marked `completed` Not `failed`

**What happened:** When the promoter crashes within 1 second, the session reaper marks it as `completed` (PID death is treated as completion). `promotion_retry_check` only clears SHA when `recent.status === 'failed'` — but the dead promoter is `completed`, so this path never fires.

The retry check's second condition (no active promotion + drift exists) does fire and clears SHA, but this is the weaker path that doesn't reset the cooldown.

**Gap:** Promoter sessions that die without producing any JSONL output should be marked `failed`, not `completed`. A 1-second session with no output is not a successful completion.

## Gap Matrix: GENTYR Mechanisms vs. This Failure

| GENTYR Mechanism | Expected Behavior | Actual Behavior | Gap? |
|-----------------|-------------------|-----------------|------|
| `createWorktree()` | Re-provision broken worktrees | Returns `{created: false}` — skips re-provisioning | **YES** — no symlink health check |
| Stale worktree reaper | Remove old unused worktrees | Skips dirty worktrees | **YES** — worktree with only untracked `.claude/config` is not truly "in use" |
| Worktree freshness (5-layer) | Keep worktrees current | Syncs git but doesn't validate symlinks | **YES** — no structural integrity check |
| Revival daemon | Revive dead sessions | Skips sessions without `taskId` | **YES** — promoters have no taskId |
| Session reviver | Revive dead sessions (10-min cycle) | Same — requires `taskId` | **YES** — same gap |
| `drainQueue()` Step 1d | Revive non-persistent dead sessions | Requires `taskId` | **YES** — same gap |
| `promotion_retry_check` | Allow retry after failure | Clears SHA but not cooldown | **PARTIAL** — incomplete recovery |
| `getCooldown()` | Return appropriate cooldown | Double-multiplies: effective × rate | **YES** — 47.75h instead of ~30min |
| Session reaper classification | Mark crashed sessions as `failed` | Marks 1-second deaths as `completed` | **YES** — no output = success? |
| CWD validation in `spawnQueueItem()` | Validate spawn environment | Checks directory exists, not internal health | **YES** — broken symlinks pass |
| `trigger_preview_promotion` MCP tool | Spawn healthy promoter | Spawns in broken worktree, returns success | **YES** — no pre-spawn health check |
| `staging-lock-guard` (PR #646) | Block non-pipeline staging ops | Working correctly | No — correctly deployed |
| tagContext promotion dedup (PR #648) | Prevent duplicate promotions | Working correctly | No — correctly deployed |
| Task deletion cascade (PR #648) | Kill sessions on task deletion | Working correctly (for task-based sessions) | No — correctly deployed |

## Fixes Required

### Immediate (Unblocks Promotion Now)

1. **Destroy broken worktree** and reset cooldown:
```bash
cd ~/git/<target-project>
git worktree remove --force .claude/worktrees/automation-preview-promotion
git branch -D automation/preview-promotion 2>/dev/null
# Reset cooldown in hourly-automation-state.json: lastPreviewPromotionCheck = 0
```
2. Re-trigger: `/promote-to-staging` or wait for next automation cycle

### Structural (Prevent Recurrence)

| # | Fix | File | Description |
|---|-----|------|-------------|
| 1 | Worktree symlink health check | `lib/worktree-manager.js` | In `createWorktree()`, when returning `{created: false}` for existing worktrees, validate that `.claude/settings.json` is readable (follows symlinks). If broken, force re-provision. |
| 2 | Promoter session revival | `lib/session-queue.js` or `scripts/revival-daemon.js` | Add a revival path for sessions with `tagContext: '*-promotion'` — don't require `taskId`. Alternatively, have `trigger_preview_promotion` create a lightweight tracking task. |
| 3 | Fix double cooldown multiplication | `config-reader.js` | Either treat `effective` values as post-rate (don't multiply again) or cap promotion cooldown at a reasonable maximum (e.g., 60 minutes). |
| 4 | `promotion_retry_check` should reset cooldown | `hourly-automation.js` | When a dead promotion is detected (completed/failed with no merge), reset BOTH `lastPreviewPromotionSha` AND `lastPreviewPromotionCheck`. |
| 5 | Classify no-output deaths as `failed` | `lib/session-reaper.js` | In `reapSyncPass()`, when a dead session has no JSONL file (or file is empty/missing), mark as `failed` not `completed`. |
| 6 | Pre-spawn health check in `trigger_preview_promotion` | `deputy-cto/server.ts` | Before calling `enqueueSession()`, verify the promotion worktree's `.claude/settings.json` is readable. If broken, destroy and let `createWorktree()` re-provision. |

## Cross-Reference: Fixes Already Shipped (This Session)

| PR | What It Fixed | Relevant to This Failure? |
|----|---------------|--------------------------|
| #646 | `trigger_preview_promotion` MCP tool, staging-lock-guard expansion | Yes — the MCP tool worked correctly. The guard would have blocked the zombie agent if it was deployed to the target project in time. |
| #647 | Self-healing loops (test failure, CI failure, SHA retry) | Partially — `promotion_retry_check` fired and cleared SHA, but couldn't bypass cooldown. |
| #648 | Task deletion cascade, promotion dedup, CI enforcement, reverse merge block | Yes — cascade kill would have stopped the zombie sessions. Reverse merge block would have prevented "merge staging into preview." |

## Lessons

1. **Worktree health is assumed, never verified.** The 5-layer freshness system tracks git state but not infrastructure integrity (symlinks, settings, MCP config). A worktree can be git-current but structurally broken.

2. **Bypassing the task system removes all recovery infrastructure.** PR #646 correctly moved promotion from task-based to direct-enqueue (to prevent category misrouting). But the revival daemon, session reviver, and drainQueue Step 1d all key on `taskId`. Promoter sessions became "unrecoverable by design."

3. **Cooldown timers are a single point of failure for time-sensitive operations.** A 47.75-hour cooldown on a promotion system that should retry every 30 minutes means a single failure locks out the entire pipeline for 2 days. Cooldown should be bounded and reset on infrastructure failures.

4. **"Completed" is not a safe default for dead sessions.** A session that dies in 1 second with no JSONL output did not "complete" — it crashed. The reaper should distinguish between graceful completion (terminal tool detected, JSONL present) and crash death (no output, sub-5-second lifetime).
