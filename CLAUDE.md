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
| Critical hook files (pre-commit-review.js, bypass-approval-hook.js, etc.) | root:wheel | 644 | Prevents agent modification |
| `.claude/hooks/` directory | user:staff | 755 | Git needs write access for checkout/merge/stash (was root-owned, caused cross-repo side effects) |
| `.claude/` directory (target projects only) | root:wheel | 1755 | Prevents hooks symlink replacement; excluded in framework repo (MCP servers need runtime file creation) |
| `.husky/` directory | root:wheel | 1755 | Prevents deletion of the pre-commit entry point |

**Tamper detection** closes the unlink+recreate gap left by not root-owning `.claude/hooks/`:
- **Commit-time check** (`husky/pre-commit`): Before each commit, verifies 8 critical hook files are still root-owned via `stat`. Blocks commit if any are not owned by root. The pre-commit script itself lives in a root-owned `.husky/` directory, making it trustworthy.
- **SessionStart check** (`gentyr-sync.js` `tamperCheck()`): At every interactive session start, reads `protection-state.json` and checks `criticalHooks` array ownership via `fs.statSync().uid`. Emits a `systemMessage` warning if tampering is detected.
- `protection-state.json` records `criticalHooks` as an array so both checks read the same source of truth dynamically.

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

After committing, the agent:
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

The SessionStart hook also attempts auto-rebuild if `src/` is newer than `dist/`, but always build explicitly after TS changes to ensure correctness.

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

## AI User Feedback System

Configure user personas to automatically test your app when staging changes are detected:

```bash
# In a Claude Code session after GENTYR is installed:
/configure-personas
```

Creates personas (GUI/CLI/API/SDK modes), registers features with file patterns, and maps personas to features. Feedback agents spawn on staging changes and report findings to deputy-CTO triage pipeline.

## Product Manager MCP Server

The product-manager MCP server (`packages/mcp-servers/src/product-manager/`) manages a 6-section product-market-fit (PMF) analysis pipeline. State is persisted in `.claude/state/product-manager.db`.

**Access via `/product-manager` slash command** (prefetches current status from the database before display).

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

**Markdown output**: Every write operation regenerates `.claude/product-market-fit.md` with all section content.

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

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by API quota limits.

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
- `pruneDeadKeys` immediately garbage-collects keys with `status: 'invalid'`; fires an `account_auth_failed` rotation log event only when an account loses its last viable key; email resolution order: key-level `account_email` → sibling key with same `account_uuid` → rotation_log history for same `key_id`; fires `account_auth_failed` only once per account (checks remaining non-pruned keys with same email to avoid duplicates); preserved in rotation_log even after the key entry is deleted; never prunes the active key; removes orphaned rotation_log entries for other event types; called automatically at the end of every `syncKeys()` run

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
- When version or config hash mismatch detected: re-merges `settings.json`, regenerates `.mcp.json` (preserving OP token), updates the GENTYR section of `CLAUDE.md`, and symlinks new agent definitions
- Auto-rebuilds MCP servers when `src/` mtime > `dist/` mtime (30s timeout); logs to stderr on failure (silent to agent)
- Syncs husky hooks by comparing `husky/` against `.husky/` in the target project; re-copies if content differs
- Falls back to legacy settings.json hook diff check when no `gentyr-state.json` exists (pre-migration projects)
- Supports both npm model (`node_modules/gentyr`) and legacy symlink model (`.claude-framework`)
- **`tamperCheck()`**: Runs before sync logic. Reads `protection-state.json`; if `protected: true`, verifies each filename in `criticalHooks` array is still root-owned (`stat.uid === 0`). Emits a `systemMessage` warning if any hook is not root-owned. Resolves the hooks directory via symlink the same way `protect.js` does.
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; version 3.0

**Branch Drift Check Hook** (`.claude/hooks/branch-drift-check.js`):
- Runs at `UserPromptSubmit` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Detects when the main working tree is not on `main` and emits a warning via both `systemMessage` (terminal) and `additionalContext` (AI model context)
- Uses `getCooldown('branch_drift_check', 30)` (30-minute default, configurable); cooldown resets immediately if the branch changes
- State file: `.claude/state/branch-drift-state.json` with `{ lastCheck, lastBranch }`
- Skips worktrees (`.git` file check), detached HEAD, and spawned sessions; warn-only — never auto-restores
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `UserPromptSubmit`
- Tests at `.claude/hooks/__tests__/gentyr-sync-branch-drift.test.js` (14 tests, runs via `node --test`)

