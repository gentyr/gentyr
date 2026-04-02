# CLAUDE.md Detailed Reference

Extracted reference sections from [CLAUDE.md](../CLAUDE.md). Each section is linked from the main file with a summary.

---

## Protection Security Model

**Security model** (as of current implementation):

| Target | Ownership | Permissions | Rationale |
|--------|-----------|-------------|-----------|
| Critical hook files (pre-commit-review.js, bypass-approval-hook.js, etc.) | root:wheel | 644 | Prevents agent modification; linked projects use copy-on-protect (`.claude/hooks-protected/`) to avoid root-owning framework source |
| `.claude/hooks/` directory | user:staff | 755 | Git needs write access for checkout/merge/stash |
| `.claude/` directory | user:staff | 755 | Git needs write access for stash/checkout/merge; symlink target verification replaces directory ownership |
| `.husky/` directory | root:wheel | 1755 | Prevents deletion of the pre-commit entry point |

**Tamper detection** uses two layers — symlink target verification and file ownership checks:
- **Symlink target verification** (`husky/pre-commit` + `gentyr-sync.js`): Verifies `.claude/hooks` symlink resolves to a directory whose grandparent contains `version.json` (GENTYR framework marker). Regular directories are only allowed in the framework repo itself. Replaces `.claude/` directory root-ownership as the anti-tampering mechanism.
- **Commit-time check** (`husky/pre-commit`): Before each commit, verifies symlink target + 10 critical hook files are still root-owned via `stat`. Prefers `.claude/hooks-protected/` when it exists (copy-on-protect for linked projects); falls back to `.claude/hooks/` for direct installs. Blocks commit if any check fails. The pre-commit script itself lives in a root-owned `.husky/` directory, making it trustworthy. Also checks `core.hooksPath` — if it points into `.claude/worktrees/` (stale entry from a sub-agent worktree), auto-repairs to `.husky` and exits 1 to force a re-run.
- **SessionStart check** (`gentyr-sync.js` `tamperCheck()`): At every interactive session start, runs three checks in order: (1) symlink target verification — confirms `.claude/hooks` resolves to a GENTYR framework; (1.5) `core.hooksPath` worktree check — if `core.hooksPath` resolves into `.claude/worktrees/`, auto-repairs to `.husky` and emits a warning; (2) file ownership check — reads `protection-state.json` and verifies each `criticalHooks` entry is still root-owned. When `state.hooksProtectedDir` is set (linked projects), ownership checks run against that directory instead of the live symlink target; a missing `hooks-protected/` directory is treated as tampering. Emits a `systemMessage` warning if any check fails.
- `protection-state.json` records `criticalHooks` as an array and, for linked projects, `hooksProtectedDir: ".claude/hooks-protected"` so both checks read the same source of truth dynamically.

---

## Worktrees core.hooksPath Poisoning Defense

**`core.hooksPath` poisoning defense**: Claude Code sub-agents in worktrees can write stale `core.hooksPath` entries to the main `.git/config`, silently bypassing all pre-commit hooks. Four layers defend against this:
1. **`removeWorktree()`** (`worktree-manager.js`): Before removing a worktree, reads `core.hooksPath` and resets it to `.husky` if it points into the worktree being removed.
2. **`tamperCheck()` Check 1.5** (`gentyr-sync.js`): At every interactive SessionStart, detects and auto-repairs a stale `core.hooksPath` pointing into `.claude/worktrees/`.
3. **`husky/pre-commit` worktree check**: At every commit, shell-level `case` match detects `.claude/worktrees/` in `core.hooksPath`, auto-repairs and exits 1 so the corrected path takes effect before lint-staged runs.
4. **`safeSymlink()` EINVAL fix** (`worktree-manager.js`): When provisioning a worktree, `safeSymlink()` now checks `lstatSync` before `readlinkSync` to handle existing real directories (e.g. git-tracked `.husky/` checked out into the worktree), preventing EINVAL crashes that previously left worktrees partially provisioned.

---

## Notion Plugin

Syncs four GENTYR data sources to Notion databases via a 60-second launchd daemon (`com.local.gentyr-notion-sync`). All reads are read-only opens against the source SQLite databases to avoid write conflicts with MCP servers.

**Synced entity types and waterline strategies:**

| Entity | Source DB | Strategy | Waterline field |
|--------|-----------|----------|----------------|
| Personas | `user-feedback.db` | Full-sync every cycle | none (mutable, few entries) |
| Reviews | `user-feedback.db` | Append-only waterline | `completed_at` |
| Work Log | `worklog.db` | Append-only waterline | `timestamp_completed` |
| Tasks | `todo.db` | Sync-time waterline | time of last sync (catches new + status transitions) |

**State persistence** (`plugins/notion/state.json`): maps `projectDir → ProjectState` with page ID tracking (gentyr UUID → Notion page ID) for idempotency, plus per-entity waterline timestamps. The tasks waterline advances to the sync start time each cycle so already-processed status transitions are not re-PATCHed.

**Task sync phases** (three-phase per cycle):
1. **New tasks** — tasks created since last waterline; created in Notion and ID stored in `taskPageIds`
2. **Modified tasks** — already-synced tasks whose `started_at` or `completed_at` changed since waterline; PATCHed in Notion
3. **Archived tasks** — tasks currently in `taskPageIds` that have been moved to the `archived_tasks` table (by `cleanup` or `delete_task` on completed tasks); PATCHed to status `Done` and `Archived` checkbox `true` in Notion then removed from `taskPageIds` to avoid re-PATCHing next cycle; waterline only advances when all three phases succeed without errors

All task upserts (new, modified, and archived) write the `Archived` checkbox unconditionally: `true` for archived tasks, `false` for active tasks. This keeps the Notion Tasks database filterable by archive state without relying on the status field alone.

**5 MCP tools** (registered as `plugin-notion` server):
- `notion_check_status` — token validity, database accessibility, service status, last sync timestamp
- `notion_sync` — on-demand sync; supports `dryRun: true` and per-`projectDir` targeting
- `notion_start_service` — writes plist to `~/Library/LaunchAgents/` and loads via `launchctl`
- `notion_stop_service` — unloads service and removes plist
- `notion_setup_instructions` — step-by-step setup guide returned as text

**Config** (`plugins/notion/config.json`): `{ plugin, version, enabled, mappings[] }` where each mapping requires `projectDir`, `integrationSecret`, `personasDbId`, `reviewsDbId`, and optionally `worklogDbId` and `tasksDbId`. Managed via `plugin_manager` MCP tools (`set_plugin_config`, `add_plugin_mapping`, `remove_plugin_mapping`). Config is gitignored and never committed.

**Logs**: `~/.claude/notion-sync.log` (stdout + stderr from the daemon, captured by launchd).

---

## Product Manager MCP Server

The product-manager MCP server (`packages/mcp-servers/src/product-manager/`) manages a 6-section product-market-fit (PMF) analysis pipeline. State is persisted in `.claude/state/product-manager.db`.

**Access via `/product-manager` slash command** (prefetches current status from the database before display, including demo scenario coverage for GUI and ADK personas — surfaces uncovered personas via `demoScenarios.uncoveredPersonas` in prefetch data).

**Command menu (when analysis is `completed`)**: Options include view section, run pipeline, regenerate markdown, finalize, persona compliance, list unmapped pain points, and **Demo scenarios** (Option 6). The demo scenarios sub-menu offers: Gap analysis (runs coverage table showing GUI and ADK personas, scenario counts, and CODE-REVIEWER task status), Create scenarios (spawns product-manager sub-agent for uncovered personas), and View scenarios (calls `mcp__user-feedback__list_scenarios`). After any demo scenario creation action, gap analysis is always re-run as a completion verification pattern — checks that every scenario has a matching `"Implement demo scenario: <title>"` CODE-REVIEWER task.

**Scope**: All 6 sections are external market research. Section content must not reference the local project, compare competitors to the local product, or describe the local product's features, strengths, or positioning. The local codebase is read only to determine what market space to research.

**6 Analysis Sections** (must be populated in strict sequential order):

| # | Key | Title | Write tool |
|---|-----|-------|------------|
| 1 | `market_space` | Market Space & Players | `write_section` |
| 2 | `buyer_personas` | Buyer Personas | `add_entry` (list, min 3) |
| 3 | `competitor_differentiation` | Competitor Differentiation | `write_section` |
| 4 | `pricing_models` | Pricing Models | `write_section` |
| 5 | `niche_strengths` | Niche Strengths & Weaknesses | `write_section` |
| 6 | `user_sentiment` | User Sentiment | `add_entry` (list, min 3) |

Sections 2 and 6 are **list sections**: they use `add_entry` instead of `write_section` and require at least **3 entries** (`MIN_LIST_ENTRIES = 3`) to be considered populated. `get_analysis_status` returns `entry_count` and `min_entries_required` for list sections.

**Analysis lifecycle**: `not_started` → `pending_approval` (initiate) → `approved` (deputy-CTO gate) → `in_progress` (first write) → `completed` (explicit `complete_analysis` call)

**14 Available Tools:**
- `get_analysis_status` — Current status, per-section progress, compliance stats
- `initiate_analysis` — Move to `pending_approval`; agent should then report to deputy-CTO
- `approve_analysis` — Called by deputy-CTO; moves to `approved`
- `read_section` — Returns target section plus all prior sections as context cascade
- `write_section` — Write content to sections 1, 3, 4, or 5 (enforces sequential lock)
- `add_entry` — Add an entry to sections 2 or 6 (enforces sequential lock)
- `update_entry` — Update an existing list entry by UUID
- `delete_entry` — Delete a list entry; also removes pain-point-persona mappings
- `list_pain_points` — List Section 6 entries with persona mappings; `unmapped_only` filter
- `map_pain_point_persona` — Map a Section 6 pain point to a persona from `user-feedback.db`
- `get_compliance_report` — Per-pain-point mapping status and compliance percentage
- `clear_and_respawn` — Wipe all section data and create all 6 `PRODUCT-MANAGER` todo tasks upfront with `followup_enabled: 0`; returns `task_ids: string[]`
- `complete_analysis` — Quality gate: validates all 6 sections meet population thresholds before marking `completed`; returns detailed error listing unpopulated sections with entry counts
- `regenerate_md` — Force-regenerate `.claude/product-market-fit.md` from database state

**Sequential lock**: `assertPreviousSectionsPopulated()` blocks any write to section N until sections 1..N-1 are populated. `clear_and_respawn` creates all 6 tasks upfront (not sequentially via followup chain) because the sequential lock already prevents out-of-order execution.

**Persona compliance**: After Section 6 is populated, pain points can be mapped to personas via `map_pain_point_persona`. Persona IDs are validated against `user-feedback.db` (read-only). `get_compliance_report` shows mapping coverage percentage.

**Forced follow-ups**: `product-manager` is in `FORCED_FOLLOWUP_CREATORS` — all tasks created by the product-manager agent automatically have `followup_enabled: true`, ensuring verification tasks are created on completion.

**Markdown output**: Every write operation regenerates `.claude/product-market-fit.md` with all section content.

**Post-analysis persona evaluation** (product-manager agent, 3-phase):
- **Mode selection**: Agent uses `AskUserQuestion` to ask whether to run **Fill gaps only** (idempotent — skips existing data) or **Full rebuild** (creates everything from scratch). `AskUserQuestion` is included in the agent's `allowedTools` for this purpose.
- **Phase 1 — Project Context Gathering**: Reads `package.json` to detect dev server URL and framework; globs for route/feature/component directories (cap 20); excludes `_`-prefixed dirs, `node_modules`, build output
- **Phase 2 — Register Features + Create Personas**: Calls `mcp__user-feedback__list_features()` to skip already-registered features (applies in both modes); in Fill gaps only mode, also calls `mcp__user-feedback__list_personas()` and `mcp__user-feedback__update_persona` to backfill existing personas where `endpoints` or `behavior_traits` is empty (never overwrites populated fields; skips `cto_protected: true` personas entirely); skips creating a new persona if an existing one covers the same archetype; calls `mcp__user-feedback__register_feature` for new dirs with `file_patterns` and `url_patterns`; creates personas via `mcp__user-feedback__create_persona` with all required fields: `name` (slug identifier, e.g. `power-user`), `display_name` (human-readable label shown in menus, e.g. `Power User`), `endpoints` (dev server URL), `behavior_traits` (derived from pain points), `consumption_mode` (`gui` for web apps, `api`/`cli`/`sdk` for other types)
- **Phase 3 — Mapping**: Checks existing feature mappings via `mcp__user-feedback__get_persona` before adding — skips persona-feature pairs that already exist (idempotent); maps pain points to personas via `map_pain_point_persona` (`unmapped_only: true` filter ensures idempotency); verifies with `get_compliance_report`; reports results to deputy-CTO with new vs existing counts for features, personas, and mappings

---

## On-Demand Triage and Deputy-CTO Tools

### On-Demand Triage

```bash
# In a Claude Code session after GENTYR is installed:
/triage
```

Force-spawns the deputy-CTO triage cycle immediately, bypassing the hourly automation's triage check interval, the automation-enabled flag, and the CTO activity gate. The command prefetches pending report counts and running agent info, asks for confirmation, then calls `force_triage_reports` on the agent-tracker MCP server. Returns the spawned session ID so the user can `claude --resume` into the triage session. Preserves the concurrency guard, agent tracker registration, and per-item triage cooldown filtering.

**Investigation-before-escalation**: When the deputy-CTO decides to escalate a report to the CTO queue, it first spawns an `INVESTIGATOR & PLANNER` task and links it to the escalation via `investigation_task_id`. A `[Investigation Follow-up]` task (assigned `system-followup`) is auto-created when the investigation completes. The follow-up picks up the escalation and either resolves it (calling `mcp__deputy-cto__resolve_question`) if the issue was already fixed, or enriches it with findings (calling `mcp__deputy-cto__update_question`) before the CTO reviews it. This reduces noise in the CTO queue by filtering out self-resolving issues.

**Investigation tools on the deputy-cto MCP server:**
- `update_question` — Appends timestamped investigation findings to a pending escalation's context field (append-only, 10KB cap). Blocked on `bypass-request` and `protected-action-request` types.
- `resolve_question` — Resolves and archives a pending escalation atomically (answer + archive to `cleared_questions` + delete from active queue). Valid resolution types: `fixed`, `not_reproducible`, `duplicate`, `workaround_applied`, `no_longer_relevant`. CTO never sees resolved escalations, but they remain in `cleared_questions` for audit and deduplication.

