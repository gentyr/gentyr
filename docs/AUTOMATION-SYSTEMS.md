# the automation layer

Automation is not a feature of GENTYR. It is the point.

Every ten minutes a background timer wakes up. It checks quota across multiple accounts. It refreshes expiring tokens. It revives dead sessions. It spawns agents for pending tasks. It adjusts its own frequency based on how much API budget remains. No human triggers any of this. No human needs to.

The system has one goal: keep agents working at 90% of available capacity, indefinitely, without intervention. When quota runs low, it slows down. When quota resets, it speeds up. When a session dies, it comes back. When all accounts are exhausted, it waits, then resumes.

This document describes how.

---

## Overview

GENTYR manages API quota across multiple Anthropic accounts through coordinated hooks that handle credential rotation, dynamic throughput adjustment, and session recovery. The system operates at three layers:

1. **In-session hooks** - Monitor quota and rotate credentials during active Claude Code sessions
2. **Background automation** - Orchestrates task spawning, key syncing, and session recovery on a timer
3. **Dynamic optimization** - Adjusts all automation cooldowns based on projected quota utilization

```
launchd timer (10 min) ──> hourly-automation.js ──> CTO Activity Gate
                                  |
                                  |── runUsageOptimizer()   -> adjust cooldown factor
                                  |── syncKeys()            -> refresh tokens, maintain standby pool
                                  |── reviveInterruptedSessions() -> recover dead sessions
                                  |── task runner           -> spawn pending TODO tasks
                                  |── feedback pipeline     -> user persona testing
                                  v
                           automation-config.json  (factor scales all 19 cooldowns)
                                  |
                                  v
                           config-reader.js  -->  getCooldown(key, fallback)
                                                        |
                                                        v
                                                  All hooks read dynamic intervals
```

---

## Hook Registration

| Event | Hooks | Purpose |
|-------|-------|---------|
| **SessionStart** | api-key-watcher | Discover credentials, health-check, select optimal key |
| **PreToolUse(Bash)** | credential-sync-hook | Periodic credential sync (30-min throttle) |
| **PostToolUse** | quota-monitor | Mid-session quota check (5-min throttle), rotate at 95% |
| **Stop** | stop-continue-hook | Auto-continue for [Task] sessions, quota death detection |

---

## Credential Rotation

### Multi-Account Architecture

The system supports multiple Anthropic OAuth accounts. Each account can have multiple discovered keys (from environment, Keychain, and credentials file). Keys are tracked in a central rotation state file with lifecycle management.

### Key Lifecycle

```
Discovered -> Active -> [High Usage 90%+] -> [Exhausted 100%] -> [Token Expires] -> Expired
                                                                       |
                                                              [OAuth Refresh]
                                                                /            \
                                                         Success          invalid_grant
                                                            |                  |
                                                         Active            Invalid -> [7d] -> Pruned
```

### Key Selection Algorithm (`selectActiveKey`)

1. Filter to keys with `status === 'active'`
2. Exclude keys exhausted in any bucket (5h, 7d, or 7d_sonnet at 100%)
3. For each candidate, compute `maxUsage = max(five_hour, seven_day, seven_day_sonnet)`
4. Select key with lowest `maxUsage`
5. Ties broken by `last_used_at` (least recently used)
6. Only switch when current key hits >= 90% and an alternative exists below 90%

### Token Refresh

Multiple hooks can refresh tokens independently, all using `refreshExpiredToken()` from key-sync.js:

- **quota-monitor** Step 4b: Proactive refresh of standby tokens approaching expiry
- **stop-continue-hook**: Pre-pass refresh before health-check on quota death
- **syncKeys()**: Comprehensive refresh during periodic sync cycle

The refresh function returns three possible outcomes:
- `{ accessToken, refreshToken, expiresAt }` on success
- `'invalid_grant'` sentinel on permanent failure (HTTP 400) - callers mark key invalid
- `null` on transient failure - key stays in current status

### Restartless Token Swap

When the active key approaches expiry (within `EXPIRY_BUFFER_MS`):

1. Find a standby key with valid status and sufficient expiry window
2. Write standby token to macOS Keychain via `updateActiveCredentials()`
3. Update `active_key_id` in rotation state
4. Claude Code's built-in `SRA()` (fires 5 min before expiry) clears in-memory cache, re-reads Keychain, adopts new token
5. No restart needed - seamless credential handoff

