# the automation layer

Automation is not a feature of GENTYR. It is the point.

Every ten minutes a background timer wakes up. It checks quota across multiple accounts. It refreshes expiring tokens. It spawns agents for pending tasks. It adjusts its own frequency based on how much API budget remains. No human triggers any of this. No human needs to.

The system has one goal: keep agents working at 90% of available capacity, indefinitely, without intervention. When quota runs low, it slows down. When quota resets, it speeds up.

This document describes how.

---

## Overview

GENTYR manages API quota across multiple Anthropic accounts through coordinated hooks that handle credential rotation, dynamic throughput adjustment, and session recovery. The system operates at four layers:

1. **Rotation proxy** - Transparent network-level credential swap (localhost:18080 MITM on api.anthropic.com)
2. **In-session hooks** - Monitor quota and rotate credentials during active Claude Code sessions
3. **Background automation** - Orchestrates task spawning and key syncing on a timer
4. **Dynamic optimization** - Adjusts all automation cooldowns based on projected quota utilization

```
launchd timer (10 min) ──> hourly-automation.js ──> CTO Activity Gate
                                  |
                                  |── runUsageOptimizer()   -> adjust cooldown factor
                                  |── syncKeys()            -> refresh tokens, maintain standby pool
                                  |── task runner           -> spawn pending TODO tasks
                                  |── feedback pipeline     -> user persona testing
                                  v
                           automation-config.json  (factor scales all 18 cooldowns)
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
| **SessionStart** | gentyr-sync | Framework version/config change detection; auto-sync settings.json, .mcp.json, hooks, agents |
| **SessionStart** | api-key-watcher | Discover credentials, health-check, select optimal key |
| **SessionStart** | credential-health-check | Vault mapping validation, OP token desync detection |
| **PreToolUse(Bash)** | credential-sync-hook | Periodic credential sync (30-min throttle) |
| **PreToolUse(Bash)** | playwright-cli-guard | Warn agents against CLI-based Playwright test invocation (non-blocking) |
| **PostToolUse** | quota-monitor | Mid-session quota check (5-min throttle), rotate at 95% |

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

### 18 Managed Cooldowns

All read via `getCooldown(key, fallback)` from config-reader.js:

| Category | Cooldowns |
|----------|-----------|
| Task management | hourly_tasks, task_runner, todo_maintenance |
| Triage | triage_check, triage_per_item |
| Code quality | lint_checker, antipattern_hunter, standalone_antipattern_hunter |
| Compliance | standalone_compliance_checker, compliance_checker_file, compliance_checker_spec |
| Deployment | preview_promotion, staging_promotion |
| Monitoring | staging_health_monitor, production_health_monitor |
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

## Session Lifecycle

### Automated Session Flow

```
hourly-automation.js
  |-- spawns: claude -p "[Task] ..." --dangerously-skip-permissions
  |
  v
Session runs task
  |
  |-- [PostToolUse] quota-monitor checks every 5 min
  |       |-- usage >= 95%? -> rotate key, write to Keychain, continue: true
  |       |-- token expiring? -> restartless swap via Keychain
  |
  v
Session ends
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

### Concurrency Guards

- `MAX_CONCURRENT_AGENTS = 5` - total running agents across all types
- `MAX_TASKS_PER_CYCLE = 3` - new task spawns per automation cycle

---

## Rotation Proxy

Local MITM proxy (`scripts/rotation-proxy.js`) that handles immediate credential swap at the network layer.

```
Claude Code ──HTTPS_PROXY──> localhost:18080 ──TLS──> api.anthropic.com
                                    |
                            reads api-key-rotation.json
                                    |
                            on 429: rotate key, retry
```

**Intercepts** (TLS MITM + Authorization header swap):
- `api.anthropic.com` — main API
- `mcp-proxy.anthropic.com` — MCP proxy endpoint

**Passes through transparently** (CONNECT tunnel, no MITM):
- `platform.claude.com` — OAuth refresh
- Everything else

**Lifecycle**: KeepAlive launchd service (`com.local.gentyr-rotation-proxy`). Provisioned by `setup-automation-service.sh`. Starts before the automation service. Proxy env vars (`HTTPS_PROXY/HTTP_PROXY/NO_PROXY`) injected into all spawned agent environments.

**Relationship to hook-based rotation**: The proxy handles the actual HTTP-level token swap. Quota-monitor still detects usage thresholds and writes new `active_key_id` to rotation state. Key-sync still refreshes OAuth tokens and writes to Keychain. The proxy reads rotation state on every request, so token swap is immediate — no waiting for SRA or r6T.

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
7. **Seamless session handling**: write to Keychain, continue with `continue: true` for all sessions, credentials adopted at SRA/r6T
8. **Post-rotation audit**: Log rotation event to `rotation-audit.log` for health tracking

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

## Credential Health Check Hook (credential-health-check.js)

Runs at `SessionStart` for interactive sessions (skipped for spawned `[Task]` sessions). Validates that all required credential mappings are present and that the `OP_SERVICE_ACCOUNT_TOKEN` in the shell environment is in sync with `.mcp.json`.

