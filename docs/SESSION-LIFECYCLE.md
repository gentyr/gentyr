# GENTYR Session Lifecycle — Complete Inventory

This is the authoritative reference for the GENTYR session state machine — entry, spawning, reaping, revival, suspension, and the task / persistent task / plan lifecycles that depend on it. CLAUDE.md links here from the "Session Lifecycle" section.

## Session Status Values & State Machine

```
queued → spawning → running → completed
  ↓                    ↓
  cancelled            suspended → running (SIGCONT)
                       ↓
  queued → failed      completed (if PID dies while suspended)
```

**Statuses:** `queued`, `spawning`, `running`, `suspended`, `completed`, `failed`, `cancelled`

## Session Entry (Enqueueing)

**Function:** `enqueueSession()` in `session-queue.js`

Seven sequential gate checks before insertion:

| # | Gate | Condition | Result if blocked |
|---|------|-----------|-------------------|
| 1 | Validation | Missing required fields | Error |
| 2 | Task-level dedup | Same `taskId` already queued/running/spawning | Returns existing queueId |
| 3 | Persistent task dedup | Same `persistentTaskId` in persistent lane | Returns existing queueId |
| 4 | Plan-level dedup | Another **plan manager** (`isPlanManager: true`) for same `planId` already queued/running/spawning | Returns existing queueId |
| 5 | Worktree exclusivity | Same worktree/cwd in use by another session | `blocked: 'worktree_exclusive'` |
| 6 | Bypass request guard | Pending CTO bypass request for this task | `blocked: 'bypass_request'` |
| 7 | Focus mode gate | Focus mode enabled + not an allowed source/priority | `blocked: 'focus_mode'` |

**Focus mode allows through:** `cto`/`critical` priority, `persistent`/`gate`/`audit`/`revival`/`automated` lanes, `force-spawn-tasks`/`persistent-task-spawner`/`stop-continue-hook`/`session-queue-reaper`/`sync-recycle` sources, or items with `persistentTaskId`.

After passing gates: inserts into `queue_items`, calls `drainQueue()` inline.

## Session Spawning (Drain Cycle)

**Function:** `drainQueue()` in `session-queue.js` — 7 steps per cycle

**Step 1: Reap stale running items** — Calls `reapSyncPass(db)`. Detects: dead PIDs, spawning zombies (5+ min no PID), stale persistent monitor heartbeats (default 5 min), auth-stalled sessions (default 2 min). Dead PID actions: mark `completed` (or `failed` with `no_output_crash` for sub-30s deaths with no JSONL), release all resource locks, remove from resource queues, reactive worktree cleanup (if clean), retire progress files, reset linked TODO task to `pending`.

**Step 1b: Re-enqueue dead persistent monitors** — Calls `requeueDeadPersistentMonitor()`. Skips tasks that are not in `active` status (e.g., idle-paused or manually paused monitors are left alone — prevents the reaper from fighting the idle pause). Circuit breaker: max 3 hard revivals per task in 10 min → exponential backoff (5→10→20→60 min). Rate-limit detection: scans session tail, applies 5-min cooldown (excluded from crash counter). Self-healing: calls `handleBlocker()` → may escalate to CTO or spawn fix task.

**Step 1b.5: Audit session revival** — For each item in `reaperResult.auditRevivals`, dedup-checks for an existing auditor in `queued/running/spawning` state for the same task ID (via `json_extract(metadata, '$.taskId')`). If none found, enqueues the appropriate auditor (type determined by `taskType` — `universal-auditor` for todo/persistent, `plan-auditor` for plan, `authorization-auditor` for authorization) in the `audit` lane with an 8-minute TTL. Source tagged `session-reaper-audit-revival`. Emits `audit_session_revived` audit event. This prevents tasks from being permanently stuck in `pending_audit` when an auditor crashes. Covers all four audit types including CTO authorization decisions.

**Step 1c: Orphan persistent task catch-all** — Queries `persistent-tasks.db` for `active` tasks with no queued/running monitor. Re-enqueues via `requeueDeadPersistentMonitor()`.

**Step 1d: Non-persistent task revival** — Max 3 per drain cycle. Prefers `--resume` if session file found. Injects bypass resolution context if CTO approved/rejected a request. Enqueues in `revival` lane at task's original priority.

**Step 2: Expire old queued items** — TTL default: 30 minutes (persistent monitors have no TTL). Marks `cancelled` with `error='TTL expired'`.

