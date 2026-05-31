# CLAUDE.md Detailed Reference

Extracted reference sections from [CLAUDE.md](../CLAUDE.md). Each section is linked from the main file with a summary.

---

## Protection Security Model

**Security model** (as of current implementation):

| Target | Ownership | Permissions | Rationale |
|--------|-----------|-------------|-----------|
| Critical hook files (pre-commit-review.js, block-no-verify.js, gate-confirmation-enforcer.js, signal-compliance-gate.js, etc.) | root:wheel | 644 | Prevents agent modification; linked projects use copy-on-protect (`.claude/hooks-protected/`) to avoid root-owning framework source |
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

## AI User Feedback System

5 consumption modes, persona profiles, and `docs-feedback` MCP server. Configured via `/configure-personas` or auto-created by the product-manager agent after Section 6.

### 5 Consumption Modes

| Mode | Tools Available | Docs Access | Use Case |
|------|----------------|-------------|----------|
| `gui` | Playwright browser | N/A (browses app) | Web UI testing as a real user |
| `cli` | programmatic-feedback (CLI) | N/A | Command-line tool testing |
| `api` | programmatic-feedback (API) | N/A | REST/GraphQL API testing |
| `sdk` | Claude Code tools + programmatic-feedback + Playwright | Docs portal via browser | Developer testing SDK in scratch workspace |
| `adk` | Claude Code tools + programmatic-feedback + docs-feedback | Docs via MCP search/read | AI agent testing SDK programmatically |

**SDK and ADK modes** spawn feedback agents with a scratch workspace (`/tmp/gentyr-feedback/workspace-{sessionId}/`) where the SDK is pre-installed via `npm install`. Agents have Claude Code tools (`Bash,Read,Write,Edit,Glob,Grep`) to write and run test scripts. The difference is docs access: SDK uses Playwright to browse the docs portal (human-like), ADK uses the `docs-feedback` MCP server for programmatic search/read (agent-like).

### `endpoints` field semantics per mode

- GUI: `[app-url]`
- CLI: `[cli-command]`
- API: `[api-base-url]`
- SDK: `[sdk-packages-csv, docs-portal-url]` — `endpoints[1]` optional
- ADK: `[sdk-packages-csv, docs-directory-path]` — `endpoints[1]` optional

**Docs configuration** is user-driven via `/configure-personas` or the product-manager agent. If `endpoints[1]` is not configured for SDK/ADK personas, the agent runs without docs access (code-only testing) and receives a warning in the prompt.

**`docs-feedback` MCP server** (`packages/mcp-servers/src/docs-feedback/`): Serves the project's own developer docs. Reads `FEEDBACK_DOCS_PATH` env var, recursively walks for `.md`/`.mdx` files, provides 4 tools: `docs_search`, `docs_list`, `docs_read`, `docs_status`. Uses `AuditedMcpServer` for audit trail.

### Product-manager persona creation

The `product-manager` agent creates fully-functional personas automatically as a post-analysis step. After Section 6 is completed, the agent receives a persona evaluation task where it first asks the user to choose between **Fill gaps only** (idempotent — backfill missing data without replacing existing) or **Full rebuild** (create everything fresh). It then reads `package.json` to detect the dev server URL and framework, scans for route/feature directories, registers them as features, creates or backfills personas with all required fields (`name`, `display_name`, `endpoints`, `behavior_traits`, `consumption_mode`), maps personas to features, maps pain points to personas, and reports compliance to the deputy-CTO. For SDK/ADK personas, the agent sets `endpoints[1]` to the project's docs path/URL when auto-detectable (e.g., `docs/` directory or `docs` script in `package.json`). This is the primary automated path; `/configure-personas` is the interactive manual path for user-driven setup.

### Persona Profile System

Named snapshots of an entire persona/market-research configuration. Profiles let the CTO archive the current set of personas, features, and a guiding strategic prompt, then switch between them instantly — useful for A/B testing different target markets or pivoting to a new ICP without losing prior research.

**State**: `persona_profiles` table in `user-feedback.db` (auto-migrated). Fields: `id`, `name`, `description`, `guiding_prompt`, `persona_ids` (JSON array of persona IDs included in the profile), `is_active` (boolean, at most one active at a time), `archived_at`, `created_at`.

**6 MCP tools** (on `user-feedback` server):
- `create_persona_profile` — create a named profile with a `guiding_prompt` and optional list of `persona_ids`; auto-activates if no other profile is active
- `archive_persona_profile` — archive a profile (soft-delete); deactivates it if it was active
- `switch_persona_profile` — make a profile active, deactivating any currently active profile; updates `is_active` atomically
- `list_persona_profiles` — list all profiles (active, inactive, and optionally archived); returns `is_active`, `persona_count`, and truncated `guiding_prompt`
- `get_persona_profile` — retrieve full profile detail including the complete `guiding_prompt` and all linked persona IDs
- `delete_persona_profile` — permanently delete a profile (irreversible; use `archive_persona_profile` for soft-delete)

**Product-manager integration**: `get_analysis_status` surfaces the active profile's `name` and `guiding_prompt` so the product-manager agent orients its research within the correct market context.

**Session briefing integration**: When a persona profile is active, `session-briefing.js` displays the profile name and guiding prompt at the top of the interactive session briefing, giving the CTO immediate context about the current research focus.

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
- `update_question` — Appends timestamped investigation findings to a pending escalation's context field (append-only, 10KB cap).
- `resolve_question` — Resolves and archives a pending escalation atomically (answer + archive to `cleared_questions` + delete from active queue). Valid resolution types: `fixed`, `not_reproducible`, `duplicate`, `workaround_applied`, `no_longer_relevant`. CTO never sees resolved escalations, but they remain in `cleared_questions` for audit and deduplication.

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
- Gate-exempt step: not subject to the CTO activity gate, so recovery proceeds even when the CTO is inactive
- **Retroactive first-run window**: On the first cycle after startup, uses a 12-hour stale window instead of 30 minutes, picking up sessions interrupted before the automation process started
- **Revival prompt**: Each resumed session receives a structured context prompt with elapsed time, interruption reason, and task verification instructions — the agent must call `mcp__todo-db__get_task` or `mcp__todo-db__list_tasks` before continuing to avoid duplicating work already handled by another agent
- **taskId resolution**: Resolved from `agent-tracker-history.json` metadata so the revival prompt can reference the specific task ID
- **Worktree CWD support** (`resumeCwd` param): `spawnResumedSession()` accepts an optional `resumeCwd` argument; resumes in the agent's original worktree path if it still exists, falls back to the main project directory otherwise (adds a note to the revival prompt when the worktree has been cleaned up)
- **Worktree session discovery**: When `findSessionFileByAgentId` fails in the main project session directory, falls back to `agent.metadata?.worktreePath` via `getSessionDir()` — covers the ~95% of task-runner agents that run in worktrees and store sessions in worktree-specific directories
- **`in_progress` task acceptance**: Queries TODO tasks with `status IN ('pending', 'in_progress')` — handles the case where the reaper ran and marked the agent dead but couldn't find the session file (so the task was never reset to `pending`); also performs inline reaping of running-but-dead agents found during the scan (sets task to `pending` before attempting revival)
- **Advisory file locking**: Uses `acquireLock`/`releaseLock` from `agent-tracker.js` around history-file reads and writes to coordinate with concurrent automation processes; includes lock leak fix on error paths
- **Memory pressure gate**: `shouldAllowSpawn()` from `lib/memory-pressure.js` checked before each spawn; revival is queued (not permanently skipped) when memory-blocked
- Cap: 3 revivals per cycle (`MAX_REVIVALS_PER_CYCLE`); respects the running-agent concurrency limit

**Three revival modes (priority order):**

| Mode | Source state file | Trigger | Stale window |
|------|-------------------|---------|--------------|
| 1 — Dead session recovery | `.claude/state/agent-tracker-history.json` | Agents reaped with `process_already_dead` + pending/in_progress TODO task | 7 days |

