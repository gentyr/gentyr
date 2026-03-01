# GENTYR Framework

A modular automation framework for Claude Code.

## Usage

### Install via npm link (recommended)

```bash
cd /path/to/project
pnpm link ~/git/gentyr        # Creates node_modules/gentyr -> ~/git/gentyr
npx gentyr init --op-token <token>   # First-time setup
npx gentyr protect        # Enable root-owned file protection
```

Installs framework symlinks (via `node_modules/gentyr`), configs, husky hooks, builds MCP servers, and optionally makes critical files root-owned to prevent agent bypass.

### Force Sync (after framework updates)

```bash
npx gentyr sync
```

Rebuilds MCP servers, re-merges settings.json, regenerates .mcp.json, and deploys staged hooks. Also runs automatically on `SessionStart` when framework version or config hash changes.

### Migrate from legacy install

```bash
cd /path/to/project
pnpm link ~/git/gentyr          # Creates node_modules/gentyr
npx gentyr migrate               # Converts .claude-framework -> node_modules/gentyr
```

### Check Status

```bash
npx gentyr status
```

### Protection

```bash
npx gentyr protect          # Enable root-owned protection
npx gentyr unprotect        # Disable protection
```

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

### Remove an Account from Rotation

```bash
npx gentyr remove-account <email>           # Remove account (must not be the only account)
npx gentyr remove-account <email> --force   # Remove even if it is the last account
```

Tombstones all keys for the given email address. If the active key belongs to the removed account, switches to the next available account first (seamless — no restart required). With `--force`, allows removal when no replacement exists, setting `active_key_id` to null.

- Tombstoned keys are auto-cleaned after 24h by the existing `pruneDeadKeys` TTL mechanism.
- Fires `key_switched` event (if active account changed) and `account_removed` event per tombstoned key.
- Interactive wrapper: `/remove-account` slash command — prompts for account selection and confirmation before executing.

### Uninstall

```bash
npx gentyr uninstall
```

Removes protection, symlinks, generated configs, husky hooks, and the managed `# BEGIN GENTYR OP` / `# END GENTYR OP` block from shell profiles. Preserves runtime state (`.claude/*.db`).

### Legacy Install (deprecated)

```bash
scripts/setup.sh --path /path/to/project --protect    # Will be removed in v2.0
```

### Verify Installation

```bash
cd /path/to/project && claude mcp list
```

## Merge Chain and Agent Git Workflow

GENTYR enforces a 4-stage merge chain: `feature/* -> preview -> staging -> main`. Direct commits to `main`, `staging`, and `preview` are blocked at the local level via pre-commit and pre-push hooks. Only promotion pipeline agents (`GENTYR_PROMOTION_PIPELINE=true`) may operate on protected branches.

### Feature Branch Commit Flow (Low-Friction)

Agents work on feature branches (`feature/*`, `fix/*`, `refactor/*`, `docs/*`, `chore/*`). At commit time, only lint and security checks run — no deputy-CTO review gate. This keeps commit latency low.

After committing, the project-manager agent:
1. Pushes the branch: `git push -u origin <branch>`
2. Creates a PR to `preview`: `gh pr create --base preview --head <branch> --title "..."`
3. Creates an urgent DEPUTY-CTO task for immediate PR review:
   ```javascript
   mcp__todo-db__create_task({
     section: "DEPUTY-CTO",
     title: "Review PR: <feature-title>",
     description: "Review and merge the PR...",
     assigned_by: "pr-reviewer",
     priority: "urgent"
   })
   ```

### Deputy-CTO PR Review Mode

When processing a `pr-reviewer`-assigned task, the deputy-CTO has `Bash` access to `gh` commands:
- `gh pr diff <number>` — review changes
- `gh pr review <number> --approve --body "..."` — approve
- `gh pr review <number> --request-changes --body "..."` — reject with feedback
- `gh pr merge <number> --merge --delete-branch` — merge and trigger worktree cleanup
- `gh pr edit <number> --add-label "deputy-cto-reviewed"` — always applied

**`pr-reviewer` and `system-followup` are approved `assigned_by` values** for the `DEPUTY-CTO` section in `SECTION_CREATOR_RESTRICTIONS` (defined in `packages/mcp-servers/src/shared/constants.ts`). `system-followup` is used by investigation follow-up tasks that call back into the deputy-cto triage pipeline after investigation completes.

### Worktrees

Concurrent agents work in isolated git worktrees at `.claude/worktrees/<branch>/`. Each worktree is provisioned with symlinked GENTYR config (hooks, agents, commands) and a worktree-specific `.mcp.json` with absolute `CLAUDE_PROJECT_DIR` paths. Worktrees for merged branches are cleaned up every **30 minutes** by the hourly automation (`getCooldown('worktree_cleanup', 30)`).

**`core.hooksPath` poisoning defense**: Claude Code sub-agents in worktrees can write stale `core.hooksPath` entries to the main `.git/config`, silently bypassing all pre-commit hooks. Four layers defend against this:
1. **`removeWorktree()`** (`worktree-manager.js`): Before removing a worktree, reads `core.hooksPath` and resets it to `.husky` if it points into the worktree being removed.
2. **`tamperCheck()` Check 1.5** (`gentyr-sync.js`): At every interactive SessionStart, detects and auto-repairs a stale `core.hooksPath` pointing into `.claude/worktrees/`.
3. **`husky/pre-commit` worktree check**: At every commit, shell-level `case` match detects `.claude/worktrees/` in `core.hooksPath`, auto-repairs and exits 1 so the corrected path takes effect before lint-staged runs.
4. **`safeSymlink()` EINVAL fix** (`worktree-manager.js`): When provisioning a worktree, `safeSymlink()` now checks `lstatSync` before `readlinkSync` to handle existing real directories (e.g. git-tracked `.husky/` checked out into the worktree), preventing EINVAL crashes that previously left worktrees partially provisioned.

### Sub-Agent Working Tree Isolation

Code-modifying sub-agents (`code-reviewer`, `code-writer`, `test-writer`) MUST be spawned with `isolation: "worktree"` when using the `Task` tool. This gives them their own branch and working directory, isolating their file changes from the main tree and other concurrent agents.

**Base branch**: All agent worktrees branch from `preview` (the default in `createWorktree(branchName, baseBranch = 'preview')` in `worktree-manager.js`). `createWorktree()` creates a NEW unique branch (e.g., `feature/code-review-abc`) based on `origin/preview` — it does NOT check out the `preview` branch itself. Multiple agents can all branch from `preview` concurrently without conflict.

**Why**: Without worktree isolation, sub-agents share the parent session's working tree. Concurrent file edits from multiple agents cause conflicts, and any git operation (stash, reset) in the main tree can destroy all agents' uncommitted work.