**Credential Health Check Hook** (`.claude/hooks/credential-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions
- Validates vault mappings against required keys in `protected-actions.json`
- Checks `.mcp.json` env blocks for keys injected directly (e.g. `OP_SERVICE_ACCOUNT_TOKEN`), which count as configured even if absent from vault-mappings
- **OP token desync detection**: Compares shell `OP_SERVICE_ACCOUNT_TOKEN` against `.mcp.json` value; if they differ, emits a warning and overwrites `process.env` with the `.mcp.json` value (source of truth); `.mcp.json` is always authoritative because it is updated by reinstall
- Auto-propagates to target projects via `.claude/hooks/` directory symlink
- Shell sync validation also available via `scripts/setup-validate.js` `validateShellSync()` function, which checks the `# BEGIN GENTYR OP` / `# END GENTYR OP` block in `~/.zshrc` or `~/.bashrc`

**Playwright CLI Guard Hook** (`.claude/hooks/playwright-cli-guard.js`):
- Runs at `PreToolUse` for Bash tool calls only; non-blocking (emits `systemMessage` warning, never blocks execution)
- Detects CLI-based Playwright invocations (`npx playwright test`, `pnpm test:e2e`, `pnpm test:pw`, and equivalents for npm/yarn)
- Warns agent to use MCP tools instead (`mcp__playwright__run_tests`, `mcp__playwright__launch_ui_mode`, etc.)
- Rationale: CLI invocations bypass the Playwright MCP server's 1Password credential injection, causing tests to fail or skip silently without proper environment variables
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `PreToolUse > Bash`
- Tests at `.claude/hooks/__tests__/playwright-cli-guard.test.js` (23 tests, runs via `node --test`)

**Playwright Health Check Hook** (`.claude/hooks/playwright-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions (`CLAUDE_SPAWNED_SESSION=true`)
- Fast-path exit when no `playwright.config.ts` or `playwright.config.js` exists in the project root (target projects that don't use Playwright are unaffected)
- Writes `.claude/playwright-health.json` with auth state freshness, cookie expiry, and extension build status
- `authState` fields: `exists`, `ageHours`, `cookiesExpired`, `isStale` (true when cookies expired or age >24h)
- `extensionBuilt` checks for the directory specified by `GENTYR_EXTENSION_DIST_PATH` env var (relative to project root); defaults to `true` (no blocker) when unset
- `needsRepair: true` when `authState.isStale || !extensionBuilt`
- Emits a visible stderr warning when auth state is stale; read by `slash-command-prefetch.js` as a 1-hour cache (avoids re-reading `.auth/*.json` on every `/demo` invocation)
- Auto-propagates to target projects via `.claude/hooks/` directory symlink; registered in `settings.json.template` under `SessionStart` (timeout: 5)
- Tests at `.claude/hooks/__tests__/playwright-health-check.test.js` (7 tests, runs via `node --test`)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos in linked target projects.

**Available Tools:**
- `launch_ui_mode` — Launch Playwright in interactive UI mode for a given project (persona)
- `run_tests` — Run headless E2E tests with optional project/grep/retries/workers filters
- `seed_data` — Seed test data via the `seed` Playwright project
- `cleanup_data` — Remove test data via the `cleanup` Playwright project
- `get_report` — Retrieve the last Playwright HTML report path and metadata
- `get_coverage_status` — Report test count and coverage status per persona project
- `preflight_check` — Validate environment readiness before launching; runs 8 checks: config exists, dependencies, browsers installed, test files, credentials valid, dev server reachable, compilation, and auth state freshness
- `run_auth_setup` — Refresh Playwright auth state by running `seed` then `auth-setup` projects; generates `.auth/vendor-owner.json`, `.auth/vendor-admin.json`, `.auth/vendor-dev.json`, `.auth/vendor-viewer.json`; 4-minute timeout; supports `seed_only` flag to skip auth-setup
- `list_extension_tabs` — List open tabs in a CDP-connected extension test browser
- `screenshot_extension_tab` — Screenshot a specific extension tab via CDP

**Auth state check in `preflight_check` (check #8)**:
- Only runs when a `project` argument is provided
- Reads `.auth/vendor-owner.json` age and cookie expiry
- Fails if file is missing, cookies are expired, or file is >24h old
- Warns if file is 4–24h old
- Recovery step: call `mcp__playwright__run_auth_setup()` to refresh

**`run_auth_setup` self-healing flow**:
- Phase 1: runs `npx playwright test --project=seed` (5-min timeout)
- Phase 2: runs `npx playwright test --project=auth-setup` (4-min timeout) — skipped if `seed_only: true`
- Returns structured `RunAuthSetupResult` with per-phase success, `auth_files_refreshed` list, and `output_summary`
- Deputy-CTO agent has `mcp__playwright__run_auth_setup` in `allowedTools` and is responsible for executing it when assigned an `auth_state` repair task from `/demo`

**`/demo` command escalation flow** (`.claude/commands/demo.md`):
- Replaces the old "stop on failure" gate with an "escalate all failures" pattern
- When `preflight_check` returns `ready: false`, `/demo` creates a single urgent DEPUTY-CTO task describing every failed check with per-check repair instructions
- Repair mapping: `config_exists` → CODE-REVIEWER; `dependencies_installed`/`browsers_installed` → direct Bash fix; `test_files_exist` → TEST-WRITER; `credentials_valid` → INVESTIGATOR & PLANNER; `auth_state` → `run_auth_setup()` then INVESTIGATOR & PLANNER on failure
- The `demo` agent identity is included in `SECTION_CREATOR_RESTRICTIONS` for DEPUTY-CTO (allows `mcp__todo-db__create_task` with `assigned_by: "demo"`)
- `slash-command-prefetch.js` reads the cached `playwright-health.json` (1-hour TTL) written by the SessionStart hook, falling back to manual `.auth/vendor-owner.json` inspection on cache miss

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

**Logging**: Structured JSON lines to `~/.claude/rotation-proxy.log` (max 1MB with rotation). Logs token swaps (key ID only, never token values), 429 retries, and errors for debugging.

**Health endpoint**: `GET http://localhost:18080/__health` returns JSON status with active key ID, uptime, and request count.

**Lifecycle**: Runs as a launchd KeepAlive service (`com.local.gentyr-rotation-proxy`). Auto-restarts on crash. Starts before the automation service.

**CONNECT head buffer handling**: The CONNECT handler's `head` parameter (early client data — typically the TLS ClientHello — sent before the 200 response arrives) is pushed back into the socket's readable stream with `clientSocket.unshift(head)` before wrapping in TLSSocket. Omitting this caused intermittent ECONNRESET errors because the TLS handshake began with incomplete data. This is the textbook fix for Node.js HTTPS MITM proxies.

**Complements existing rotation**: The proxy handles immediate token swap at the network level. Quota-monitor still handles usage detection and key selection. Key-sync still handles token refresh and Keychain writes.

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

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports a `--mock` flag for development and README generation. The `packages/cto-dashboard/src/mock-data.ts` module provides deterministic fixture data (waypoint-interpolated usage curves, realistic triage reports, deployment history) that renders without requiring live MCP connections.

**`--page` flag** splits rendering to avoid Bash tool output truncation on large deployments (e.g., 68 worktrees):
- `--page 1` (Intelligence): Header, Quota + Status, Accounts, Deputy-CTO, Usage Trends, Usage Trajectory, Automations
- `--page 2` (Operations): Testing, Deployments, Worktrees, Infra, Logging
- `--page 3` (Analytics): Feedback Personas, PM, Worklog, Timeline, Metrics Summary
- No `--page` argument renders all sections (backwards compatible; used by `generate-readme.js`)

The `/cto-report` slash command runs all three pages sequentially. Data fetching is optimized per page — sections not rendered on the active page skip their I/O readers in `index.tsx`.

The **ACCOUNT OVERVIEW** section displays a curated EVENT HISTORY (last 24h, capped at 20 entries). Only 6 event types pass the `ALLOWED_EVENTS` whitelist in `account-overview-reader.ts`:
- `key_added` — new account registered (token-refresh re-additions filtered as noise)
- `key_switched` — active account changed by rotation logic
- `key_exhausted` — account reached 100% quota in any bucket
- `account_nearly_depleted` — active account hit 95% (5-hour per-key cooldown; fired by quota-monitor)
- `account_quota_refreshed` — previously exhausted account dropped below 100% (fired by quota-monitor and api-key-watcher)
- `account_auth_failed` — account lost its last key to invalid_grant pruning (fired by pruneDeadKeys in key-sync)

Event descriptions resolve account identity via entry-level `account_email` → key-level `account_email` → rotation_log history lookup (email captured in earlier events for the same key_id) → truncated key ID fallback. Consecutive identical events (same type + description) are deduplicated after sorting so a burst of duplicate `account_auth_failed` entries collapses to one. Events are colored in the dashboard: `key_switched`/`account_quota_refreshed` cyan/green, `key_exhausted`/`account_auth_failed` red, `account_nearly_depleted` yellow.

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