**Stop Hook** (`.claude/hooks/stop-continue-hook.js`):
- **Memory pressure gate**: `shouldAllowSpawn()` from `lib/memory-pressure.js` is called before spawning; spawn is blocked at critical pressure.
- **Worktree path capture**: Resolves `worktreePath` from `agent-tracker-history.json` (keyed by `agentId` extracted from the transcript) and includes it in the session record so revival can resume the session in the correct worktree CWD
- **First [Automation]/[Task] stop — uncommitted changes gate**: On the first stop event for a spawned session, checks for uncommitted changes in the worktree; if found, injects a specific `additionalContext` instruction to spawn project-manager before exiting rather than a generic continue message. Ensures git discipline even when orchestrators reach their natural stop without explicitly invoking project-manager.
- Uses `lib/revival-utils.js` helpers (`buildRevivalPrompt`, `resolveTaskIdForAgent`, `extractSessionIdFromPath`) and `lib/spawn-env.js` (`buildSpawnEnv`) shared modules.

**Agent Reaper** (`scripts/reap-completed-agents.js`):
- **Worktree session discovery**: Both the dead-process path and the live-process path now fall back to `agent.metadata?.worktreePath` via `getSessionDir()` when `findSessionFileByAgentId` returns null for the main project session directory — enables session file caching and TODO reconciliation for worktree agents

**`agent-tracker.js` constants**: Exports `SESSION_REVIVED` (`'session-revived'`) and `SESSION_REVIVER` (`'session-reviver'`) agent/hook type constants consumed by session-reviver; mirrored in `packages/mcp-servers/src/agent-tracker/types.ts`. Also exports `acquireLock` / `releaseLock` for advisory file locking, used by session-reviver and dead-agent-recovery to coordinate concurrent history-file access.

**`config-reader.js` defaults**: `session_reviver: 10` and `abandoned_worktree_rescue: 30` minutes added to `DEFAULTS`; operators can override via `.claude/state/automation-config.json`

**Shared Revival Modules** (`lib/`):
- **`lib/memory-pressure.js`**: Monitors free RAM using `vm_stat` (macOS) or `/proc/meminfo` (Linux). Exports `shouldAllowSpawn({ priority, context })` — returns `{ allowed: boolean, reason: string }`. Critical pressure (< 256 MB free) blocks all spawning; high pressure (< 512 MB free) blocks non-urgent spawning. Spawns blocked by memory pressure are not permanently skipped — they remain in their source queue (task DB) for the next automation cycle or reviver pass.
- **`lib/spawn-env.js`**: Exports `buildSpawnEnv(projectDir)`, shared across stop-continue-hook, session-reviver, urgent-task-spawner, and hourly-automation.
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
- Displays a multi-line status block each prompt (30-day token usage, session counts, TODO counts, pending CTO items)
- Critical mode: when `rejections > 0`, collapses to a compact one-liner with `COMMITS BLOCKED` prefix
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

### Git Wrapper (Merge Chain Enforcement)