**Enforcement**: `main-tree-commit-guard.js` hard-blocks `git add`/`git commit`/`git reset --hard`/`git stash`/`git clean`/`git pull` for spawned agents (`CLAUDE_SPAWNED_SESSION=true`) in the main tree as a safety net.

**Example**:
```
// CORRECT: Agent gets its own isolated worktree (branched from preview)
Task(subagent_type: "code-writer", isolation: "worktree", ...)

// WRONG: Agent shares parent's working tree — file edits may conflict with other agents
Task(subagent_type: "code-writer", ...)
```

**Read-only agents are exempt**: Agents that only read code (e.g., `Explore`, `Plan`, `investigator`) don't need worktree isolation since they never run git write operations.

**Commit ownership**: Only the project-manager agent and interactive (CTO) sessions commit. Code-reviewer, code-writer, and test-writer agents do NOT commit — they write/review code and leave git operations to the project-manager. The `uncommitted-change-monitor.js` hook warns after 5 uncommitted file edits; interactive sessions should treat these warnings as mandatory and commit immediately.

## Propagation to Linked Projects

When developing GENTYR locally with `pnpm link`, most changes auto-propagate to target projects:
- **Hooks, commands, agents, docs**: Immediate (directory/file symlinks)
- **Config templates**: Next Claude Code session (SessionStart re-merges)
- **CLAUDE.md.gentyr-section**: Next Claude Code session (SessionStart replaces managed section)
- **Husky hooks**: Next Claude Code session (SessionStart auto-syncs)

### After editing MCP TypeScript source

MCP servers are referenced via `node_modules/gentyr/packages/mcp-servers/dist/`. The built `dist/` files propagate via symlink, but you MUST build after editing source:

```bash
cd packages/mcp-servers && npm run build
```

The SessionStart hook also attempts auto-rebuild if `src/` is newer than `dist/`; before running `tsc` it checks for `@types/node` in `packages/mcp-servers/node_modules/` and runs `npm install` first if missing (covers `git clean` or fresh npm installs that omit `packages/mcp-servers/node_modules/`). Always build explicitly after TS changes to ensure correctness.

### Slash Command Path Resolution

Slash commands in `.claude/commands/` must not hardcode `node_modules/gentyr` because they run in three different install contexts:
- **npm link** (standard): `node_modules/gentyr -> ~/git/gentyr`
- **Legacy symlink**: `.claude-framework -> ~/git/gentyr`
- **Gentyr repo itself**: `.` (working directly in the framework)

All slash commands resolve the framework directory with this pattern before running any `node` commands or `Read` tool paths:

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

This is documented within each command's `## Framework Path Resolution` section and enforced by the test suite at `.claude/hooks/__tests__/slash-command-markdown-gentyr-dir.test.js`.

### After changing launchd plist configuration

If you change automation service intervals, environment variables, or script paths that affect the launchd plists, run sync in each linked target project:

```bash
cd ~/git/my-project && npx gentyr sync
```

This regenerates the plists and reloads the launchd services.

## Plugin System

Local-only extensions live in `plugins/` (gitignored). Each plugin is a directory with:
- `config.json` — plugin config (standard schema, managed via `plugin_manager` MCP tools)
- `src/server.ts` — optional MCP server contributing plugin-specific tools
- `dist/server.js` — compiled output; auto-discovered and registered in gentyr's `.mcp.json`

Plugin-manager MCP tools are only available when working in the gentyr repo itself.

### After adding a new plugin server

Build the plugin and regenerate `.mcp.json`:
```bash
cd plugins/{name} && npm run build
cd ~/git/gentyr && npx gentyr sync   # or restart Claude Code session
```

### Notion Plugin (`plugins/notion/`)

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

## AI User Feedback System

Configure user personas to automatically test your app when staging changes are detected:

```bash
# In a Claude Code session after GENTYR is installed:
/configure-personas
```

Creates personas (GUI/CLI/API/SDK/ADK modes), registers features with file patterns, and maps personas to features. Feedback agents spawn on staging changes and report findings to deputy-CTO triage pipeline.

**5 Consumption Modes:**

| Mode | Tools Available | Docs Access | Use Case |
|------|----------------|-------------|----------|
| `gui` | Playwright browser | N/A (browses app) | Web UI testing as a real user |
| `cli` | programmatic-feedback (CLI) | N/A | Command-line tool testing |
| `api` | programmatic-feedback (API) | N/A | REST/GraphQL API testing |
| `sdk` | Claude Code tools + programmatic-feedback + Playwright | Docs portal via browser | Developer testing SDK in scratch workspace |
| `adk` | Claude Code tools + programmatic-feedback + docs-feedback | Docs via MCP search/read | AI agent testing SDK programmatically |

**SDK and ADK modes** spawn feedback agents with a scratch workspace (`/tmp/gentyr-feedback/workspace-{sessionId}/`) where the SDK is pre-installed via `npm install`. Agents have Claude Code tools (`Bash,Read,Write,Edit,Glob,Grep`) to write and run test scripts. The difference is docs access: SDK uses Playwright to browse the docs portal (human-like), ADK uses the `docs-feedback` MCP server for programmatic search/read (agent-like).

**`endpoints` field semantics per mode:**
- GUI: `[app-url]`
- CLI: `[cli-command]`
- API: `[api-base-url]`
- SDK: `[sdk-packages-csv, docs-portal-url]` — `endpoints[1]` optional
- ADK: `[sdk-packages-csv, docs-directory-path]` — `endpoints[1]` optional

**Docs configuration** is user-driven via `/configure-personas` or the product-manager agent. If `endpoints[1]` is not configured for SDK/ADK personas, the agent runs without docs access (code-only testing) and receives a warning in the prompt.

**`docs-feedback` MCP server** (`packages/mcp-servers/src/docs-feedback/`): Serves the project's own developer docs. Reads `FEEDBACK_DOCS_PATH` env var, recursively walks for `.md`/`.mdx` files, provides 4 tools: `docs_search`, `docs_list`, `docs_read`, `docs_status`. Uses `AuditedMcpServer` for audit trail.

To browse a persona's feedback history or spawn a one-shot feedback session on demand:

```bash
/persona-feedback
```

Shows an overview of all personas and recent feedback runs, lets you pick a persona, view its satisfaction trend and CTO reports, drill into past session details, or spawn a live feedback session (fire-and-forget).

The `product-manager` agent also creates fully-functional personas automatically as a post-analysis step. After Section 6 is completed, the agent receives a persona evaluation task where it first asks the user to choose between **Fill gaps only** (idempotent — backfill missing data without replacing existing) or **Full rebuild** (create everything fresh). It then reads `package.json` to detect the dev server URL and framework, scans for route/feature directories, registers them as features, creates or backfills personas with all required fields (`name`, `display_name`, `endpoints`, `behavior_traits`, `consumption_mode`), maps personas to features, maps pain points to personas, and reports compliance to the deputy-CTO. For SDK/ADK personas, the agent sets `endpoints[1]` to the project's docs path/URL when auto-detectable (e.g., `docs/` directory or `docs` script in `package.json`). This is the primary automated path; `/configure-personas` is the interactive manual path for user-driven setup.