This is safe because refreshing Account B's token does not revoke Account A's in-memory token.

---

## Usage Optimizer

### Purpose

Targets 90% token budget utilization by dynamically scaling all 19 automation cooldowns through a single factor (0.05 to 20.0).

### Algorithm

1. **Collect snapshot**: Fetch usage from Anthropic API for all active keys. Store timestamped snapshot.
2. **Detect reset boundary**: If 5h usage drops > 30pp between consecutive snapshots, a quota reset just occurred. Skip adjustment.
3. **Calculate EMA rate**: Select time-based snapshots from a 2-hour window (minimum 5-min spacing). Apply Exponential Moving Average (alpha=0.3) to consecutive pairs to compute smoothed tokens-per-hour rate.
4. **Project utilization**: `projected = currentUsage + (rate * hoursUntilReset)`. Compare to 90% target.
5. **Adjust factor**: Compute desired rate ratio, apply conservative bounds (max +/-10% per cycle), clamp to 0.05-20.0.
6. **Write effective cooldowns**: `effective[key] = max(5, round(default / factor))`

### Factor Effects

| Factor | Effect | Example (60-min default) |
|--------|--------|--------------------------|
| 20.0 | 20x speed (cooldowns divided by 20) | 3 min effective (floor: 5 min) |
| 2.0 | 2x speed (half cooldowns) | 30 min effective |
| 1.0 | Normal (no adjustment) | 60 min effective |
| 0.5 | Half speed (double cooldowns) | 120 min effective |
| 0.05 | 20x slowdown (cooldowns multiplied by 20) | 1200 min effective |

### 19 Managed Cooldowns

All read via `getCooldown(key, fallback)` from config-reader.js:

| Category | Cooldowns |
|----------|-----------|
| Task management | hourly_tasks, task_runner, todo_maintenance |
| Triage | triage_check, triage_per_item |
| Code quality | lint_checker, antipattern_hunter, standalone_antipattern_hunter |
| Compliance | standalone_compliance_checker, compliance_checker_file, compliance_checker_spec |
| Deployment | preview_promotion, staging_promotion |
| Monitoring | staging_health_monitor, production_health_monitor |
| Recovery | session_reviver |
| Other | user_feedback, test_failure_reporter, pre_commit_review |

### Edge Cases

- **Already at target**: If usage >= 90%, factor clamped to <= 1.0 (never speed up)
- **Zero rate**: Conservatively ramp toward MAX_FACTOR at 5% per cycle
- **Factor stuck at minimum**: If `currentFactor <= 0.15` and usage << 50% of target, reset factor to 1.0 (projection model unreliable)
- **Single key warning**: If any single key exceeds 80% in either bucket, bias effective usage upward
- **Overdrive mode**: Skips adjustment; reverts when overdrive expires

### Snapshot Quality

Snapshots are protected against rapid-fire contamination by three layers:
1. **Collection throttle**: Skip if last snapshot < 5 min old
2. **Time-based selection**: EMA uses snapshots >= 5 min apart within 2-hour window (not raw array tail)
3. **Interval floor**: EMA ignores any snapshot pair < 3 min apart

---

## Session Lifecycle & Recovery

### Automated Session Flow

```
hourly-automation.js
  |-- spawns: claude -p "[Task] ..." --dangerously-skip-permissions
  |
  v
Session runs task
  |
  |-- [PostToolUse] quota-monitor checks every 5 min
  |       |-- usage >= 95%? -> rotate key, write to Keychain, stop cleanly (continue: false)
  |       |-- token expiring? -> restartless swap via Keychain
  |
  |-- [Stop triggered]
  |       |-- stop-continue-hook reads transcript
  |       |-- Is [Task] session + first stop? -> BLOCK (force continue)
  |       |-- Is quota death? -> record for revival, APPROVE immediately
  |       |-- Second stop or not [Task]? -> APPROVE
  |
  v
Session ends
  |
  |-- If quota death: written to quota-interrupted-sessions.json
  |-- If all accounts exhausted: written to paused-sessions.json
  |
  v
session-reviver.js (next automation cycle)
  |-- Mode 1: picks up quota-interrupted sessions -> claude --resume with fresh credentials
  |-- Mode 2: scans agent-tracker for dead sessions -> re-spawns
  |-- Mode 3: checks paused sessions for account recovery
```