**Git wrapper** (`.claude/hooks/git-wrappers/git`): POSIX shell script placed in `git-wrappers/` directory; injected into spawned agent environments via `PATH` prepending in `buildSpawnEnv()` (hourly-automation, urgent-task-spawner, session-reviver, force-spawn-tasks, force-triage-reports). Blocks `git add`/`git commit` on protected non-base branches (`main`/`preview`/`staging` but not the detected base) for ALL sessions. `GENTYR_PROMOTION_PIPELINE=true` exempts all guards. Exits 128 with a descriptive message on blocked operations. Zero-overhead fast path for all other git subcommands. Root-owned via `npx gentyr protect`.

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
- Validates vault mappings against required credential keys
- Checks `.mcp.json` env blocks for keys injected directly (e.g. `OP_SERVICE_ACCOUNT_TOKEN`), which count as configured even if absent from vault-mappings
- **OP token desync detection**: Compares shell `OP_SERVICE_ACCOUNT_TOKEN` against `.mcp.json` value; if they differ, emits a warning and overwrites `process.env` with the `.mcp.json` value (source of truth); `.mcp.json` is always authoritative because it is updated by reinstall
- **Vault-mappings backup/restore** (`lib/vault-mappings.js`): When vault-mappings.json has non-empty mappings, a backup is written to `.claude/state/vault-mappings.backup.json`. If vault-mappings.json is missing at `SessionStart`, the hook attempts to restore from backup before treating all keys as missing. `init` and `sync` also restore from backup when the primary file is absent or empty.
- Auto-propagates to target projects via `.claude/hooks/` directory symlink
- Shell sync validation also available via `scripts/setup-validate.js` `validateShellSync()` function, which checks the `# BEGIN GENTYR OP` / `# END GENTYR OP` block in `~/.zshrc` or `~/.bashrc`

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
- `run_demo` — Launch Playwright tests in a visible headed browser at human-watchable speed (auto-play mode). Accepts any project name from the target project's `playwright.config.ts`. Passes `DEMO_SLOW_MO` env var (default 800ms) for pace control — target project must read `parseInt(process.env.DEMO_SLOW_MO || '0')` in `use.launchOptions.slowMo`. Automatically enables `--trace on` for every demo run, enabling play-by-play trace capture after the run completes. **Auto-injects 1Password secrets** from `.claude/config/services.json` `secrets.local` into the child process env (non-fatal — missing secrets are logged to stderr, not fatal); infrastructure credentials (`OP_SERVICE_ACCOUNT_TOKEN`, etc.) are stripped before injection. Returns an error immediately if the spawned child process has no PID. Monitors for early crashes during a 15s startup window (accommodates headed browser + webServer compilation); returns success once the process survives that window. **Early exit handling**: if the process exits within the monitoring window with a non-zero code, writes a `crash` event to the progress JSONL file (up to 5000 chars of stderr) so `check_demo_result` can surface it via `progress.recent_errors`; if the process exits with code 0, it is treated as successful completion — a full `DemoRunState` entry is created with artifact scanning, trace parsing, and video recording, and the result is returned immediately without waiting for polling. stderr in the direct response is truncated to 2000 chars. **Captures stdout** from the child process for failure diagnostics — accessible via `stdout_tail` in `check_demo_result` (last 2000 chars). Records the demo run state (PID, project, test file, started_at) in memory and persisted to `.claude/state/demo-runs.json` (capped at 20 entries); `trace_summary` and `progress_file` are excluded from persistence to avoid 50KB-per-entry state file bloat (in-memory only). On load, persisted entries with a valid numeric `pid` field are accepted. Sets `DEMO_PROGRESS_FILE` env var pointing to a tmp JSONL file consumed by the Playwright Progress Reporter for real-time progress tracking. **Process termination on suite_end**: when the progress JSONL file reports a `suite_end` event (all tests finished), the process group is sent SIGTERM after a 5-second delay — prevents browser processes from lingering after demos complete; the run is marked `passed` directly (not via exit handler) to avoid a race condition. **Video recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` spawns a `WindowRecorder` Swift CLI (`tools/window-recorder/`) alongside Playwright after Chrome is already running. `startWindowRecorder()` always passes `--skip-snapshot` so the binary matches any existing window instead of waiting for a new one to appear — this fixes the prior bug where Chrome was excluded because it was already present in the window list when the recorder launched. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space — no need for the browser to be in the foreground. The recorder polls for up to 120s for the window to appear, then streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and temp output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()` to `.claude/recordings/demos/{scenarioId}.mp4`; temp files are cleaned up automatically. All exit paths (suite_end auto-kill, crash, stall, `stop_demo`, `check_demo_result`) send SIGINT for clean AVAssetWriter finalization and poll for up to 10s for the process to exit. If the process exits cleanly, the MP4 is valid and is persisted; if SIGKILL is required (process still alive at the 10s deadline), the MP4 is considered corrupted (no moov atom) and persistence is skipped. `stopWindowRecorderSync()` returns `true` only on clean exit; `stopWindowRecorder()` (async) does the same. All teardown paths gate `persistScenarioRecording()` on the recorder's return value. **Window-specific screenshot capture**: `run_demo` calls `getChromeWindowId()` (uses `swift -e` + CoreGraphics `CGWindowListCopyWindowInfo` to find Chrome's CGWindowID) after Chrome appears and passes the result to `startScreenshotCapture()`. When a `windowId` is available, `screencapture` is invoked with `-l <windowId>` to capture only that specific window instead of the full screen. `extra_env` — Optional `Record<string, string>` of additional env vars for the Playwright child process. Max 25 keys, 512KB total size. Validated independently from scenario `env_vars` (scenario env_vars are trusted DB data and bypass the blocklist). Used by `/replay` to pass `REPLAY_SESSION_ID` and `REPLAY_AUDIT_DATA`. **`PLAYWRIGHT_BASE_URL` auto-set**: when the dev server is confirmed healthy before demo launch, `run_demo` captures the resolved dev server URL and passes it as `PLAYWRIGHT_BASE_URL` in the Playwright child's env — Playwright reads this to skip its own `webServer` startup block, eliminating a ~90s silence at the start of each demo run. **`demoDevModeEnv` injection**: when the dev server is ready, project-level dev-mode env vars from `services.json`'s `demoDevModeEnv` field are applied (after secrets, before demo-specific vars and `extra_env`).
- `check_demo_result` — Poll the result of a `run_demo` call by PID. Returns `status` (`running`, `passed`, `failed`, `unknown`), exit code, `failure_summary`, `screenshot_paths`, `trace_summary`, `stdout_tail` (last 2000 chars of captured stdout), `artifacts` (object with `screenshots[]` and `videos[]` paths collected from the test-results directory), `degraded_features` (array of `"<test_title>: <description>"` strings extracted from `warning`-type annotations — present only when warning annotations exist), `duration_seconds` (total demo run time in seconds), `screenshot_hint` (glob pattern for retrieving periodic screenshots — e.g., `.claude/recordings/demos/screenshots/{scenarioId}-*.png`), `failure_frames` (array of frame paths auto-extracted from 3s before failure end when a demo fails with video recording — ffprobe+ffmpeg at 0.5s intervals), `analysis_guidance` (REQUIRED instructions for agents to analyze screenshots/video frames and verify UI state matches user requirements — always present), `recording_path` and `recording_source` (`'window' | 'none'`), and `progress` when available. The `progress` field (`DemoProgress`) includes `tests_completed`, `tests_passed`, `tests_failed`, `total_tests`, `current_test`, `current_file`, `has_failures`, `recent_errors`, `last_5_results`, `suite_completed`, `annotations` (array of `{ test_title, type, description }` objects, capped at 50 total, populated from `test_end` annotation events), and `has_warnings` (true when any `warning`-type annotation exists) — read from the JSONL progress file in real time. When `run_demo` detects a startup crash, a `crash` event is written to the progress JSONL file; `readDemoProgress()` handles this event by setting `has_failures = true` and pushing the stderr snippet (and `stdout_snippet` with `[stdout]` prefix) into `recent_errors`. Checks process liveness for `running` status; reads persisted state from `.claude/state/demo-runs.json` for completed runs (note: `trace_summary` is not persisted — available only in the same MCP server process that ran the demo). **Suite-completed process termination**: when `checkDemoResult()` reads a progress file with `suite_completed: true` (set on `suite_end` events), the demo process is terminated immediately via SIGTERM, the run status is finalized, the progress file is cleaned up, and the enriched result is returned — prevents orphaned demo processes lingering after Playwright suites fully finish. **Improved dead-process recovery**: when the PID is no longer alive but no exit event was captured (e.g., user closed the browser or MCP restarted), reads the progress file to determine final pass/fail status instead of returning `unknown`; also scans for artifacts and parses trace data so the response is fully enriched. Failure details are enriched from the playwright-failure-reporter's `lastDemoFailure` entry in `test-failure-state.json` when available. Stall detector: emits a stall warning when the process is alive but no meaningful JSONL progress events (`test_begin`, `test_end`, `suite_begin`, `suite_end`) have arrived for >90s — uses `Math.max(lastRawOutputAt, lastProgressEventAt)` to avoid false stalls from browser console chatter that produces raw stdout without test progress; after a 90s startup grace period (increased from 60s to accommodate headed browser + webServer boot). Stale demo warning: when `check_demo_result` has not been called for over 60 seconds, the response includes a `stale_warning` field alerting the agent that the demo is unpolled and wasting resources (browser, display lock, dev server). Demos are never auto-killed — the agent must explicitly call `stop_demo` to terminate. A PostToolUse hook (`stale-demo-warning.js`) also detects stale demos on every tool call and injects context warnings.
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
- The `demo` agent identity is included in the `Triage & Delegation` category's `creator_restrictions` (allows `mcp__todo-db__create_task` with `assigned_by: "demo"`)
- `slash-command-prefetch.js` reads the cached `playwright-health.json` (1-hour TTL) written by the SessionStart hook, falling back to dynamic `.auth/` scan on cache miss; discovers projects dynamically from `playwright.config.ts` via regex (no hardcoded project list); credential check uses generic `op://` env scan (no hardcoded credential key names); also queries `user-feedback.db` for enabled demo scenarios; test file counts include `.demo.ts` files alongside `.spec.ts` and `.manual.ts`; pre-computes `personaGroups` — scenarios grouped by persona (`{ persona_name, persona_display_name, playwright_project, scenarios[] }`) where `persona_display_name` is `COALESCE(display_name, name)` from the personas table and each scenario object carries its own `playwright_project` field — enabling two-step persona → scenario selection in demo commands without redundant DB queries; all error/missing-db paths emit empty `personaGroups: []`

### Demo Execution Routing (local / fly / steel)

`run_demo` and `run_demo_batch` use a simple 3-rule routing model:
1. **Structural local** — scenarios with `remote_eligible=false` in the DB or `usesChromeBridge=true` (detected from the test file path) route to local execution. No flags needed; no error.
2. **Explicit local** — `run_demo({ local: true })` forces local execution. CTO-gated for spawned agents via `demo-local-guard.js`. Conflicts with `stealth: true` (returns input error).
3. **Stealth** — `run_demo({ stealth: true })` or a scenario with `stealth_required=true` routes to Steel.dev. Fail-closed if Steel is not configured, unhealthy, or at session capacity.
4. **Default (no flags)** — routes to Fly.io. Fail-closed if Fly.io is not configured, unhealthy, or at machine capacity.

Key behaviors:
- `run_demo` and `run_demo_batch` default to neither `local` nor `stealth`, meaning they route to Fly.io.
- `run_demo` also defaults to `recorded: true` — runs headed with video recording (ScreenCaptureKit locally, Xvfb + ffmpeg on Fly.io). Set `recorded: false` for headless without recording. The low-level `headless` and `skip_recording` params still work as explicit overrides.
- `run_demo_batch` runs multiple scenarios in parallel across Fly machines (limited by `fly.maxConcurrentMachines`, default 10). When all pool slots are contended, the batch waits up to 10 minutes before timing out with a pool contention error.
- Spawned agents requesting `local: true` without CTO approval are blocked by `demo-local-guard.js`. Structural local scenarios pass through without bypass.
- **Worktree branch auto-push**: Before spawning a Fly machine, `server.ts` checks if the current `gitRef` exists on the remote (`git ls-remote --heads origin <ref>`). If not (worktree branches are local-only), it pushes the branch automatically (`git push -u origin HEAD:<ref>`) so the Fly machine can clone it. Falls back to `preview` or `main` if the push fails.
- **Machine kill timeout**: Fly machines are configured with `stop_config.timeout: '75s'` (API) and `kill_timeout = "75s"` in `fly.toml.template` to allow the EXIT trap's 60-second artifact-retrieval window to complete before Fly force-kills the machine.
- `check_demo_result` returns `execution_target` (`'local'` | `'fly'` | `'steel'`), `fly_machine_id`, `fly_region`, `steel_session_id` (for Steel.dev runs), `steel_recording_path` (Steel-only stealth scenarios) and `fly_recording_path`, and — when a recording was captured — `recording_path`, `recording_source` (`'window'`), `failure_frames`, and `screenshot_hint` (identical fields to local). Also returns `run_id` (unique demo run identifier) and, when telemetry was enabled, `telemetry_dir` and `telemetry_summary`. Screenshots are extracted from the Fly recording via `extractScreenshotsFromRecording()` at 3-second intervals and placed in `.claude/recordings/demos/{scenarioId}/screenshots/` using the same `screenshot-XXXX.png` naming convention as local macOS captures, so `get_demo_screenshot` works identically for both local and Fly.io runs.
- `get_fly_status` reports configured/healthy state, current machine count, region, `imageDeployed` (if `false`, no Docker image has been pushed and remote execution will fail silently), `imageStale` (boolean — true when infra files changed since last deploy), `machineRamHeadless`, and `machineRamHeaded` (current per-mode RAM settings from the state file).
- **Image freshness detection**: `get_fly_status` also returns `imageAgeHours` (hours since last deployment) and `imageMetadata` (deployment timestamp, app name, file hashes). `deploy_fly_image` writes `.claude/state/fly-image-metadata.json` with SHA-256 hashes of the infra files after successful deployment. `run_demo` includes a non-blocking `image_staleness_warning` in its response when the image is stale. Session briefing shows a one-line Fly.io image health status at login. Hourly automation checks image freshness every 60 minutes and files a deputy-CTO report when stale. Shared module: `.claude/hooks/lib/fly-image-freshness.js`. The module also exports `readProjectImageMetadata()` and `checkProjectImageStaleness()` for project-image-specific lifecycle checks (lockfile hash comparison, stuck-deploy detection). **`preflight_check` also surfaces Fly.io image health** via two new checks: `fly_image` (check 10a — verifies the base image is deployed and infra files match stored hashes; fail if not deployed, warn if stale) and `project_image_branch` (check 10b — during releases, warns when the project image was built from a branch other than `staging`). Both checks are gated on `fly.enabled` and run without network calls.
- **Per-mode RAM configuration**: `set_fly_machine_ram` and `get_fly_machine_ram` MCP tools configure RAM independently for headless vs headed Fly machines. State persisted at `.claude/state/fly-machine-config.json` (always writable, no root protection, no `npx gentyr sync` needed). Defaults: headless 2048MB (~900MB actually needed), headed 4096MB (~2GB for Xvfb + ffmpeg + headed Chromium). Changes take effect immediately on the next `run_demo` — no restart required. The `machineRam` field in `services.json` is now superseded by the per-mode values from the state file.
- Infrastructure: `infra/fly-playwright/` contains the Dockerfile, fly.toml template, and provisioning scripts. Setup via `/setup-fly` slash command; step 8 calls `deploy_fly_image()` MCP tool to build and push the Docker image after app creation. Step 6b of `/setup-fly` covers adding `GITHUB_TOKEN` to `secrets.local` for private repositories — the token is resolved at runtime and passed as `GIT_AUTH_TOKEN` to the Fly.io machine for authenticated git clone; the value never enters agent context.
- Config fields in `services.json` `fly` object: `apiToken` (op:// ref), `appName`, `region`, `machineSize`, `machineRam` (legacy flat value, now superseded by per-mode state file), `maxConcurrentMachines` (default 10), `enabled`.
- `FLY_API_TOKEN` is in the `INFRA_CRED_KEYS` set — treated as an infrastructure credential by the secret-sync server.

### Batch Diagnostic Enrichment & Retry

**Batch Diagnostic Enrichment**: Failed batch scenarios include per-scenario diagnostic fields: `stderr_tail` (last 5KB of stderr/stdout/error.log captured during machine polling), `fly_machine_log` (dmesg/process list/memory captured via exec while machine is alive), `failure_classification` (one of `test_failure`, `build_failure`, `oom`, `timeout`, `startup_failure`, `external_kill`, `recording_failure`, `install_timeout`, `unknown`), `failure_suggestion` (actionable fix guidance), and `elastic_query_hint` (Elastic log query when configured). The shared `classifyFailure()` function in `server.ts` centralizes failure classification for both single-demo and batch paths. `install_timeout` specifically identifies cold-install stall-outs (base image fallback with slow `pnpm install`) distinct from mid-test timeouts.

**Per-Scenario Retry**: `run_demo_batch` accepts `retry_infra_failures` (default 1, max 3). After all scenarios complete, infra-classified failures (`oom`, `timeout`, `startup_failure`, `external_kill`) are automatically retried. OOM retries auto-upgrade to `compute_size: 'large'`. `retried_scenarios` array on the batch result tracks retry outcomes.

**Batch Timeouts**: `run_demo_batch` accepts `scenario_timeout` (default 600000ms = 10 min per scenario) and `batch_timeout` (default 1800000ms = 30 min total). Scenarios exceeding their timeout are killed and classified as `timeout`. Exceeding the batch timeout skips remaining scenarios.

**All Demos Run Headed**: The `headed` DB column and `headless` parameter are deprecated. All demos run headed with video recording (Xvfb+ffmpeg on Fly.io, ScreenCaptureKit locally). `DEMO_HEADLESS` is always `'0'`. The `headless` param in `RunDemoArgsSchema` and `RunDemoBatchArgsSchema` is ignored.

**Shared Machine Slot Pool** (`packages/mcp-servers/src/playwright/machine-pool.ts`): SQLite-backed pool at `.claude/state/fly-machine-pool.db` coordinates Fly.io machine capacity across concurrent batch runs. `acquireSlot()` / `releaseSlot()` with dead-PID cleanup and TTL expiry. Seeds `max_slots` from `services.json` `fly.maxConcurrentMachines` (default 10). `check_demo_batch_result` returns `pool_status` showing active slots, max, and per-batch breakdown. Replaces the chunk-based batch loop with a streaming slot-aware execution model. When the pool has zero available slots, acquisition waits up to 10 minutes before returning a pool contention error — preventing indefinite batch starvation. `check_demo_batch_result` also accepts a `compact: true` parameter that reduces the response payload from ~4KB to ~500B (omitting per-scenario detail fields) to prevent context burn during rapid polling. A 10-second server-side throttle cache prevents redundant processing on back-to-back polls.

**`batch_size` Default**: `run_demo_batch` defaults `batch_size` to `maxConcurrentMachines` from fly config (typically 10), not a fixed value. Multiple concurrent batches share the machine pool.

### Project-Specific Docker Images

**Project-Specific Docker Images**: `deploy_project_image` MCP tool builds Docker images with project dependencies pre-installed, reducing cold start from ~90s to ~10s. `resolveAppImage()` prefers `project-*` registry tags when `fly.projectImageEnabled: true`. **Staleness model**: lockfile hash comparison is informational only — a mismatched lockfile does NOT trigger "stale" warnings, timeout extensions, or deploy instructions. `pnpm install` on the machine handles the lockfile delta (~30s). The `get_fly_status` response provides `projectImageAgeHours`, `projectImageLockfileMatch` (informational boolean), and `projectImageRecommendation` (age-based suggestion, null when image is fresh). Agents evaluate image health via these fields and decide when to deploy — there is no automated staleness-triggered deployment. `deploy_project_image` has a 2-hour cooldown (non-forced deploys within 2 hours of the last successful deploy are rejected with an informational message). **Project image lifecycle protection** (multi-layer, added PR #633): (1) `checkProjectImageStaleness()` in `fly-image-freshness.js` — returns `freshnessTier` (`fresh`/`warm`/`stale`/`missing`/`deploying`) for informational/logging use; `stale` is always `false` (project image is usable when deployed); (2) `recoverStuckProjectDeploy()` — auto-clears metadata stuck in `deploying` state after 30 minutes, preventing permanent lockout from a crashed deploy; (3) auto-enable — `deploy_project_image` writes `projectImageEnabled: true` back to `services.json` after a successful deploy so subsequent runs use the fast image automatically; (4) adaptive stall timeouts — only extend timeouts when NO project image exists (true base-image fallback); when a project image exists (even with mismatched lockfile), no timeout extension is applied; (5) `install_timeout` failure classification — identifies cold-install stall-outs as a distinct failure type from `timeout`, enabling targeted repair guidance.

### Live Log Capture & Observability

**Live Log Capture**: `captureRunningMachineLogs()` runs every 30s during the batch polling loop AND at scenario completion, capturing stderr/stdout/error.log and system diagnostics (dmesg/ps/meminfo) via exec while the machine is alive. This is the primary log capture mechanism — the Fly NATS SSE stream is live-only and returns empty for dead machines.

**Live observability for running Fly.io demos**: `tail_running_fly_demo` MCP tool execs into the live Fly machine and pulls in-container stdout/stderr/error.log plus system diagnostics. Locates the live demo by `pid` / `run_id` / `scenario_id`. Closes the gap where `get_fly_logs` (even when working) only showed Fly's lifecycle stream, not the actual test process output. `get_fly_logs` itself is fixed: it now pipes flyctl output through `tail(1)` for line-count limiting (flyctl has no line-count flag and parsed `-n <count>` as `--no-tail --no-tail <count>`, yielding "unknown command 200"), and uses `--machine` instead of the renamed `--instance`. **Live telemetry shipping**: `pullFlyTelemetryDelta()` and `shipTelemetryDelta()` run every 30s during running-Fly polls (byte-offset-aware, incremental). Even dying machines stream their telemetry to Elastic before destruction. Final ship is offset-aware so we do not double-ship. **`verify_logging_config` reachability fix**: `client.cluster.health()` 404s on Elastic Serverless and 403s for read-only API keys, so it was replaced with `ping()` → fallback to a `size:0` search probe against the configured index pattern. Now matches the exact permissions used by `query_logs`.

**Base image contents**: `infra/fly-playwright/` Dockerfile installs `pnpm@10` and `bun@1` via `npm install -g` (replacing the prior unpinned curl bun installer). Required for downstream packages whose build script invokes `bun run build.ts`. Without bun, such builds silently fail on Fly.io remote machines (typically masked by `|| echo 'bun not available...'` band-aids in target `package.json` scripts).

**`get_session_activity_summary` accuracy fixes** (21a1be5): Three bugs fixed simultaneously. Bug B (timezone): `elapsed_minutes` was inflated by the local timezone offset (e.g., +2h on CEST). SQLite `datetime('now')` stores UTC without a `Z` suffix; `new Date()` parsed it as local time. Now parsed as UTC by appending `T` + `Z`. Bug C (PID liveness): the tool reported dead sessions as `running` while `get_session_queue_status` showed 0. A PID liveness filter is now applied so both tools agree on session state. Bug A (worktree JSONL): worktree sessions (e.g., preview-promoter) have JSONL in the worktree-specific session dir, but the lookup only searched the main project dir. Now checks `resume_session_id` from `queue_items` first (populated by reaper backfill using CWD), then falls back to agent history and direct search. Promotion session metadata includes `worktreePath`.

**Stale gentyr checkout detection + dead deploy recovery** (8db3335): `gentyr-sync.js` SessionStart hook fetches `origin/main` for the gentyr source repo and warns if the local checkout is behind — catches the scenario where a PR was merged via `gh` but `git pull` was never run, so dependent projects see stale code via the symlink. Runs after all other checks so branch protection and CTO gate still fire. `recoverStuckProjectDeploy()` checks PID liveness BEFORE the 30-minute time threshold — a dead PID means the deploy is finished regardless of age, so recovery happens immediately rather than waiting 30 minutes.

### Demo Run IDs and Telemetry

**Demo Run IDs and Telemetry**: Every demo run gets a unique `run_id` (format: `dr-{scenarioId}-{ts}-{hex}`) returned in both `run_demo` and `check_demo_result` responses. This ID is the correlation key across all telemetry, artifacts, and Elastic logs for a single run.

**Demo Telemetry (Maximum Capture Mode)**: Optional deep observability for debugging. Enable per-scenario (`update_demo_scenario({ id, telemetry: true })`) or per-run (`run_demo({ ..., telemetry: true })`). When enabled, captures:
- Browser console logs from ALL open tabs (log/warn/error/info/debug) via CDP
- Network requests and responses (method, URL, status, timing, headers) via CDP
- JavaScript errors and unhandled exceptions with full stack traces
- Performance metrics (Web Vitals: LCP, FCP, CLS, TTFB, navigation timing)
- System metrics (CPU%, memory, load averages) sampled every 2 seconds from `packages/mcp-servers/src/playwright/telemetry-capture.ts`
- On remote Fly.io machines: system metrics also polled inside `infra/fly-playwright/remote-runner.sh`

Browser-level telemetry is injected via `--import .claude/hooks/lib/playwright-telemetry-setup.mjs` (Node.js ESM loader monkey-patch) applied to the Playwright child process. Telemetry files stored as JSONL at `.claude/recordings/demos/{scenarioId}/telemetry/` (`console-logs.jsonl`, `network-log.jsonl`, `js-errors.jsonl`, `performance-metrics.jsonl`, `system-metrics.jsonl`). `check_demo_result` returns `telemetry_summary` with counts of each type and `telemetry_dir` path. Telemetry is shipped to Elastic (index `logs-demo-telemetry-{date}`) when `ELASTIC_CLOUD_ID` or `ELASTIC_ENDPOINT` and `ELASTIC_API_KEY` env vars are set — fire-and-forget, silent no-op when credentials are missing. Query pattern: `demo.run_id:"dr-xxx"` in `mcp__elastic-logs__query_logs`. The `telemetry` field on `demo_scenarios` table in `user-feedback.db` (auto-migrated, settable via `create_demo_scenario`/`update_demo_scenario`) persists per-scenario telemetry configuration.

### Steel.dev Cloud Browser (stealth mode)

**Steel.dev Cloud Browser (`stealth: true`)**: When the `steel` section is configured in `services.json`, callers can route demos to Steel.dev with `run_demo({ stealth: true })`, or scenarios can set `stealth_required=true` in the DB to auto-enable stealth routing. Steel.dev runs as a peer of Fly.io — Playwright executes locally on the host but connects to the Steel cloud browser via CDP (`STEEL_CDP_URL` / `STEEL_SESSION_ID` / `STEEL_SESSION_VIEWER_URL` are injected into the test environment). Routing is fail-closed: if Steel is configured but unhealthy, or at session capacity, `run_demo` returns an error rather than silently falling back to a non-stealth execution path. `resolveExecutionTarget()` in `packages/mcp-servers/src/playwright/execution-target.ts` implements the 3-rule routing model (structural local → explicit local → stealth → default Fly.io). Config fields in `services.json` `steel` object: `apiKey` (op:// ref), `orgId` (optional), `enabled`, `defaultTimeout`, `extensionId` (pre-uploaded extension for Steel sessions), `proxyConfig` (`enabled`, `country`), `maxConcurrentSessions`, `region` (optional default; per-run override via `run_demo({ steel_region })`). The `checkSteelHealth()` utility in `execution-target.ts` probes `https://api.steel.dev/v1/sessions` with a configurable timeout (default 5s). GENTYR provides the generic Steel REST API client (`steel-runner.ts`), MCP tools (`steel_health_check`, `upload_steel_extension`), and env var passthrough (`STEEL_CDP_URL`, `STEEL_SESSION_ID`, `STEEL_SESSION_VIEWER_URL`). Target project test code handles CDP connection, extension loading, and bridge wiring.

**Steel skip-local-setup**: stealth runs do NOT execute registered prerequisites or auto-start the local dev server — Playwright runs locally but the browser is in Steel's cloud, so any localhost the test reached would be unreachable from the Steel browser anyway. Stealth scenarios must target public URLs (deployed env, third-party sites). Use the `PLAYWRIGHT_BASE_URL` env or absolute URLs in `page.goto()`.

**Steel native recording download**: On stealth runs, GENTYR releases the Steel session and downloads the MP4 recording (Steel records server-side via WebRTC) at the end of `check_demo_result`. The downloaded file lands at `.claude/recordings/demos/{scenarioId}/steel-{runId}.mp4` and is surfaced as `steel_recording_path` on the result. When the demo passed, the recording is also persisted as the scenario's last-known-good via `persistScenarioRecording`. Implementation: `downloadSteelRecording()` in `steel-runner.ts` plus `finalizeSteelSession()` in `server.ts`. Idempotent and gated by `entry.steel_finalized`. Local ScreenCaptureKit and screenshot capture are suppressed on stealth runs (the local Chrome window doesn't exist).

**Steel Profiles**: pass `steel_profile_id` to `run_demo` to load a previously persisted Steel Profile (cookies, localStorage, fingerprint, auth tokens) — useful for skipping repeated logins on stealth runs. Pass `steel_persist_profile: true` to save the session's state as a new Profile on release; the returned `check_demo_result` includes the assigned `steel_profile_id` so you can wire it back into the scenario for the next run. **Scenario-level auto-persist**: when `steel_persist_profile: true` is set on a run that has a `scenario_id`, `finalizeSteelSession()` writes the returned `profile_id` back to `demo_scenarios.steel_profile_id` (auto-migrated column on `user-feedback.db`). Subsequent runs of the same scenario auto-load the saved profile without the caller having to pass `steel_profile_id` explicitly — `run_demo` reads the column at startup and uses it when no explicit profile was passed. Explicit `steel_profile_id` always wins.

**Steel sessionContext**: pass `steel_session_context` to `run_demo` to inject a `sessionContext` blob (cookies, localStorage) directly into the Steel session at create time, without going through the Profiles API. Useful when the auth state was captured elsewhere (e.g. via Playwright `storageState`). Transient — Steel does NOT persist this between sessions; use `steel_persist_profile` if you want it to stick.

**Steel-aware Playwright fixture** (`@gentyr/playwright-helpers/steel`): The Steel-only execution path injects `STEEL_CDP_URL` and expects target test code to call `chromium.connectOverCDP(url)`. To honor that contract without bespoke wiring per test, import `steelAwareTest` from `@gentyr/playwright-helpers/steel` (or `connectToSteelOrLaunch` for tests that orchestrate their own Browser). When `STEEL_CDP_URL` is unset the helpers fall through to the project's default launch, so the same `.demo.ts` file works for local, Fly.io, and Steel runs.

**CTO Dashboard STEALTH launch**: Page 2 of the live dashboard exposes a STEALTH mode alongside LOCAL/FLY. Selecting STEALTH and pressing Enter on a scenario calls `launchStealthDemo()` in `packages/cto-dashboard-live/utils/process-runner.ts`, which resolves the Steel API key from `services.json` secrets.local, creates a Steel session via the REST API, spawns Playwright locally with `STEEL_CDP_URL` injected, and releases the Steel session on child exit. Scenarios flagged `remote_eligible=false` are blocked from STEALTH the same way they are from FLY.

**Ad-hoc runs without `scenario_id`**: `RunDemoArgsSchema.scenario_id` is optional. Pass `test_file` alone to run a demo file without a registered user-feedback scenario — useful for scripts, throwaway stealth experiments against public URLs, or any case where the user-feedback MCP isn't reachable. The Zod schema requires `scenario_id` OR `test_file` (schema-level `.refine()`). Without a scenario_id: scenario-scoped prerequisites, env_vars, telemetry flags, and demo_results persistence are skipped; recordings still land under `.claude/recordings/demos/<run_id>/`; the routing/Steel/Fly machinery and `run_demo` return shape are unchanged. `scenario_id` remains required for `verify_demo_completeness` (the production promotion gate uses registered scenarios only).

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

**`env_vars` field** (on `demo_scenarios`): Optional JSON object of environment variables to inject when running a specific scenario. Useful for feature flags, mock-mode toggles, or per-scenario API endpoint overrides. Max 25 keys. Blocked prefixes include system paths (`PATH`, `HOME`, `USER`, `SHELL`), Node options, specific infrastructure credentials (`SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`, `CLOUDFLARE_`, etc.), Playwright/GENTYR internals (`DEMO_*`, `PLAYWRIGHT_BASE_URL`, `CLAUDE_`, `GENTYR_`), and proxy vars. Non-secret identifiers like `SUPABASE_URL`, `DATABASE_URL`, and `NEXT_PUBLIC_SUPABASE_URL` are allowed. `op://` secret references are resolved via 1Password at runtime by `resolveOpReferences()` in `op-secrets.ts` — called in both `runDemo` (single scenario) and `discoverScenarios` (batch), so scenarios in all execution paths get credentials resolved before the subprocess receives them. Failed resolutions are logged to stderr and omitted from the env map (non-fatal). Merged into demo validation execution env in `hourly-automation.js` alongside `DEMO_HEADLESS=1`. Example: `{"AZURE_DEMO": "1", "AWS_ACCESS_KEY_ID": "op://Preview/aws-key/access-key-id"}`.

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

### Demo Task Enforcement (4 layers)

- **`create_task` auto-correction**: Tasks with `demo_involved: true` automatically get `strict_infra_guidance: true` and are rerouted to the `demo-design` category. Warnings are returned in the response.
- **`secret_run_command` blocklist**: `validateCommand()` in the secret-sync server blocks `playwright test` and `playwright show-report` commands with an error redirecting to `run_demo`/`run_tests` MCP tools.
- **`playwright-cli-guard` scope**: The PreToolUse hook intercepts both `Bash` and `mcp__secret-sync__secret_run_command` tool calls, blocking Playwright CLI patterns on both paths.
- **Task gate demo check**: When `demo_involved: true`, the gate agent checks task descriptions for anti-patterns: direct CLI commands via `secret_run_command`, "main tree" / "DO NOT worktree" instructions, and wrong category routing.

### `verify_demo_completeness` (production promotion gate)

Machine-checkable gate for the production promotion pipeline. Queries all enabled scenarios and returns whether each has a `passed` result and a fresh recording since a given `since` ISO timestamp (and optional `branch` filter, applied only when the `branch` column exists). Returns `{ complete: boolean, total_scenarios: number, scenarios_missing_pass: DemoCompletenessScenarioStatus[], scenarios_missing_recording: DemoCompletenessScenarioStatus[] }`. Each `DemoCompletenessScenarioStatus` includes `scenario_id`, `title`, `persona_name`, `latest_result_status` (`passed`/`failed`/`none`), `latest_result_at`, `has_fresh_recording`, `recording_path`, and `last_recorded_at`. Used by the Phase 4 plan-auditor during production promotion to confirm `complete: true` before marking the task done.

**Remote-ineligible exclusion from promotion**: `verify_demo_completeness` filters to `remote_eligible=1` scenarios only. Remote-ineligible demos (chrome-bridge, local-only) cannot be validated on Fly.io and are excluded from the production promotion gate.

**Demo local execution preference**: Spawned agents should prefer Fly.io or Steel.dev for demos; only CTO interactive sessions should pass `local: true`. Structural local scenarios (`remote_eligible=false`, chrome-bridge) are decided server-side at the routing layer and skipped from Fly.io batches automatically.

**Scenario flag protection**: Spawned agents cannot change `remote_eligible`, `enabled`, or `headed` flags on demo scenarios without CTO approval. These fields control which demos run in the production promotion pipeline. The `update_demo_scenario` and `create_demo_scenario` handlers block protected field changes for `CLAUDE_SPAWNED_SESSION=true` with instructions to file a bypass request.

### Window Recording (ScreenCaptureKit / Xvfb+ffmpeg)

Video recording is automatic in headed demo modes on macOS and in remote Fly.io demos. Scenario videos: `.claude/recordings/demos/{scenarioId}.mp4`.

**Window recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` spawns Playwright first, then waits for Chrome to appear (up to 30s via AppleScript `waitForChromeWindow`), then starts the `WindowRecorder` Swift CLI and screenshot capture. Chrome is maximized via `--start-maximized` (set by `DEMO_MAXIMIZE=1`) — native macOS fullscreen (`AXFullScreen`) is NOT used because it intercepts the Escape key at the OS level, preventing the demo interrupt feature from working. `startWindowRecorder()` always passes `--skip-snapshot` to the `WindowRecorder` binary because the recorder starts after Chrome is already running. The `--skip-snapshot` flag instructs the binary to match ANY existing window (not just newly-appearing ones), fixing the prior bug where Chrome was excluded because it already existed in the window list when the recorder launched. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space — recording quality is identical to fullscreen since the recorder captures window pixels directly, not the screen. The recorder streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()`; temp files are cleaned up automatically. `stop_demo` and `check_demo_result` also handle window recorder teardown gracefully: SIGINT is sent first; if the process exits cleanly within 10s, the MP4 is persisted; if SIGKILL is required (process did not exit in time), persistence is skipped because SIGKILL prevents AVAssetWriter from writing the moov atom (corrupted MP4). All teardown paths gate persistence on the recorder's clean exit. `check_demo_result` returns `recording_path` and `recording_source` (`'window' | 'none'`) indicating whether a recording was persisted.

**Window recording via Xvfb + ffmpeg** (remote Fly.io demos — when headed): `remote-runner.sh` conditionally starts Xvfb and ffmpeg only when `DEMO_HEADLESS != 1`. When active: Xvfb starts on `:99` at `1920x1080` (configurable via `GENTYR_RECORDING_RESOLUTION`), `DISPLAY=:99` and `DEMO_MAXIMIZE=1` are exported, then ffmpeg captures the display to `/app/.recording.mp4` at `GENTYR_RECORDING_FPS` fps (default 25). When `DEMO_HEADLESS=1` (the default for remote runs), Xvfb and ffmpeg are skipped entirely and Playwright runs headless. In both modes a comprehensive `trap cleanup EXIT` fires on ANY exit (including early failures like git clone) and: (1) writes `/app/.exit-code` immediately so the proactive artifact poll can detect completion, (2) stops ffmpeg gracefully if running (SIGINT → up to 10s wait → SIGKILL, ensuring the moov atom is written), (3) stops Xvfb if running, (4) copies whatever artifacts exist to `/app/.artifacts/` (even partial logs from early failures), and (5) sleeps 60s for MCP artifact retrieval before the machine is destroyed. Ten `setup` progress events are emitted to the progress JSONL file (created at script start, not after Playwright launches) at key phases (clone_start, clone_done, install_start, install_done, prerequisites_start, prerequisites_done, devserver_start, devserver_ready, test_start) to prevent the stall detector from timing out during long setup steps. A background heartbeat process additionally emits `install_progress` events every 30 seconds during `pnpm install` to keep the stall detector alive during the 2–4 minute install phase (cold machines with 1600+ packages emit no output between `install_start` and `install_done`). The MCP polling loop in `server.ts` also attempts a last-chance artifact pull when the machine dies unexpectedly — if an exit-code file is recovered, the demo result is resolved to `passed` or `failed` instead of `unknown`. `fly-runner.ts` pulls `recording.mp4` and `ffmpeg.log` as individual artifacts. `check_demo_result` for remote runs persists the recording via `persistScenarioRecording()`, extracts failure frames from the last 3 seconds on failure, and returns `recording_path`, `recording_source: 'window'`, and `failure_frames` — identical fields to local macOS recording. If Xvfb or ffmpeg fails to start, the runner falls back to headless execution with no recording (`recording_source: 'none'`).

### Periodic Screenshot Capture & Reminders

**Periodic screenshot capture** (headed demos — macOS local and remote Fly.io): Local macOS demos: `run_demo` calls `getChromeWindowId()` (uses `swift -e` + CoreGraphics `CGWindowListCopyWindowInfo` to find Chrome's CGWindowID) and passes the result to `startScreenshotCapture()`. When a `windowId` is available, `screencapture` is invoked with `-l <windowId>` to capture only that specific Chrome window instead of the full screen, producing clean window-only screenshots at the display's native resolution. `startScreenshotCapture()` runs `screencapture -x` every 3 seconds throughout the demo. Screenshots are stored in `DemoRunState` as `screenshot_dir`, `screenshot_start_time`, and `screenshot_interval`. Remote Fly.io demos: `check_demo_result` calls `extractScreenshotsFromRecording()` to extract frames from the pulled recording via ffmpeg at 3-second intervals, renames them to `screenshot-XXXX.png` (XXXX = elapsed seconds, zero-padded), cleans stale screenshots from prior runs, and stores them in `.claude/recordings/demos/{scenarioId}/screenshots/`. Both paths: `check_demo_result` returns `screenshot_hint` (path pattern for retrieving screenshots) and `analysis_guidance` (REQUIRED instructions for agents to analyze captured screenshots and verify UI state matches user requirements). When a demo fails with video recording, failure frames are auto-extracted from 3 seconds before the failure end using `extract_video_frames` (ffprobe+ffmpeg at 0.5s intervals) and returned as `failure_frames` in the result. `check_demo_result` also returns `duration_seconds` for the total demo run time. The `get_demo_screenshot` MCP tool retrieves screenshots by timestamp and works identically for local and remote runs; `extract_video_frames` extracts frames from any recording around a given timestamp.

**Automatic Screenshot Reminder** (`screenshot-reminder.js` PostToolUse hook): Fires on every tool call. When a tool response contains a screenshot file path (e.g., `[Screenshot saved: /path/to/file.png]`, `"file_path": "...png"`, or `"screenshot_hint": "..."`), injects a `hookSpecificOutput.additionalContext` reminder instructing the agent to use the `Read` tool to view the screenshot before proceeding. Fast path: exits in under 1ms when no screenshot path is present (regex-only check). Skips reminder when the current tool is `Read` (agent is already viewing a screenshot). Caps at 5 paths per response. Registered in the global empty-matcher PostToolUse block in `settings.json.template`.

**Screenshot and recording cleanup** (30-day retention): The `screenshot_cleanup` runIfDue block in `hourly-automation.js` (24h cooldown) walks `.claude/screenshots/` and `.claude/recordings/demos/`, removes `.png` and `.mp4` files whose `mtime` is older than 30 days, and prunes empty directories. Non-fatal on any I/O error. Empty parent directories are removed after their contents are pruned.

### Escape Key Interrupt (headed demos)

Pressing Escape during a headed demo triggers a clean interrupt. The persona overlay immediately shows "Demo Interrupted — interact freely" (updated directly by the Chrome extension content script for instant visual feedback). All in-progress helper actions in `playwright-helpers` (cursor highlight, terminal/editor tab operations, persona overlay interactions) check `isInterrupted()` and exit early. On the server side, the Playwright MCP server detects the interrupt (via progress JSONL event or signal file — see Interrupt mechanism below), discards any in-progress recording (window recorder is killed without persisting the MP4), keeps the browser alive for manual inspection, and returns `status: 'interrupted'` with `interrupted_at` and `interrupt_reason` fields from `stopDemo`/`check_demo_result`. The associated task (if any) is paused so the parent persistent task monitor receives a signal to wait rather than retrying.

**Interrupt mechanism**: Two paths deliver the interrupt signal, one framework-level and one in-process:

- **Framework-level (automatic, no target project changes)**: The gentyr Chrome extension content script (`tools/chrome-extension/extension/assets/demo-interrupt-listener.js`) detects Escape keydown, updates the persona overlay DOM directly for instant visual feedback, then sends a `demo_interrupt` message to the service worker (`service-worker-loader.js`). The service worker forwards it via `chrome.runtime.sendNativeMessage` to the native host (`host.cjs`), which writes a signal file at `/tmp/gentyr-demo-interrupt.signal`. The Playwright MCP server background monitor (5s poll interval) detects the file, consumes it, sets `interruptDetectedAt`, appends a `demo_interrupted` event to the progress JSONL with `source: 'escape_key_extension'`, and the existing interrupt handling takes over. Any stale signal file from a previous demo is deleted at demo start to prevent false interrupts.

- **In-process (faster, requires target project wiring)**: `page.exposeFunction('__gentyrDemoInterrupt')` bridge + JSONL progress file. The browser-side listener calls `window.__gentyrDemoInterrupt()` which triggers the Node-side handler immediately (no 5s polling delay). Two setup paths: (1) `enableDemoInterrupt(page)` from `@gentyr/playwright-helpers` (called automatically by `injectPersonaOverlay` in demo mode), and (2) `setupDemoInterrupt(context)` from `.claude/hooks/lib/demo-interrupt-setup.js` — a standalone module for target projects that auto-wires all pages in a BrowserContext. Target projects should call `setupDemoInterrupt(context)` once in their Playwright fixtures after creating the context. The content script attempts the in-process path first (via injected inline script) and falls through to the extension path if CSP blocks it.

Agents handling `status: 'interrupted'` results should NOT spawn repair agents — the CTO will resolve the bypass request to resume.

### Demo Prerequisites (3 scopes)

Register setup commands that must run before demos. Prerequisites are idempotent: if a health check passes, the setup command is skipped.

**3 scopes:**
- `global` — runs before all demos
- `persona` — runs before demos for a specific persona
- `scenario` — runs before a specific scenario

**Execution order:** global → persona → scenario, sorted by `sort_order` within each scope.

**Health checks:** Optional verification command. If exit 0, setup command is skipped entirely. For `run_as_background` prerequisites (e.g., dev servers), the health check is polled every 2s until ready or timeout. **Port-aware health checks are mandatory** — use `${PORT:-3000}` instead of hardcoded `localhost:3000`. GENTYR injects `PORT` from the worktree-allocated `PLAYWRIGHT_WEB_PORT` so the same prerequisite works in both main tree (port 3000) and worktrees (port 3100+).

**CRUD tools** (on `user-feedback` server): `register_prerequisite`, `update_prerequisite`, `delete_prerequisite`, `list_prerequisites`.

**Execution tool** (on `playwright` server): `run_prerequisites` — automatically called by `run_demo`, `run_demo_batch`, `preflight_check`, and `run_auth_setup`.

**Dev server lifecycle is fully automated.** `run_demo` handles dev server startup in 3 layers: (1) registered prerequisites, (2) auto-start from `services.json` `devServices` config with secrets resolved from 1Password, (3) fallback `pnpm run dev`. Agents MUST NOT manually call `secret_dev_server_start` before `run_demo` — it handles this automatically. If the auto-start fails, register a prerequisite rather than adding manual steps.

**Auto-set `PLAYWRIGHT_BASE_URL`**: When `ensureDevServer()` confirms the dev server is healthy, `run_demo` and `run_demo_batch` auto-inject `PLAYWRIGHT_BASE_URL` so Playwright skips its `webServer` startup. No `base_url` arg needed — defaults to `http://localhost:3000` (main tree) or the worktree-allocated `PLAYWRIGHT_WEB_PORT` when running from a worktree.

**Prerequisite stall detection**: Foreground prerequisites are killed after 120 seconds of no stdout/stderr. Background demo processes are killed after 45 seconds of silence (configurable via `stall_timeout_ms` on `run_demo`, 0 to disable) following a 30-second startup grace period for local demos; remote Fly.io demos default to 300 seconds (5 minutes) to accommodate the 2–4 minute pnpm install phase on cold machines. Stall detection tracks stdout, stderr, AND JSONL progress events — any output resets the timer. Use `run_as_background: true` with a health check for long-silent commands. Demos must emit `console.warn('[demo-progress] ...')` checkpoints or break long operations into `test.step()` blocks — see "Progress Checkpoints" in the demo-manager agent definition. For demos with slow fixture setup (bridge server, extension rebuild), pass `stall_timeout_ms: 120000` or higher.

**Prerequisite timeout defaults**: `timeout_ms` defaults to 60s (raised from 30s) — this is the total polling budget for background service health checks. `health_check_timeout_ms` defaults to 5s per attempt and is capped at 60s (raised from 30s). For services with long startup (code-server postinstall, database init), set `timeout_ms: 300000` (5 min). Never increase timeouts as a fix for `ECONNREFUSED` — the service is not starting at all, not starting slowly.

**Infrastructure readiness detection**: `run_demo_batch` calls `checkInfraReadiness()` before starting the batch and returns `missing_prerequisite_warnings` when scenarios reference localhost URLs (via `env_vars`) that have no registered background prerequisite at any scope. `preflight_check` runs the same check as step 0.6 (`infrastructure_readiness`) and surfaces warnings before any test execution. Use these to proactively discover missing prerequisites rather than diagnosing ECONNREFUSED failures after the fact.

**Demo execution step ordering**: `run_demo`, `run_demo_batch`, and `preflight_check` execute steps in this order: (1) validate prerequisites (fast credential check), (2) worktree freshness gate (auto-sync if behind), (3) verify dist artifacts, (4) execute registered prerequisites (starts dev server), (5) ensure dev server healthy. Steps 2-3 run BEFORE step 4 to prevent the dev server from dying during the 45-second worktree sync window. `preflight_check` additionally runs step 0.6 (infrastructure readiness) before step 1. `run_demo_batch` returns `missing_prerequisite_warnings` alongside the batch start confirmation when gaps are detected.

**Demo crash diagnostics**: `check_demo_result` returns `stderr_tail` (last 5KB of stderr) and preserves `progress_file` and `stdout_tail` across MCP server restarts. When a demo exits with `status: "unknown"`, stderr is used as fallback `failure_summary`. The stall detector persists its failure_summary to `demo-runs.json` before sending SIGTERM, ensuring diagnostic data survives MCP restarts. **Periodic crash-safe persistence**: The background monitor persists `stdout_tail` and `stderr_tail` to `demo-runs.json` every 30 seconds during demo runs, so if the MCP server crashes mid-demo, the most recent stdio data is available for `check_demo_result` to recover. An `uncaughtException` handler also calls `persistDemoRuns()` as a last resort before exit.

**`demoDevModeEnv`**: Optional `Record<string, string>` in `services.json` — env vars injected into both demo child processes (when dev server is healthy) and prerequisite execution environments. Applied after 1Password secrets, before `extra_env`. Example: `"E2E_REBUILD_EXTENSION": "false"`.

### Automated Demo Validation

6-hour automated cycle that runs all enabled demo scenarios headless and spawns repair agents for failures.

**Opt-in:** Set `demoValidationEnabled: true` in `.claude/state/automation-config.json`.

**Flow:**
1. Query enabled scenarios from `user-feedback.db`
2. Run global prerequisites
3. Execute each scenario headless (`DEMO_HEADLESS=1, DEMO_SLOW_MO=0`); scenario `env_vars` are merged into the execution environment; `op://` references in `env_vars` are resolved via 1Password before merging
4. Persist results to `.claude/state/demo-validation-history.json` (last 100 runs)
5. Spawn `demo-manager` repair agents (max 3) for failures in isolated worktrees; repair prompts include prerequisite context queried from `user-feedback.db`
6. Report failures to deputy-CTO via `agent-reports`

ADK-category scenarios are skipped (require replay data). Cooldown: `demo_validation` (default 360 minutes / 6 hours).

### Demo-Manager Agent

Sole authority for demo lifecycle work. Handles prerequisite registration, scenario creation, `.demo.ts` implementation, preflight, execution, video recording, debugging, repair, AND persona scenario planning/scaffolding. Routable via the `Demo Design` category in `todo.db`.

**Failure-triggered automation:** A PostToolUse hook on `check_demo_result`, `check_demo_batch_result`, and `run_demo` detects failures, deduplicates against in-flight repairs, and spawns demo-manager agents in isolated worktrees. Repair prompts are enriched with prerequisite context (global, persona, and scenario-scoped prerequisites queried from `user-feedback.db`) so agents diagnose prerequisite failures before modifying `.demo.ts` files. The `run_demo` hook handles immediate failures (e.g., prerequisite failure before test execution begins), with title and test file fallback lookup from `user-feedback.db` when the tool response lacks them. **Repair prompt enrichments**: `failure_classification` (from batch diagnostic enrichment) is passed through to repair prompts so agents know the classified failure mode upfront. When `error` contains `ECONNREFUSED`/`connection refused`/`ERR_CONNECTION`, an `infraGuidance` block is injected with step-by-step instructions to register a background prerequisite rather than patching the `.demo.ts` file. **Skipped scenario accountability**: On completed batches with skipped scenarios, a `skippedContext` block is injected into `additionalContext` mandating the agent either fix the skip reason or create a DEMO-MANAGER task — it cannot silently ignore skipped scenarios. When escalation is also triggered, `skippedContext` is prepended to the escalation message (single stdout write prevents dual output).

---

## Chrome Browser Automation

The chrome-bridge MCP server provides access to Claude for Chrome extension capabilities:

```bash
# Chrome extension must be installed and running
# Server auto-discovers browser instances via Unix domain socket at:
# /tmp/claude-mcp-browser-bridge-{username}/*.sock
```

**24 Available Tools:**
- Tab management: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `switch_browser`
- Page interaction: `read_page`, `get_page_text`, `find`, `form_input`, `computer`, `javascript_tool`
- Debugging: `read_console_messages`, `read_network_requests`
- Media: `gif_creator`, `upload_image`, `resize_window`
- Workflows: `shortcuts_list`, `shortcuts_execute`, `update_plan`
- Server-side (AppleScript, macOS only): `list_chrome_extensions`, `reload_chrome_extension`
- Server-side (convenience, React/SPA): `find_elements`, `click_by_text`, `fill_input`, `wait_for_element`
- Server-side (diagnostics): `health_check` — proactive connectivity diagnosis; returns structured check results with remediation steps; call first when other tools fail with connection errors

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
- `ChromeActions` — high-level API class wrapping all 17 socket-based chrome-bridge tools
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