## Product Manager MCP Server

The product-manager MCP server (`packages/mcp-servers/src/product-manager/`) manages a 6-section product-market-fit (PMF) analysis pipeline. State is persisted in `.claude/state/product-manager.db`.

**Access via `/product-manager` slash command** (prefetches current status from the database before display, including demo scenario coverage for GUI personas — surfaces uncovered personas via `demoScenarios.uncoveredPersonas` in prefetch data).

**Command menu (when analysis is `completed`)**: Options include view section, run pipeline, regenerate markdown, finalize, persona compliance, list unmapped pain points, and **Demo scenarios** (Option 6). The demo scenarios sub-menu offers: Gap analysis (runs coverage table showing GUI personas, scenario counts, and CODE-REVIEWER task status), Create scenarios (spawns product-manager sub-agent for uncovered personas), and View scenarios (calls `mcp__user-feedback__list_scenarios`). After any demo scenario creation action, gap analysis is always re-run as a completion verification pattern — checks that every scenario has a matching `"Implement demo scenario: <title>"` CODE-REVIEWER task.

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

## Automation Service

```bash
scripts/setup-automation-service.sh status --path /project                  # Check service status
scripts/setup-automation-service.sh remove --path /project                  # Remove service
scripts/setup-automation-service.sh run --path /project                     # Manual run
scripts/setup-automation-service.sh setup --path /project --op-token TOKEN  # Install with 1Password service account
```

By default, the automation service runs without 1Password credentials in background mode to avoid macOS permission prompts. Provide `--op-token` with a 1Password service account token to enable headless credential resolution for infrastructure MCP servers.

### On-Demand Task Spawning

```bash
# In a Claude Code session after GENTYR is installed:
/spawn-tasks
```

Bypasses the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate to force-spawn pending TODO tasks immediately. The command prefetches current agent counts and concurrency limits, asks which sections to spawn and what concurrency cap to use, then calls `force_spawn_tasks` on the agent-tracker MCP server. Preserves the concurrency guard and task status tracking.

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

## Task Gate System

New tasks created by non-privileged agents enter `pending_review` status and are reviewed by a lightweight Haiku gate agent before entering the active queue.

**Task state machine**: `pending_review` → `pending` → `in_progress` → `completed`

**Gate bypass**: Tasks from trusted creators (`deputy-cto`, `cto`, `human`, `pr-reviewer`, `system-followup`, `demo`) skip the gate and enter `pending` directly.

**Urgency auto-downgrade**: Only urgency-authorized creators (same list as gate bypass) can set `priority: "urgent"`. Tasks from other agents are auto-downgraded to `normal` with a warning.

**Gate decision tools** (on `todo-db` server):
- `gate_approve_task` — moves `pending_review` → `pending`
- `gate_kill_task` — deletes a `pending_review` task with reason
- `gate_escalate_task` — approves task AND creates a deputy-CTO report for review

**PostToolUse hook** (`.claude/hooks/task-gate-spawner.js`): Fires on `mcp__todo-db__create_task`. When the response shows `status: 'pending_review'`, spawns a Haiku gate agent that checks for duplicates, feature stability locks, and CTO intent before deciding.

**Crash recovery**: `hourly-automation.js` auto-approves stale `pending_review` tasks older than 10 minutes (gate agent timed out or crashed).

**Race condition prevention**: `urgent-task-spawner.js` checks `toolInput.priority === 'urgent'` (input-side); `task-gate-spawner.js` checks `tool_response.status === 'pending_review'` (output-side). No overlap.

## Feature Stability Registry

CTO-gated mechanism to lock features and prevent endless agent nitpick chains on solid features.

**`feature_stability` table** (in `user-feedback.db`): Stores stability locks linked to features via `feature_id` FK (CASCADE delete).

**4 MCP tools** (on `user-feedback` server):
- `lock_feature` — CTO-gated (only `cto` or `human` caller); creates a stability lock
- `unlock_feature` — CTO-gated; removes a stability lock
- `list_stable_features` — JOINs to features table; returns locked features with reasons
- `check_feature_stability` — Checks file patterns and feature name against locked features; used by the gate agent to auto-kill tasks targeting stable features

**CTO workflow**: Lock/unlock features in interactive sessions. Product-manager can request locks via deputy-CTO escalation.

## CTO Session Search

The `search_cto_sessions` tool on the `agent-tracker` MCP server filters session files to user-only (non-autonomous) sessions before searching.

- Scans `~/.claude/projects/{encoded-project-path}/` for session JSONL files
- Reads first 2KB of each file; skips sessions containing `[Task]` or `[AGENT:` markers (autonomous)
- Searches remaining files for the query string (case-insensitive)
- Returns matching excerpts with surrounding context lines
- Used by the gate agent to check if the CTO recently discussed a topic (CTO intent check)

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by API quota limits, unexpected process death, or full account exhaustion.

**Session Reviver** (`.claude/hooks/session-reviver.js`):
- Called from `hourly-automation.js` every automation cycle (10-minute cooldown via `getCooldown('session_reviver', 10)`)
- Gate-exempt step: runs after key sync, not subject to the CTO activity gate, so recovery proceeds even when the CTO is inactive
- **Retroactive first-run window**: On the first cycle after startup, uses a 12-hour stale window instead of 30 minutes, picking up sessions interrupted before the automation process started
- **Revival prompt**: Each resumed session receives a structured context prompt with elapsed time, interruption reason, and task verification instructions — the agent must call `mcp__todo-db__get_task` or `mcp__todo-db__list_tasks` before continuing to avoid duplicating work already handled by another agent
- **taskId resolution**: Resolved from `agent-tracker-history.json` metadata so the revival prompt can reference the specific task ID
- **Mode 3 sessionId fallback**: When `paused-sessions.json` lacks an explicit `sessionId`, finds the session JSONL file by scanning for the `[AGENT:<agentId>]` marker in the first 2KB of each transcript file
- Cap: 3 revivals per cycle (`MAX_REVIVALS_PER_CYCLE`); respects the running-agent concurrency limit

**Three revival modes (priority order):**

| Mode | Source state file | Trigger | Stale window |
|------|-------------------|---------|--------------|
| 1 — Quota-interrupted | `.claude/state/quota-interrupted-sessions.json` | `stop-continue-hook.js` writes on quota death | 30 min (12h retroactive on first run) |
| 2 — Dead session recovery | `.claude/state/agent-tracker-history.json` | Agents reaped with `process_already_dead` + pending TODO task | 7 days |
| 3 — Paused sessions | `.claude/state/paused-sessions.json` | `quota-monitor.js` `writePausedSession()` when all accounts exhausted | 24h |