### Interactive Session Flow

```
User starts claude
  |-- [SessionStart] api-key-watcher discovers keys, selects optimal
  |
User works
  |-- [PreToolUse:Bash] credential-sync-hook (30-min throttle)
  |-- [PostToolUse] quota-monitor (5-min throttle)
  |       |-- usage >= 95%? -> rotate key, write to Keychain, continue (continue: true)
  |       |       |-- credentials adopted at token expiry (SRA) or 401 (r6T)
  |       |-- token expiring? -> restartless Keychain swap
  |
User or system stops session
```

### Session Recovery Modes

**Mode 1: Quota-Interrupted Pickup**
- Source: `quota-interrupted-sessions.json` (written by stop-continue-hook)
- Action: Spawns `claude --resume <sessionId>`
- Window: Entries older than 30 minutes are skipped (stale)

**Mode 2: Dead Session Recovery**
- Source: `agent-tracker-history.json` (agents with `reapReason: 'process_already_dead'`)
- Action: Cross-references with todo.db for pending tasks, re-spawns with original session
- Window: 7-day historical scan

**Mode 3: Paused Session Resume**
- Source: `paused-sessions.json` (written by quota-monitor when all accounts exhausted)
- Action: Checks each account for recovery (< 90% in all buckets), rotates to recovered account
- Scope: Only revives automated sessions; logs info for interactive sessions

### Concurrency Guards

- `MAX_CONCURRENT_AGENTS = 5` - total running agents across all types
- `MAX_TASKS_PER_CYCLE = 3` - new task spawns per automation cycle
- `MAX_REVIVALS_PER_CYCLE = 3` - session revivals per cycle

---

## Quota Monitor (PostToolUse)

Runs after every tool call, throttled to 5-minute intervals.

### Steps

1. **Throttle check**: Skip if last check < 5 min ago
2. **Anti-loop check**: Skip if rotated < 10 min ago
3. **Health check**: Query Anthropic usage API for active key
4. **Step 4b - Proactive refresh**: Refresh expired AND approaching-expiry standby tokens
5. **Step 4c - Pre-expiry swap**: If active key near expiry, write standby to Keychain (no restart)
6. **Rotation check**: If max usage >= 95%, select better key and rotate
7. **Seamless session handling**:
   - Interactive sessions: write to Keychain, continue with `continue: true`, credentials adopted at SRA/r6T
   - Automated sessions: write to Keychain, stop cleanly with `continue: false`, session-reviver resumes
8. **Exhaustion handling**: If no key available, write paused-sessions.json
9. **Post-rotation audit**: Log rotation event to `rotation-audit.log` for health tracking

### Key Thresholds

```
PROACTIVE_THRESHOLD    = 95%     (trigger rotation)
HIGH_USAGE_THRESHOLD   = 90%     (from key-sync.js)
EXHAUSTED_THRESHOLD    = 100%    (from key-sync.js)
EXPIRY_BUFFER_MS       = 600,000 (10 min - token pre-expiry window)
CHECK_INTERVAL_MS      = 300,000 (5 min - throttle between checks)
ROTATION_COOLDOWN_MS   = 600,000 (10 min - anti-loop after rotation)
```

---

## Stop-Continue Hook

Runs on every session stop event.

### Decision Logic

```
if [Task] session AND quota death detected:
    -> Attempt credential rotation
    -> Write to quota-interrupted-sessions.json for revival
    -> APPROVE stop (don't waste final API call on retry)

else if [Task] session AND first stop (not already continuing):
    -> BLOCK stop (force one continuation cycle)

else:
    -> APPROVE stop
```

### Quota Death Detection

Reads the last 8KB of the session transcript JSONL. Checks the last 5 parseable entries for `error: 'rate_limit'` combined with `isApiErrorMessage: true`. If detected, the session is dying from quota exhaustion and should not waste its final API call on a doomed retry.

---

## Background Automation (hourly-automation.js)

Orchestrated by a launchd service running every 10 minutes.

### CTO Activity Gate

All automation is gated behind a recency check on the deputy-CTO briefing. If the last briefing is > 24 hours old, the automation exits immediately. This prevents rogue automation when the CTO is not actively monitoring.

### Execution Order