**Step 2.5: Reserved slots auto-restore** — Checks `reserved_slots_restore` timer, resets to default when elapsed.

**Step 2.6: Resource lock expiry** — `checkAndExpireResources()` — promotes next waiters for expired locks.

**Step 2.7: Stale port cleanup** — Removes port allocations for deleted worktrees.

**Step 3-4: Count running by lane, fetch queued by priority.**

**Step 5: Spawn loop (per-item):**

| Lane | Capacity Rule |
|------|--------------|
| `persistent` | No limit — always spawns |
| `automated` | No limit — background system sessions (22 auto-promoted sources) |
| `gate` | Sub-limit: 5 |
| `audit` | Sub-limit: 5 |
| `standard`/`revival` | Global `maxConcurrent` minus `reservedSlots` (for non-priority-eligible items) |

**Priority-eligible** (sees full `maxConcurrent`): `cto`/`critical` priority, `persistent` lane, or has `persistentTaskId`. Per-item checks: (1) Capacity — if at cap for CTO/critical items, suspend lowest-priority via SIGTSTP; (2) Memory pressure — `shouldAllowSpawn()` gates by RAM; `cto`/`critical` bypass; (3) Workstream dependencies — checks `queue_dependencies` in workstream.db.

**`spawnQueueItem()`:** Atomic `queued→spawning` claim → register agent → substitute `{AGENT_ID}` in prompt → compaction for `resume` spawns → build CLI args (`--agent`, `--model`, `--disallowedTools`) → build env (`CLAUDE_WORKTREE_DIR`, `CLAUDE_QUEUE_ID`) → validate CWD exists → `spawn('claude', ...)` detached → update `spawning→running` with PID → update persistent-tasks.db with monitor_pid.

**Step 6: Resume suspended sessions** — If capacity freed, sends SIGCONT to suspended items (ordered by priority). Dead suspended PIDs marked `completed`, linked TODO reset to `pending`.

## Session Reaping (Death Detection)

**Sync Pass (`reapSyncPass`) — every drain cycle:**

| Detection | Condition | Action | Kill? |
|-----------|-----------|--------|-------|
| Spawning zombie | `spawning` + no PID for 5+ min | Mark `failed` | No |
| Dead PID | `running` + `process.kill(pid,0)` fails | Mark `completed` (or `failed` with `no_output_crash` if died <30s with no JSONL), release resources, cleanup | No (already dead) |
| Stale heartbeat | Persistent monitor, heartbeat > 5 min stale, spawned > 60s ago | Kill process group, mark `completed` | Yes (sync kill) |
| Auth stall | Non-persistent, file mtime > 2 min stale, 3+ consecutive auth errors | Kill process group, mark `completed` | Yes (sync kill) |
| Stuck alive | Running > hard-kill threshold | Add to `stuckAlive` list for async pass | Deferred |

**`diagnoseSessionFailure()`** classifies: `rate_limit` (transient), `auth_error` (fatal), `crash` (fatal), `unknown` (retry).

**Async Pass (`reapAsyncPass`) — hourly automation, 30-min cooldown:** For each stuck-alive item, 3 completion signal checks: (1) JSONL last message has `stop_reason` + no pending `tool_use`; (2) Last 16KB contains `complete_task` or `summarize_work`; (3) Process state is zombie (Z) or stopped (T). Any positive → graceful cleanup, `in_progress → completed`. All negative → hard kill (SIGTERM→SIGKILL), `in_progress → pending` + deputy-CTO report. Per-task override: persistent tasks with `hard_kill_minutes` in metadata override the global 60-min threshold. Gate-lane exemption: gate agents skipped entirely.

## Session Revival (8 Overlapping Mechanisms)