**Stop Hook** (`.claude/hooks/stop-continue-hook.js`):
- Writes `quota-interrupted-sessions.json` entries with `status: 'pending_revival'` when a spawned session dies from a rate limit error
- Cleanup window widened from 30 min to 12 h so records survive for retroactive revival on the first automation cycle after restart
- Tombstone consumer: filters tombstoned rotation state keys before passing to `checkKeyHealth()`

**`quota-monitor.js` Mode 3 integration**: Calls `writePausedSession(agentId)` when all accounts are exhausted and a spawned session is about to be abandoned; session-reviver resumes it once any account recovers below 90% usage

**`agent-tracker.js` constants**: Exports `SESSION_REVIVED` (`'session-revived'`) and `SESSION_REVIVER` (`'session-reviver'`) agent/hook type constants consumed by session-reviver; mirrored in `packages/mcp-servers/src/agent-tracker/types.ts`

**`config-reader.js` default**: `session_reviver: 10` minutes added to `DEFAULTS`; operators can override via `.claude/state/automation-config.json`

**Quota Monitor Hook** (`.claude/hooks/quota-monitor.js`):
- Runs after every tool call (throttled to 5-minute intervals)
- Checks active key usage and triggers rotation at 95% utilization
- **Step 4b unified refresh loop**: Refreshes expired tokens AND proactively refreshes non-active tokens approaching expiry (within 10 min of `EXPIRY_BUFFER_MS`); uses single loop with `isExpired`/`isApproachingExpiry` variables for efficiency
- `refreshExpiredToken` returns the sentinel string `'invalid_grant'` (not `null`) when the OAuth server responds HTTP 400 + `{ error: 'invalid_grant' }`; callers mark the key `invalid` and skip it permanently
- **Step 4c pre-expiry restartless swap**: When the active key is within 10 min of expiry and a valid standby exists, writes standby to Keychain via `updateActiveCredentials()`; Claude Code's built-in `SRA()` (proactive refresh at 5 min before expiry) or `r6T()` (401 recovery) picks up the new token seamlessly — no restart needed
- Safe: refreshing Account B does not revoke Account A's in-memory token
- **Seamless rotation** (quota-based): writes new credentials to Keychain, continues with `continue: true` for all sessions, credentials adopted at token expiry (SRA) or 401 (r6T)
  - No disruptive kill/restart paths; no orphaned processes
- Post-rotation health audit: logs rotation verification to `rotation-audit.log`
- Fires `account_nearly_depleted` rotation log event when active key reaches 95% usage (5-hour per-key cooldown to avoid re-firing every check cycle)
- Fires `account_quota_refreshed` rotation log event when a previously exhausted key's usage drops back below 100% (also fires in `api-key-watcher.js` during SessionStart health checks)

**Key Sync Module** (`.claude/hooks/key-sync.js`):
- Shared library used by api-key-watcher, hourly-automation, credential-sync-hook, and quota-monitor
- Exports `EXPIRY_BUFFER_MS` (10 min) and `HEALTH_DATA_MAX_AGE_MS` (15 min) constants for consistent timing across all rotation logic
- `refreshExpiredToken` returns `'invalid_grant'` sentinel (distinct from `null`) when OAuth responds 400 + `error: invalid_grant`; all callers mark the key `status: 'invalid'` and log `refresh_token_invalid_grant`
- `syncKeys()` proactively refreshes non-active tokens approaching expiry (within `EXPIRY_BUFFER_MS`), resolves account profiles for keys missing `account_uuid` via `fetchAccountProfile()`, and performs pre-expiry restartless swap to Keychain; covers idle sessions because hourly-automation calls `syncKeys()` every 10 min via launchd even when no Claude Code process is active
- `fetchAccountProfile(accessToken)` — exported function that calls `https://api.anthropic.com/api/oauth/profile` to resolve `account_uuid` and `email` for keys added by automation or token refresh that skipped the interactive SessionStart profile-resolution path; non-fatal, retried on next sync
- `selectActiveKey()` freshness gate: nulls out usage data older than 15 minutes to prevent uninformed switches based on stale health checks; stale keys pass "usable" filter but are excluded from comparison logic, causing system to stay put rather than make blind decisions
- `pruneDeadKeys` converts keys with `status: 'invalid'` to `status: 'tombstone'` (with `tombstoned_at` timestamp and 24h TTL) rather than deleting them; tombstoned keys are distinguishable from genuinely unknown tokens so the rotation proxy can swap rather than passthrough; fires `account_auth_failed` rotation log event only when an account loses its last viable key; email resolution order: key-level `account_email` → sibling key with same `account_uuid` → rotation_log history for same `key_id`; fires `account_auth_failed` only once per account (checks remaining non-pruned keys with same email to avoid duplicates); tombstoned entries removed from rotation_log only after their 24h TTL expires; `hasOtherViableKey` filter excludes `tombstone` status; never prunes the active key; called automatically at the end of every `syncKeys()` run
- `refreshExpiredToken` skips keys with `status: 'tombstone'` (in addition to `'invalid'`)

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

### Hook Output Format: `systemMessage` vs `additionalContext`

For `UserPromptSubmit` hooks, two output fields serve different purposes:
- **`systemMessage`**: Shown in the terminal UI only. The AI model does NOT see this — it only receives "Success" for hook status.
- **`hookSpecificOutput.additionalContext`**: Injected into the AI model's conversation context. This is the ONLY way to pass information from a hook to the model.

Hooks that need the AI to act on their output must include both:
```json
{
  "continue": true,
  "systemMessage": "human-visible warning",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "context that reaches the AI model"
  }
}
```