**Protected action approval tools on the deputy-cto MCP server:**
- `list_pending_action_requests` — List all pending (non-expired) protected action requests. Shows code, server, tool, args, and approval mode for each. Used during triage to discover actions awaiting deputy-CTO sign-off.
- `get_protected_action_request` — Get details of a specific pending request by its 6-character approval code. Use to inspect a request before approving or denying.
- `approve_protected_action` — Approve a `deputy-cto` approval-mode request. Verifies `pending_hmac` against the protection key unconditionally when a key is present (G001 fail-closed: a missing `pending_hmac` is treated as a forgery, not a skip), then writes an HMAC-signed `approved_hmac` entry so the gate hook can confirm authenticity. Uses `O_CREAT|O_EXCL` advisory file locking (same algorithm as `approval-utils.js`) with exponential backoff (10 attempts, stale-lock cleanup at 10 s) to prevent concurrent read-modify-write races on `.claude/protected-action-approvals.json`. Only works for `approval_mode: "deputy-cto"` — CTO-mode actions must be escalated.
- `deny_protected_action` — Remove a pending protected action request, recording a reason. Also uses `O_CREAT|O_EXCL` advisory file locking to prevent concurrent writes. Applicable to any approval mode.

**Pre-approved bypass tools on the deputy-cto MCP server:**
- `request_preapproved_bypass` — Create a long-lived, burst-use pre-approval for a specific server+tool. Stores a pending entry in `protected-action-approvals.json` with HMAC signature (`preapproval-pending` domain, domain-separated from standard approval HMACs). Returns a 6-character code and instructions for CTO confirmation via AskUserQuestion. Constraints: max 5 active pre-approvals, one per server+tool combination, expiry 1–12 hours (default 8), max uses 1–5 (default 3).
- `activate_preapproved_bypass` — Activate a pending pre-approval after CTO confirms interactively via AskUserQuestion. Verifies `pending_hmac`, sets `status: "approved"`, and writes `approved_hmac` (domain `preapproval-activated`). The activated entry can then be auto-consumed by any agent invoking the matching server+tool via the gate hook's Pass 2 path.
- `list_preapproved_bypasses` — List all active (non-expired) pre-approvals with code, server, tool, reason, status, uses remaining, and hours until expiry.

**Pre-approved bypass security model:**
- HMAC domains are separated from standard approvals: `preapproval-pending` and `preapproval-activated` vs `pending` and `approved`. Cross-forging between standard approvals and pre-approvals is cryptographically blocked.
- G001 fail-closed for pre-approvals: the gate hook's Pass 2 rejects any pre-approval if the protection key is missing, regardless of whether HMAC fields are present. This is stricter than Pass 1 (which allows legacy no-HMAC approvals) because pre-approvals are long-lived and higher risk.
- Burst-use window: after the first consumption, subsequent uses must occur within 60 seconds (`burst_window_ms: 60000`). If the window elapses, remaining uses are expired. This constrains multi-step operations without creating an open-ended multi-use token.
- Args-agnostic: matches ANY invocation of the server+tool regardless of arguments. Designed for operations where exact args are unpredictable at approval time (e.g., scheduled deployments).

**`approval-utils.js` security model** (`.claude/hooks/lib/approval-utils.js`):
- `validateApproval(phrase, code)` — called by the gate hook when an agent submits an approval phrase; verifies `pending_hmac` before marking approved; if protection key is present and `pending_hmac` is missing-or-invalid, rejects with `FORGERY` reason (G001 fail-closed); writes `approved_hmac` on success so `checkApproval()` can verify downstream
- `checkApproval(server, tool, args)` — two-pass approval scan under file lock: Pass 1 checks standard exact-match approvals (args-bound, single-use, skips `is_preapproval` entries); Pass 2 checks pre-approved bypasses (args-agnostic, burst-use, requires protection key unconditionally). Both passes verify HMAC signatures and delete forged entries. Pre-approval entries identified by `is_preapproval: true` flag.
- `saveApprovals()` in both `approval-utils.js` and `protected-action-gate.js` uses atomic write-via-rename (write to `.tmp.<pid>`, then `fs.renameSync`) to prevent partial writes from concurrent access leaving a corrupted approvals file; the tmp file is unlinked on rename failure

---

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by API quota limits, unexpected process death, or full account exhaustion.

**Dead Agent Recovery Hook** (`.claude/hooks/dead-agent-recovery.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Immediate dead-agent detection at session start — catches dead agents right away instead of waiting for the next 5-minute automation cycle
- Scans `agent-tracker-history.json` for agents with `status: 'running'` and a `pid`, checks liveness via `process.kill(pid, 0)`, and for each dead agent: marks it `completed` with `reapReason: 'process_already_dead'` and resets the linked TODO task from `in_progress` to `pending` (clears both `started_at` and `started_timestamp`)
- Uses the same `agent-tracker-history.json.lock` file (O_CREAT|O_EXCL advisory locking, 10-attempt exponential backoff) as `agent-tracker.js` and `reap-completed-agents.js` to coordinate with concurrent automation processes; bails early if the lock cannot be acquired
- Emits a `systemMessage` summary when agents are recovered (terminal-visible only)
- 5-second timeout; registered in `settings.json.template` under `SessionStart` after `todo-maintenance.js`

**Session Reviver** (`.claude/hooks/session-reviver.js`):
- Called from `hourly-automation.js` every automation cycle (10-minute cooldown via `getCooldown('session_reviver', 10)`)
- Gate-exempt step: runs after key sync, not subject to the CTO activity gate, so recovery proceeds even when the CTO is inactive
- **Retroactive first-run window**: On the first cycle after startup, uses a 12-hour stale window instead of 30 minutes, picking up sessions interrupted before the automation process started
- **Revival prompt**: Each resumed session receives a structured context prompt with elapsed time, interruption reason, and task verification instructions — the agent must call `mcp__todo-db__get_task` or `mcp__todo-db__list_tasks` before continuing to avoid duplicating work already handled by another agent
- **taskId resolution**: Resolved from `agent-tracker-history.json` metadata so the revival prompt can reference the specific task ID
- **Mode 3 sessionId fallback**: When `paused-sessions.json` lacks an explicit `sessionId`, finds the session JSONL file by scanning for the `[AGENT:<agentId>]` marker in the first 2KB of each transcript file
- **Mode 3 worktree path**: Resolves `worktreePath` from `agent-tracker-history.json` by `agentId` (same lookup as Mode 1), fixing a gap where Mode 3 sessions were resumed in the main project directory instead of their original worktree CWD
- **Worktree CWD support** (`resumeCwd` param): `spawnResumedSession()` accepts an optional `resumeCwd` argument; resumes in the agent's original worktree path if it still exists, falls back to the main project directory otherwise (adds a note to the revival prompt when the worktree has been cleaned up)
- **Worktree session discovery** (Mode 1 and 2): When `findSessionFileByAgentId` fails in the main project session directory, falls back to `agent.metadata?.worktreePath` via `getSessionDir()` — covers the ~95% of task-runner agents that run in worktrees and store sessions in worktree-specific directories
- **Mode 2 `in_progress` task acceptance**: Queries TODO tasks with `status IN ('pending', 'in_progress')` — handles the case where the reaper ran and marked the agent dead but couldn't find the session file (so the task was never reset to `pending`); also performs inline reaping of running-but-dead agents found during the scan (sets task to `pending` before attempting revival)
- **Duplicate revival guard**: Checks `quota-interrupted-sessions.json` for `status: 'revived'` before attempting Mode 1 spawns — prevents double-revival when inline revival in the stop hook already succeeded
- **Advisory file locking**: Uses `acquireLock`/`releaseLock` from `agent-tracker.js` around history-file reads and writes to coordinate with concurrent automation processes; includes lock leak fix on error paths
- **Memory pressure gate**: `shouldAllowSpawn()` from `lib/memory-pressure.js` checked before each spawn; revival is queued (not permanently skipped) when memory-blocked
- Cap: 3 revivals per cycle (`MAX_REVIVALS_PER_CYCLE`); respects the running-agent concurrency limit

**Three revival modes (priority order):**

| Mode | Source state file | Trigger | Stale window |
|------|-------------------|---------|--------------|
| 1 — Quota-interrupted | `.claude/state/quota-interrupted-sessions.json` | `stop-continue-hook.js` writes on quota death | 30 min (12h retroactive on first run) |
| 2 — Dead session recovery | `.claude/state/agent-tracker-history.json` | Agents reaped with `process_already_dead` + pending/in_progress TODO task | 7 days |
| 3 — Paused sessions | `.claude/state/paused-sessions.json` | `quota-monitor.js` `writePausedSession()` when all accounts exhausted | 24h |

**Stop Hook** (`.claude/hooks/stop-continue-hook.js`):
- Writes `quota-interrupted-sessions.json` entries with `status: 'pending_revival'` when a spawned session dies from a rate limit error
- **Phase 1 — Inline revival**: After successful credential rotation, immediately spawns `claude --resume <sessionId>` via `inlineRevive()` — reducing revival latency from 5-15 minutes to 0-2 seconds. The safety-net record is written to `quota-interrupted-sessions.json` first (with `status: 'pending_revival'`); if inline revival succeeds the record is updated to `status: 'revived'` so session-reviver skips it. If all keys are exhausted, inline revival is skipped and session-reviver Modes 1 + 3 handle recovery once keys recover.
- **Memory pressure gate**: `shouldAllowSpawn()` from `lib/memory-pressure.js` is called before inline revival; spawn is blocked at critical pressure (blocked inline, queued for session-reviver).
- **Worktree path capture**: Resolves `worktreePath` from `agent-tracker-history.json` (keyed by `agentId` extracted from the transcript) and includes it in the quota-interrupted session record so Mode 1 revival can resume the session in the correct worktree CWD
- Cleanup window widened from 30 min to 12 h so records survive for retroactive revival on the first automation cycle after restart
- Tombstone consumer: filters tombstoned rotation state keys before passing to `checkKeyHealth()`
- **First [Automation]/[Task] stop — uncommitted changes gate**: On the first stop event for a spawned session, checks for uncommitted changes in the worktree; if found, injects a specific `additionalContext` instruction to spawn project-manager before exiting rather than a generic continue message. Ensures git discipline even when orchestrators reach their natural stop without explicitly invoking project-manager.
- Uses `lib/revival-utils.js` helpers (`buildRevivalPrompt`, `resolveTaskIdForAgent`, `extractSessionIdFromPath`) and `lib/spawn-env.js` (`buildSpawnEnv`) shared modules.

**Agent Reaper** (`scripts/reap-completed-agents.js`):
- **Worktree session discovery**: Both the dead-process path and the live-process path now fall back to `agent.metadata?.worktreePath` via `getSessionDir()` when `findSessionFileByAgentId` returns null for the main project session directory — enables session file caching and TODO reconciliation for worktree agents

**`quota-monitor.js` Mode 3 integration**: Calls `writePausedSession(agentId)` when all accounts are exhausted and a spawned session is about to be abandoned; session-reviver resumes it once any account recovers below 90% usage

**`agent-tracker.js` constants**: Exports `SESSION_REVIVED` (`'session-revived'`) and `SESSION_REVIVER` (`'session-reviver'`) agent/hook type constants consumed by session-reviver; mirrored in `packages/mcp-servers/src/agent-tracker/types.ts`. Also exports `acquireLock` / `releaseLock` for advisory file locking, used by session-reviver and dead-agent-recovery to coordinate concurrent history-file access.

**`config-reader.js` defaults**: `session_reviver: 10` and `abandoned_worktree_rescue: 30` minutes added to `DEFAULTS`; operators can override via `.claude/state/automation-config.json`

**Shared Revival Modules** (`lib/`):
- **`lib/memory-pressure.js`**: Monitors free RAM using `vm_stat` (macOS) or `/proc/meminfo` (Linux). Exports `shouldAllowSpawn({ priority, context })` — returns `{ allowed: boolean, reason: string }`. Critical pressure (< 256 MB free) blocks all spawning; high pressure (< 512 MB free) blocks non-urgent spawning. Spawns blocked by memory pressure are not permanently skipped — they remain in their source queue (quota-interrupted, paused-sessions, or task DB) for the next automation cycle or reviver pass.
- **`lib/spawn-env.js`**: Exports `buildSpawnEnv(projectDir)`, shared across stop-continue-hook, session-reviver, urgent-task-spawner, and hourly-automation. Consolidates proxy env-var injection (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS`) with `isProxyDisabled()` check.
- **`lib/revival-utils.js`**: Exports `buildRevivalPrompt({ reason, interruptedAt, taskId })`, `resolveTaskIdForAgent(agentId, projectDir)`, and `extractSessionIdFromPath(sessionPath)`. Used by both stop-continue-hook (inline revival) and session-reviver to produce consistent revival context prompts.

**Revival Daemon** (`scripts/revival-daemon.js`):
- Persistent daemon using `fs.watch()` + polling fallback for sub-second crash detection
- Watches `agent-tracker-history.json` for status changes to `completed`/`process_already_dead`; triggers revival pipeline on detection
- Registered as a launchd service (`com.local.gentyr-revival-daemon`) and systemd unit via `setup-automation-service.sh`
- Complements — does not replace — the 10-minute session-reviver cooldown in hourly automation; the daemon catches crashes within seconds while the reviver handles retroactive recovery after restarts
- **Queue drain on death**: calls `drainQueue()` when an agent is detected dead, so queued sessions fill the freed capacity immediately

## Centralized Session Queue

All agent spawning routes through `enqueueSession()` in `.claude/hooks/lib/session-queue.js`. Every previous `registerSpawn() + spawn('claude', ...) + updateAgent()` call site has been migrated.

**DB**: `.claude/state/session-queue.db` (SQLite, WAL mode). **Log**: `.claude/session-queue.log`.

**Schema**:
- `queue_items` — id, status (`queued`/`running`/`completed`/`failed`/`cancelled`/`expired`), priority, lane, spawn_type (`fresh`/`resume`), title, agent_type, hook_type, tag_context, prompt, model, cwd, mcp_config, resume_session_id, extra_args, extra_env, project_dir, worktree_path, metadata, source, agent_id, pid, enqueued_at, spawned_at, completed_at, error, expires_at
- `queue_config` — key/value pairs; seeded with `max_concurrent_sessions = 10`

**Indexes**: `idx_queue_status` (status), `idx_queue_priority` (priority, lane, enqueued_at)

**Priority ordering** (lower = higher): `critical:0` > `urgent:1` > `normal:2` > `low:3`