### Validation Steps

1. **Load required keys**: Reads `protected-actions.json` to build the set of required credential keys
2. **Check vault mappings**: Reads `vault-mappings.json`; counts configured keys (both `op://` refs and direct values)
3. **Check `.mcp.json` env blocks**: Keys injected directly into `.mcp.json` (e.g. `OP_SERVICE_ACCOUNT_TOKEN`) count as configured even if absent from vault-mappings
4. **OP token desync detection**: Compares the shell `OP_SERVICE_ACCOUNT_TOKEN` environment variable against the value in `.mcp.json`; if they differ, sets `opTokenDesync = true` and always overwrites `process.env` with the `.mcp.json` value (source of truth)
5. **Alternative key resolution**: Removes keys from the missing list if a known alternative is already configured (e.g. `ELASTIC_CLOUD_ID` / `ELASTIC_ENDPOINT`)
6. **1Password connectivity**: If any `op://` refs are present, calls `op whoami` to verify the CLI is authenticated

### Output Behavior

| Condition | Output |
|-----------|--------|
| All configured, no desync | Silent (`suppressOutput: true`) |
| Token desync only | Warning prefix: "GENTYR: OP_SERVICE_ACCOUNT_TOKEN in shell differs from .mcp.json (source of truth). Run `npx gentyr sync` to re-sync." |
| Missing credentials | Error with count; prepended with desync warning if applicable |
| 1Password not authenticated | Error prompting to run setup with `--op-token`; prepended with desync warning if applicable |

### Deployment

The hook lives at `.claude/hooks/credential-health-check.js` and auto-propagates to target projects via the `.claude/hooks/` directory symlink (npm link model).

---

## Background Automation (hourly-automation.js)

Orchestrated by a launchd service running every 10 minutes.

### CTO Activity Gate

All automation is gated behind a recency check on the deputy-CTO briefing. If the last briefing is > 24 hours old, the automation exits immediately. This prevents rogue automation when the CTO is not actively monitoring.

### Execution Order

1. **Usage Optimizer** - Collect snapshot, adjust factor
2. **Key Sync** - Discover credentials, refresh tokens, prune dead keys
3. **Urgent Task Dispatcher** - Dispatch urgent priority tasks immediately (bypasses age filter)
4. **Task Runner** - Query todo.db for pending normal tasks (1-hour age filter), spawn agents up to concurrency limit
5. **Feedback Pipeline** - Trigger user persona testing on staging changes

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
4. Resolve account profiles for keys with `account_uuid === null` — calls `fetchAccountProfile()` for each active/exhausted key missing a UUID; non-fatal, retried on next sync
5. Set initial `active_key_id` if not set
6. Pre-expiry restartless swap if active key near expiry
7. Prune dead keys (invalid > 7 days, never prunes active key)
8. Write state and return `{ keysAdded, keysUpdated, tokensRefreshed }`

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
  "defaults": { "task_runner": 60, "triage_check": 5, ... },
  "effective": { "task_runner": 30, "triage_check": 3, ... },
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

## Pre-Commit Review Hook (pre-commit-review.js)

Runs as a Husky pre-commit hook on every `git commit` attempt.

### Commit Flow

```
git commit
  |
  v
pre-commit-review.js
  |-- Verify git core.hooksPath hasn't been tampered (hook bypass detection)
  |-- Check for valid emergency bypass token (from execute_bypass flow)
  |-- Check for pending CTO items (G020 compliance)
  |       |-- Pending questions in deputy-cto.db?
  |       |-- Pending triage items in cto-reports.db?
  |       |-- Either present? -> BLOCK commit
  |-- Check for valid approval token (from deputy-cto approve_commit)
  |       |-- Token exists + not expired (5 min) + hash matches staged files?
  |       |-- Yes -> ALLOW commit
  |-- Spawn deputy-cto review in background
  |-- BLOCK commit (await review)
  |
  v (after deputy-cto reviews and approves)

git commit (second attempt)
  |-- Valid approval token found -> ALLOW commit
```

### Approval Token Lifecycle

1. Deputy-CTO reviews staged diff and calls `approve_commit`
2. `approve_commit` writes `.claude/commit-approval-token.json` with SHA-256 hash of staged diff + 5-minute expiry
3. Next commit attempt validates: token unexpired AND `diffHash` matches current staged changes
4. On match: commit proceeds; token consumed

### Emergency Bypass

A CTO-authorized emergency bypass writes a `commit_decisions` row with `rationale LIKE 'EMERGENCY BYPASS%'` and `question_id IS NOT NULL`. The hook detects this within a 5-minute window and allows the commit without requiring a deputy-CTO review cycle. The `question_id IS NOT NULL` constraint ensures only bypass decisions created via the `execute_bypass` MCP tool (which always links to the originating bypass-request question) are honored — bare `approve_commit` calls with "EMERGENCY BYPASS" prefix are blocked by the server-side guard.