**GENTYR Auto-Sync Hook** (`.claude/hooks/gentyr-sync.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Fast path: reads `version.json` and `gentyr-state.json`, compares version + config hash — exits in <5ms when nothing has changed
- When version or config hash mismatch detected: re-merges `settings.json`, regenerates `.mcp.json` (preserving OP token), updates the GENTYR section of `CLAUDE.md`, and symlinks new agent definitions; handles missing `settings.json` gracefully by checking directory writability instead of file writability when the file does not yet exist
- Auto-rebuilds MCP servers when `src/` mtime > `dist/` mtime; checks for `@types/node` in `packages/mcp-servers/node_modules/` and runs `npm install` first if missing, then `npm run build` (30s timeout); logs to stderr on failure (silent to agent)
- Syncs husky hooks by comparing `husky/` against `.husky/` in the target project; re-copies if content differs
- Falls back to legacy settings.json hook diff check when no `gentyr-state.json` exists (pre-migration projects)
- Supports both npm model (`node_modules/gentyr`) and legacy symlink model (`.claude-framework`)
- **`tamperCheck()`**: Runs before sync logic. Two checks: (1) symlink target verification — confirms `.claude/hooks` is a symlink resolving to a directory whose grandparent contains `version.json`; regular directories only allowed in the framework repo itself; (2) file ownership check — reads `protection-state.json`, if `protected: true` verifies each filename in `criticalHooks` array is still root-owned (`stat.uid === 0`). Emits a `systemMessage` warning listing all failed checks if any are detected.
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; version 3.0

**CTO Notification Hook** (`.claude/hooks/cto-notification-hook.js`):
- Runs at `UserPromptSubmit` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`) and slash commands (sentinel markers or `/command-name` pattern)
- Checks deputy-cto database (pending decisions, rejections), agent-reports database (unread reports), todo.db (queued/active task counts), and autonomous mode status
- Reads aggregate quota from `~/.claude/api-key-rotation.json`; deduplicates same-account keys by `account_uuid`; falls back to fingerprint cross-match for null-UUID keys
- Displays a multi-line status block each prompt (quota bar, 30-day token usage, session counts, TODO counts, pending CTO items)
- Critical mode: when `rejections > 0`, collapses to a compact one-liner with `COMMITS BLOCKED` prefix
- Uses an incremental session-file cache (`~/.claude/cto-metrics-cache-*.json`) with a 3-second time budget to compute token usage without blocking
- Output uses both `systemMessage` (terminal display) and `hookSpecificOutput.additionalContext` (AI model context) so the AI can act on quota/deadline data
- Tests at `.claude/hooks/__tests__/cto-notification-hook.test.js` (36 tests, runs via `node --test`)

**Branch Drift Check Hook** (`.claude/hooks/branch-drift-check.js`):
- Runs at `UserPromptSubmit` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Detects when the main working tree is not on `main` and emits a warning via both `systemMessage` (terminal) and `additionalContext` (AI model context)
- Uses `getCooldown('branch_drift_check', 30)` (30-minute default, configurable); cooldown resets immediately if the branch changes
- State file: `.claude/state/branch-drift-state.json` with `{ lastCheck, lastBranch }`
- Skips worktrees (`.git` file check), detached HEAD, and spawned sessions; warn-only — never auto-restores
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `UserPromptSubmit`
- Tests at `.claude/hooks/__tests__/gentyr-sync-branch-drift.test.js` (18 tests, runs via `node --test`)

**Branch Checkout Guard** (two-layer defense — `.claude/hooks/branch-checkout-guard.js` + `.claude/hooks/git-wrappers/git`):

Prevents branch drift by blocking `git checkout`/`git switch` in the main working tree. Complements the warn-only Branch Drift Check with a hard enforcement layer:

- **Layer 1 — Git wrapper** (`.claude/hooks/git-wrappers/git`): POSIX shell script placed in `git-wrappers/` directory; injected into spawned agent environments via `PATH` prepending in `buildSpawnEnv()` (hourly-automation, urgent-task-spawner, session-reviver, force-spawn-tasks, force-triage-reports). Intercepts `git checkout`/`git switch` invocations (all sessions) and `git add`/`git commit`/`git reset --hard`/`git stash`/`git clean`/`git pull` (spawned agents with `CLAUDE_SPAWNED_SESSION=true` only; `GENTYR_PROMOTION_PIPELINE=true` exempted). Exits 128 with a descriptive message on blocked operations. Zero-overhead fast path for all other git subcommands. Root-owned via `npx gentyr protect`.
- **Layer 2 — PreToolUse hook** (`.claude/hooks/branch-checkout-guard.js`): Hard-blocking (`permissionDecision: "deny"`) Claude Code PreToolUse hook that catches checkout/switch at the tool-call level. Covers interactive sessions (where PATH injection is not active) and agents that invoke `/usr/bin/git` directly, bypassing the PATH wrapper. Uses the same quote-aware `tokenize()` + `splitOnShellOperators()` pattern from `credential-file-guard.js` for robust parsing of chained commands.
- **Both layers**: Skip silently in worktrees (`.git` file check — `.git` is a file in a worktree, not a directory), non-repo directories, and skip global git flags (`-C`, `--git-dir`, etc.) when locating the subcommand. Always allow `git checkout main` (recovery path) and file restore invocations (`git checkout -- <file>`).
- Registered in `settings.json.template` under `PreToolUse > Bash`. Root-owned and listed in `protection-state.json` `criticalHooks` array alongside `git-wrappers/git`. Included in the `husky/pre-commit` tamper-detection ownership loop.
- Tests at `.claude/hooks/__tests__/branch-checkout-guard.test.js` (30 tests, runs via `node --test`)

**Main Tree Commit Guard Hook** (`.claude/hooks/main-tree-commit-guard.js`):
- Runs at `PreToolUse` for Bash tool calls; hard-blocking (`permissionDecision: "deny"`) for spawned agents in the main working tree
- Only fires when ALL three conditions are true: `CLAUDE_SPAWNED_SESSION=true`, `.git` is a directory (main tree, not a worktree), and `GENTYR_PROMOTION_PIPELINE !== 'true'`
- Blocked subcommands: `git add` (staging triggers lint-staged chain), `git commit` (invokes pre-commit hooks including lint-staged `stash`/`reset --hard`), `git reset --hard` (directly destroys uncommitted changes), `git stash` (push/pop/drop/clear/apply — `list`/`show` are read-only and allowed), `git clean` (destroys untracked files), `git pull` (fetch+merge can clobber working tree)
- Uses the same quote-aware `tokenize()` + `splitOnShellOperators()` pattern from `branch-checkout-guard.js` for robust multi-command parsing
- Complements the Layer 1 git wrapper (which covers the same subcommands via PATH injection); together they form a two-layer defense against sub-agent data loss
- Root-owned and listed in `protection-state.json` `criticalHooks` array; included in the `husky/pre-commit` tamper-detection ownership loop
- Tests at `.claude/hooks/__tests__/main-tree-commit-guard.test.js` (56 tests, runs via `node --test`)

**Uncommitted Change Monitor Hook** (`.claude/hooks/uncommitted-change-monitor.js`):
- Runs at `PostToolUse` for Write and Edit tool calls
- Tracks cumulative file-modifying tool calls since the last `git commit` via `.claude/state/uncommitted-changes-state.json`
- At threshold (5 edits), injects an `additionalContext` warning instructing the agent to commit immediately; 3-minute cooldown between repeat warnings
- Counter resets when a new commit is detected (HEAD hash change via `git log -1 --format=%H`)
- Skips all spawned agents (`CLAUDE_SPAWNED_SESSION=true`) — only the project-manager and interactive (CTO) sessions commit, so warning other spawned agents is counterproductive; fires for interactive sessions only
- Output uses `hookSpecificOutput.additionalContext` so the AI model receives the warning, not just the terminal display
- Tests at `.claude/hooks/__tests__/uncommitted-change-monitor.test.js` (16 tests, runs via `node --test`)