**Lane sub-limits**: `gate` lane capped at 5 concurrent (Haiku gate agents)

**Default TTL**: 30 minutes; expired items are marked `expired` on next drain

**Default concurrency**: 10 (configurable 1–50)

**`enqueueSession(opts)`**: Inserts a queue item, then calls `drainQueue()` immediately. Returns `{ queued: true, queueId, position }` or `{ queued: false, spawned: true, queueId, agentId, pid }` if spawned inline.

**`drainQueue()`**: Counts live running items (PID liveness check via `kill(pid, 0)`), spawns queued items up to capacity in priority order. Skips gate-lane items beyond 5. Dead running items are marked `failed` to free capacity. Returns `{ drained, skipped, errors }`.

**`getQueueStatus()`**: Returns `{ running, queued, config: { max_concurrent_sessions }, stats_24h: { avg_wait_ms, total_completed, top_sources } }`. Used by `get_session_queue_status` MCP tool and the dashboard reader.

**4 MCP tools** (on `agent-tracker` server):
- `get_session_queue_status` — running items (with PID liveness), queued items, capacity, 24h throughput
- `set_max_concurrent_sessions` — update global limit (1–50); persisted to `queue_config` table
- `cancel_queued_session` — mark a `queued` item `cancelled` by queue ID
- `drain_session_queue` — trigger immediate drain; useful after manual capacity adjustment

**Dashboard**: `SessionQueueSection` (Page 1) reads from `session-queue-reader.ts`. Capacity bar: green (<70%), yellow (70–89%), red (90%+). Columns: title, source, wait/elapsed.

**Slash commands**:
- `/session-queue` — calls `mcp__show__show_session_queue()`; shows running/queued tables + 24h stats
- `/concurrent-sessions [N]` — with no arg: show status; with number: calls `set_max_concurrent_sessions` then shows updated status

**Migrated spawn sites** (21 files): `task-gate-spawner.js`, `urgent-task-spawner.js`, `demo-failure-spawner.js`, `stop-continue-hook.js`, `session-reviver.js`, `compliance-checker.js`, `antipattern-hunter-hook.js`, `plan-executor.js`, `schema-mapper-hook.js`, `reporters/jest-failure-reporter.js`, `reporters/vitest-failure-reporter.js`, `reporters/playwright-failure-reporter.js`, `lib/revival-utils.js`, `todo-maintenance.js`, `hourly-automation.js`, `scripts/force-spawn-tasks.js`, `scripts/force-triage-reports.js`, `scripts/feedback-launcher.js`, `.claude/hooks/feedback-launcher.js`, `scripts/revival-daemon.js`, `packages/mcp-servers/test/reporters/test-failure-reporter.ts`

### Quota Monitor Hook

**Quota Monitor Hook** (`.claude/hooks/quota-monitor.js`):
- Runs after every tool call (throttled to 5-minute intervals)
- Checks active key usage and triggers rotation at 95% utilization
- **Step 4b unified refresh loop**: Refreshes expired tokens AND proactively refreshes non-active tokens approaching expiry (within 10 min of `EXPIRY_BUFFER_MS`); uses single loop with `isExpired`/`isApproachingExpiry` variables for efficiency
- `refreshExpiredToken` returns the sentinel string `'invalid_grant'` (not `null`) when the OAuth server responds HTTP 400 + `{ error: 'invalid_grant' }`; callers mark the key `invalid` and skip it permanently
- **Step 4c pre-expiry restartless swap**: When the active key is within 10 min of expiry and a valid standby exists, writes standby to Keychain via `updateActiveCredentials()`; Claude Code's built-in `SRA()` (proactive refresh at 5 min before expiry) or `r6T()` (401 recovery) picks up the new token seamlessly — no restart needed
- Safe: refreshing Account B does not revoke Account A's in-memory token
- **Seamless rotation** (quota-based): writes new credentials to Keychain, continues with `continue: true` for all sessions, credentials adopted at token expiry (SRA) or 401 (r6T); rotation message shows `fromEmail (usage%) → toEmail` for human-readable account identification
  - No disruptive kill/restart paths; no orphaned processes
  - All-exhausted message differentiates interactive vs automated sessions and includes active account email; interactive prompt suggests `/login`, automated prompt notes session will resume when quota resets
- Post-rotation health audit: logs rotation verification to `rotation-audit.log`
- Fires `account_nearly_depleted` rotation log event when active key reaches 95% usage (5-hour per-key cooldown to avoid re-firing every check cycle)
- Fires `account_quota_refreshed` rotation log event when a previously exhausted key's usage drops back below 100% (also fires in `api-key-watcher.js` during SessionStart health checks)

### API Key Watcher Hook

**API Key Watcher Hook** (`.claude/hooks/api-key-watcher.js`):
- Runs at `SessionStart` for interactive sessions only; performs health checks on all registered keys
- **Refresh-before-invalidate**: When a health check fails (401/invalid), calls `refreshExpiredToken(keyData)` before marking the key `invalid`. Three outcomes:
  - `refreshed === 'invalid_grant'` — refresh token permanently revoked; marks key `invalid`, logs `health_check_failed_then_invalid_grant`
  - `refreshed` truthy — access token recovered; updates `accessToken`/`refreshToken`/`expiresAt`, marks key `active`, logs `key_added` with reason `token_refreshed_after_health_check_failure`
  - `refreshed` falsy (transient error) — marks key `expired` (recoverable), logs `health_check_failed_*_refresh_failed`
- This replaces the previous behavior of immediately marking keys `invalid` on any health check failure, preventing false-positive permanent invalidation of keys with expired (but refreshable) access tokens
- Fires `account_quota_refreshed` when a previously exhausted key's usage drops back below 100%

### Key Sync Module

**Key Sync Module** (`.claude/hooks/key-sync.js`):
- Shared library used by api-key-watcher, hourly-automation, credential-sync-hook, and quota-monitor
- Exports `EXPIRY_BUFFER_MS` (10 min) and `HEALTH_DATA_MAX_AGE_MS` (15 min) constants for consistent timing across all rotation logic
- `refreshExpiredToken` returns `'invalid_grant'` sentinel (distinct from `null`) when OAuth responds 400 + `error: invalid_grant`; all callers mark the key `status: 'invalid'` and log `refresh_token_invalid_grant`
- `readCredentialSources()` no longer filters Keychain entries by `expiresAt`: expired Keychain tokens are included so `syncKeys()` can pick them up and call `refreshExpiredToken()` to obtain a new access token. Previously, expired Keychain tokens were silently dropped before reaching the refresh path, causing auth failures.
- `syncKeys()` proactively refreshes non-active tokens approaching expiry (within `EXPIRY_BUFFER_MS`), resolves account profiles for keys missing `account_uuid` via `fetchAccountProfile()`, and performs pre-expiry restartless swap to Keychain; covers idle sessions because hourly-automation calls `syncKeys()` every 10 min via launchd even when no Claude Code process is active
- `fetchAccountProfile(accessToken)` — exported function that calls `https://api.anthropic.com/api/oauth/profile` to resolve `account_uuid` and `email` for keys added by automation or token refresh that skipped the interactive SessionStart profile-resolution path; non-fatal, retried on next sync
- `selectActiveKey()` freshness gate: nulls out usage data older than 15 minutes to prevent uninformed switches based on stale health checks; stale keys pass "usable" filter but are excluded from comparison logic, causing system to stay put rather than make blind decisions
- `pruneDeadKeys` converts keys with `status: 'invalid'` to `status: 'tombstone'` (with `tombstoned_at` timestamp and 24h TTL) rather than deleting them; tombstoned keys are distinguishable from genuinely unknown tokens so the rotation proxy can swap rather than passthrough; fires `account_auth_failed` rotation log event only when an account loses its last viable key; email resolution order: key-level `account_email` → sibling key with same `account_uuid` → rotation_log history for same `key_id`; fires `account_auth_failed` only once per account (checks remaining non-pruned keys with same email to avoid duplicates); tombstoned entries removed from rotation_log only after their 24h TTL expires; `hasOtherViableKey` filter excludes `tombstone` status; never prunes the active key; called automatically at the end of every `syncKeys()` run
- `refreshExpiredToken` skips keys with `status: 'tombstone'` (in addition to `'invalid'`)
- `deduplicateKeys()` returns `{ merged: number, details: Array<{ removed: string, survivor: string, email: string|null }> }` — `details` contains truncated key ID pairs and account email for each merge; used by `syncKeys()` to log human-readable dedup output (e.g., `a1b2c3d4→e5f6g7h8 (user@example.com)`)

### Rotation Monitoring

**Rotation Monitoring** (`scripts/monitor-token-swap.mjs`):
```bash
# Real-time rotation state monitoring
node scripts/monitor-token-swap.mjs --path /project [--interval 30]

# Rotation health audit report
node scripts/monitor-token-swap.mjs --path /project --audit
```

Tracks credential rotation state, Keychain sync status, and account health. Audit mode generates rotation health reports showing recent rotations, pending audits, and system alerts.

**Binary Patch Research** (`scripts/patch-credential-cache.js`) — **ARCHIVED**:
Research artifact from investigating Claude Code's credential memoization cache. Replaced by the rotation proxy which handles credential swap at the network level, eliminating the need for binary modification. Kept for reference only.

---

## Hooks Reference

### GENTYR Auto-Sync Hook

**GENTYR Auto-Sync Hook** (`.claude/hooks/gentyr-sync.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Fast path: reads `version.json` and `gentyr-state.json`, compares version + config hash — exits in <5ms when nothing has changed
- When version or config hash mismatch detected: re-merges `settings.json`, regenerates `.mcp.json` (preserving OP token), updates the GENTYR section of `CLAUDE.md`, and symlinks new agent definitions; handles missing `settings.json` gracefully by checking directory writability instead of file writability when the file does not yet exist
- Auto-rebuilds MCP servers when `src/` mtime > `dist/` mtime; checks for `@types/node` in `packages/mcp-servers/node_modules/` and runs `npm install` first if missing, then `npm run build` (30s timeout); build failures are silently swallowed — no stderr, no warning; session continues unblocked
- Syncs husky hooks by comparing `husky/` against `.husky/` in the target project; re-copies if content differs
- **Husky untrack migration** (target projects only, skipped in gentyr repo itself): if `.husky/pre-commit`, `.husky/post-commit`, or `.husky/pre-push` are tracked by git, runs `git rm --cached .husky/<file>` to untrack them — these files are managed by GENTYR and should not be committed in target projects; logs each untracked file as a change entry
- Falls back to legacy settings.json hook diff check when no `gentyr-state.json` exists (pre-migration projects)
- Supports both npm model (`node_modules/gentyr`) and legacy symlink model (`.claude-framework`)
- **`tamperCheck()`**: Runs before sync logic. Two checks: (1) symlink target verification — confirms `.claude/hooks` is a symlink resolving to a directory whose grandparent contains `version.json`; regular directories only allowed in the framework repo itself; (2) file ownership check — reads `protection-state.json`, if `protected: true` verifies each filename in `criticalHooks` array is still root-owned (`stat.uid === 0`). Emits a `systemMessage` warning listing all failed checks if any are detected.
- **Branch protection auto-fix** (runs at end of every interactive SessionStart, after sync checks): if the main working tree is on a protected non-base branch (e.g. `staging` or `main` in a target project) with no uncommitted changes, auto-runs `git checkout <baseBranch>` and surfaces a `BRANCH AUTO-FIX` systemMessage; if uncommitted changes are present, emits a recovery warning instead. Non-fatal — never blocks session start.
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; version 3.0

### CTO Notification Hook

**CTO Notification Hook** (`.claude/hooks/cto-notification-hook.js`):
- Runs at `UserPromptSubmit` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`) and slash commands (sentinel markers or `/command-name` pattern)
- Checks deputy-cto database (pending decisions, rejections), agent-reports database (unread reports), todo.db (queued/active task counts), and autonomous mode status
- Reads aggregate quota from `~/.claude/api-key-rotation.json`; deduplicates same-account keys by `account_uuid`; falls back to fingerprint cross-match for null-UUID keys
- Displays a multi-line status block each prompt (quota bar, 30-day token usage, session counts, TODO counts, pending CTO items)
- Critical mode: when `rejections > 0`, collapses to a compact one-liner with `COMMITS BLOCKED` prefix; compact quota display appends `[activeEmail]` and uses `activeCount >= 1` guard (works for single-account setups too) with singular/plural grammar
- Uses an incremental session-file cache (`~/.claude/cto-metrics-cache-*.json`) with a 3-second time budget to compute token usage without blocking
- Output uses both `systemMessage` (terminal display) and `hookSpecificOutput.additionalContext` (AI model context) so the AI can act on quota/deadline data
- Tests at `.claude/hooks/__tests__/cto-notification-hook.test.js` (38 tests, runs via `node --test`)

### Branch Drift Check Hook

**Branch Drift Check Hook** (`.claude/hooks/branch-drift-check.js`):
- Runs at `UserPromptSubmit` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Detects when the main working tree is not on the expected base branch and emits a warning via both `systemMessage` (terminal) and `additionalContext` (AI model context)
- Auto-detects expected branch via `detectBaseBranch()` (shared from `lib/feature-branch-helper.js`): `preview` if `origin/preview` exists (target projects with merge chain), else `main` (gentyr repo or projects without preview)
- Uses `getCooldown('branch_drift_check', 30)` (30-minute default, configurable); cooldown resets immediately if the branch changes
- State file: `.claude/state/branch-drift-state.json` with `{ lastCheck, lastBranch }`
- Skips worktrees (`.git` file check), detached HEAD, and spawned sessions
- **Protected branch auto-switch**: when the main tree is on a protected non-base branch (`main`, `preview`, or `staging`, but not the detected base branch) with no uncommitted changes, auto-runs `git checkout <baseBranch>` and returns an `AUTO-FIX` message; falls through to a `CRITICAL BRANCH DRIFT` warning when auto-switch fails or uncommitted changes are present
- Non-protected branch drift (e.g. feature branch left checked out) emits a plain `BRANCH DRIFT` warning without auto-switching
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `UserPromptSubmit`
- Tests at `.claude/hooks/__tests__/gentyr-sync-branch-drift.test.js` (runs via `node --test`)

### Branch Checkout Guard

**Branch Checkout Guard** (two-layer defense — `.claude/hooks/branch-checkout-guard.js` + `.claude/hooks/git-wrappers/git`):

Prevents branch drift by blocking `git checkout`/`git switch` in the main working tree. Complements the warn-only Branch Drift Check with a hard enforcement layer:

- **Layer 1 — Git wrapper** (`.claude/hooks/git-wrappers/git`): POSIX shell script placed in `git-wrappers/` directory; injected into spawned agent environments via `PATH` prepending in `buildSpawnEnv()` (hourly-automation, urgent-task-spawner, session-reviver, force-spawn-tasks, force-triage-reports). Intercepts `git checkout`/`git switch` invocations (all sessions, recovery path to base branch always allowed). Also blocks `git add`/`git commit` on protected non-base branches (`main`/`preview`/`staging` but not the detected base) for ALL sessions — plus the full spawned-agent guard (`git add`/`git commit`/`git reset --hard`/`git stash`/`git clean`/`git pull` for `CLAUDE_SPAWNED_SESSION=true`). `GENTYR_PROMOTION_PIPELINE=true` exempts all guards. Exits 128 with a descriptive message on blocked operations. Zero-overhead fast path for all other git subcommands. Root-owned via `npx gentyr protect`.
- **Layer 2 — PreToolUse hook** (`.claude/hooks/branch-checkout-guard.js`): Hard-blocking (`permissionDecision: "deny"`) Claude Code PreToolUse hook that catches checkout/switch at the tool-call level. Covers interactive sessions (where PATH injection is not active) and agents that invoke `/usr/bin/git` directly, bypassing the PATH wrapper. Uses the same quote-aware `tokenize()` + `splitOnShellOperators()` pattern from `credential-file-guard.js` for robust parsing of chained commands. Recovery path is dynamic: detects base branch via `detectBaseBranch()` (shared from `lib/feature-branch-helper.js`) so `git checkout preview` is allowed in target projects and `git checkout main` in the gentyr repo. `GENTYR_PROMOTION_PIPELINE=true` passes through.
- **Both layers**: Skip silently in worktrees (`.git` file check — `.git` is a file in a worktree, not a directory), non-repo directories, and skip global git flags (`-C`, `--git-dir`, etc.) when locating the subcommand. Always allow checkout to the detected base branch and file restore invocations (`git checkout -- <file>`).
- Registered in `settings.json.template` under `PreToolUse > Bash`. Root-owned and listed in `protection-state.json` `criticalHooks` array alongside `git-wrappers/git`. Included in the `husky/pre-commit` tamper-detection ownership loop.
- Tests at `.claude/hooks/__tests__/branch-checkout-guard.test.js` (runs via `node --test`)

### Main Tree Commit Guard Hook

**Main Tree Commit Guard Hook** (`.claude/hooks/main-tree-commit-guard.js`):
- Runs at `PreToolUse` for Bash tool calls; hard-blocking (`permissionDecision: "deny"`)
- **Layer 1 (ALL sessions)**: Blocks `git add` and `git commit` when the main working tree is on a protected non-base branch (`main`, `preview`, or `staging`, but not the detected base branch). Fires for both interactive and spawned sessions. `GENTYR_PROMOTION_PIPELINE=true` exempted. Uses `detectBaseBranch()` and `PROTECTED_BRANCHES` from `lib/feature-branch-helper.js`. Provides a stash-then-switch recovery hint in the error message.
- **Layer 2 (spawned agents only)**: Fires when ALL three conditions are true: `CLAUDE_SPAWNED_SESSION=true`, `.git` is a directory (main tree, not a worktree), and `GENTYR_PROMOTION_PIPELINE !== 'true'`. Blocked subcommands: `git add`, `git commit`, `git reset --hard`, `git stash` (push/pop/drop/clear/apply — `list`/`show` are read-only and allowed), `git clean`, `git pull`.
- Uses the same quote-aware `tokenize()` + `splitOnShellOperators()` pattern from `branch-checkout-guard.js` for robust multi-command parsing
- Complements the git wrapper (`git-wrappers/git`) which enforces the same rules via PATH injection; together they form a two-layer defense
- Root-owned and listed in `protection-state.json` `criticalHooks` array; included in the `husky/pre-commit` tamper-detection ownership loop
- Tests at `.claude/hooks/__tests__/main-tree-commit-guard.test.js` (runs via `node --test`)

### Uncommitted Change Monitor Hook

**Uncommitted Change Monitor Hook** (`.claude/hooks/uncommitted-change-monitor.js`):
- Runs at `PostToolUse` for Write and Edit tool calls
- Tracks cumulative file-modifying tool calls since the last `git commit` via `.claude/state/uncommitted-changes-state.json`
- At threshold (5 edits), injects an `additionalContext` warning instructing the agent to commit immediately; 3-minute cooldown between repeat warnings
- Counter resets when a new commit is detected (HEAD hash change via `git log -1 --format=%H`)
- Skips all spawned agents (`CLAUDE_SPAWNED_SESSION=true`) — only the project-manager and interactive (CTO) sessions commit, so warning other spawned agents is counterproductive; fires for interactive sessions only
- Output uses `hookSpecificOutput.additionalContext` so the AI model receives the warning, not just the terminal display
- Tests at `.claude/hooks/__tests__/uncommitted-change-monitor.test.js` (16 tests, runs via `node --test`)

### PR Auto-Merge Nudge Hook

**PR Auto-Merge Nudge Hook** (`.claude/hooks/pr-auto-merge-nudge.js`):
- Runs at `PostToolUse` for Bash tool calls only
- Detects `gh pr create` commands that produce a PR URL in the response
- Injects `additionalContext` reminding the agent to self-merge immediately with `gh pr merge <number> --squash --delete-branch`
- No-op if the command is not `gh pr create` or if no PR URL is found in the response
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PostToolUse > Bash`

### Project Manager Reminder Hook

**Project Manager Reminder Hook** (`.claude/hooks/project-manager-reminder.js`):
- Runs at `PostToolUse` after `mcp__todo-db__summarize_work` tool calls
- Only active for spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) running in a worktree (`.git` is a file, not a directory)
- Checks for uncommitted changes via `git status --porcelain`; if found, injects `additionalContext` instructing the orchestrator to spawn project-manager before calling `complete_task`
- Fail-open design: any error (git failure, missing `.git`, etc.) exits with `{ continue: true }` and no injection
- Complements the Stop Hook first-stop check; this hook fires at work-summary time so orchestrators receive the reminder while still active rather than only at the final stop event
- Registered in `settings.json.template` under `PostToolUse > mcp__todo-db__summarize_work`

### Credential Health Check Hook

**Credential Health Check Hook** (`.claude/hooks/credential-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions
- Validates vault mappings against required keys in `protected-actions.json`
- Checks `.mcp.json` env blocks for keys injected directly (e.g. `OP_SERVICE_ACCOUNT_TOKEN`), which count as configured even if absent from vault-mappings
- **OP token desync detection**: Compares shell `OP_SERVICE_ACCOUNT_TOKEN` against `.mcp.json` value; if they differ, emits a warning and overwrites `process.env` with the `.mcp.json` value (source of truth); `.mcp.json` is always authoritative because it is updated by reinstall
- **Vault-mappings backup/restore** (`lib/vault-mappings.js`): When vault-mappings.json has non-empty mappings, a backup is written to `.claude/state/vault-mappings.backup.json`. If vault-mappings.json is missing at `SessionStart`, the hook attempts to restore from backup before treating all keys as missing. `init` and `sync` also restore from backup when the primary file is absent or empty.
- Auto-propagates to target projects via `.claude/hooks/` directory symlink
- Shell sync validation also available via `scripts/setup-validate.js` `validateShellSync()` function, which checks the `# BEGIN GENTYR OP` / `# END GENTYR OP` block in `~/.zshrc` or `~/.bashrc`

### Credential File Guard Hook

**Credential File Guard Hook** (`.claude/hooks/credential-file-guard.js`):
- Runs at `PreToolUse` for Read, Write, Edit, Grep, Glob, and Bash tool calls; hard-blocking (uses `permissionDecision: "deny"` — not just a warning)
- Blocks access to `BLOCKED_BASENAMES` (`.env`, `.zshrc`, `.bashrc`, etc.) and `BLOCKED_PATH_SUFFIXES` (`.claude/protection-key`, `.claude/api-key-rotation.json`, `.mcp.json`, etc.)
- For Bash commands, uses a quote-aware shell tokenizer (`tokenize()`) to extract redirection targets (including quoted targets like `echo hello > ".env"`), command arguments, and inline path references; `NON_FILE_COMMANDS` set exempts echo/printf/git/package managers to avoid false positives
- Redirection scan covers `>`, `>>`, `<`, `2>`, `2>>`, `1>`, `1>>`, `0<` and operates on tokenized output so quoted bypasses (e.g. `> ".env"`) are caught; also detects protected basename references in path context (`/basename` or `~basename` patterns) to block deep-path variants
- `ALWAYS_BLOCKED_SUFFIXES` and `ALWAYS_BLOCKED_BASENAMES` are hard-blocked with no approval escape hatch; other protected paths can be approved via `protected-action-approvals.json`
- Blocks credential environment variable references (`$TOKEN`, etc.) sourced from `protected-actions.json` `credentialKeys` arrays; also blocks environment dump commands (`env`, `printenv`, `export -p`)
- Root-ownership of credential files at the OS level is the primary defense; this hook is defense-in-depth
- Tests at `.claude/hooks/__tests__/credential-file-guard.test.js` (165 tests, 24 skipped pending G027 B2 integration, runs via `node --test`)

### Playwright CLI Guard Hook