### G020 Compliance Check

Before any approval path, the hook queries:
- `deputy-cto.db` questions table: `WHERE status = 'pending'`
- `cto-reports.db` reports table: `WHERE triage_status = 'pending'` (or `triaged_at IS NULL` as fallback)

If either count > 0, the commit is blocked regardless of token state. This ensures no code ships while the CTO has outstanding decisions.

### Fail-Closed Behavior

- `better-sqlite3` unavailable: skip CTO item check (permissive), approval token check still runs
- DB read error on triage count: assume 1 pending item (blocks commit)
- Hook path tampered (`core.hooksPath` changed): BLOCK with alert

---

## Deputy-CTO Server Security Guards (deputy-cto/server.ts)

Defense-in-depth guards implemented across the deputy-cto and agent-reports MCP servers to prevent bypass-route exploitation.

### Phase 1: Tool Handler Guards

Four `add_question` / `answer_question` / `clear_question` / `approve_commit` guards block agent-accessible loopholes:

**`add_question` Guard** — Blocks creation of `bypass-request` or `protected-action-request` question types via `add_question`. These types have dedicated creation paths (`request_bypass` tool, protected-action hook) that enforce the CTO verification code flow. An agent cannot self-create a bypass request and then self-answer it.

**`answer_question` Guard** — Blocks answering `bypass-request` questions via `answer_question`. The only valid answer path for bypass-requests is the CTO typing `APPROVE BYPASS <code>` in chat, which routes through the `execute_bypass` tool with cryptographic code verification.

**`clear_question` Guard** — Blocks clearing a pending `bypass-request` or `protected-action-request` question via `clear_question`. Pending requests of these types can only be resolved through their designated approval flows. This prevents an agent from clearing a pending bypass-request to make it appear resolved.

**`approve_commit` Guard** — Blocks any `approve_commit` call with a rationale beginning with `EMERGENCY BYPASS`. This prefix is reserved exclusively for the `execute_bypass` MCP tool, which validates a CTO-provided 6-character code before writing the bypass decision row. Direct use of this prefix via `approve_commit` would create a bypass-looking token without CTO verification.

The SQL fix in `pre-commit-review.js` (`AND question_id IS NOT NULL`) ensures the hook only honors bypass decisions that were created by `execute_bypass` — which always links `question_id` to the originating bypass-request question — not arbitrary `approve_commit` calls with the "EMERGENCY BYPASS" prefix.

### Phase 2: HMAC Verification and Rate Limits

**`executeBypass` HMAC verification** — When the CTO types `APPROVE BYPASS <code>`, the UserPromptSubmit hook writes a `bypass-approval-token.json` file containing an HMAC-SHA256 signature over `code|request_id|expires_timestamp|bypass-approved`. The `execute_bypass` tool recomputes the expected HMAC using the protection key (`loadProtectionKey()`) and rejects tokens that fail verification with `FORGERY DETECTED: Invalid bypass approval token signature. Token deleted.` This matches the pattern used by `executeHotfixPromotion()` and prevents an agent from writing a forged approval token file (the key is root-owned and unreadable by agent processes).

**`requestBypass` rate limit** — Maximum 3 pending bypass-request questions at a time. If the limit is reached, `request_bypass` returns an error asking the agent to wait for existing requests to be addressed. Prevents request flooding that could obscure legitimate bypass requests.

**`reportToCto` rate limit (agent-reports server)** — Maximum 5 untriaged reports per reporting agent at a time. If the limit is reached, `report_to_cto` returns an error message. Prevents a single agent from flooding the triage queue and hiding reports from other agents.

**`get_pending_count` exposes `pending_triage_count`** — The `GetPendingCountResult` type now includes `pending_triage_count` alongside `pending_count` and `commits_blocked`. This lets the CTO see the split between pending questions and pending triage reports when understanding why `commits_blocked: true`.

**`spawn_implementation_task` removed** — The `spawn_implementation_task` tool (which spawned background Claude instances directly from the deputy-cto server) was removed. Task spawning is now exclusively managed by the agent-tracker MCP server and hourly automation, which enforce concurrency limits, registration, and tracking.

---

## State Files

| File | Scope | Written By | Read By |
|------|-------|-----------|---------|
| `~/.claude/api-key-rotation.json` | User | key-sync, quota-monitor, api-key-watcher | All rotation hooks, rotation-proxy |
| `~/.claude/.credentials.json` | User | Claude Code | key-sync |
| `~/.claude/rotation-proxy.log` | User | rotation-proxy | monitor-token-swap (--audit) |
| `.claude/state/automation-config.json` | Project | usage-optimizer | config-reader (all hooks) |
| `.claude/state/usage-snapshots.json` | Project | usage-optimizer | usage-optimizer, cto-dashboard |
| `.claude/state/quota-monitor-state.json` | Project | quota-monitor | quota-monitor |
| macOS Keychain `Claude Code-credentials` | System | key-sync, quota-monitor | Claude Code runtime |