| # | Mechanism | Trigger | Latency | Priority | Lane | Max Retries | Guards |
|---|-----------|---------|---------|----------|------|-------------|--------|
| 1 | **Revival daemon** (`scripts/revival-daemon.js`) | fs.watch on agent-tracker-history | <1s | urgent | revival | 5 (then escalating cooldown) | Memory pressure, bypass guard, suspended check, age <1h |
| 2 | **Session reviver** (`session-reviver.js`) | Hourly automation, 10-min cooldown | ~10 min | urgent | revival | 1 per cycle, max 3/cycle | Memory pressure, concurrency slots, bypass guard, suspended check |
| 3 | **Dead agent recovery** (SessionStart hook) | Every interactive session start | Immediate (CTO login) | N/A (no spawn) | N/A | 1 per login | Lock coordination, spawned-session skip |
| 4 | **Crash-loop resume** (SessionStart hook) | Every interactive session start | Immediate (CTO login) | N/A (informational) | N/A | N/A | Reports only — no auto-resume |
| 5 | **Stop-continue hook** (Stop hook) | Agent attempts to stop | Real-time | N/A (gates exit) | N/A | Blocks until conditions met | Persistent task status, plan completion, worktree cleanup |
| 6 | **Stale-pause auto-resume** (hourly automation) | Persistent task paused > 30 min | ~15 min cycle | critical | persistent | Unlimited (unless self-pause circuit breaker) | Bypass guard, 1Password check, do_not_auto_resume flag, self-pause circuit breaker |
| 7 | **Orphan catch-all** (drainQueue Step 1c) | Every drain cycle | Per-drain | critical | persistent | Unlimited | Bypass guard, dedup |
| 8 | **requeueDeadPersistentMonitor** (drainQueue Step 1b) | Dead persistent PID detected | Immediate | critical | persistent | 3/10-min (then exponential backoff) | Paused task skip (idle-paused tasks are not revived), rate-limit detection, crash-loop circuit breaker, dedup, self-healing |

**Circuit Breaker (dual-layer):** Layer 1 (in-memory): `_monitorRevivalTimestamps` Map — max 3 hard revivals per task in 10 min. Layer 2 (DB): `revival_events` table — survives process restart. Backoff: 5 min → 10 → 20 → 60 min (exponential, capped). Stale heartbeat revivals excluded from crash counter.

## Session Suspension & Preemption

