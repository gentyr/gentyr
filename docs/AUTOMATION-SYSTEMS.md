# the automation layer

Automation is not a feature of GENTYR. It is the point.

Every ten minutes a background timer wakes up. It spawns agents for pending tasks. It adjusts its own frequency based on how much API budget remains. No human triggers any of this. No human needs to.

The system has one goal: keep agents working at capacity, indefinitely, without intervention.

This document describes how.

---

## Overview

GENTYR coordinates background automation, dynamic throughput adjustment, and session recovery. The system operates at three layers:

1. **In-session hooks** - Monitor and protect sessions during active Claude Code sessions
2. **Background automation** - Orchestrates task spawning on a timer
3. **Dynamic optimization** - Adjusts all automation cooldowns based on projected quota utilization

```
launchd timer (10 min) ──> hourly-automation.js ──> CTO Activity Gate
                                  |
                                  |── runUsageOptimizer()   -> adjust cooldown factor
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
| **SessionStart** | credential-health-check | Vault mapping validation, OP token desync detection |
| **PreToolUse(Bash)** | playwright-cli-guard | Block CLI-based Playwright test invocations (hard deny); escape hatch: `PLAYWRIGHT_CLI_BYPASS=1` prefix |

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
| Deployment | staging_reactive_review |
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
  |-- spawns: claude -p "[Automation] ..." --dangerously-skip-permissions
  |
  v
Session runs task
  |
  v
Session ends
```

### Interactive Session Flow

```
User starts claude
  |-- [SessionStart] credential-health-check validates vault mappings
  |
User works
  |
User or system stops session
```

### Concurrency Guards

- `MAX_CONCURRENT_AGENTS = 5` - total running agents across all types
- `MAX_TASKS_PER_CYCLE = 3` - new task spawns per automation cycle

---

## Credential Health Check Hook (credential-health-check.js)

Runs at `SessionStart` for interactive sessions (skipped for spawned `[Automation]`/`[Task]` sessions). Validates that all required credential mappings are present and that the `OP_SERVICE_ACCOUNT_TOKEN` in the shell environment is in sync with `.mcp.json`.

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
2. **Urgent Task Dispatcher** - Dispatch urgent priority tasks immediately (bypasses age filter)
3. **Task Runner** - Query todo.db for pending normal tasks (1-hour age filter), spawn agents up to concurrency limit
4. **Feedback Pipeline** - Trigger user persona testing on staging changes

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

Runs as a Husky pre-commit hook on every `git commit` attempt. As of **v4.0 (PR-Based Review)**, all commits use a universal fast path — lint and security checks only. Full deputy-CTO code review happens at PR time, not commit time.

### Commit Flow (v4.0)

```
git commit
  |
  v
pre-commit-review.js
  |-- [1] Lint config integrity check (block forbidden override files)
  |-- [2] Git core.hooksPath tamper check (BLOCK if redirected)
  |-- [3] Strict ESLint --max-warnings 0 on staged .ts/.tsx files
  |-- [4] Protected branch guard
  |       |-- Is branch main / staging / preview?
  |       |-- GENTYR_PROMOTION_PIPELINE=true? -> allow
  |       |-- Otherwise -> BLOCK
  |-- [5] G020 pending CTO items (informational only — shown in session briefing, does NOT block commits)
  |-- All checks pass -> commit allowed
  |
  v (post-commit, for feature branches)

Agent pushes branch and creates PR to preview
  |-- gh pr create --base preview ...
  |-- mcp__todo-db__create_task({ category_id: "triage", assigned_by: "pr-reviewer", priority: "urgent" })
  |-- Deputy-CTO reviews PR diff via gh pr diff, then approves+merges or requests changes
```

### PR-Based Review Flow

After committing and pushing a feature branch, the agent:
1. Creates a PR to `preview`: `gh pr create --base preview --head <branch>`
2. Creates an urgent DEPUTY-CTO task with `assigned_by: "pr-reviewer"` to trigger immediate review
3. The deputy-CTO reviews via `gh pr diff`, decides to approve+merge or request changes
4. Merged branches trigger worktree cleanup (30-minute cycle)

### Emergency Bypass

A CTO-authorized emergency bypass writes a `commit_decisions` row with `rationale LIKE 'EMERGENCY BYPASS%'` and `question_id IS NOT NULL`. The hook detects this within a 5-minute window and allows the commit without requiring a deputy-CTO review cycle. The `question_id IS NOT NULL` constraint ensures only bypass decisions created via the `execute_bypass` MCP tool (which always links to the originating bypass-request question) are honored — bare `approve_commit` calls with "EMERGENCY BYPASS" prefix are blocked by the server-side guard.

### G020 Status (Informational Only)

The `hasPendingCtoItems()` function queries:
- `deputy-cto.db` questions table: `WHERE status = 'pending'`
- `cto-reports.db` reports table: `WHERE triage_status = 'pending'` (or `triaged_at IS NULL` as fallback)

This is exposed in the session briefing for CTO visibility but does **not** block commits on any branch. The branch-aware blocking (main: hard block; staging: warn) was removed in Phase 2 of the production promotion overhaul.

### Fail-Closed Behavior

- `better-sqlite3` unavailable: skip G020 check (permissive)
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
| `.claude/state/automation-config.json` | Project | usage-optimizer | config-reader (all hooks) |
| `.claude/state/usage-snapshots.json` | Project | usage-optimizer | usage-optimizer, cto-dashboard |