1. **Usage Optimizer** - Collect snapshot, adjust factor
2. **Key Sync** - Discover credentials, refresh tokens, prune dead keys
3. **Session Reviver** - Check all 3 recovery modes
4. **Urgent Task Dispatcher** - Dispatch urgent priority tasks immediately (bypasses age filter)
5. **Task Runner** - Query todo.db for pending normal tasks (1-hour age filter), spawn agents up to concurrency limit
6. **Feedback Pipeline** - Trigger user persona testing on staging changes

### Task Orchestration

**Priority-Based Dispatch** (added 2026-02-21):
- Tasks in the TODO database have a `priority` field with values `'normal' | 'urgent'`
- **Urgent tasks** bypass the 1-hour age filter and dispatch immediately in Step 4
- **Normal tasks** require 1-hour age threshold before dispatch in Step 5
- Both urgent and normal dispatchers respect global concurrency limits
- All triage self-handle operations route through `create_task(priority: 'urgent')` for full governance

**Task Lifecycle**:
1. Created via `mcp__todo-db__create_task` (default `priority: 'normal'`)
2. If urgent: dispatched immediately by hourly automation Step 4
3. If normal: waits 1 hour, then dispatched by hourly automation Step 5
4. Agent spawned with task context, status → `in_progress`
5. On completion: status → `done`, followup tasks created if configured
6. Stale tasks (in_progress > 4 hours) escalated to project manager

**Concurrency Cap**:
- Default: 5 simultaneous task agents
- Configurable via `DEFAULT_MAX_CONCURRENT` in `agent-tracker.js`
- Urgent + normal combined count against single global limit

### Credential Cache

1Password credentials are lazily resolved on first agent spawn. Skipped in headless mode without `OP_SERVICE_ACCOUNT_TOKEN` to avoid macOS permission prompts. Results cached in memory only.

---

## Key Sync Module (key-sync.js)

Shared library used by api-key-watcher, hourly-automation, credential-sync-hook, and quota-monitor.

### `syncKeys()` Process

1. Discover credentials from all sources (env, Keychain, credentials file)
2. Sync into rotation state (add new, update existing)
3. Refresh expired tokens AND proactively refresh non-active tokens approaching expiry
4. Set initial `active_key_id` if not set
5. Pre-expiry restartless swap if active key near expiry
6. Prune dead keys (invalid > 7 days, never prunes active key)
7. Write state and return `{ keysAdded, keysUpdated, tokensRefreshed }`

### Credential Sources (priority order)

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. macOS Keychain `Claude Code-credentials` entry
3. `~/.claude/.credentials.json` file

All sources are read (not short-circuited) and merged into rotation state.

---

## Config Reader (config-reader.js)

Centralized dynamic cooldown configuration.

### `getCooldown(key, fallbackMinutes)`

Priority: `effective[key]` > `defaults[key]` > `fallbackMinutes`

The `effective` object is computed by the usage optimizer as `default * (1 / factor)`. Every hook and automation reads cooldowns through this function, making factor adjustment propagate system-wide.

### Configuration Structure

```json
{
  "version": 1,
  "defaults": { "task_runner": 60, "session_reviver": 10, ... },
  "effective": { "task_runner": 30, "session_reviver": 5, ... },
  "adjustment": {
    "factor": 1.5,
    "last_updated": "...",
    "constraining_metric": "5h|7d",
    "projected_at_reset": 0.89,
    "direction": "ramping up|ramping down|stable",
    "hours_until_reset": 3.5
  }
}
```

---

## State Files

| File | Scope | Written By | Read By |
|------|-------|-----------|---------|
| `~/.claude/api-key-rotation.json` | User | key-sync, quota-monitor, api-key-watcher | All rotation hooks |
| `~/.claude/.credentials.json` | User | Claude Code | key-sync |
| `.claude/state/automation-config.json` | Project | usage-optimizer | config-reader (all hooks) |
| `.claude/state/usage-snapshots.json` | Project | usage-optimizer | usage-optimizer, cto-dashboard |
| `.claude/state/quota-monitor-state.json` | Project | quota-monitor | quota-monitor |
| `.claude/state/quota-interrupted-sessions.json` | Project | stop-continue-hook | session-reviver |
| `.claude/state/paused-sessions.json` | Project | quota-monitor | session-reviver |
| macOS Keychain `Claude Code-credentials` | System | key-sync, quota-monitor | Claude Code runtime |