**Non-destructive (SIGTSTP/SIGCONT):** Trigger: CTO/critical item at capacity in drainQueue Step 5. `preemptLowestPriority()` suspends lowest-priority running session. State: `running → suspended` (doesn't count toward concurrency). Resume: drainQueue Step 6 sends SIGCONT when capacity frees.

**Destructive (legacy, `preemptForCtoTask()`):** Sends SIGTERM to victim, waits 5s, extracts session ID. Re-enqueues victim as `urgent` resume item. Resets victim's TODO task to `pending`.

## Task Lifecycle (todo.db)

```
pending_review → [gate_approve] → pending → [spawn] → in_progress → [complete_task] → completed
     ↓                                          ↓
  [gate_kill]                              [hard_kill/crash]
   (deleted)                             in_progress → pending (reset for revival)
```

**Gate bypass creators:** `deputy-cto`, `cto`, `human`, `pr-reviewer`, `system-followup`, `demo`, `self-heal-system`. Urgency downgrade: non-bypass creators' `urgent` silently becomes `normal`.

**Spawning triggers:** `urgent-task-spawner.js` (PostToolUse on `create_task`) — immediate for CTO/human/urgent. `hourly-automation.js` task runner — batch of up to 3 pending tasks per cycle. `scripts/force-spawn-tasks.js` — manual force-spawn via `/spawn-tasks`.

**Completion gates (PostToolUse hooks):** `session-completion-gate.js` verifies `user-alignment` + `project-manager` sub-agents ran. `project-manager-reminder.js` warns about uncommitted changes. `worktree-cleanup-gate.js` reminds to remove worktree.

**Stale task cleanup:** hourly automation resets `in_progress` tasks stuck >30 min back to `pending`. Gate stale cleanup: `pending_review` tasks older than 10 min auto-approved.

## Persistent Task Lifecycle

```
draft → active → paused ⇆ active → completed
                    ↓                    ↓
                cancelled            cancelled
                    ↓
                  failed
```

| Transition | Trigger | Side Effects |
|-----------|---------|--------------|
| `draft → active` | `activate_persistent_task` | Spawner hook enqueues monitor in `persistent` lane at `critical` priority; auto-activates 2 reserved slots |
| `active → paused` | `pause_persistent_task`, bypass request, circuit breaker | `propagatePauseToPlan()` → plan task paused → blocking_queue entry; audit event |
| `paused → active` | `resume_persistent_task`, amendment auto-resume, stale-pause auto-resume, CTO bypass approval | `propagateResumeToPlan()` → plan task in_progress → blocking_queue resolved; spawner hook re-enqueues monitor |
| `active → completed` | `complete_persistent_task` | `plan-persistent-sync.js` hook → routes to `pending_audit` or `completed` on linked plan task; cascade to phase/plan |
| `* → cancelled` | `cancel_persistent_task` | Audit event; plan cascade may auto-pause |

**Self-healing:** `blocker-auto-heal.js` diagnoses crash type → spawns fix tasks (max 3) → exponential backoff → escalates to CTO via bypass request after exhaustion.

## Plan Lifecycle

```
draft → active → paused ⇆ active → completed
                    ↓                    ↓
                cancelled             archived
```

**Plan task statuses:** `pending → ready → in_progress → paused/completed/pending_audit/skipped`

| Mechanism | Hook/Module | What it does |
|-----------|------------|--------------|
| Plan activation | `plan-activation-spawner.js` | Creates plan-manager persistent task, links atomically (TOCTOU-safe), enqueues monitor |
| PR merge detection | `plan-merge-tracker.js` | Auto-advances linked plan tasks to `completed` on `gh pr merge` |
| Persistent task completion sync | `plan-persistent-sync.js` | Routes to `pending_audit` (if `verification_strategy`) or `completed`; cascades phase → plan |
| Verification audit | `plan-audit-spawner.js` | Spawns independent Sonnet `plan-auditor` in `audit` lane (signal-excluded, 8-min TTL) via `buildAuditorSessionSpec({ taskType: 'plan' })` |
| Pause propagation | `lib/pause-propagation.js` | Persistent task paused → plan task paused → assess blocking level → auto-pause plan if no parallel work |
| Resume propagation | `lib/pause-propagation.js` | Persistent task resumed → plan task in_progress → resolve blocking_queue → auto-resume plan if no other paused tasks |
| Plan orphan detection | `hourly-automation.js` | 10-min cycle: detects active plans with no live plan-manager → creates new persistent task + enqueues |
| Plan completion gate | `stop-continue-hook.js` | Blocks plan-manager exit if incomplete tasks remain (escape hatch: monitor paused/completed/cancelled) |

**Auto-completion cascade:** task completed → check all phase tasks resolved → mark phase completed (or skipped if all skipped) → check all phases resolved → mark plan completed (only if no required phases skipped). Gate phases: tasks in `gate: true` phases cannot be skipped. CTO override: `force_complete: true` with `completion_note`.

## Background Automation Affecting Lifecycle

**Gate-Exempt (always run):**

| Block | Cooldown | What it does |
|-------|----------|-------------|
| Session reviver | 10 min | Scans history for dead sessions, revives up to 3 |
| Session reaper (async) | 30 min | Hard-kills stuck sessions, reconciles TODO tasks |
| Persistent monitor health | 15 min | Detects dead/stale monitors, re-enqueues |
| Timed pause auto-resume | 1 min | Auto-resolves expired timed bypass pauses (≤60 min) without CTO action |
| Stale-pause auto-resume | 15 min | Resumes persistent tasks paused > 30 min |
| Rate-limit cooldown recovery | 30 min | Clears expired rate-limit cooldowns, re-enqueues |
| Self-heal fix check | 5 min | Checks fix task completion, resolves/escalates blockers |
| Plan orphan detection | 10 min | Revives active plans with no live manager |
| Report auto-resolve | 2 min | Auto-resolves reports matching merged PRs |
| Report dedup | 30 min | Deduplicates pending reports |
| Triage check | 5 min | Spawns triage agents for pending reports by tier |
| Auto-rollback check | 2 min | Reads `synthetic-alerts.json`; triggers rollback on 3+ consecutive probe failures within 5 min of deploy |
| Fly project image freshness | 30 min | Checks project image staleness (lockfile hash comparison); files deputy-CTO report when stale or stuck deploying |
| Promotion retry check | configurable | Clears `lastPreviewPromotionSha` and resets cooldown when a promotion agent fails or crashes with `no_output_crash`, allowing immediate retry |
| Global monitor health | 5 min | Ensures a `global_monitor` persistent task exists and a monitor session is live; creates the task on first run, re-enqueues on crash |
| Global monitor idle check | 1 min | Auto-pauses the monitor when no work sessions are active; auto-resumes within 1 minute when sessions reappear |
| Interactive session reaper | 5 min | Purges dead-session entries from `interactive-sessions.json`, removes their `cto-interactive-*` worktrees IF clean (never auto-commits in-progress CTO work), cleans up `automation-config.json` `ctoWorktreePaths` |
| Branch pruner | 30 min | Delete local AND remote branches with merged PRs; delete local-only branches >24h old with no PR and no commits ahead of base; runs `git remote prune origin` |

**Gate-Required (CTO briefing within 24h):**

| Block | Cooldown | What it does |
|-------|----------|-------------|
| Task runner | configurable | Spawns up to 3 pending tasks per cycle |
| Task gate stale cleanup | every cycle | Auto-approves pending_review tasks > 10 min |
| Abandoned worktree rescue | configurable | Spawns project-manager for orphaned dirty worktrees |
| Worktree cleanup | 30 min | Removes worktrees for merged branches |
| Stale worktree reaper | 60 min | Removes clean worktrees > 4 hours old |
| Stale task cleanup | 30 min | Resets in_progress tasks stuck > 30 min to pending |
| Orphan process reaper | 60 min | Kills node/esbuild processes in deleted worktree CWDs |
| Demo validation | 6 hours | Runs all demo scenarios, spawns repair agents for failures |

## Daemons (Persistent Background Processes)

| Daemon | File | Interval | Purpose |
|--------|------|----------|---------|
| Revival daemon | `scripts/revival-daemon.js` | fs.watch + 10s poll | Sub-second dead agent detection, enqueues revival |
| Preview watcher | `scripts/preview-watcher.js` | 30s poll | Auto-merges base branch into worktrees, syncs deps |
| Session activity broadcaster | `scripts/session-activity-broadcaster.js` | 5 min | Generates per-session summaries, broadcasts to agents |
| Live feed daemon | `scripts/live-feed-daemon.js` | 60s | Generates AI commentary for CTO dashboard Page 5 |
| MCP shared daemon | `scripts/mcp-server-daemon.js` | Always-on | Hosts Tier 1 MCP servers on port 18090 |
| Synthetic monitor | `scripts/synthetic-monitor.js` | 60s prod / 5 min staging | Probes health endpoints from `services.json`; writes alerts to `synthetic-alerts.json`; stores metrics in `synthetic-metrics.db` |
| Quota recovery daemon | `scripts/quota-recovery-daemon.js` | fs.watch + 5s poll near reset | Watches `quota-exhaustion.json`; uses `setTimeout` to `resets_at - 15s`, then polls usage API every 5s — clears state and drains queue within 10s of quota recovery |
| Token usage collector | `scripts/token-usage-collector.js` | 60s | Walks every session JSONL under `~/.claude/projects/<project>/`, parses assistant `message.usage`, joins to `session-queue.db`, persists per-message events + daily rollups in `.claude/state/token-usage.db`. Incremental scan, idempotent ingest, 90-day retention on events. Powers `/tokens` and the 5 `agent-tracker` query tools |

## Cross-Cutting Guards

| Guard | Type | What it blocks |
|-------|------|---------------|
| Memory pressure | Spawn gate | Blocks non-critical spawns at high/critical RAM pressure |
| Focus mode | Enqueue gate | Blocks non-essential automation (allows CTO/critical/persistent) |
| Quota exhaustion | Enqueue + spawn gate | Blocks all non-CTO spawns and queue draining when usage ≥ 99%; cleared by quota-recovery-daemon |
| Bypass request | Enqueue + revival gate | Blocks task spawn/revival when CTO decision pending |
| CTO activity gate | Automation gate | Blocks gate-required hourly automation when no CTO briefing in 24h |
| Worktree exclusivity | Enqueue gate | Blocks sessions targeting same worktree |
| Self-pause circuit breaker | Auto-resume guard | Sets `do_not_auto_resume` after 2+ self-pauses in 2 hours |
| Crash-loop circuit breaker | Revival guard | Exponential backoff after 3+ hard revivals in 10 min |
| Rate-limit cooldown | Revival guard | 5-min cooldown on rate-limited sessions |

## Resource Lock Lifecycle

Shared resources (`display`, `chrome-bridge`, `main-dev-server`) use acquire/release/renew/queue semantics. On agent death: `releaseAllResources()` + `removeFromAllQueues()` called by reaper. TTL expiry: `checkAndExpireResources()` in every drain cycle; dead holders released immediately via PID check. Force release: CTO override via `force_release_shared_resource`; spawned agents blocked from seizing CTO-held locks. Auto-acquire: `run_demo` with `recorded: true` auto-acquires `display` lock.

## Session Sync/Recycle (npx gentyr sync)

`npx gentyr sync` Step 10: enumerates all running/spawning sessions, sends SIGTERM→SIGKILL, marks old items `failed`, resets linked TODO tasks to `pending`, releases shared resources, re-enqueues each at `urgent` priority. Resume-capable sessions (matching JSONL) use `--resume`. MCP daemon restarted between kill and re-enqueue.