**Playwright CLI Guard Hook** (`.claude/hooks/playwright-cli-guard.js`):
- Runs at `PreToolUse` for Bash tool calls only; hard-blocking (`permissionDecision: "deny"`)
- Detects CLI-based Playwright invocations (`npx playwright test`, `pnpm test:e2e`, `pnpm test:pw`, and equivalents for npm/yarn)
- Blocks execution and directs agent to use MCP tools instead (`mcp__playwright__run_tests`, `mcp__playwright__launch_ui_mode`, etc.)
- Rationale: CLI invocations bypass the Playwright MCP server's 1Password credential injection, causing tests to fail or skip silently without proper environment variables
- **Escape hatch**: Prefix the command with `PLAYWRIGHT_CLI_BYPASS=1` to allow CLI execution for a single command (e.g., `PLAYWRIGHT_CLI_BYPASS=1 npx playwright install`). Valid reasons: codegen/trace viewer, debugging with custom Node flags, installing browsers
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PreToolUse > Bash`
- Tests at `.claude/hooks/__tests__/playwright-cli-guard.test.js` (41 tests, runs via `node --test`)

### Playwright Health Check Hook

**Playwright Health Check Hook** (`.claude/hooks/playwright-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Automation]`/`[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Fast-path exit when no `playwright.config.ts` or `playwright.config.js` exists in the project root (target projects that don't use Playwright are unaffected)
- Writes `.claude/playwright-health.json` with auth state freshness, cookie expiry, and extension build status
- `authState` fields: `exists`, `ageHours`, `cookiesExpired`, `isStale` (true when cookies expired or age >24h)
- **Dynamic auth file discovery**: reads `storageState` from the first project entry in `playwright.config.ts` via regex; falls back to scanning `.auth/` for any `.json` file; no hardcoded auth file names (project-agnostic)
- `extensionBuilt` checks for the directory specified by `GENTYR_EXTENSION_DIST_PATH` env var (relative to project root); defaults to `true` (no blocker) when unset
- `needsRepair: true` when `authState.isStale || !extensionBuilt`
- Emits a visible stderr warning when auth state is stale; read by `slash-command-prefetch.js` as a 1-hour cache (avoids re-reading `.auth/*.json` on every `/demo` invocation)
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `SessionStart` (timeout: 5)
- Tests at `.claude/hooks/__tests__/playwright-health-check.test.js` (10 tests, runs via `node --test`)

### Worktree Path Guard Hook

**Worktree Path Guard Hook** (`.claude/hooks/worktree-path-guard.js`):
- Runs at `PreToolUse` for `Write`, `Edit`, and `NotebookEdit` tool calls; hard-blocking (`permissionDecision: "deny"`)
- Only active when the session is running inside a git worktree (detected by `.git` being a file, not a directory)
- Reads `.git` file to extract the worktree root and main repo root from the `gitdir:` line
- Blocks file write operations targeting paths **outside** the worktree root, preventing agents from accidentally writing to the main repo's working tree due to path confusion
- **Safe pass-through paths**: `/tmp/`, OS tmpdir (`os.tmpdir()`), and `~/.claude/` (user-level config writes are always allowed)
- **Helpful error output**: includes the blocked target path, worktree root, and a suggested corrected path when the target appears to be the main-repo equivalent of the intended worktree path
- Fail-open on JSON parse errors or unexpected exceptions (does not block valid operations)
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PreToolUse > Write`, `PreToolUse > Edit`, and `PreToolUse > NotebookEdit`
- Tests at `.claude/hooks/__tests__/worktree-path-guard.test.js` (runs via `node --test`)

### Worktree CWD Guard Hook

**Worktree CWD Guard Hook** (`.claude/hooks/worktree-cwd-guard.js`):
- Runs at `PreToolUse` for `Bash` tool calls; hard-blocking (`permissionDecision: "deny"`)
- Detects when the session's working directory (`CLAUDE_PROJECT_DIR` or `event.cwd`) no longer exists on disk — the primary cause being a worktree deleted by cleanup automation or manual removal
- Prevents cryptic "no such file or directory" shell errors by intercepting Bash calls before they execute in a missing directory
- **Recovery escape hatch**: commands starting with `cd` are always allowed so the agent can navigate to a valid directory and recover the session without manual intervention
- Extracts the main project directory from the worktree path pattern (`/path/to/project/.claude/worktrees/<name>/`) for a precise recovery hint in the error message
- Fail-open when CWD cannot be determined or on unexpected exceptions
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PreToolUse > Bash` (alongside `main-tree-commit-guard.js`)
- Tests at `.claude/hooks/__tests__/worktree-cwd-guard.test.js` (runs via `node --test`)

### Interactive Agent Guard Hook

**Interactive Agent Guard Hook** (`.claude/hooks/interactive-agent-guard.js`):
- Runs at `PreToolUse` for `Agent` tool calls; hard-blocking (`permissionDecision: "deny"`)
- Blocks code-modifying agent invocations in interactive (non-spawned) sessions; spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always allowed
- **Root cause**: Claude Code's built-in Agent tool creates worktrees WITHOUT GENTYR provisioning (no hooks, no MCP config, no guards) and causes branch switching in the main tree when processing results — exactly the isolation violations the GENTYR worktree system prevents
- **Allowed interactive types** (read-only, no git operations): `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`; all other types are denied
- **Deny message** directs the CTO to use GENTYR's task system: `/spawn-tasks <description>`, `/spawn-tasks`, or `create_task + force_spawn_tasks` MCP tools
- Defaults `subagent_type` to `'general-purpose'` when omitted — also denied
- Fail-open on JSON parse errors or unexpected exceptions (`{ allow: true }`)
- Root-owned and listed in `protection-state.json` `criticalHooks` array; registered in `settings.json.template` under `PreToolUse > Agent`
- Tests at `.claude/hooks/__tests__/interactive-agent-guard.test.js` (21 tests, runs via `node --test`)

---

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos in linked target projects.

**Project-agnostic config discovery** (`packages/mcp-servers/src/playwright/config-discovery.ts`):
- Reads `playwright.config.ts` (or `.js`) as raw text using regex and brace-matching — no `require`/`import` of the config, avoiding TS compilation and side effects
- Exports `discoverPlaywrightConfig(projectDir): PlaywrightConfig` and `resetConfigCache()` (for tests)
- Discovered fields: `projects[]` (with `name`, `testDir`, `storageState`, `isInfrastructure`, `isManual`, `isExtension`), `defaultTestDir`, `projectDirMap`, `personaMap`, `extensionProjects` (Set), `authFiles[]`, `primaryAuthFile`, `webServers[]` (`WebServerConfig` — `command`, `url`, `port` fields parsed from `webServer:` entries in config)
- Infrastructure projects (`seed`, `auth-setup`, `cleanup`, `setup`) excluded from `projectDirMap` and `personaMap`
- Extension projects detected by `name.includes('extension')` or `name === 'demo'`
- Persona labels auto-generated: `vendor-owner` → `Vendor (Owner)`, `cross-persona` → `Cross Persona`, etc.
- `extractWebServers()` handles both single-object (`webServer: { ... }`) and array (`webServer: [...]`) forms using brace-balanced parsing — same approach as project extraction, no `require`/`import`
- Results cached per `projectDir` for the lifetime of the MCP server process
- Replaces ALL hardcoded maps previously in `server.ts` (`PERSONA_MAP`, `ACTIVE_DIRS`, `EXTENSION_PROJECTS`, `vendor-owner.json` references, `SUPABASE_*` credential checks)
- 25 tests at `packages/mcp-servers/src/playwright/__tests__/config-discovery.test.ts` (runs via vitest)

**`PLAYWRIGHT_PROJECTS` constant** (`packages/mcp-servers/src/playwright/types.ts`):
- **Deprecated** — use `discoverPlaywrightConfig()` from `config-discovery.ts` instead
- Kept for backwards compatibility with existing test imports only

**Available Tools:**
- `launch_ui_mode` — Launch Playwright in interactive UI mode for a given project (persona)
- `run_tests` — Run headless E2E tests with optional project/grep/retries/workers filters
- `seed_data` — Seed test data via the `seed` Playwright project
- `cleanup_data` — Remove test data via the `cleanup` Playwright project
- `get_report` — Retrieve the last Playwright HTML report path and metadata
- `get_coverage_status` — Report test count and coverage status per persona project; persona labels and test dirs derived from config discovery
- `preflight_check` — Validate environment readiness before launching; runs up to 11 checks: config exists, dependencies, browsers installed, test files, credentials valid, dev server reachable (check #6 — now **fails** rather than warns when unreachable or returns app-level errors; uses GET with body inspection for error patterns like "Application error" or "Internal Server Error"; **auto-starts the dev server** via `npm run dev` when the reachability check fails — polls up to 30s for startup; orphaned server process killed if health polling fails; supports both HTTP and HTTPS; full HTTP error response body included in failure messages), compilation, **webServer URL reachability** (check #7b — one `web_server` check per additional `webServer` entry in `playwright.config.ts` that differs from the primary base URL), **code freshness** (check #7c — compares newest source file mtime against newest Next.js build artifact mtime; warns if source is more than 5 seconds newer than `.next/static` or `.next/server`; skips when no `.next/` directory or no `src/`/`app/` directory; recovery step: restart the dev server), auth state freshness, and extension manifest valid
- `run_auth_setup` — Refresh Playwright auth state by running `seed` then `auth-setup` projects; discovers expected auth files from `storageState` fields in config (or scans `.auth/` as fallback); 4-minute timeout; supports `seed_only` flag to skip auth-setup
- `run_demo` — Launch Playwright tests in a visible headed browser at human-watchable speed (auto-play mode). Accepts any project name from the target project's `playwright.config.ts`. Passes `DEMO_SLOW_MO` env var (default 800ms) for pace control — target project must read `parseInt(process.env.DEMO_SLOW_MO || '0')` in `use.launchOptions.slowMo`. Automatically enables `--trace on` for every demo run, enabling play-by-play trace capture after the run completes. **Auto-injects 1Password secrets** from `.claude/config/services.json` `secrets.local` into the child process env (non-fatal — missing secrets are logged to stderr, not fatal); infrastructure credentials (`OP_SERVICE_ACCOUNT_TOKEN`, etc.) are stripped before injection. Returns an error immediately if the spawned child process has no PID. Monitors for early crashes during a 15s startup window (accommodates headed browser + webServer compilation); returns success once the process survives that window. **Early exit handling**: if the process exits within the monitoring window with a non-zero code, writes a `crash` event to the progress JSONL file (up to 5000 chars of stderr) so `check_demo_result` can surface it via `progress.recent_errors`; if the process exits with code 0, it is treated as successful completion — a full `DemoRunState` entry is created with artifact scanning, trace parsing, and video recording, and the result is returned immediately without waiting for polling. stderr in the direct response is truncated to 2000 chars. **Captures stdout** from the child process for failure diagnostics — accessible via `stdout_tail` in `check_demo_result` (last 2000 chars). Records the demo run state (PID, project, test file, started_at) in memory and persisted to `.claude/state/demo-runs.json` (capped at 20 entries); `trace_summary` and `progress_file` are excluded from persistence to avoid 50KB-per-entry state file bloat (in-memory only). On load, persisted entries with a valid numeric `pid` field are accepted. Sets `DEMO_PROGRESS_FILE` env var pointing to a tmp JSONL file consumed by the Playwright Progress Reporter for real-time progress tracking. **Auto-kill on suite_end**: when the progress JSONL file reports a `suite_end` event (all tests finished), the process group is sent SIGTERM after a 5-second delay — prevents browser processes from lingering after demos complete; the run is marked `passed` directly (not via exit handler) to avoid a race condition. When killed this way, the `run_demo` response message says "Demo completed and process auto-killed after suite_end" rather than the normal "Headed auto-play demo launched" message. **Video recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` spawns a `WindowRecorder` Swift CLI (`tools/window-recorder/`) alongside Playwright after Chrome is already running. `startWindowRecorder()` always passes `--skip-snapshot` so the binary matches any existing window instead of waiting for a new one to appear — this fixes the prior bug where Chrome was excluded because it was already present in the window list when the recorder launched. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space — no need for the browser to be in the foreground. The recorder polls for up to 120s for the window to appear, then streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and temp output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()` to `.claude/recordings/demos/{scenarioId}.mp4`; temp files are cleaned up automatically. All exit paths (suite_end auto-kill, crash, stall, `stop_demo`, `check_demo_result`) send SIGINT for clean AVAssetWriter finalization and poll for up to 10s for the process to exit. If the process exits cleanly, the MP4 is valid and is persisted; if SIGKILL is required (process still alive at the 10s deadline), the MP4 is considered corrupted (no moov atom) and persistence is skipped. `stopWindowRecorderSync()` returns `true` only on clean exit; `stopWindowRecorder()` (async) does the same. All teardown paths gate `persistScenarioRecording()` on the recorder's return value. **Window-specific screenshot capture**: `run_demo` calls `getChromeWindowId()` (uses `swift -e` + CoreGraphics `CGWindowListCopyWindowInfo` to find Chrome's CGWindowID) after Chrome appears and passes the result to `startScreenshotCapture()`. When a `windowId` is available, `screencapture` is invoked with `-l <windowId>` to capture only that specific window instead of the full screen. `extra_env` — Optional `Record<string, string>` of additional env vars for the Playwright child process. Max 10 keys, 512KB total size. Used by `/replay` to pass `REPLAY_SESSION_ID` and `REPLAY_AUDIT_DATA`. **`PLAYWRIGHT_BASE_URL` auto-set**: when the dev server is confirmed healthy before demo launch, `run_demo` captures the resolved dev server URL and passes it as `PLAYWRIGHT_BASE_URL` in the Playwright child's env — Playwright reads this to skip its own `webServer` startup block, eliminating a ~90s silence at the start of each demo run. **`demoDevModeEnv` injection**: when the dev server is ready, project-level dev-mode env vars from `services.json`'s `demoDevModeEnv` field are applied (after secrets, before demo-specific vars and `extra_env`).
- `check_demo_result` — Poll the result of a `run_demo` call by PID. Returns `status` (`running`, `passed`, `failed`, `unknown`), exit code, `failure_summary`, `screenshot_paths`, `trace_summary`, `stdout_tail` (last 2000 chars of captured stdout), `artifacts` (object with `screenshots[]` and `videos[]` paths collected from the test-results directory), `degraded_features` (array of `"<test_title>: <description>"` strings extracted from `warning`-type annotations — present only when warning annotations exist), `duration_seconds` (total demo run time in seconds), `screenshot_hint` (glob pattern for retrieving periodic screenshots — e.g., `.claude/recordings/demos/screenshots/{scenarioId}-*.png`), `failure_frames` (array of frame paths auto-extracted from 3s before failure end when a demo fails with video recording — ffprobe+ffmpeg at 0.5s intervals), `analysis_guidance` (REQUIRED instructions for agents to analyze screenshots/video frames and verify UI state matches user requirements — always present), `recording_path` and `recording_source` (`'window' | 'none'`), and `progress` when available. The `progress` field (`DemoProgress`) includes `tests_completed`, `tests_passed`, `tests_failed`, `total_tests`, `current_test`, `current_file`, `has_failures`, `recent_errors`, `last_5_results`, `suite_completed`, `annotations` (array of `{ test_title, type, description }` objects, capped at 50 total, populated from `test_end` annotation events), and `has_warnings` (true when any `warning`-type annotation exists) — read from the JSONL progress file in real time. When `run_demo` detects a startup crash, a `crash` event is written to the progress JSONL file; `readDemoProgress()` handles this event by setting `has_failures = true` and pushing the stderr snippet (and `stdout_snippet` with `[stdout]` prefix) into `recent_errors`. Checks process liveness for `running` status; reads persisted state from `.claude/state/demo-runs.json` for completed runs (note: `trace_summary` is not persisted — available only in the same MCP server process that ran the demo). **Suite-completed auto-kill**: when `checkDemoResult()` reads a progress file with `suite_completed: true` (set on `suite_end` events), the demo process is killed immediately via SIGTERM, the run status is finalized, the progress file is cleaned up, and the enriched result is returned — prevents orphaned demo processes lingering after Playwright suites fully finish. **Improved dead-process recovery**: when the PID is no longer alive but no exit event was captured (e.g., user closed the browser or MCP restarted), reads the progress file to determine final pass/fail status instead of returning `unknown`; also scans for artifacts and parses trace data so the response is fully enriched. Failure details are enriched from the playwright-failure-reporter's `lastDemoFailure` entry in `test-failure-state.json` when available. Stall detector: emits a stall warning when the process is alive but no meaningful JSONL progress events (`test_begin`, `test_end`, `suite_begin`, `suite_end`) have arrived for >90s — uses `Math.max(lastRawOutputAt, lastProgressEventAt)` to avoid false stalls from browser console chatter that produces raw stdout without test progress; after a 90s startup grace period (increased from 60s to accommodate headed browser + webServer boot). Auto-kill: demo processes are automatically killed if `check_demo_result` is not called within 60 seconds. Each poll resets the countdown. Prevents orphaned browser processes when the polling agent stops.
- `stop_demo` — Kill a running demo process by PID. Verifies the entry is in `running` state and the process is alive before sending SIGTERM. Reads the final progress snapshot from the JSONL progress file before killing. Cleans up the progress file. Returns `success`, `pid`, `project`, `message`, and optional `progress` snapshot.
- `open_video` — Open a video file (`.webm`, `.mp4`, `.avi`, `.mov`, `.mkv`) in the system's default media player. Accepts relative paths resolved from the project directory (absolute paths rejected). Path traversal protection: `..` segments blocked at schema level and containment-checked against `PROJECT_DIR` after resolution. Intended for videos returned by `check_demo_result` artifacts or recordings in `.claude/recordings/`. Returns `{ success, video_path, message }`.
- `list_extension_tabs` — List open tabs in a CDP-connected extension test browser
- `screenshot_extension_tab` — Screenshot a specific extension tab via CDP
- `get_demo_screenshot` — Retrieve a periodic screenshot captured during a headed demo by timestamp. Accepts `scenario_id` and `timestamp_seconds`; returns the path of the closest screenshot at or before the requested timestamp. Screenshots are stored in `.claude/recordings/demos/screenshots/{scenarioId}-{offset}.png`. Returns `{ success, screenshot_path, timestamp_seconds, offset_seconds }`.
- `extract_video_frames` — Extract frames from a demo recording (`.mp4`) at 0.5-second intervals around a given timestamp using ffprobe+ffmpeg. Accepts `video_path` and `timestamp_seconds`; extracts frames from `timestamp_seconds - 3s` to `timestamp_seconds + 3s` (capped to video bounds). Returns `{ success, frames, video_duration_seconds, extraction_range }` where `frames` is an array of `{ path, timestamp_seconds }` objects. Used for failure analysis — auto-invoked by `check_demo_result` on failure when a window recording is available.

**`preflight_check` cross-project compatibility**:
- `launch_ui_mode`, `run_demo`, `run_tests`, and `preflight_check` all accept any `project` string (not a hardcoded enum) — compatible with any target project's `playwright.config.ts` configuration
- `test_files_exist` check (check #4): returns `skip` (not `fail`) when the project name has no known directory mapping — compilation check (#6) validates it instead; prevents false failures on projects with non-standard directory layouts

**WebServer URL check in `preflight_check` (check #7b)**:
- Reads `webServers` from `discoverPlaywrightConfig()` — parsed from `webServer: { ... }` (single object) or `webServer: [{ ... }, ...]` (array) in `playwright.config.ts`
- Emits one `web_server` check per unique URL that differs from the primary base URL (deduplication by host:port to avoid double-checking the frontend server)
- Skips malformed URLs silently (they cannot be reached anyway); recovery step: fix the `webServer` entry in `playwright.config.ts`
- Check name `web_server` is mapped to its own recovery step in `preflight_check` output

**Code freshness check in `preflight_check` (check #7c)**:
- Compares the newest mtime of source files (`.ts`, `.tsx`, `.js`, `.jsx`) under `src/` (preferred) or `app/` against the newest mtime of Next.js build artifacts (`.js`, `.css`, `.json`) under `.next/static` and `.next/server`
- `newestMtime(dir, extensions, maxDepth)` helper walks the directory tree up to `maxDepth` (default 5 for source, 3 for build artifacts), skipping dotfiles and `node_modules/`
- Skips when: no `.next/` directory (not a Next.js project), no `src/` or `app/` directory, no source files found
- Warns when build artifacts are absent from `.next/static` and `.next/server` (stale state)
- Warns with drift seconds when source files are newer than build output by more than 5 seconds (5s grace for HMR in-progress)
- Passes when source and build output are within 5 seconds of each other
- Recovery step: "Restart the dev server to recompile source changes, or wait for HMR to complete"

**Auth state check in `preflight_check` (check #8)**:
- Only runs when a `project` argument is provided
- **Dynamic auth file**: uses `pwConfig.primaryAuthFile` (from config discovery); falls back to scanning `.auth/` for any `.json` file; no hardcoded `vendor-owner.json`
- Fails if file is missing, cookies are expired, or file is >24h old
- Warns if file is 4–24h old
- Recovery step: call `mcp__playwright__run_auth_setup()` to refresh

**Extension manifest check in `preflight_check` (check #9)**:
- Only runs when `project` is in `pwConfig.extensionProjects` (derived from config discovery — projects with `name.includes('extension')` or `name === 'demo'`); skips for all other projects
- When `GENTYR_EXTENSION_DIST_PATH` is not set, auto-discovers the extension manifest by checking `dist/`, `build/`, `out/`, `extension/dist/`, `extension/build/` in the project root; returns `skip` only if no `manifest.json` is found in any of these locations
- Resolves `manifest.json` at `$GENTYR_EXTENSION_DIST_PATH/manifest.json` then falls back to the parent directory (when env var is set)
- Validates every `matches` and `exclude_matches` pattern in each `content_scripts` entry against the Chrome match-pattern spec: `<all_urls>`, `file:///path`, `(*|https?):// host /path` where host is `*`, `*.domain`, or exact domain (no partial wildcards like `*-admin.example.com`)
- Recovery step: fix invalid patterns in `manifest.json` — Chrome requires host to be `*`, `*.domain.com`, or `exact.domain.com`

**Credentials check in `preflight_check` (check #5)**:
- **Project-agnostic**: scans all `process.env` entries for unresolved `op://` references; no hardcoded credential key names
- Any env var still containing an `op://` value indicates broken 1Password injection

**`run_auth_setup` self-healing flow**:
- Phase 1: runs `npx playwright test --project=seed` (5-min timeout)
- Phase 2: runs `npx playwright test --project=auth-setup` (4-min timeout) — skipped if `seed_only: true`
- Expected auth files: derived from `pwConfig.authFiles` (config discovery); falls back to scanning `.auth/` directory
- Returns structured `RunAuthSetupResult` with per-phase success, `auth_files_refreshed` list, and `output_summary`
- Deputy-CTO agent has `mcp__playwright__run_auth_setup` in `allowedTools` and is responsible for executing it when assigned an `auth_state` repair task from `/demo`

**Demo Trace Parser** (`packages/mcp-servers/src/playwright/trace-parser.ts`):
- Parses Playwright trace zip files (produced by `--trace on`) into human-readable play-by-play summaries returned via `check_demo_result`'s `trace_summary` field
- Exported functions: `findTraceZip(testResultsDir)` — finds the most recent `trace.zip` in test-results subdirectories (depth limit 3); `parseTraceZip(traceZipPath)` — extracts and parses NDJSON `.trace` files; `formatTrace(events)` — formats parsed events into timestamped lines; `classifyAction(method)` — categorizes action methods into `NAV`/`INPUT`/`ASSERT`/`ACTION`; `describeAction(ev, method)` — generates human-readable descriptions
- Input/output caps: 20MB per extracted trace file (skips larger files), 50KB output summary (truncated with count of remaining events)
- Noise filtering: skips `BrowserContext`/`Browser`/`BrowserType`/`Tracing`/`APIRequestContext` class events and `waitFor*`/`evaluate*`/`screenshot`/`close` method calls
- Sensitive data masking: selector-based (masks values when selector matches `password|secret|token|api.?key|credential|auth|ssn|credit.?card`); value-based (masks mixed alphanumeric+special values without spaces and length >4)
- Handles both split format (before/after events correlated by `callId`) and combined `action` events; captures navigation, console messages, and page errors
- Uses `execFileSync('unzip', ...)` with 10s timeout to extract `.trace` files from the zip to a tmp directory; cleans up tmp directory in `finally` block
- 42 tests at `packages/mcp-servers/src/playwright/__tests__/trace-parser.test.ts` (runs via vitest)

**Playwright Progress Reporter** (`.claude/hooks/reporters/playwright-progress-reporter.js`):
- Custom Playwright reporter that writes structured JSONL events to a temp file for real-time demo progress tracking by `check_demo_result`
- No-op when `DEMO_PROGRESS_FILE` env var is not set — safe to register globally in `playwright.config.ts` without affecting non-demo runs
- Event types: `suite_begin` (run starts, total test count), `test_begin` (individual test starts), `step` (pw:api and expect steps only — noise filtered), `test_end` (test finishes with status, duration, error on failure, and `annotations[]` — filtered to `info`/`warning`/`skip`/`fixme` types, capped at 10 per test, each description truncated to 300 chars), `console_error` (error pattern detected in stderr — does NOT set `has_failures`), `suite_end` (all tests finish with aggregates; includes `annotation_counts: { [type]: count }` when any annotations were recorded)
- 1MB file cap (`MAX_FILE_SIZE`); stops writing new events at limit but always force-writes the final `suite_end` event; non-fatal on write errors (best-effort)
- `has_failures` is set only by `test_end` events with `failed` or `timedOut` status — not by `console_error` (stderr errors may be transient)
- Annotation tracking: `_annotationCounts` map accumulates per-type counts across all tests; emitted in `suite_end` as `annotation_counts`
- `recent_errors` accumulates up to 10 entries from `console_error` events and `crash` events (written directly by `server.ts` on startup crash); `crash` events contribute both `stderr_snippet` (plain) and `stdout_snippet` (prefixed with `[stdout] `) entries when present; used for informational display only in `check_demo_result`
- Provisioned to linked target projects as `.claude/reporters/playwright-progress-reporter.js` (symlink) by `createReporterSymlinks()` in `cli/lib/symlinks.js` — runs on `npx gentyr sync` and initial install when a `playwright.config` is detected; legacy path via `scripts/setup.sh` Playwright section

**Playwright Failure Reporter** (`.claude/hooks/reporters/playwright-failure-reporter.js`):
- Custom Playwright reporter that spawns Claude to fix test failures automatically (fire-and-forget, does not block test completion)
- Per-suite cooldown (120 min, configurable via `test_failure_reporter` in automation config) + content-based SHA-256 deduplication (24h expiry) prevent duplicate spawns
- `onTestEnd()` captures screenshot attachment paths from `result.attachments` for every failed test
- `onEnd()` writes a `lastDemoFailure` entry to `test-failure-state.json` when any `.demo.ts` file fails — includes `testFile`, `suiteNames`, `failureDetails` (4KB cap), and `screenshotPaths` (up to 5). This enriches `check_demo_result` responses for demo run failures.
- Spawn uses `[Automation][test-failure-playwright]` prefix for CTO dashboard tracking; sets `CLAUDE_SPAWNED_SESSION=true` to prevent hook chain reactions

**`/demo` command suite** (`.claude/commands/demo.md`, `demo-interactive.md`, `demo-autonomous.md`, `demo-all.md`):
- `/demo` — Escape hatch: launches Playwright UI mode showing ALL tests. No scenario filtering. Developer power-tool for browsing the full test suite. Step 2 uses `personaGroups` from prefetch for persona-first selection with an "All tests" option; falls back to `discoveredProjects` when no `personaGroups` exist.
- `/demo-interactive` — Scenario-based two-step flow: Step 2 selects a persona (with `[N]` scenario count labels), Step 3 selects a scenario within that persona. Single-item paths skip their prompts. Runs at full speed then pauses for manual interaction. "Take me to this screen."
- `/demo-autonomous` — Scenario-based two-step flow (same persona → scenario selection as `/demo-interactive`): runs at human-watchable speed (slowMo 800ms), browser stays open after completion. "Show me the product in action." After launch, polls `check_demo_result` every 10 seconds (max 30 polls, ~5 min) to detect failures; when `progress.has_failures` is true calls `stop_demo` immediately then escalates; creates an urgent DEPUTY-CTO task with failure summary, exit code, and screenshot paths on failure. If polls exhaust with status still `running`, the autonomous flow completed successfully (failures cause process exit) and the browser is paused at the final screen.
- `/demo-all` — Runs the entire demo suite at human-watchable speed (slowMo 1200ms) with cursor visualization. No test file filter. Designed for full product walkthroughs or pre-presentation confidence checks. "Show me everything working." Polls every 10 seconds (max 60 polls for the full suite, extended polling at 30s after that). Escalates all failures to deputy-CTO via `mcp__cto-reports__report_to_cto`.
- All four use the same "escalate all failures" pattern — when `preflight_check` returns `ready: false`, a single urgent DEPUTY-CTO task is created describing every failed check with per-check repair instructions
- `/demo` calls `mcp__playwright__launch_ui_mode`; `/demo-interactive`, `/demo-autonomous`, and `/demo-all` call `mcp__playwright__run_demo` with `test_file` from the selected scenario
- Repair mapping: `config_exists` → CODE-REVIEWER; `dependencies_installed`/`browsers_installed` → direct Bash fix; `test_files_exist` → TEST-WRITER; `credentials_valid` → INVESTIGATOR & PLANNER; `auth_state` → `run_auth_setup()` then INVESTIGATOR & PLANNER on failure; `extension_manifest` → CODE-REVIEWER (fix invalid match patterns in `manifest.json`)
- The `demo` agent identity is included in `SECTION_CREATOR_RESTRICTIONS` for DEPUTY-CTO (allows `mcp__todo-db__create_task` with `assigned_by: "demo"`)
- `slash-command-prefetch.js` reads the cached `playwright-health.json` (1-hour TTL) written by the SessionStart hook, falling back to dynamic `.auth/` scan on cache miss; discovers projects dynamically from `playwright.config.ts` via regex (no hardcoded project list); credential check uses generic `op://` env scan (no hardcoded credential key names); also queries `user-feedback.db` for enabled demo scenarios; test file counts include `.demo.ts` files alongside `.spec.ts` and `.manual.ts`; pre-computes `personaGroups` — scenarios grouped by persona (`{ persona_name, persona_display_name, playwright_project, scenarios[] }`) where `persona_display_name` is `COALESCE(display_name, name)` from the personas table and each scenario object carries its own `playwright_project` field — enabling two-step persona → scenario selection in demo commands without redundant DB queries; all error/missing-db paths emit empty `personaGroups: []`

---

## Demo Scenario System

Curated product walkthroughs (NOT tests) mapped to personas. Scenarios are managed by the product-manager agent and implemented by code-writer agents. The test-writer agent is explicitly excluded from `*.demo.ts` files.

**`demo_scenarios` table** (in `user-feedback.db`):
- `id` TEXT PK, `persona_id` TEXT FK→personas, `title`, `description`, `category` (optional), `playwright_project`, `test_file` (UNIQUE, must end with `.demo.ts`), `sort_order`, `enabled`, `env_vars` (JSON object, optional), timestamps
- FK CASCADE: deleting a persona deletes its scenarios

**5 MCP tools** (on `user-feedback` server):
- `create_scenario` — validates persona exists AND `consumption_mode` includes `'gui'` or `'adk'` (rejects other modes); enforces `.demo.ts` suffix; accepts optional `env_vars`
- `update_scenario` — partial update; enforces `.demo.ts` if `test_file` changes; accepts `env_vars` (set to `null` to clear)
- `delete_scenario` — simple DELETE
- `list_scenarios` — JOIN to personas for `persona_name`; filters by `persona_id`, `enabled`, `category`
- `get_scenario` — enriches with `persona_name`

**`env_vars` field** (on `demo_scenarios`): Optional JSON object of environment variables to inject when running a specific scenario. Useful for feature flags, mock-mode toggles, or per-scenario API endpoint overrides. Max 10 keys. Blocked prefixes include system paths (`PATH`, `HOME`, `USER`, `SHELL`), Node options, infrastructure credentials (`SUPABASE_`, `GITHUB_TOKEN`, `CLOUDFLARE_`, etc.), Playwright/GENTYR internals (`DEMO_*`, `PLAYWRIGHT_BASE_URL`, `CLAUDE_`, `GENTYR_`), and proxy vars. `op://` secret references are resolved via 1Password at runtime (Playwright MCP server's `executePrerequisites()`). Merged into demo validation execution env in `hourly-automation.js` alongside `DEMO_HEADLESS=1`. Example: `{"AZURE_DEMO": "1", "FEATURE_FLAG_CHECKOUT": "v2"}`.

**Constraints:**
- Only `gui` and `adk` consumption_mode personas can have demo scenarios — SDK/CLI/API personas cannot
- `*.demo.ts` file naming convention enforced by `create_scenario` and `update_scenario`
- `env_vars` blocked-prefix validation prevents scenarios from overriding infrastructure credentials or framework internals

**Foreground prerequisite stall detection** (`executePrerequisites()` in `playwright/server.ts`):
- Foreground prerequisites (non-`run_as_background`) are executed via `runWithStallDetection()` — an async spawn-based helper replacing the previous `execFileSync` call
- Kills the child process with SIGKILL if no stdout/stderr output arrives for 60 seconds (stall timeout), independent of `timeout_ms` (total timeout)
- Both the stall interval checker and the hard total-timeout timer are `.unref()`'d so they cannot prevent MCP server shutdown
- Error message distinguishes stall (`Command stalled (no output for 60s)`) from total timeout (`Command timed out after Nms`) — visible in the prerequisite `entries[].error` field

**`demoDevModeEnv`** (`services.json` top-level field, schema in `packages/mcp-servers/src/secret-sync/types.ts`):
- Optional `Record<string, string>` of project-level env vars injected into Playwright child processes when the dev server is confirmed healthy
- Applied in `buildDemoEnv()` after 1Password secret resolution and before per-demo vars and `extra_env` — can be overridden per-scenario
- Intended for dev-mode flags that should be active for all demos when the app is running (e.g., `"E2E_REBUILD_EXTENSION": "false"` to skip costly extension rebuilds during demo runs)
- Passed to both `run_demo` and `run_demo_batch` via the `dev_server_ready` parameter on `buildDemoEnv()`

**Playwright MCP extensions:**
- `run_demo` accepts `test_file` (positional arg for single-file filtering); video recording is always enabled
- `launch_ui_mode` accepts optional `test_file` for filtered UI mode
- `countTestFiles()` recognizes `.demo.ts` alongside `.spec.ts` and `.manual.ts`

**Feedback N+1 spawning pattern:**
- When personas are spawned for feedback sessions, GUI personas get N+1 sessions: 1 default (no scenario) + up to 3 scenario sessions
- Each scenario session runs the demo file first via `mcp__playwright__run_demo()` as a pre-step (scaffolds app state), then the feedback agent explores from the paused state
- Demo coverage check: GUI and ADK personas with zero enabled scenarios are flagged in the feedback orchestrator log

**Product-manager responsibilities:**
- Defines scenario records (DB entries) with detailed descriptions
- Creates CODE-REVIEWER tasks for `*.demo.ts` file implementation
- Ensures every GUI and ADK persona has 2-4 demo scenarios covering key product flows

**Session replay and consumption mode support:**
- `/replay` — Browse and replay past feedback sessions. Fetches audit trail via `mcp__user-feedback__get_session_audit`, converts to RecordingActions, launches `session-replay-runner.demo.ts` in headed mode at 800ms slowMo with thinking bubble overlays. Supports consumption mode filtering. Passes `REPLAY_SESSION_ID` and `REPLAY_AUDIT_DATA` via `run_demo`'s `extra_env` parameter.
- Consumption mode badges in `/demo-autonomous` step 3 (`[gui]`, `[sdk]`, `[api]`, `[adk]`), optional mode filter in step 2b
- ADK scenarios in `/demo-autonomous` trigger the session replay path instead of direct `run_demo` — fetches past feedback sessions and replays audit data
- ADK scenarios self-skip in `/demo-all` (no `REPLAY_SESSION_ID`); use `/replay` for ADK demos
- `/persona-feedback` step 5b includes a "Replay this session" option that launches session replay from past session details

---

## Rotation Proxy

Local MITM proxy for transparent credential rotation (`scripts/rotation-proxy.js`).

**Architecture:**
```
Claude Code ──HTTPS_PROXY──> localhost:18080 ──TLS──> api.anthropic.com
                                    │
                            reads rotation state
                        (~/.claude/api-key-rotation.json)
                                    │
                            on 429: rotate key, retry
```

**What it intercepts** (TLS MITM + header swap):
- `api.anthropic.com` — main API

**What passes through** (transparent CONNECT tunnel):
- `mcp-proxy.anthropic.com` — MCP proxy endpoint (uses session-bound OAuth tokens; swapping them causes 401 → revocation cascade)
- `platform.claude.com` — OAuth refresh
- Everything else

**429 retry**: On quota exhaustion response, marks the current key as exhausted, calls `selectActiveKey()` to pick the next available key, and retries the request (max 2 retries). If no keys are available, returns the original 429 to the client.

**401 retry**: On auth failure response (not a quota issue), retries up to `MAX_401_RETRIES` times with a fresh key selection — allows picking up a key that was rotated between the proxy's token resolution and the upstream response. Does not call `rotateOnExhaustion`; fires `rotating_on_401` log event. Defense-in-depth: 401s from `mcp-proxy.anthropic.com` are never retried (the host validates session-bound OAuth tokens; a 401 there is a token mismatch, not key expiration).

**Tombstone-aware routing** (`forwardRequest`): When the incoming request carries a token known to rotation state, the proxy inspects its entry:
- `status: 'tombstone'` — pruned dead token; swap with the active key and forward (prevents "OAuth token revoked" errors from stale sessions sending tombstoned credentials)
- No entry at all — genuinely unknown token (fresh login not yet registered); pass through unchanged and trigger async `syncKeys()` to register it (preserves fresh login flow)
- Any other status — normal swap path (inject active key's token)

**Path-level swap allowlist** (`SWAP_PATH_PREFIXES`): Even within a MITM'd TLS connection to `api.anthropic.com`, only paths matching `SWAP_PATH_PREFIXES` get the Authorization header swapped with the active rotation key. Paths not in the allowlist (OAuth endpoints, session-health checks, MCP server registration, etc.) receive a `session_path_passthrough` log event and are forwarded with the session's original token. The allowlist approach is intentionally conservative — new endpoints default to passthrough rather than accidental swap. Current entries: `/v1/messages`, `/v1/organizations`, `/api/event_logging/`, `/api/eval/`, `/api/web/`.

**`forceSwap` for merged/tombstone tokens**: Merged and tombstone tokens have no valid `accessToken` — passing them through unchanged guarantees a 403. When the token-identity check detects a tombstone or merged token, it sets `forceSwap = true`, ensuring the active key's token is swapped in. However, the path-level passthrough check (`SWAP_PATH_PREFIXES`) ALWAYS applies regardless of `forceSwap` — OAuth and session-health paths receive the session's original token even if it is tombstoned or merged. This prevents swapping the active key onto OAuth paths, which would revoke the session token. On non-SWAP paths, `forceSwap` is irrelevant because the passthrough already applies; on SWAP paths, `forceSwap` ensures the swap happens.

**Dead active key passthrough**: When the active key's status is not usable (`expired`, `invalid`, `tombstone`, `merged`, or missing from state), `forwardRequest()` evaluates whether to fall back to passthrough. If the incoming token differs from the dead active key, it passes through unchanged (`dead_active_key_passthrough`) — this preserves fresh tokens from `/login`. If the incoming token IS the dead active key (same key ID), passthrough is skipped (`dead_active_key_self_hit`) and 401 rotation handles recovery instead. Only `active` and `exhausted` statuses are considered usable (`exhausted` is still valid for 429 retry + rotation). Both paths trigger async `syncKeys()` to register fresh credentials.

**401 rotation debounce**: Multiple concurrent MITM connections can see a 401 simultaneously for the same key and each independently trigger `rotateOnAuth401Sync()`. To prevent cascading rotations, a 5-second per-key debounce (`ROTATION_DEBOUNCE_MS = 5000`) is applied at the call site. The second 401 for the same key within 5s is logged as `rotation_debounced` and passed through to the client; the first connection's rotation handles recovery.

**Conditional auth header injection** (`rebuildRequest`): Authorization header is only added back to the rebuilt request if the original request had one. Requests without auth headers (e.g., health checks, OAuth flows that pass through to a MITM host) are forwarded without injecting a token.

**Logging**: Structured JSON lines to `~/.claude/rotation-proxy.log` (max 1MB with rotation). Logs token swaps (key ID only, never token values), 429 retries, 401 retries, tombstone swaps, unknown-token passthroughs, and errors for debugging.

**Health endpoint**: `GET http://localhost:18080/__health` returns JSON status with active key ID, uptime, and request count.

**Lifecycle**: Runs as a launchd KeepAlive service (`com.local.gentyr-rotation-proxy`). Auto-restarts on crash. Starts before the automation service.

**CONNECT head buffer handling**: The CONNECT handler's `head` parameter (early client data — typically the TLS ClientHello — sent before the 200 response arrives) is pushed back into the socket's readable stream with `clientSocket.unshift(head)` before wrapping in TLSSocket. Omitting this caused intermittent ECONNRESET errors because the TLS handshake began with incomplete data. This is the textbook fix for Node.js HTTPS MITM proxies.

**Tombstone consumer filters**: Consumer hooks that iterate rotation state keys (`session-reviver.js`, `api-key-watcher.js`, `stop-continue-hook.js`, `quota-monitor.js`) filter out tombstoned entries before passing key data to `checkKeyHealth()`, preventing calls with `undefined` access tokens.

**Complements existing rotation**: The proxy handles immediate token swap at the network level. Quota-monitor still handles usage detection and key selection. Key-sync still handles token refresh and Keychain writes.

### Proxy Enable/Disable

```bash
npx gentyr proxy disable   # Stop proxy service, remove shell env, persist flag
npx gentyr proxy enable    # Restart proxy service, restore shell env
npx gentyr proxy status    # Show current state (default when no subcommand)
npx gentyr proxy           # Same as status
```

Emergency kill switch for the rotation proxy. When the Anthropic usage API is degraded and the proxy's key-selection logic causes issues, `disable` takes the proxy completely out of the equation:

1. Unloads the launchd/systemd service (stops the process, prevents auto-restart)
2. Kill-by-port fallback: uses `lsof -ti :18080` + `process.kill(SIGTERM)` to terminate any lingering proxy process that `launchctl unload` may have left running
3. Strips the `# BEGIN GENTYR PROXY` / `# END GENTYR PROXY` block from `~/.zshrc`/`~/.bashrc`
4. Writes `~/.claude/proxy-disabled.json` with `{ disabled: true }` — read by all spawn helpers

**State file**: `~/.claude/proxy-disabled.json` (global, not per-project — one proxy serves all projects).

**Spawn helper integration**: `isProxyDisabled()` from `.claude/hooks/lib/proxy-state.js` is checked by `buildSpawnEnv()` in `.claude/hooks/lib/spawn-env.js` (shared module) — consumed by `hourly-automation.js`, `urgent-task-spawner.js`, `task-gate-spawner.js`, and `session-reviver.js`. When disabled, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS` are omitted from spawned agent environments — agents connect directly to `api.anthropic.com`.

**Default**: Enabled. Missing state file = proxy enabled. `npx gentyr init` does not create this file.

---

## Chrome Browser Automation

The chrome-bridge MCP server provides access to Claude for Chrome extension capabilities:

```bash
# Chrome extension must be installed and running
# Server auto-discovers browser instances via Unix domain socket at:
# /tmp/claude-mcp-browser-bridge-{username}/*.sock
```

**18 Available Tools:**
- Tab management: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `switch_browser`
- Page interaction: `read_page`, `get_page_text`, `find`, `form_input`, `computer`, `javascript_tool`
- Debugging: `read_console_messages`, `read_network_requests`
- Media: `gif_creator`, `upload_image`, `resize_window`
- Workflows: `shortcuts_list`, `shortcuts_execute`, `update_plan`

**Contextual Tips:**
The chrome-bridge server injects site-specific browser automation tips into tool responses. Tips are sourced from docs/SETUP-GUIDE.md and cover common UI quirks for GitHub, 1Password, Render, Vercel, Cloudflare, Supabase, Elastic Cloud, Resend, and Codecov. Each tip is shown at most once per session on interactive tools (`navigate`, `computer`, `form_input`, `find`, `read_page`).

No credentials required - communicates via local Unix domain socket with length-prefixed JSON framing protocol.

### Gentyr Browser Automation Extension

A stripped-down Chrome extension at `tools/chrome-extension/` for headless browser automation without the official Claude app. Forked from Claude Chrome Extension v1.0.66; removes auth, permission prompts, side panel UI, and analytics.

**Extension ID**: `dojoamdbiafnflmaknagfcakgpdkmpmn`

**File layout:**
```
tools/chrome-extension/
  extension/
    manifest.json                         # Chrome MV3 manifest
    service-worker-loader.js              # 1-line ES module loader
    assets/
      service-worker.js                   # 155-line stripped service worker
      mcpPermissions-qqAoJjJ8.js          # Copied verbatim from v1.0.66
      PermissionManager-9s959502.js       # Copied verbatim from v1.0.66
      index-BVS4T5_D.js                   # Copied verbatim from v1.0.66
      accessibility-tree.js-D8KNCIWO.js  # Content script
      agent-visual-indicator.js-Ct7LqXhp.js  # Content script
    offscreen.html / offscreen.js / gif.js / gif.worker.js / icon-128.png
  native-host/
    host.js        # Node.js native messaging host (~230 lines)
    install.sh     # Registers host manifest with Chrome
```

**Service worker** (`assets/service-worker.js`): Connects to `com.gentyr.chrome_browser_extension` native host via Chrome native messaging. Handles `tool_request` messages by calling the v1.0.66 `toolExecutor` with `source: 'bridge'` and `permissionMode: 'skip_all_permission_checks'` — bypassing all permission dialogs. Keeps service worker alive via offscreen document.

**Native messaging host** (`native-host/host.js`): Node.js ESM script registered with Chrome. Bridges Chrome's stdin/stdout 4-byte-length-prefixed JSON protocol to a Unix domain socket server at `/tmp/claude-mcp-browser-bridge-{username}/{pid}.sock`. Key behaviors:
- Socket directory created with mode `0o700`; ownership and permissions validated on startup
- Stale `.sock` files from dead PIDs are cleaned on startup
- Request queue serializes tool execution (one in-flight request at a time through Chrome)
- Responses routed to the requesting socket client only (not broadcast)
- Reference-counted `mcp_connected`/`mcp_disconnected`: fires `mcp_connected` on first socket client, `mcp_disconnected` when last client disconnects
- Chrome's 1MB native message limit enforced: oversized responses replaced with an error message
- Handles `ping`/`pong` handshake and `get_status` queries from the service worker

**Protocol (socket side)**: Socket clients send bare JSON requests:
```json
{ "method": "execute_tool", "params": { "tool": "navigate", "args": { "url": "..." } } }
```
The native host wraps these in `{ "type": "tool_request", ... }` before forwarding to Chrome, then strips the `type`/`tool_response` wrapper before relaying results back to the requesting client.

**Installation**: `npx gentyr sync` runs `install.sh` as step 7c. Manual install:
```bash
tools/chrome-extension/native-host/install.sh
```
Then load `tools/chrome-extension/extension/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

`scripts/grant-chrome-ext-permissions.sh` now iterates over both the official Claude extension ID and the Gentyr extension ID (`dojoamdbiafnflmaknagfcakgpdkmpmn`) to grant debugger permissions in all Chrome profiles.

### @gentyr/chrome-actions Package

TypeScript bindings for the Chrome Extension's Unix domain socket protocol. Located at `packages/chrome-actions/`. Published as `@gentyr/chrome-actions`.

**Exports:**
- `ChromeActions` — high-level API class wrapping all 18 chrome-bridge tools
- `ChromeSocketClient` — low-level socket protocol client
- Typed interfaces for all tool argument/response shapes (`NavigateArgs`, `FindArgs`, `FormInputArgs`, etc.)
- 5 custom error classes: `ChromeConnectionError`, `ChromeTimeoutError`, `ChromeToolError`, `ChromeProtocolError`, `ChromeNotFoundError`

**Convenience helpers:**
- `clickByText(text)` — find and click an element by visible text
- `fillInput(selector, value)` — find and fill an input field
- `waitForUrl(pattern, timeout?)` — wait for navigation to a URL matching a pattern
- `waitForElement(selector, timeout?)` — wait for an element to appear in the DOM

**Use case:** Lets target project `.demo.ts` test code directly control Chrome without Claude in the loop, using the same Unix domain socket protocol as the chrome-bridge MCP server.

```bash
cd packages/chrome-actions && npm run build
```

---

## Secret Management

The secret-sync MCP server orchestrates secrets from 1Password to deployment platforms without exposing values to agent context.

**Security model:**
- Secret values NEVER pass through agent context window
- Agent calls tools with target platform names only
- Server resolves `op://` references internally via 1Password CLI
- Output is sanitized to redact accidentally leaked values

**6 Available Tools:**
- `secret_sync_secrets` - Push secrets to Render/Vercel from 1Password
- `secret_list_mappings` - List configured secret keys and op:// references
- `secret_verify_secrets` - Check secret existence on platforms (no values)
- `secret_run_command` - Run commands with secrets injected (Playwright, Prisma, etc.)
- `secret_dev_server_status` - Check running dev servers with secret injection
- `secret_dev_server_stop` - Terminate managed dev servers

**Key features:**
- Executable allowlist for `secret_run_command`: `pnpm`, `npx`, `node`, `tsx`, `playwright`, `prisma`, `drizzle-kit`, `vitest`
- Inline eval blocked: `-e`, `--eval`, `-c` flags rejected
- Infrastructure credentials filtered from child processes
- Output sanitization replaces secret values with `[REDACTED:KEY_NAME]`
- Background mode for long-running processes

Configuration via `.claude/config/services.json` with `secrets.local` section. Auto-generates `op-secrets.conf` during setup (contains `op://` references only).

**Shared 1Password utilities** (`packages/mcp-servers/src/shared/op-secrets.ts`): Extracted module consumed by both the `secret-sync` and `playwright` MCP servers. Exports: `opRead(reference)` — reads a single secret via `op read`; `loadServicesConfig(projectDir)` — loads and Zod-validates `.claude/config/services.json`; `resolveLocalSecrets(config)` — resolves all `secrets.local` entries (non-fatal, collects `failedKeys`); `buildCleanEnv(extraSecrets?)` — builds a child process env from `process.env` with `INFRA_CRED_KEYS` stripped and optional secrets merged. `INFRA_CRED_KEYS` set: `OP_SERVICE_ACCOUNT_TOKEN`, `RENDER_API_KEY`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `GH_TOKEN`, `GITHUB_TOKEN`.

See `packages/mcp-servers/src/secret-sync/README.md` for full documentation.

---

## Icon Processor MCP Server

The icon-processor MCP server (`packages/mcp-servers/src/icon-processor/`) provides tools for sourcing, downloading, processing, and storing brand/vendor icons into clean square SVG format. It is consumed by the `icon-finder` agent.

**12 Available Tools:**
- `lookup_simple_icon` — Offline lookup against the Simple Icons database (3000+ brands). Returns SVG content and brand hex color. No network required.
- `download_image` — Download an image (PNG, SVG, ICO, WEBP) from a URL. 50 MB cap, 30 s timeout. Returns file metadata including format and dimensions.
- `analyze_image` — Analyze a raster image: dimensions, channel count, alpha presence, and background type estimation (`transparent` / `solid` / `complex`) via corner-pixel sampling.
- `remove_background` — Remove a solid-color background from a PNG/WEBP by detecting the background from corner pixels and making matching pixels transparent. Configurable color-distance threshold.
- `trace_to_svg` — Convert a raster image to SVG using potrace bitmap tracing. Best with high-contrast images on transparent backgrounds. Returns SVG content and path count.
- `normalize_svg` — Normalize an SVG to a square viewBox. Computes a tight bounding box across all path elements, centers content with configurable padding, sets target dimensions, and runs SVGO optimization.
- `optimize_svg` — Optimize SVG content using SVGO (removes comments, metadata, editor cruft; optimizes paths/colors/transforms). Returns size reduction stats.
- `analyze_svg_structure` — Structural analysis of an SVG: element breakdown (paths, text, groups), per-element attributes (fill, stroke, opacity), per-path bounding boxes, and overall content bounding box.
- `recolor_svg` — Apply a single hex color to an SVG by setting fill on the root `<svg>` element and stripping explicit fills from child elements. Preserves `fill="none"` cutouts.
- `list_icons` — List all icons in the global store (`~/.claude/icons/`). Returns slug, display_name, brand_color, source, created_at, and variant/report flags per entry.
- `store_icon` — Persist a finalized icon to the global store (`~/.claude/icons/<slug>/`). Writes `icon.svg`, optional `icon-black.svg`, `icon-white.svg`, `icon-full-color.svg`, `report.md`, and `metadata.json` atomically. Cleans up stale variant files from prior store calls.
- `delete_icon` — Delete an icon from the global store by slug (removes entire brand directory).

**Global Icon Store** (`~/.claude/icons/`):

Each stored icon lives at `~/.claude/icons/<slug>/` with the following layout:

```
~/.claude/icons/<slug>/
  artifacts/
    candidates/       ← Raw downloads (PNG, SVG, ICO, WEBP)
    processed/        ← After bg removal + tracing
    cleaned/          ← After text removal + variants
    final/            ← After normalize + optimize
  icon.svg            ← Winner (brand-colored)
  icon-black.svg      ← Black solid
  icon-white.svg      ← White solid
  icon-full-color.svg ← Full-color
  metadata.json       ← Written by store_icon tool (Zod-validated on read)
  report.md           ← Selection rationale
```

**Dependencies** (added in `packages/mcp-servers/package.json` and root `package.json`):
- `potrace` — bitmap tracing for PNG→SVG conversion
- `sharp` — raster image analysis, background removal, alpha channel handling
- `simple-icons` — offline brand icon database (3000+ brands)
- `svg-path-bbox` — bounding box computation for SVG path data
- `svgo` — SVG optimization

All heavy dependencies are **lazy-loaded** at first tool invocation to keep server startup fast (avoids loading ~30 MB `simple-icons` at startup).

**Security model:**
- `assertSafeUrl()`: blocks all non-HTTP(S) protocols and validates the final URL after redirects (SSRF protection)
- `assertSafePath()`: requires absolute paths and rejects path traversal (normalized path must equal input)
- Download body is checked against a 50 MB hard cap both via `Content-Length` header and actual buffer size after download
- Slug validation in `StoreIconSchema` enforces `[a-z0-9]+(-[a-z0-9]+)*` regex before any filesystem write
- Metadata reads from `metadata.json` are validated with `IconMetadataSchema` (Zod); malformed entries fall back to minimal info rather than crashing

**Known deferred items** (security/robustness, flagged by code review, not yet addressed):
- Download OOM risk: `response.arrayBuffer()` loads the full body into memory before the size check — a malicious server omitting `Content-Length` can cause high memory usage up to the 50 MB cap before the check fires
- SSRF blocking: only protocol is checked after redirects; redirects to `localhost` or RFC 1918 addresses are not blocked at the IP level

### Icon Finder Agent

The `icon-finder` agent (`.claude/agents/icon-finder.md`) implements a multi-phase pipeline for sourcing and processing brand icons:

- **Phase -1**: Check global store — reports existing icons and stops early if already stored
- **Phase 0**: Research brand color, icon shape, official asset sources, and any recent redesigns via web search
- **Phase 1**: Simple Icons fast path (offline lookup via `lookup_simple_icon`)
- **Phase 2**: Download 3-5 icon candidates from official sources, SVG repositories, and favicons
- **Phase 2.5**: Candidate analysis and validation — describe each candidate's design concept, identify distinct design concepts across candidates, research the brand's current official icon when multiple concepts are found, prune outdated/wrong candidates, and document the analysis in `artifacts/candidate-analysis.md`
- **Phase 3**: Process each candidate — background removal and PNG→SVG tracing for raster sources
- **Phase 4**: SVG cleanup — remove text/wordmark elements, isolate the icon symbol using agent judgment
- **Phase 4.5**: Variant generation — cutout, simplified, and fill variants for complex icons
- **Phase 5**: Normalize and optimize each cleaned SVG
- **Phase 6**: Select the best candidate and generate all 4 color variants (brand-colored, black, white, full-color), then call `store_icon` to persist to the global store; report references Phase 2.5 candidate analysis findings

The agent uses `model: opus` and has all 12 `mcp__icon-processor__*` tools in its `allowedTools` alongside standard file and web tools.

---

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports a `--mock` flag for development and README generation. The `packages/cto-dashboard/src/mock-data.ts` module provides deterministic fixture data (waypoint-interpolated usage curves, realistic triage reports, deployment history) that renders without requiring live MCP connections.

**`--page` flag** splits rendering to avoid Bash tool output truncation on large deployments (e.g., 68 worktrees):
- `--page 1` (Intelligence): Header, Quota + Status, Accounts, Deputy-CTO, Usage Trends, Usage Trajectory, Automations, Session Queue
- `--page 2` (Operations): Testing, Deployments, Worktrees, Infra, Logging
- `--page 3` (Analytics): Feedback Personas, PM, Worklog, Timeline, Metrics Summary
- No `--page` argument renders all sections (backwards compatible; used by `generate-readme.js`)

The `/cto-report` slash command runs all three pages sequentially. Data fetching is optimized per page — sections not rendered on the active page skip their I/O readers in `index.tsx`.

**`getVerifiedQuota()` fallback** (`packages/cto-dashboard/src/utils/data-reader.ts`): When no live API health checks succeed (all keys unreachable or offline), quota display falls back to stored `last_usage` data from `api-key-rotation.json` instead of showing "No healthy keys". Accounts with `status: 'invalid'` or `'tombstone'` are excluded; remaining accounts are deduplicated by `account_uuid` or `account_email`. The `account_email` field is now included in `KeyRotationKeyDataSchema` to support this deduplication path.

The **ACCOUNT OVERVIEW** section displays a curated EVENT HISTORY (last 24h, capped at 20 entries). Only 7 event types pass the `ALLOWED_EVENTS` whitelist in `account-overview-reader.ts`:
- `key_added` — new account registered (token-refresh re-additions filtered as noise); also fires when `api-key-watcher.js` recovers a key via `refreshExpiredToken()` after a failed health check (reason: `token_refreshed_after_health_check_failure`)
- `key_switched` — active account changed by rotation logic
- `key_exhausted` — account reached 100% quota in any bucket
- `account_nearly_depleted` — active account hit 95% (5-hour per-key cooldown; fired by quota-monitor)
- `account_quota_refreshed` — previously exhausted account dropped below 100% (fired by quota-monitor and api-key-watcher)
- `account_auth_failed` — account lost its last key to invalid_grant pruning (fired by pruneDeadKeys in key-sync)
- `account_removed` — account explicitly removed by user via `npx gentyr remove-account` or `/remove-account`

Event descriptions resolve account identity via entry-level `account_email` → key-level `account_email` → rotation_log history lookup (email captured in earlier events for the same key_id) → truncated key ID fallback. Consecutive identical events (same type + description) are deduplicated after sorting so a burst of duplicate `account_auth_failed` entries collapses to one. Events are colored in the dashboard: `key_switched`/`account_quota_refreshed` cyan/green, `key_exhausted`/`account_auth_failed` red, `account_nearly_depleted`/`account_removed` yellow.

### WORKLOG System

Agents call `mcp__todo-db__summarize_work()` before `mcp__todo-db__complete_task()` to record structured worklog entries. Data is stored in `.claude/worklog.db` (separate from `todo.db`).

**`summarize_work` tool** (on `todo-db` MCP server):
- `summary` (required) — concise description of work performed
- `success` (required) — boolean indicating task outcome
- `task_id` (optional) — auto-resolved from `CLAUDE_AGENT_ID` env -> agent-tracker metadata
- Extracts token usage from session JSONL files (input, output, cache read/creation)
- Computes durations from task timestamps (assign-to-start, start-to-complete, assign-to-complete)

**`get_worklog` tool** (on `todo-db` MCP server):
- `hours` (default 24, max 720) — lookback window
- `section` — optional section filter
- `limit` (default 20, max 100) — max entries
- `include_metrics` (default true) — 30-day rolling metrics: coverage %, avg durations, avg tokens/task, cache hit rate

**`list_archived_tasks` tool** (on `todo-db` MCP server):
- `section` — optional section filter
- `limit` (default 20, max 100) — max tasks to return
- `hours` (default 24, max 720) — lookback window
- Returns tasks moved to `archived_tasks` table by `cleanup` (old completed tasks) or `delete_task` (completed tasks are archived before deletion, non-completed are hard-deleted)
- Useful for audit history and the Notion plugin's archived-task phase; archived tasks retain all original fields plus `archived_at` and `archived_timestamp`

**`delete_task` archiving behavior**: When `delete_task` is called on a completed task, the task is first copied to `archived_tasks` and then deleted from `tasks` (atomic transaction). Non-completed tasks (pending, in_progress) are hard-deleted without archiving. The `DeleteTaskResult` includes `archived: true` when this path is taken.

**CTO Dashboard section**: WORKLOG section shows recent entries (time, section, title, result, duration, tokens) with 30-day metrics block. Standalone view: `/show worklog`.

### Regenerate README Dashboard Sections

```bash
node scripts/generate-readme.js
```

Or via npm:

```bash
npm run generate:readme
```

Runs the dashboard with `--mock` and `COLUMNS=80`, updates two files:
- `README.md` — teaser with selected sections (Quota, System Status, Deputy CTO, Automations, Metrics) between `<!-- CTO_DASHBOARD_START -->` / `<!-- CTO_DASHBOARD_END -->` markers
- `docs/CTO-DASHBOARD.md` — full dashboard output between `<!-- FULL_CTO_DASHBOARD_START -->` / `<!-- FULL_CTO_DASHBOARD_END -->` markers

The script uses `execFileSync` (not `execSync`) to prevent shell injection. Tests live at `scripts/__tests__/generate-readme.test.js`.