**Credential Health Check Hook** (`.claude/hooks/credential-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions
- Validates vault mappings against required keys in `protected-actions.json`
- Checks `.mcp.json` env blocks for keys injected directly (e.g. `OP_SERVICE_ACCOUNT_TOKEN`), which count as configured even if absent from vault-mappings
- **OP token desync detection**: Compares shell `OP_SERVICE_ACCOUNT_TOKEN` against `.mcp.json` value; if they differ, emits a warning and overwrites `process.env` with the `.mcp.json` value (source of truth); `.mcp.json` is always authoritative because it is updated by reinstall
- Auto-propagates to target projects via `.claude/hooks/` directory symlink
- Shell sync validation also available via `scripts/setup-validate.js` `validateShellSync()` function, which checks the `# BEGIN GENTYR OP` / `# END GENTYR OP` block in `~/.zshrc` or `~/.bashrc`

**Credential File Guard Hook** (`.claude/hooks/credential-file-guard.js`):
- Runs at `PreToolUse` for Read, Write, Edit, Grep, Glob, and Bash tool calls; hard-blocking (uses `permissionDecision: "deny"` — not just a warning)
- Blocks access to `BLOCKED_BASENAMES` (`.env`, `.zshrc`, `.bashrc`, etc.) and `BLOCKED_PATH_SUFFIXES` (`.claude/protection-key`, `.claude/api-key-rotation.json`, `.mcp.json`, etc.)
- For Bash commands, uses a quote-aware shell tokenizer (`tokenize()`) to extract redirection targets (including quoted targets like `echo hello > ".env"`), command arguments, and inline path references; `NON_FILE_COMMANDS` set exempts echo/printf/git/package managers to avoid false positives
- Redirection scan covers `>`, `>>`, `<`, `2>`, `2>>`, `1>`, `1>>`, `0<` and operates on tokenized output so quoted bypasses (e.g. `> ".env"`) are caught; also detects protected basename references in path context (`/basename` or `~basename` patterns) to block deep-path variants
- `ALWAYS_BLOCKED_SUFFIXES` and `ALWAYS_BLOCKED_BASENAMES` are hard-blocked with no approval escape hatch; other protected paths can be approved via `protected-action-approvals.json`
- Blocks credential environment variable references (`$TOKEN`, etc.) sourced from `protected-actions.json` `credentialKeys` arrays; also blocks environment dump commands (`env`, `printenv`, `export -p`)
- Root-ownership of credential files at the OS level is the primary defense; this hook is defense-in-depth
- Tests at `.claude/hooks/__tests__/credential-file-guard.test.js` (142 tests, runs via `node --test`)

**Playwright CLI Guard Hook** (`.claude/hooks/playwright-cli-guard.js`):
- Runs at `PreToolUse` for Bash tool calls only; hard-blocking (`permissionDecision: "deny"`)
- Detects CLI-based Playwright invocations (`npx playwright test`, `pnpm test:e2e`, `pnpm test:pw`, and equivalents for npm/yarn)
- Blocks execution and directs agent to use MCP tools instead (`mcp__playwright__run_tests`, `mcp__playwright__launch_ui_mode`, etc.)
- Rationale: CLI invocations bypass the Playwright MCP server's 1Password credential injection, causing tests to fail or skip silently without proper environment variables
- **Escape hatch**: Prefix the command with `PLAYWRIGHT_CLI_BYPASS=1` to allow CLI execution for a single command (e.g., `PLAYWRIGHT_CLI_BYPASS=1 npx playwright install`). Valid reasons: codegen/trace viewer, debugging with custom Node flags, installing browsers
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PreToolUse > Bash`
- Tests at `.claude/hooks/__tests__/playwright-cli-guard.test.js` (41 tests, runs via `node --test`)

**Playwright Health Check Hook** (`.claude/hooks/playwright-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Fast-path exit when no `playwright.config.ts` or `playwright.config.js` exists in the project root (target projects that don't use Playwright are unaffected)
- Writes `.claude/playwright-health.json` with auth state freshness, cookie expiry, and extension build status
- `authState` fields: `exists`, `ageHours`, `cookiesExpired`, `isStale` (true when cookies expired or age >24h)
- **Dynamic auth file discovery**: reads `storageState` from the first project entry in `playwright.config.ts` via regex; falls back to scanning `.auth/` for any `.json` file; no hardcoded auth file names (project-agnostic)
- `extensionBuilt` checks for the directory specified by `GENTYR_EXTENSION_DIST_PATH` env var (relative to project root); defaults to `true` (no blocker) when unset
- `needsRepair: true` when `authState.isStale || !extensionBuilt`
- Emits a visible stderr warning when auth state is stale; read by `slash-command-prefetch.js` as a 1-hour cache (avoids re-reading `.auth/*.json` on every `/demo` invocation)
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `SessionStart` (timeout: 5)
- Tests at `.claude/hooks/__tests__/playwright-health-check.test.js` (10 tests, runs via `node --test`)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos in linked target projects.

**Project-agnostic config discovery** (`packages/mcp-servers/src/playwright/config-discovery.ts`):
- Reads `playwright.config.ts` (or `.js`) as raw text using regex and brace-matching — no `require`/`import` of the config, avoiding TS compilation and side effects
- Exports `discoverPlaywrightConfig(projectDir): PlaywrightConfig` and `resetConfigCache()` (for tests)
- Discovered fields: `projects[]` (with `name`, `testDir`, `storageState`, `isInfrastructure`, `isManual`, `isExtension`), `defaultTestDir`, `projectDirMap`, `personaMap`, `extensionProjects` (Set), `authFiles[]`, `primaryAuthFile`
- Infrastructure projects (`seed`, `auth-setup`, `cleanup`, `setup`) excluded from `projectDirMap` and `personaMap`
- Extension projects detected by `name.includes('extension')` or `name === 'demo'`
- Persona labels auto-generated: `vendor-owner` → `Vendor (Owner)`, `cross-persona` → `Cross Persona`, etc.
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
- `preflight_check` — Validate environment readiness before launching; runs 9 checks: config exists, dependencies, browsers installed, test files, credentials valid, dev server reachable, compilation, auth state freshness, and extension manifest valid
- `run_auth_setup` — Refresh Playwright auth state by running `seed` then `auth-setup` projects; discovers expected auth files from `storageState` fields in config (or scans `.auth/` as fallback); 4-minute timeout; supports `seed_only` flag to skip auth-setup
- `run_demo` — Launch Playwright tests in a visible headed browser at human-watchable speed (auto-play mode). Accepts any project name from the target project's `playwright.config.ts`. Passes `DEMO_SLOW_MO` env var (default 800ms) for pace control — target project must read `parseInt(process.env.DEMO_SLOW_MO || '0')` in `use.launchOptions.slowMo`. Automatically enables `--trace on` for every demo run, enabling play-by-play trace capture after the run completes. Returns an error immediately if the spawned child process has no PID. Monitors for early crashes during a 15s startup window (accommodates headed browser + webServer compilation); returns success once the process survives that window. Records the demo run state (PID, project, test file, started_at) in memory and persisted to `.claude/state/demo-runs.json` (capped at 20 entries); `trace_summary` is excluded from persistence to avoid 50KB-per-entry state file bloat (in-memory only). On load, persisted entries with a valid numeric `pid` field are accepted.
- `check_demo_result` — Poll the result of a `run_demo` call by PID. Returns `status` (`running`, `passed`, `failed`, `unknown`), exit code, `failure_summary`, `screenshot_paths`, and `trace_summary` when available. Checks process liveness for `running` status; reads persisted state from `.claude/state/demo-runs.json` for completed runs (note: `trace_summary` is not persisted — available only in the same MCP server process that ran the demo). Failure details are enriched from the playwright-failure-reporter's `lastDemoFailure` entry in `test-failure-state.json` when available.
- `list_extension_tabs` — List open tabs in a CDP-connected extension test browser
- `screenshot_extension_tab` — Screenshot a specific extension tab via CDP

**`preflight_check` cross-project compatibility**:
- `launch_ui_mode`, `run_demo`, `run_tests`, and `preflight_check` all accept any `project` string (not a hardcoded enum) — compatible with any target project's `playwright.config.ts` configuration
- `test_files_exist` check (check #4): returns `skip` (not `fail`) when the project name has no known directory mapping — compilation check (#6) validates it instead; prevents false failures on projects with non-standard directory layouts

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

**Playwright Failure Reporter** (`.claude/hooks/reporters/playwright-failure-reporter.js`):
- Custom Playwright reporter that spawns Claude to fix test failures automatically (fire-and-forget, does not block test completion)
- Per-suite cooldown (120 min, configurable via `test_failure_reporter` in automation config) + content-based SHA-256 deduplication (24h expiry) prevent duplicate spawns
- `onTestEnd()` captures screenshot attachment paths from `result.attachments` for every failed test
- `onEnd()` writes a `lastDemoFailure` entry to `test-failure-state.json` when any `.demo.ts` file fails — includes `testFile`, `suiteNames`, `failureDetails` (4KB cap), and `screenshotPaths` (up to 5). This enriches `check_demo_result` responses for demo run failures.
- Spawn uses `[Task][test-failure-playwright]` prefix for CTO dashboard tracking; sets `CLAUDE_SPAWNED_SESSION=true` to prevent hook chain reactions

**`/demo` command suite** (`.claude/commands/demo.md`, `demo-interactive.md`, `demo-autonomous.md`):
- `/demo` — Escape hatch: launches Playwright UI mode showing ALL tests. No scenario filtering. Developer power-tool for browsing the full test suite. Step 2 uses `personaGroups` from prefetch for persona-first selection with an "All tests" option; falls back to `discoveredProjects` when no `personaGroups` exist.
- `/demo-interactive` — Scenario-based two-step flow: Step 2 selects a persona (with `[N]` scenario count labels), Step 3 selects a scenario within that persona. Single-item paths skip their prompts. Runs at full speed then pauses for manual interaction. "Take me to this screen."
- `/demo-autonomous` — Scenario-based two-step flow (same persona → scenario selection as `/demo-interactive`): runs at human-watchable speed (slowMo 800ms), browser stays open after completion. "Show me the product in action." After launch, polls `check_demo_result` every 30 seconds (max 5 polls, ~2.5 min) to detect failures; creates an urgent DEPUTY-CTO task with failure summary, exit code, and screenshot paths on failure. If polls exhaust with status still `running`, the autonomous flow completed successfully (failures cause process exit) and the browser is paused at the final screen.
- All three use the same "escalate all failures" pattern — when `preflight_check` returns `ready: false`, a single urgent DEPUTY-CTO task is created describing every failed check with per-check repair instructions
- `/demo` calls `mcp__playwright__launch_ui_mode`; `/demo-interactive` and `/demo-autonomous` call `mcp__playwright__run_demo` with `test_file` and `pause_at_end` from the selected scenario
- Repair mapping: `config_exists` → CODE-REVIEWER; `dependencies_installed`/`browsers_installed` → direct Bash fix; `test_files_exist` → TEST-WRITER; `credentials_valid` → INVESTIGATOR & PLANNER; `auth_state` → `run_auth_setup()` then INVESTIGATOR & PLANNER on failure; `extension_manifest` → CODE-REVIEWER (fix invalid match patterns in `manifest.json`)
- The `demo` agent identity is included in `SECTION_CREATOR_RESTRICTIONS` for DEPUTY-CTO (allows `mcp__todo-db__create_task` with `assigned_by: "demo"`)
- `slash-command-prefetch.js` reads the cached `playwright-health.json` (1-hour TTL) written by the SessionStart hook, falling back to dynamic `.auth/` scan on cache miss; discovers projects dynamically from `playwright.config.ts` via regex (no hardcoded project list); credential check uses generic `op://` env scan (no hardcoded credential key names); also queries `user-feedback.db` for enabled demo scenarios; test file counts include `.demo.ts` files alongside `.spec.ts` and `.manual.ts`; pre-computes `personaGroups` — scenarios grouped by persona (`{ persona_name, persona_display_name, playwright_project, scenarios[] }`) where `persona_display_name` is `COALESCE(display_name, name)` from the personas table and each scenario object carries its own `playwright_project` field — enabling two-step persona → scenario selection in demo commands without redundant DB queries; all error/missing-db paths emit empty `personaGroups: []`

## Demo Scenario System

Curated product walkthroughs (NOT tests) mapped to personas. Scenarios are managed by the product-manager agent and implemented by code-writer agents. The test-writer agent is explicitly excluded from `*.demo.ts` files.

**`demo_scenarios` table** (in `user-feedback.db`):
- `id` TEXT PK, `persona_id` TEXT FK→personas, `title`, `description`, `category` (optional), `playwright_project`, `test_file` (UNIQUE, must end with `.demo.ts`), `sort_order`, `enabled`, timestamps
- FK CASCADE: deleting a persona deletes its scenarios

**5 MCP tools** (on `user-feedback` server):
- `create_scenario` — validates persona exists AND `consumption_mode = 'gui'` (rejects non-GUI); enforces `.demo.ts` suffix
- `update_scenario` — partial update; enforces `.demo.ts` if `test_file` changes
- `delete_scenario` — simple DELETE
- `list_scenarios` — JOIN to personas for `persona_name`; filters by `persona_id`, `enabled`, `category`
- `get_scenario` — enriches with `persona_name`

**Constraints:**
- Only `gui` consumption_mode personas can have demo scenarios — SDK/CLI/API/ADK personas cannot
- `*.demo.ts` file naming convention enforced by `create_scenario` and `update_scenario`
- `DEMO_PAUSE_AT_END` env var — demo files import a shared helper that checks this and calls `page.pause()` if set

**Playwright MCP extensions:**
- `run_demo` accepts `test_file` (positional arg for single-file filtering) and `pause_at_end` (sets `DEMO_PAUSE_AT_END=1`)
- `launch_ui_mode` accepts optional `test_file` for filtered UI mode
- `countTestFiles()` recognizes `.demo.ts` alongside `.spec.ts` and `.manual.ts`

**Feedback N+1 spawning pattern:**
- When personas are spawned for feedback sessions, GUI personas get N+1 sessions: 1 default (no scenario) + up to 3 scenario sessions
- Each scenario session runs the demo file first via `mcp__playwright__run_demo()` as a pre-step (scaffolds app state), then the feedback agent explores from the paused state
- Demo coverage check: GUI personas with zero enabled scenarios are flagged in the feedback orchestrator log

**Product-manager responsibilities:**
- Defines scenario records (DB entries) with detailed descriptions
- Creates CODE-REVIEWER tasks for `*.demo.ts` file implementation
- Ensures every GUI persona has 2-4 demo scenarios covering key product flows

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
- `mcp-proxy.anthropic.com` — MCP proxy endpoint

**What passes through** (transparent CONNECT tunnel):
- `platform.claude.com` — OAuth refresh
- Everything else

**429 retry**: On quota exhaustion response, marks the current key as exhausted, calls `selectActiveKey()` to pick the next available key, and retries the request (max 2 retries). If no keys are available, returns the original 429 to the client.

**401 retry**: On auth failure response (not a quota issue), retries once with a fresh state read — allows picking up a key that was rotated between the proxy's token resolution and the upstream response. Does not call `rotateOnExhaustion`; fires `auth_retry_on_401` log event.

**Tombstone-aware routing** (`forwardRequest`): When the incoming request carries a token known to rotation state, the proxy inspects its entry:
- `status: 'tombstone'` — pruned dead token; swap with the active key and forward (prevents "OAuth token revoked" errors from stale sessions sending tombstoned credentials)
- No entry at all — genuinely unknown token (fresh login not yet registered); pass through unchanged and trigger async `syncKeys()` to register it (preserves fresh login flow)
- Any other status — normal swap path (inject active key's token)

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
2. Strips the `# BEGIN GENTYR PROXY` / `# END GENTYR PROXY` block from `~/.zshrc`/`~/.bashrc`
3. Writes `~/.claude/proxy-disabled.json` with `{ disabled: true }` — read by all spawn helpers

**State file**: `~/.claude/proxy-disabled.json` (global, not per-project — one proxy serves all projects).

**Spawn helper integration**: `isProxyDisabled()` from `.claude/hooks/lib/proxy-state.js` is checked by `buildSpawnEnv()` in `hourly-automation.js`, `urgent-task-spawner.js`, `task-gate-spawner.js`, and `session-reviver.js`. When disabled, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS` are omitted from spawned agent environments — agents connect directly to `api.anthropic.com`.

**Default**: Enabled. Missing state file = proxy enabled. `npx gentyr init` does not create this file.

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

## MCP Server Startup Behavior

### Infrastructure Servers — Lazy Credential Validation

Infrastructure MCP servers (`github`, `cloudflare`, `codecov`, `resend`, `supabase`) use lazy credential validation. Credentials are NOT checked at module load time. Instead, each server starts, connects to Claude Code, and exposes its tools normally regardless of whether credentials are configured. When a tool is invoked without the required credential, the fetch helper inside the handler throws an `Error` with a descriptive message (G001: fail-closed at invocation time). This pattern mirrors the existing `render` server and ensures all 29 project MCP servers appear in `claude mcp list` even in partially-configured environments.

**Required env vars per server:**
- `github` — `GITHUB_TOKEN`
- `cloudflare` — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`
- `codecov` — `CODECOV_TOKEN`
- `resend` — `RESEND_API_KEY`
- `supabase` — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

### Feedback Servers — Graceful Startup

Feedback MCP servers (`feedback-reporter`, `playwright-feedback`, `programmatic-feedback`) use empty-string fallbacks for optional environment variables (`FEEDBACK_PERSONA_NAME`, `FEEDBACK_SESSION_ID`) instead of exiting at startup. This allows them to start in base interactive sessions and non-feedback agent contexts without error. The `AuditedMcpServer` class likewise treats a missing `FEEDBACK_SESSION_ID` as a no-op: audit logging is skipped (all `recordAudit` and `recordAuditError` calls return early when `sessionId` is falsy) rather than throwing. Tools remain fully functional; only the audit trail is absent.

### Root Package Runtime Dependencies

The root `package.json` `dependencies` field includes MCP server runtime deps (`@elastic/elasticsearch`, `@modelcontextprotocol/sdk`, `playwright`, `potrace`, `sharp`, `simple-icons`, `svg-path-bbox`, `svgo`, `tweetnacl`) alongside the shared deps (`better-sqlite3`, `zod`, `ajv`, `ajv-formats`). This is required for npm-published installs where `packages/mcp-servers/node_modules/` is not included in the npm tarball — Node.js module resolution falls back to the root `node_modules/` to find these packages.

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

See `packages/mcp-servers/src/secret-sync/README.md` for full documentation.

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

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports a `--mock` flag for development and README generation. The `packages/cto-dashboard/src/mock-data.ts` module provides deterministic fixture data (waypoint-interpolated usage curves, realistic triage reports, deployment history) that renders without requiring live MCP connections.

**`--page` flag** splits rendering to avoid Bash tool output truncation on large deployments (e.g., 68 worktrees):
- `--page 1` (Intelligence): Header, Quota + Status, Accounts, Deputy-CTO, Usage Trends, Usage Trajectory, Automations
- `--page 2` (Operations): Testing, Deployments, Worktrees, Infra, Logging
- `--page 3` (Analytics): Feedback Personas, PM, Worklog, Timeline, Metrics Summary
- No `--page` argument renders all sections (backwards compatible; used by `generate-readme.js`)

The `/cto-report` slash command runs all three pages sequentially. Data fetching is optimized per page — sections not rendered on the active page skip their I/O readers in `index.tsx`.

The **ACCOUNT OVERVIEW** section displays a curated EVENT HISTORY (last 24h, capped at 20 entries). Only 7 event types pass the `ALLOWED_EVENTS` whitelist in `account-overview-reader.ts`:
- `key_added` — new account registered (token-refresh re-additions filtered as noise)
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
