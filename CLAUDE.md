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

Rebuilds MCP servers, re-merges settings.json, regenerates .mcp.json, and deploys staged hooks. Also runs automatically on `SessionStart` when framework version or config hash changes. At every SessionStart, the hook also checks `~/.claude/settings.json` for stale hook file references (hook entries whose referenced file no longer exists on disk) and emits an escalated warning to run `npx gentyr sync` immediately. `npx gentyr sync` itself removes stale hook entries from `~/.claude/settings.json` as part of its cleanup pass. **Step 6c — branch protection check**: `npx gentyr sync` checks whether GitHub branch protection (required status checks) is configured on `preview`, `staging`, and `main` via the GitHub API. If any branch is missing protection, a yellow warning is printed with the command to run `scripts/setup-branch-protection.js`. This is advisory — sync succeeds even if protection is absent. **Session recycling** (Step 10): After all config steps complete, `npx gentyr sync` enumerates all `running`/`spawning` sessions in the queue (excluding `gate` and `audit` lanes), sends SIGTERM→SIGKILL to each, marks the old queue item `failed`, resets linked TODO tasks to `pending`, releases shared resources, and immediately re-enqueues each session at `urgent` priority via `enqueueSession()` with `source: 'sync-recycle'`. Resume-capable sessions are re-spawned with `--resume` — the session UUID is stored on the queue item at spawn time (`resume_session_id` column, backfilled by `reapSyncPass()` for sessions that missed it). Sessions with no discoverable JSONL are skipped with a warning rather than spawned fresh, preventing accumulated context loss. A 30-second poll verifies each revived session has a live PID. **Phase 2b — MCP daemon restart**: Between killing sessions and re-enqueuing them, `npx gentyr sync` always restarts the shared MCP daemon to pick up new code and credentials after the rebuild. It kills the stale PID (from state file) and any process holding port 18090, then restarts via `launchctl bootstrap` (macOS) or `systemctl --user restart` (Linux), and polls for recovery up to 15 seconds. Reports green (healthy), yellow (restart attempted), or red (failed to recover). Non-fatal — sync succeeds even if daemon restart fails. Worktree paths that no longer exist are skipped during session re-enqueue (sessions are re-spawned without a worktree context instead of crashing with ENOENT). **Re-protect before recycle**: `npx gentyr sync` re-enables protection (re-protect) BEFORE session recycling, not after. Session recycling spawns 10+ processes taking 30-60s, which expired the sudo credential cache and corrupted terminal stdin when re-protect ran afterward. **Project-local MCP server preservation**: Both `npx gentyr sync` and the SessionStart auto-regeneration preserve any MCP servers the target project added to `.mcp.json` that are not part of the gentyr template. Gentyr-owned names always win on collision; dynamically-injected servers (`plugin-manager`, `plugin-*`) are excluded from the preserved set. This is implemented via `extractProjectServers()` and `mergeProjectServers()` in `lib/shared-mcp-config.js`.

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

Root-owned critical hook files prevent agent modification. Tamper detection uses symlink target verification and file ownership checks at both commit-time and session-start. `protection-state.json` records the critical hooks list.

> Full details: [Protection Security Model](docs/CLAUDE-REFERENCE.md#protection-security-model)

### Local Prototyping Mode

```bash
npx gentyr init --local              # Install without remote servers
npx gentyr status                    # Shows "Local mode: enabled"
```

Excludes all 10 remote MCP servers (`github`, `cloudflare`, `supabase`, `vercel`, `render`, `codecov`, `resend`, `elastic-logs`, `onepassword`, `secret-sync`) from `.mcp.json`. **1Password is completely unnecessary in local mode.** All 24 local servers (todo-db, agent-tracker, playwright, plans, persistent tasks, etc.) remain fully functional.

**Two-layer design:** Layer 1 (MCP servers in `.mcp.json`) requires `npx gentyr sync` + session restart after toggling. Layer 2 (automation behavior, credential checks, agent prompts) takes effect immediately.

**Toggle at runtime:** `/local-mode` slash command or `set_local_mode` MCP tool on agent-tracker. Enabling is unrestricted. Disabling requires CTO authorization via `record_cto_decision` (Unified CTO Authorization System).

**What's skipped in local mode:**
- Credential health check (no 1Password warnings)
- Health monitors (staging/production), promotion pipelines, demo validation with OP secrets, feedback spawning
- Remote MCP tool references stripped from agent prompts and CLAUDE.md.gentyr-section
- Dashboard remote panels show "Disabled — local mode active" instead of empty data

**What keeps running:** Session reviver/reaper, worktree cleanup, task runner, lint checker, antipattern hunter, triage, merge chain (falls back to feature -> main when `origin/preview` doesn't exist).

**Unavailable in local mode:** `/push-secrets`, `/push-migrations`, `/hotfix`, `secret-manager` agent.

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

## Mandatory Git Workflow (GENTYR Source Repo)

> This applies to the gentyr source repo ONLY. Target projects follow
> the 4-stage merge chain described in CLAUDE.md.gentyr-section.

### Rules (NON-NEGOTIABLE)

1. **ALL changes on feature branches in worktrees.** Never commit to `main` directly.
   Use `isolation: "worktree"` for all code-modifying sub-agents.

2. **PRs target `main` directly.** No `preview` or `staging` branches in this repo.

3. **Self-merge after CI passes.** After `gh pr create`, the project-manager waits
   for CI (`gh pr checks --watch --fail-on-fail`), then runs
   `gh pr merge --squash --delete-branch` in the same session. No waiting for review.
   **CI Fix Loop**: If CI fails, the project-manager autonomously iterates — fixes the
   failure, pushes, and re-checks — up to 5 times. Only escalates with "I'm stuck" after
   exhausting all attempts. Agents MUST NOT ask the CTO to approve a PR with failing CI.

4. **Clean up immediately.** After merge: delete local branch, remove worktree.
   Feature branches must not exist for more than a few hours.

5. **Sub-agents are different from target projects.** The agents in `.claude/agents/`
   are gentyr-specific. Target projects get different agents from the `agents/` directory.

## Merge Chain and Agent Git Workflow (Target Projects Only)

> **Gentyr source repo vs target projects**: The 4-stage merge chain below applies
> to **target projects** that install gentyr. The gentyr repo uses `feature -> main`
> with immediate self-merge — see "Mandatory Git Workflow" above.

In target projects, GENTYR enforces a 4-stage merge chain: `feature/* -> preview -> staging -> main`. Direct commits to `main`, `staging`, and `preview` are blocked at multiple layers: the git wrapper (`git-wrappers/git`, Layer 1 — blocks `git add`/`git commit` on protected non-base branches for all sessions), the `main-tree-commit-guard.js` PreToolUse hook (Layer 1 all-sessions block + Layer 2 spawned-agent block), the `branch-checkout-guard.js` PreToolUse hook (blocks branch switching in the main tree), and pre-commit/pre-push husky hooks. Only promotion pipeline agents (`GENTYR_PROMOTION_PIPELINE=true`) may operate on protected branches.

### Feature Branch Commit Flow (Self-Merge)

Agents work on feature branches (`feature/*`, `fix/*`, `refactor/*`, `docs/*`, `chore/*`). At commit time, only lint and security checks run — no deputy-CTO review gate. This keeps commit latency low.

**Branch Age Guard** (`pre-commit-review.js`): Blocks commits on feature branches when the last branch-specific commit is older than the configured limit (default 4 hours). Measures from the most recent commit on the branch (not the merge-base) to avoid deadlocks on interrupted sessions. First commits on a branch are always allowed (no commits to measure against). Merge resolution commits (`MERGE_HEAD` present) are exempt from the age check. The limit is configurable via `branch_age_limit_hours` in `.claude/state/automation-config.json`. Non-fatal: if branch age cannot be determined, the commit is allowed.

After committing, the project-manager agent:
1. Pushes the branch: `git push -u origin HEAD`
2. Creates a PR to the appropriate base branch (`preview` in target projects, `main` in the gentyr repo): `gh pr create --base <base> --head <branch> --title "..."`
3. **Waits for CI**: `gh pr checks <number> --watch --fail-on-fail`
4. **If CI fails**: Diagnoses and fixes the failure, pushes again, and re-runs `gh pr checks`. Repeats up to 5 times. Escalates with "I'm stuck" only after all attempts are exhausted. Never asks the CTO to approve a failing PR.
5. **Self-merges**: `gh pr merge <number> --squash --delete-branch`
6. Syncs the base branch, deletes the local feature branch, and runs `git worktree remove --force` + `git worktree prune` to remove the worktree. Session is NOT complete until worktree is removed.

Code review happens at promotion time (preview -> staging), not at the feature branch level.

### Test Scope Profiles

Test scope profiles let teams gate pushes on a vertical slice of tests rather than the full suite. This is useful when an active feature area has known failing tests outside its scope that should not block development on other verticals.

**Configuration**: Two fields in `ServicesConfigSchema` (`services.json`) control scope gating:
- `testScopes` — named map of `TestScope` objects. Each scope defines: `unitTestPattern` (regex applied to test file paths), `scopedUnitCommand`/`scopedIntegrationCommand` (explicit command overrides), plus reserved-future fields `e2eTestPattern`, `e2eDemoPath`, `additionalPatterns`, and `gatingBehavior`.
- `activeTestScope` — name of the currently active scope (or `null` for full-suite gating, the default).

**`GENTYR_TEST_SCOPE` env var** overrides `activeTestScope` from config. Useful for CI or temporary overrides without modifying `services.json`.

**Pre-push hook behavior** (`husky/pre-push`): When a scope is active, the full unit + integration suite still runs on every push. If the full suite passes, the push proceeds normally. If the full suite has failures, the hook invokes `lib/test-scope-classifier.js` to re-run only the scoped subset:
- Scoped tests fail → push is **blocked** (exit 1)
- Scoped tests pass, non-scoped tests fail → push is **allowed with a warning** (exit 0)
- Scope config missing or unresolvable → **fail-closed** (push blocked)

The original non-scoped path (full suite failures always block) is preserved verbatim when no scope is active.

**Key modules**:
- `lib/test-scope.js` — shared ES module: `getActiveTestScope()`, `getTestScopeConfig()`, `buildScopedCommand()`, `formatPushSummary()`. Shell metacharacter sanitization in `buildScopedCommand()` prevents injection via `unitTestPattern` values in `services.json`.
- `lib/test-scope-classifier.js` — Node CLI called from `pre-push` on failures. Resolves scope config, re-runs scoped tests, prints a formatted summary, exits 0 or 1. Fail-closed when scope config is absent or malformed.

**Promotion pipeline awareness**: `hourly-automation.js` injects scope context into hotfix promotion agent prompts via `getTestScopePromptContext()`. When a scope is active, promotion agents are instructed that only scoped test failures are blocking; non-scoped failures are informational.

**Session briefing**: Both interactive (deputy-CTO) and spawned-agent briefings in `session-briefing.js` display the active scope name and description when `activeTestScope` is set.

**Schema validation**: `TestScopeSchema` and `TestScopeGatingSchema` in `packages/mcp-servers/src/secret-sync/types.ts` validate scope objects. The `e2eTestPattern`, `e2eDemoPath`, `additionalPatterns`, and `gatingBehavior` fields are schema-defined but marked "reserved for future promotion pipeline use" — the pre-push hook does not consume them yet.

**Tests**: 23 unit tests in `.claude/hooks/__tests__/test-scope.test.js` cover all four exported functions. 19 structural tests in `.claude/hooks/__tests__/test-scope-classifier.test.js` cover the classifier CLI and pre-push integration.

Read and write `testScopes` and `activeTestScope` via the `get_services_config` / `update_services_config` tools on the `secret-sync` MCP server.

### 100% Test Coverage Gate (Production Promotion)

Production promotion to staging and main is hard-gated on 100% test coverage (lines, statements, functions, branches). This is non-negotiable.

**CI template** (`templates/github/workflows/ci.yml.template`): Includes a `test:coverage:check` step that fails the build when any coverage metric falls below 100%. Target projects that run `npx gentyr sync` receive this step automatically.

**Preview-promoter self-healing loop**: When the `test:coverage:check` CI step fails during promotion, the `preview-promoter` agent does NOT escalate immediately. Instead it spawns `test-writer` sub-agents for the uncovered code, waits for them to complete, re-runs the full CI pipeline, and repeats — up to 3 iterations. Only after all 3 iterations fail does the promoter escalate to the CTO. This is fully autonomous; no CTO intervention is needed for coverage gaps.

**Plan-manager gate**: Before advancing a plan to the CTO sign-off phase, the `plan-manager` agent verifies CI is green and all coverage checks pass. A failing CI check blocks phase advancement regardless of other task completions.

**test-writer mandate**: The `test-writer` agent treats 100% coverage as non-negotiable. When writing or updating tests, it must ensure every new line of code has corresponding test coverage. The test-writer is the designated recipient of coverage fix tasks spawned by the preview-promoter's self-healing loop.

### Deputy-CTO Triage (Two-Tier)

The deputy-CTO triages agent reports through two separate queues:

**Preview tier** (`GENTYR_REPORT_TIER=preview`): Reports from agents on preview-based worktrees. The deputy-CTO CANNOT escalate to the CTO — must either dismiss, create a task, persistent task, or plan. No merge chain gating.

**Staging tier** (`GENTYR_REPORT_TIER=staging`): Reports from staging reactive reviewers and release review sessions. The deputy-CTO CAN escalate to the CTO. Reports do NOT block production promotion.

Tier enforcement is server-side in the `agent-reports` MCP server — `completeTriage()` and `markTriaged()` reject `escalated` when `GENTYR_REPORT_TIER=preview`. The `get_reports_for_triage` tool accepts a `tier` parameter for server-side filtering.

**Triage automation**: The `triage_check` block in `hourly-automation.js` queries each tier separately and spawns `spawnPreviewTriage()`, `spawnStagingTriage()`, or `spawnReportTriage()` (legacy null-tier) accordingly.

**`pr-reviewer` and `system-followup` are approved `assigned_by` values** for the `Triage & Delegation` category's `creator_restrictions` (stored in `task_categories` in `todo.db`). `system-followup` is used by investigation follow-up tasks that call back into the deputy-cto triage pipeline after investigation completes. The legacy `SECTION_CREATOR_RESTRICTIONS` constant in `packages/mcp-servers/src/shared/constants.ts` is deprecated — creator restrictions are now defined per-category in `task_categories`.

### Worktrees

Concurrent agents work in isolated git worktrees at `.claude/worktrees/<branch>/`. Each worktree is provisioned with symlinked GENTYR config (hooks, agents, commands) and a worktree-specific `.mcp.json` with absolute `CLAUDE_PROJECT_DIR` paths. `PROJECT_DIR` is normalized via `path.resolve()` to prevent trailing-slash mismatches in path operations. When `createWorktree()` detects an existing worktree, it performs a symlink health check on `.claude/settings.json` before reusing it — if the symlink is broken (e.g., after `npx gentyr sync` rebuilt `.claude/`), the worktree is re-provisioned instead of returned as-is. Worktrees for merged branches are cleaned up every **5 minutes** by the hourly automation (`getCooldown('worktree_cleanup', 5)`). The project-manager is responsible for cleaning up worktrees immediately after self-merge; the 5-minute automation is a safety net for missed cleanups.

**Worktree freshness system**: Multi-layer defense ensuring worktrees stay current with the base branch. Layer 0: `scripts/preview-watcher.js` daemon (launchd KeepAlive) polls every 30s, auto-merges clean worktrees, broadcasts signals, and calls `syncWorktreeDeps()` after each merge to re-install dependencies if the lockfile changed. Layer 1: `worktree-freshness-check.js` PostToolUse hook nags agents every 2 minutes if stale. Layer 2: `plan-merge-tracker.js` broadcasts on PR merge. Layer 3: `run_demo` hard gate auto-syncs or blocks stale demos. Layer 4: `session-briefing.js` reports freshness at session start. Layer 5: `createWorktree()` verifies freshness after fetch. All layers use `git merge origin/{baseBranch} --no-edit` (not rebase) because merge commits are exempt from the branch age guard. `syncWorktreeDeps()` hashes the lockfile after install and re-installs + rebuilds only when the hash changes, preventing redundant installs. Agents in worktrees should never need to run `pnpm install` manually.

**Abandoned worktree rescue**: `rescueAbandonedWorktrees()` in `hourly-automation.js` detects worktrees that have uncommitted changes but no active agent process, then spawns a project-manager to commit, push, and merge the orphaned work. Runs every **15 minutes** (`getCooldown('abandoned_worktree_rescue', 15)`). **Fail-closed + session-queue cross-check** (PR #475): before calling `lsof +D`, pre-loads active session paths from `session-queue.db` (`running/queued/spawning/suspended`) and skips any worktree that matches; `lsof` errors/timeouts now set `inUse = true` (skip rescue) instead of proceeding as if no processes exist — preventing the bug where `ETIMEDOUT` was treated as "safe to rescue". **Pre-enqueue dedup + rescue prompt hardening** (PR #478): before spawning a rescue agent, checks `session-queue.db` for any already-queued/running session targeting the same worktree path and skips the spawn if one exists; rescue prompt explicitly instructs the project-manager agent not to remove the worktree ("Do NOT remove the worktree — the cleanup automation handles removal after merge").

**Stale worktree reaper**: `reapStaleWorktrees()` in `hourly-automation.js` removes worktrees older than 4 hours with no uncommitted changes. Runs every **20 minutes** (`getCooldown('stale_worktree_reaper', 20)`). Dirty worktrees are skipped (rescue handles those). **Skip guard + session-queue cross-check + fail-closed lsof** (PR #475): pre-loads active session paths from `session-queue.db` and skips any matching worktree; then runs `lsof +D` as a secondary check — if any processes are detected the worktree is **skipped** (not killed). `lsof` errors/timeouts are treated as fail-closed: skip the worktree rather than proceeding. Previously, active processes were killed by `removeWorktree()` with no pre-check, and `lsof` errors were silently treated as "no processes". Calls `removeWorktree(branch, { force: true })` (PR #478) to bypass the `removeWorktree()` session-queue guard, since safety was already verified by the pre-checks above.

**Reactive worktree cleanup**: `reapSyncPass()` in `session-reaper.js` automatically cleans up worktrees when it detects a dead agent PID. If the worktree has no uncommitted changes, `removeWorktree()` is called immediately (seconds, not minutes). Dirty worktrees are left for `rescueAbandonedWorktrees()`. **Surviving child process check** (PR #475): before removing a clean worktree, `reapSyncPass()` now runs `lsof +D` to detect Playwright demos, dev servers, or other processes spawned with `detached: true` that outlived the dead agent. If any processes are found, the worktree is left intact; `lsof` errors/timeouts are treated fail-closed (skip removal). Calls `removeWorktree(branch, { force: true })` (PR #478) since the session is confirmed dead before this point.

**Worktree cleanup gate**: `worktree-cleanup-gate.js` PostToolUse hook fires on `summarize_work` and reminds agents to remove their worktree before completing. Detects worktree context via CWD path pattern (not env var) since hooks inherit the Claude process environment, not the MCP server environment.

**Worktree env var injection**: `spawnQueueItem()` in `session-queue.js` injects `CLAUDE_WORKTREE_DIR` into the spawned agent's environment when `worktree_path` is set, and `CLAUDE_QUEUE_ID` (PR #478) into all spawned sessions. `CLAUDE_QUEUE_ID` allows hooks (e.g., `worktree-remove-guard.js`) to identify which queue entry owns the current session, enabling self-cleanup vs. other-session detection. `CLAUDE_WORKTREE_DIR` and `CLAUDE_QUEUE_ID` are available to all hooks (PostToolUse, PreToolUse, Stop) via `process.env`. Hooks should also include a CWD-based fallback (`process.cwd().match(/\.claude\/worktrees\//)`) for robustness.

**Process group cleanup** (`lib/process-tree.js`): Shared module with three exports — `killProcessGroup(pid, signal)` (synchronous, sends signal to `-pid` process group with EPERM fallback to lead PID), `killProcessGroupEscalated(pid)` (async SIGTERM→SIGKILL with 5s wait), and `killProcessesInDirectory(dirPath)` (uses `lsof +D` to find all PIDs with open files in a directory, deduplicates by process group, kills each group). Used by `removeWorktree()` and `reapOrphanProcesses()` to ensure child processes (esbuild, vitest, dev servers) spawned with `detached: true` are fully terminated.

**Active session protection**: `cleanupMergedWorktrees()` in `worktree-manager.js` checks `isWorktreeInUse()` (`lsof +D`) before removing merged worktrees to protect live sessions from CWD eviction, and also cross-checks `session-queue.db` for any `running/queued/spawning/suspended` sessions using the worktree path (PR #475 extended this from `suspended`-only to all active statuses). `isWorktreeInUse()` is **fail-closed** (PR #475): it returns `true` (assume in use) on any `lsof` error or timeout — only returns `false` when `lsof` exits with code 1 and empty stdout (confirmed no processes). Previously it returned `false` on any error (fail-open). `removeWorktree()` (called by stale reaper path and reactive cleanup) uses `killProcessesInDirectory()` to kill all processes with open files in the worktree before attempting removal; the stale reaper and rescue paths now skip rather than kill when active processes are found. **`removeWorktree()` session-queue guard** (PR #478): `removeWorktree()` itself now cross-checks `session-queue.db` before removal — if any `running/queued/spawning/suspended` session claims the worktree path and its PID is alive, removal is blocked with an error. Callers that already performed their own safety checks pass `{ force: true }` to bypass (currently: `cleanupMergedWorktrees`, `reapSyncPass`, `reapStaleWorktrees`). Fail-open on DB read errors (missing file, busy, etc.) to avoid blocking routine cleanup. **`enqueueSession()` worktree exclusivity** (PR #478): blocks enqueue when another active queue item already has the same `worktree_path` or `cwd` — returns `{ blocked: 'worktree_exclusive' }`. A partial index on `worktree_path` keeps the lookup fast. Path normalization (trailing slash stripping) ensures consistent comparison. The `worktree-cwd-guard.js` hook additionally detects stale CWD at tool-call time and blocks Bash execution with a recovery hint if the worktree directory no longer exists. The `worktree-remove-guard.js` PreToolUse hook (PR #478) intercepts `git worktree remove` Bash commands and denies removal of `.claude/worktrees/` paths owned by other active sessions (allows self-cleanup and orphaned cleanup; fails open on DB errors).

**Orphan process reaper**: `reapOrphanProcesses()` in `hourly-automation.js` finds `node`/`esbuild`/`vitest` processes whose CWD (resolved via `lsof -d cwd`) is inside `.claude/worktrees/` but the directory no longer exists, then kills their process groups. Runs every **60 minutes** (`getCooldown('orphan_process_reaper', 60)`). Guards against processes that survived after their parent session was killed and their worktree removed.

**Session activity broadcasting**: `scripts/session-activity-broadcaster.js` daemon (launchd KeepAlive) polls every 5 minutes, reads all running session JSONL tails, generates per-session summaries via `claude -p --model haiku`, creates a unified super-summary, stores both in `.claude/state/session-activity.db`, and broadcasts the super-summary to all agents. Sub-agent activity (Agent tool sub-agents detected via the `subagents/` directory) is included in each session's summary when present, giving the broadcaster visibility into nested agent work. All `callLLM` and `callLLMStructured` subprocess invocations inject `CLAUDE_SPAWNED_SESSION=true` so the broadcaster's internal `claude` calls are correctly identified as spawned (non-interactive) sessions by all hooks, including the interactive-lockdown-guard. Agents access detailed summaries via `session-activity` MCP tools: `get_session_summary` (by UUID), `list_session_summaries` (by session/agent ID), `list_project_summaries`, `get_project_summary`. No DB cleanup — summaries are stored long-term.

**Session summary subscription system**: The broadcaster supports a subscription model so agents receive targeted summaries of other sessions rather than only the global broadcast. Three delivery tiers: `short` (2-4 sentence summary), `detailed` (full summary + agent type context), `verbatim` (full summary + raw recent session messages for near-complete visibility). Subscriptions are stored in a `summary_subscriptions` table in `session-activity.db`. Each poll cycle runs three additional steps after the global broadcast: Step 8 — auto-subscribes persistent-task monitors to all their child sessions at `verbatim` tier (keyed by `persistentTaskId` in session metadata); Step 9 — delivers pending subscriptions as signals via `sendSignal`; Step 10 — LLM-driven selective delivery using `callLLMStructured()` with `--json-schema` to detect cross-session relevance (overlapping files, dependent features, merge conflict risk) and deliver targeted summaries to sessions that would benefit. Step 10 skips sessions already covered by Step 9. Three MCP tools on the `agent-tracker` server manage subscriptions: `subscribe_session_summaries` (short/detailed/verbatim), `unsubscribe_session_summaries`, and `list_summary_subscriptions` (shows both outgoing and incoming relationships).

**Bounded fetch** (`fetchTimeout` option): `createWorktree()` accepts `{ fetchTimeout: N }` (milliseconds) to run `git fetch origin` with a timeout, bounding latency while keeping remote refs fresher than skipping entirely. Latency-critical paths (e.g., `urgent-task-spawner.js`, `demo-failure-spawner.js`) pass `fetchTimeout: 10000` (10s). The legacy `{ skipFetch: true }` option is deprecated — callers should migrate to `fetchTimeout`. Not recommended to omit both on cold-start provisioning where the base branch ref may be stale.

**Port isolation** (`lib/port-allocator.js`): Each worktree is assigned a dedicated port block (base 3100, increments of 100 per worktree, max 50). `provisionWorktree()` calls `allocatePortBlock()` and injects `CLAUDE_WORKTREE_DIR`, `PLAYWRIGHT_WEB_PORT`, `PLAYWRIGHT_BACKEND_PORT`, and `PLAYWRIGHT_BRIDGE_PORT` into `.mcp.json` env for the `playwright` and `secret-sync` servers. This enables worktree-local demo testing — `run_demo`, `run_tests`, and `secret_dev_server_start` all operate from the worktree at its allocated ports without merging first. State at `.claude/state/port-allocations.json` (O_EXCL lockfile for TOCTOU safety). `removeWorktree()` releases the block; `cleanupMergedWorktrees()` calls `cleanupStaleAllocations()` as a safety net for worktrees removed via paths that bypassed `removeWorktree()`.

**Worktree provisioning config** (`services.json`): Five optional fields in `ServicesConfigSchema` control install and build behavior during `provisionWorktree()`. Two additional fields control test scope gating (see Test Scope Profiles below):
- `worktreeBuildCommand` — shell command to build workspace packages (e.g., `"pnpm --recursive build"`). Runs after install when build artifacts are absent.
- `worktreeBuildHealthCheck` — shell command that exits 0 if build artifacts already exist; skips the build command when it passes (e.g., `"test -f packages/browser-proxy/dist/index.js"`).
- `worktreeInstallTimeout` — timeout in ms for the package manager install step (default: 120000). Large monorepos with 43+ packages may need 300000 or more.
- `worktreeProvisioningMode` — `"strict"` or `"lenient"` (default). In strict mode, install or build failures abort `createWorktree()`, remove the broken worktree, and re-throw. In lenient mode (default), failures are non-fatal warnings.
- `worktreeArtifactCopy` — array of glob patterns specifying build artifact directories to copy from the main tree to worktrees (e.g., `["packages/*/dist", "apps/extension/dist"]`). Copied BEFORE install so `pnpm install` can create bin symlinks referencing `dist/` files. When present and artifacts exist in the main tree, the build health check passes and the full build step is skipped entirely — reducing worktree provisioning from minutes to seconds. Only single-level `*` wildcards are supported. Non-fatal in lenient mode; throws in strict mode. Also runs in `syncWorktreeDeps()` after install to refresh artifacts post-merge. **Self-discovery**: Three guidance layers help agents configure this when it is missing — (1) the `update_services_config` MCP tool description prominently mentions `worktreeArtifactCopy` with a usage tip; (2) `session-briefing.js` emits a hint at worktree agent startup when `worktreeBuildCommand` is set but `worktreeArtifactCopy` is not; (3) `provisionWorktree()` logs a hint to stderr when it runs a full build and no artifact copy is configured.

These fields can be read and updated via the `get_services_config` / `update_services_config` tools on the `secret-sync` MCP server — no manual sudo commands required. See Secret Management section for details.

`core.hooksPath` poisoning is defended by 4 layers (removeWorktree, tamperCheck, husky pre-commit, safeSymlink EINVAL fix).

> Full details: [Worktrees core.hooksPath Poisoning Defense](docs/CLAUDE-REFERENCE.md#worktrees-corehookspath-poisoning-defense)

### Sub-Agent Working Tree Isolation

Code-modifying sub-agents (`code-reviewer`, `code-writer`, `test-writer`) MUST be spawned with `isolation: "worktree"` when using the `Task` tool. This gives them their own branch and working directory, isolating their file changes from the main tree and other concurrent agents.

**Base branch**: Agent worktrees branch from the project's base branch — `preview` in target projects, `main` in the gentyr repo. `createWorktree()` auto-detects by checking if `origin/preview` exists; if not, falls back to `origin/main`. It creates a NEW unique branch (e.g., `feature/code-review-abc`) based on the detected base — it does NOT check out the base branch itself. Multiple agents can all branch from the base concurrently without conflict.

**Why**: Without worktree isolation, sub-agents share the parent session's working tree. Concurrent file edits from multiple agents cause conflicts, and any git operation (stash, reset) in the main tree can destroy all agents' uncommitted work.

**Enforcement**: Two layers enforce this. Layer 1: the git wrapper (`git-wrappers/git`, PATH-injected) and `main-tree-commit-guard.js` PreToolUse hook both block `git add`/`git commit` on protected non-base branches for ALL sessions (interactive and spawned). Layer 2: `main-tree-commit-guard.js` additionally hard-blocks `git add`/`git commit`/`git reset --hard`/`git stash`/`git clean`/`git pull` for spawned agents (`CLAUDE_SPAWNED_SESSION=true`) in the main tree. `GENTYR_PROMOTION_PIPELINE=true` exempts both layers.

**Example**:
```
// CORRECT: Agent gets its own isolated worktree (branched from preview or main)
Task(subagent_type: "code-writer", isolation: "worktree", ...)

// WRONG: Agent shares parent's working tree — file edits may conflict with other agents
Task(subagent_type: "code-writer", ...)
```

**Read-only agents are exempt**: Agents that only read code (e.g., `Explore`, `Plan`, `investigator`) don't need worktree isolation since they never run git write operations.

**Agent separation**: The gentyr repo uses repo-specific agents from `.claude/agents/` (e.g., project-manager merges to `main`). Target projects use shared agents from the `agents/` directory (e.g., project-manager merges to `preview`). Shared agents are symlinked into `.claude/agents/` in the gentyr repo for local use.

**Commit ownership**: Only the project-manager agent and interactive (CTO) sessions commit. Code-reviewer, code-writer, and test-writer agents do NOT commit — they write/review code and leave git operations to the project-manager. The `uncommitted-change-monitor.js` hook warns after 5 uncommitted file edits; interactive sessions should treat these warnings as mandatory and commit immediately.

**Mandatory project-manager spawn**: Agents running in worktrees (spawned by `hourly-automation.js` or `urgent-task-spawner.js`) are required to spawn the project-manager sub-agent BEFORE calling `summarize_work` or `complete_task`, if they made any file changes. This hard gate is injected into every spawned agent's task prompt. Skipping it leaves orphaned worktrees and unmerged code. Investigation/research-only agents that made no file changes are exempt.

**Task-specific workflow overrides**: The standard 6-step pipeline (investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager) injected into agent prompts is the DEFAULT. If a task description provides explicit alternative workflow instructions (e.g., "skip investigation, just build and run the demo"), spawned agents follow those instructions instead. This is intentional: the task creator (persistent monitor, CTO, or other orchestrator) knows the context. The only invariant is that project-manager must run if file changes were made. This replaces the former "WORKFLOW IS NON-NEGOTIABLE" enforcement across `hourly-automation.js`, `urgent-task-spawner.js`, and `scripts/force-spawn-tasks.js`.

## Enforcement Doctrine: Multi-Layer Compliance

GENTYR uses a layered enforcement architecture that GUARANTEES consistent outcomes. Agent compliance is not optional or guidance-based — critical behaviors are enforced at the infrastructure level so agents CANNOT deviate regardless of their reasoning.

### Three Enforcement Layers

| Layer | Mechanism | Can agent bypass? | Examples |
|-------|-----------|:---:|---------|
| **Guidance** (soft) | Agent definitions, CLAUDE.md, session briefing, prompt templates | Yes (agent can ignore) | "Use the project-manager for git ops", "Defer to cicd-manager for deployments" |
| **Orchestration** (medium) | PostToolUse hooks that inject reminders, session-completion-gate that blocks summarize_work | Technically yes (agent could stop responding) | uncommitted-change-monitor, project-manager-reminder, worktree-cleanup-gate |
| **Enforcement** (hard) | PreToolUse hooks that DENY tool calls, root-owned files agents can't modify | **No** — tool call is rejected before execution | staging-lock-guard, main-tree-commit-guard, credential-file-guard, interactive-lockdown-guard |

### Design Principle: Don't Trust the Agent

For any behavior that MUST happen consistently:
1. **Guide** the agent to do it willingly (agent definitions, CLAUDE.md, prompt injection)
2. **Orchestrate** the environment so doing the right thing is easy (PostToolUse hooks inject reminders)
3. **Enforce** at the infrastructure level so the wrong thing is impossible (PreToolUse hooks block bad actions)

Guidance reduces friction. Enforcement guarantees outcomes. Use BOTH.

### Enforcement Patterns

#### Pattern 1: Protected Branch Merge Guard

**Requirement**: Only the preview-promoter agent (with full quality gates) can merge to staging.

**Guidance layer**:
- `agents/project-manager.md`: "For deployment matters, defer to cicd-manager"
- `CLAUDE.md.gentyr-section`: "Staging merges MUST go through the preview-promoter pipeline"
- Session briefing: Shows staging drift and promotion status

**Orchestration layer**:
- `pr-auto-merge-nudge.js`: Reminds agent to wait for CI after PR creation
- `preview_promotion` automation block: Auto-spawns preview-promoter every 30 minutes. Both `preview_promotion` and `promotion_retry_check` are in the `INFRASTRUCTURE_KEYS` set (not rate-multiplied). The retry check also resets the cooldown timer alongside the SHA to allow immediate re-promotion after a crash, and includes dead-promoter detection for `no_output_crash` sessions with no merge artifacts.

**Enforcement layer**:
- `staging-lock-guard.js` (PreToolUse, root-owned): DENIES `gh pr create --base staging`, `gh pr merge` targeting staging (runtime PR target check + CI check verification), `gh pr merge --admin` (admin CI bypass), `git push origin staging` for ALL sessions without `GENTYR_PROMOTION_PIPELINE=true`
- `merge-chain-check.yml` (GitHub Actions): BLOCKS PRs from non-preview branches to staging
- `setup-branch-protection.js`: Configures GitHub required status checks; staging has `enforce_admins: true` to prevent admin CI bypass

**CTO bypass**: Agent calls `record_cto_decision` with the CTO's verbatim approval → `authorization-audit-spawner.js` enqueues an independent auditor → on audit pass, `deferred-action-audit-executor.js` executes the blocked action autonomously.

#### Pattern 2: Interactive Session Lockdown

**Requirement**: CTO interactive sessions manage via tasks/agents, never edit code directly.

**Guidance layer**:
- Session briefing: "Deputy-CTO console — manage via tasks"
- `CLAUDE.md.gentyr-section`: Documents the lockdown model

**Orchestration layer**:
- `orchestration-guidance-hook.js`: Nudges toward parallel tasks when complexity detected

**Enforcement layer**:
- `interactive-lockdown-guard.js` (PreToolUse, root-owned): DENIES Write/Edit/NotebookEdit and code-modifying Agent spawns in interactive sessions. When lockdown is disabled, still DENIES Write/Edit/NotebookEdit to main-tree files (only worktree, `.claude/`, and `~/.claude/` paths are allowed) to prevent conflicts with running agents.
- `interactive-agent-guard.js` (PreToolUse): DENIES code-modifying agent types when lockdown is on; ALLOWS all agent types when lockdown is off (reads `interactiveLockdownDisabled` from `automation-config.json`).
- Deferred action required to disable: `set_lockdown_mode({ enabled: false })` creates a deferred action; CTO approves via `record_cto_decision`, `authorization-audit-spawner.js` executes inline (writes `automation-config.json` directly and auto-provisions a `cto-interactive` worktree — no separate auditor spawned for lockdown toggles since interactive sessions have no `agent_id`/`queue_id` for `peek_session` to locate).

**CTO bypass**: Agent calls `record_cto_decision` with the CTO's verbatim approval → `authorization-audit-spawner.js` executes the lockdown state change inline (skips auditor for `lockdown_toggle` decision type).

#### Pattern 3: Backward-Compatible Migration Enforcement

**Requirement**: All database migrations must be backward-compatible (enables safe auto-rollback).

**Guidance layer**:
- `agents/preview-promoter.md`: Documents expand/contract pattern with examples
- `agents/cicd-manager.md`: Lists BLOCKED patterns (DROP TABLE, DROP COLUMN, RENAME, etc.)

**Orchestration layer**:
- `migration-safety.js` (v2.0.0): Dual-layer analysis — Layer 1 is fast static regex matching for known destructive patterns (deterministic, instant); Layer 2 is LLM-powered per-file classification via `analyzeMigrations()` (Haiku) that catches context-dependent issues static regex misses (conditional DDL, stored procedures, complex ALTER chains). Static findings are authoritative — the LLM cannot downgrade a BLOCKED static finding. Each SQL operation is classified as SAFE, WARNING, or BLOCKED with expand/contract fix suggestions.

**Enforcement layer**:
- Preview-promoter agent EXITS without promoting when any BLOCKED operation is detected (hard gate, not a warning); records full per-operation results in `migration-safety.json`
- `staging-lock-guard.js`: Even if the promoter is somehow bypassed, staging is blocked
- Auto-rollback (`auto-rollback.js`): If a bad migration somehow reaches staging, code is automatically reverted

#### Pattern 4: CI Wait Before Merge

**Requirement**: All PRs must pass CI before merging (to any branch).

**Guidance layer**:
- `agents/project-manager.md`: Step 7 documents `gh pr checks --watch --fail-on-fail`
- `CLAUDE.md.gentyr-section`: "CI is a required status check"

**Orchestration layer**:
- `pr-auto-merge-nudge.js`: Injects CI wait reminder after every `gh pr create`

**Enforcement layer**:
- GitHub branch protection (required status checks): `gh pr merge` fails if CI hasn't passed
- `setup-branch-protection.js`: Configures these rules automatically

### The Unified CTO Authorization System

When enforcement blocks a legitimate CTO action, the authorization system allows temporary override through a verified, audited approval chain:

1. **Agent hits a block**: PreToolUse hook creates a `deferred_actions` record and returns `permissionDecision: 'deny'` with the deferred action ID
2. **Agent presents to CTO**: Shows the blocked action context and requests the CTO's verbatim approval; for spawned agents, files a `submit_bypass_request` and exits
3. **CTO approves**: Types approval response; agent calls `record_cto_decision` with the verbatim text and the `deferred_action_id`
4. **authorization-audit-spawner.js fires**: For `lockdown_toggle` and `local_mode_toggle`, executes inline (writes state files directly, marks `audit_passed` without spawning an auditor — interactive sessions have no `agent_id`/`queue_id` for `peek_session` to look up). For all other decision types, transitions to `audit_pending` and enqueues an independent `authorization-auditor` agent in the `audit` lane (Sonnet-tier, 8-min TTL, signal-excluded)
5. **authorization-auditor verifies**: Uses `peek_session` with the CTO's `session_id` to read the CTO's session JSONL — confirms the CTO was presented accurate context, the decision scope matches the actual action, and no critical information was omitted or misrepresented
6. **On audit pass**: `deferred-action-audit-executor.js` executes the blocked tool call autonomously via the MCP shared daemon (Tier 1) or Bash (Tier 2); signals the original agent with the result
7. **On audit fail**: The blocked action is NOT executed; the agent receives a failure signal with the scope mismatch reason

**Security properties**:
- CTO approval is recorded verbatim and hashed in `cto_decisions` table — agents cannot fabricate a decision
- Independent auditor verifies context accuracy from the actual session JSONL — not from agent claims
- Deferred action is bound by `args_hash` — approved args must match stored args (no bait-and-switch)
- Spawned sessions cannot override the auditor verdict — server-side guard blocks `cto_decision_audit_pass` for spawned sessions
- Fail-closed: auditor cannot find session file → FAIL verdict (never passes on uncertainty)
- Stale auditors are auto-revived by `session-reaper.js` to prevent `pending_audit` stuck states

**Legacy HMAC bypass** (`bypass-approval-hook.js`, `bypass-approval-token.js`): Deprecated in Phase 2 of the Unified CTO Authorization System. The `APPROVE BYPASS <code>` pattern and file-based approval tokens are no longer the primary bypass mechanism. The HOTFIX flow is preserved pending Phase 5 cleanup. New enforcement hooks should use the deferred action pattern (`createDeferredAction` in `lib/deferred-action-db.js`) instead.

**When to use the authorization system in new enforcement hooks**:
```javascript
// In a PreToolUse hook that blocks an action:
// 1. Call createDeferredAction() to persist the blocked call
// 2. Return permissionDecision: 'deny' with the deferred action ID
// 3. The agent presents the ID to the CTO, calls record_cto_decision, and exits
// 4. authorization-audit-spawner.js and deferred-action-audit-executor.js handle the rest
```

### Adding New Enforcement

When adding a new "must always happen" behavior:

1. **Start with enforcement** — write the PreToolUse hook that blocks the bad action
2. **Add to criticalHooks** — in `cli/commands/protect.js` so it becomes root-owned
3. **Add guidance** — update agent definitions and CLAUDE.md so agents understand why
4. **Add orchestration** — PostToolUse hook that reminds/nudges the correct behavior
5. **Wire CTO bypass** — include bypass instructions in the denial message
6. **Test the enforcement** — verify an agent CANNOT perform the blocked action

### Files Involved in Enforcement

| File | Role | Root-owned? |
|------|------|:-----------:|
| `.claude/hooks/staging-lock-guard.js` | Block staging merges | Yes |
| `.claude/hooks/main-tree-commit-guard.js` | Block main tree commits by spawned agents | Yes |
| `.claude/hooks/interactive-lockdown-guard.js` | Block file edits in CTO sessions | Yes |
| `.claude/hooks/credential-file-guard.js` | Block access to credential files | Yes |
| `.claude/hooks/branch-checkout-guard.js` | Block branch switching in main tree | Yes |
| `.claude/hooks/block-no-verify.js` | Block --no-verify on git commands | Yes |
| `.claude/hooks/gate-confirmation-enforcer.js` | Block task completion during audit | Yes |
| `.claude/hooks/signal-compliance-gate.js` | Block malformed inter-agent signals | Yes |
| `.claude/hooks/demo-local-guard.js` | Block local demo execution by spawned agents | Yes |
| `.claude/protection-key` | HMAC signing key for bypass tokens | Yes |
| `cli/commands/protect.js` | Manages the criticalHooks list | — |

## Propagation to Linked Projects

When developing GENTYR locally with `pnpm link`, most changes auto-propagate to target projects:
- **Hooks, commands, docs**: Immediate (directory symlinks)
- **Agents**: Immediate (individual file symlinks from `agents/` directory)
- **Config templates**: Next Claude Code session (SessionStart re-merges)
- **CLAUDE.md.gentyr-section**: Next Claude Code session (SessionStart replaces managed section)
- **Husky hooks**: Next Claude Code session (SessionStart auto-syncs)

### After editing MCP TypeScript source

MCP servers are referenced via `node_modules/gentyr/packages/mcp-servers/dist/`. The built `dist/` files propagate via symlink, but you MUST build after editing source:

```bash
cd packages/mcp-servers && npm run build
```

The SessionStart hook also attempts auto-rebuild if `src/` is newer than `dist/`; before running `tsc` it checks for `@types/node` in `packages/mcp-servers/node_modules/` and runs `npm install` first if missing (covers `git clean` or fresh npm installs that omit `packages/mcp-servers/node_modules/`). Always build explicitly after TS changes to ensure correctness.

### After editing window recorder Swift source

The `tools/window-recorder/` directory contains a Swift CLI (`WindowRecorder`) that uses ScreenCaptureKit to capture specific browser windows during headed demos. The binary is gitignored (`tools/window-recorder/.build/`) and must be compiled locally on macOS:

```bash
cd tools/window-recorder && swift build -c release
```

`npx gentyr sync` automatically builds the window recorder on macOS (step 7b). **Source-hash skip**: step 7b hashes all Swift source files (including `Package.swift`) and compares against `.build/.source-hash`. When the binary already exists and the hash is unchanged, the rebuild is skipped entirely — this preserves the binary's CDHash, which macOS TCC ties Screen Recording permission to. The hash file is written after a successful build so subsequent syncs see the new hash. The binary is discovered at runtime by the Playwright MCP server's `getWindowRecorderBinary()` function, which walks up from `dist/playwright/` to find `tools/window-recorder/.build/release/WindowRecorder`. Not available on non-macOS platforms; falls back silently.

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

Syncs four GENTYR data sources (Personas, Reviews, Work Log, Tasks) to Notion databases via a 60-second launchd daemon. Provides 5 MCP tools (`notion_check_status`, `notion_sync`, `notion_start_service`, `notion_stop_service`, `notion_setup_instructions`). Config via `plugins/notion/config.json` (gitignored).

> Full details: [Notion Plugin](docs/CLAUDE-REFERENCE.md#notion-plugin)

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

## Product Manager MCP Server

The product-manager MCP server (`packages/mcp-servers/src/product-manager/`) manages a 6-section PMF analysis pipeline. State is in `.claude/state/product-manager.db`. Access via `/product-manager` slash command. Scope: all 6 sections are external market research (never reference local project). Sequential lock enforces section ordering. Analysis lifecycle: `not_started` → `pending_approval` → `approved` → `in_progress` → `completed`.

> Full details: [Product Manager MCP Server](docs/CLAUDE-REFERENCE.md#product-manager-mcp-server)

## Automation Service

```bash
scripts/setup-automation-service.sh status --path /project                  # Check service status
scripts/setup-automation-service.sh remove --path /project                  # Remove service
scripts/setup-automation-service.sh run --path /project                     # Manual run
scripts/setup-automation-service.sh setup --path /project --op-token TOKEN  # Install with 1Password service account
```

By default, the automation service runs without 1Password credentials in background mode to avoid macOS permission prompts. Provide `--op-token` with a 1Password service account token to enable headless credential resolution for infrastructure MCP servers. **OP token preservation**: When regenerating an existing plist (macOS) or systemd unit (Linux) without explicitly passing `--op-token`, the setup script reads the token from the existing service file and carries it forward automatically. This prevents token loss during sync/update cycles.

**Automation state resilience**: `hourly-automation.js` reads `hourly-automation-state.json` at startup to track last-run timestamps. If the file is missing, corrupt, or contains non-numeric timestamps, the automation recreates it with epoch (0) timestamps — forcing all `runIfDue` blocks to fire immediately on the next cycle rather than exiting with a parse error. This prevents automation from going silent after a crash or manual deletion of the state file.

### Synthetic Monitoring and Auto-Rollback

`scripts/synthetic-monitor.js` runs as a KeepAlive launchd service (`com.local.gentyr-synthetic-monitor`) installed by `setup-automation-service.sh`. It probes all health endpoints defined in `services.json` `environments` config and writes results to a SQLite WAL-mode database at `.claude/state/synthetic-metrics.db`.

**Probe intervals**: production endpoints every 60 seconds; all other environments (staging, preview) every 5 minutes. Main loop tick is 5 seconds. Probe HTTP timeout is 10 seconds via `AbortSignal.timeout`.

**Two SQLite tables**: `health_probes` (7-day retention — status code, response time, healthy flag, error text per probe) and `metrics_summary` (90-day retention — per-environment hourly rollup of uptime %, P95 latency, probe count, failure count). The summary is computed opportunistically after each probe cycle.

**Alert conditions**: (1) 3+ consecutive failures for the same endpoint → `consecutive_failures` alert; (2) response time > 2× the 5-minute rolling baseline → `latency_spike` alert. Alerts are written atomically (tmp+rename) to `.claude/state/synthetic-alerts.json` (capped at last 100 entries).

**Auto-rollback integration**: `hourly-automation.js` runs an `auto_rollback_check` gate-exempt block every 2 minutes. It reads `synthetic-alerts.json`, filters to `consecutive_failures` alerts from the last 10 minutes, deduplicates by environment, then calls `recordFailure(envName)` and `executeRollback(envName, PROJECT_DIR)` from `.claude/hooks/lib/auto-rollback.js` when rollback conditions are met (deploy < 5 minutes old, 3+ consecutive failures, known-good prior deploy exists). Rollback targets Vercel (`npx vercel rollback --yes`) or Render (REST API) based on the `platform` field in deploy state. Skipped in local mode.

**Deploy state**: `auto-rollback.js` tracks deployments in `.claude/state/deploy-tracking.json`. Call `trackDeployment(environment, deployId, platform)` after each deploy, `recordHealthy(environment, deployId, platform)` when health checks pass (updates `lastKnownGood`). The rollback log is at `.claude/auto-rollback.log`.

**Cooldown key**: `auto_rollback_check: 2` in `config-reader.js` DEFAULTS.

### Automation Toggle Tools

**2 MCP tools** (on `agent-tracker` server):
- `set_automation_toggle` — enable or disable any of 18 hourly automation features by name (e.g., `userFeedbackEnabled`, `demoValidationEnabled`, `taskRunnerEnabled`). Persists to `autonomous-mode.json`. Accepts `{ feature: z.enum(AUTOMATION_TOGGLE_KEYS), enabled: boolean }`. Blocked for spawned sessions.
- `get_automation_toggles` — returns the current enabled/disabled state of all 18 automation features with descriptions, default states, and explicit vs. implicit values. CTO-facing — eliminates the need to manually edit `autonomous-mode.json` to control automation behavior.

These tools replace manual JSON editing for all automation on/off decisions. The underlying `autonomous-mode.json` file remains the source of truth; both tools read and write it atomically. Toggle semantics match `hourly-automation.js`: a feature is disabled only when explicitly set to `false`.

### On-Demand Task Spawning

```bash
# In a Claude Code session after GENTYR is installed:
/spawn-tasks
```

Unified agent spawning command with two modes:

- **Bare mode** (`/spawn-tasks`): Browse pending tasks by category and spawn them immediately
- **Description mode** (`/spawn-tasks <description>`): Create new tasks from plain English, then spawn

Bypasses the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate. Prefetches current agent counts and concurrency limits. Uses `force_spawn_tasks` on the agent-tracker MCP server with optional `taskIds` for targeted spawning, and `monitor_agents` to poll spawned agent status. Preserves the concurrency guard and task status tracking.

`monitor_agents` returns enriched per-agent data when a progress file exists: pipeline stage (e.g., `code-writer`), progress percentage, list of completed stages, and worktree git state (current branch, commit count, PR URL/status/merged flag). Stale progress files (no update in 10+ minutes) are flagged. This gives the deputy-CTO a view like "agent at code-writer stage (42%), 1 commit, PR #1460 merged" rather than just "PID alive". Progress files live at `.claude/state/agent-progress/<agent-id>.json` and are written by the `progress-tracker.js` PostToolUse hook (fast-exit for interactive sessions). Session-reaper renames them to `<agent-id>.json.retired` on agent death (deferred deletion — async pass sweeps retired files older than 30 minutes); agent-tracker tools fall back to `.retired` suffix when the primary file is absent, enabling short-lived post-death reads. Hourly automation cleans up orphaned non-retired files.

### On-Demand Triage

`/triage` force-spawns the deputy-CTO triage cycle immediately. Investigation-before-escalation pattern reduces CTO queue noise by spawning investigators before escalating.

> Full details: [On-Demand Triage and Deputy-CTO Tools](docs/CLAUDE-REFERENCE.md#on-demand-triage-and-deputy-cto-tools)

## Task Gate System

New tasks created by non-privileged agents enter `pending_review` status and are reviewed by a lightweight Haiku gate agent before entering the active queue.

**Task state machine**: `pending_review` → `pending` → `in_progress` → `completed`

**Gate bypass**: Tasks from trusted creators (`deputy-cto`, `cto`, `human`, `pr-reviewer`, `system-followup`, `demo`, `self-heal-system`) skip the gate and enter `pending` directly.

**Urgency auto-downgrade**: Only urgency-authorized creators (same list as gate bypass) can set `priority: "urgent"`. Tasks from other agents are auto-downgraded to `normal` with a warning.

**Gate decision tools** (on `todo-db` server):
- `gate_approve_task` — moves `pending_review` → `pending`
- `gate_kill_task` — archives and deletes a `pending_review` task with reason (audit trail preserved in `archived_tasks`)
- `gate_escalate_task` — approves task AND creates a deputy-CTO report for review

**PostToolUse hook** (`.claude/hooks/task-gate-spawner.js`): Fires on `mcp__todo-db__create_task`. When the response shows `status: 'pending_review'`, spawns a Haiku gate agent that checks for duplicates, feature stability locks, and CTO intent before deciding.

**Crash recovery**: `hourly-automation.js` auto-approves stale `pending_review` tasks older than 10 minutes (gate agent timed out or crashed).

**Race condition prevention**: `urgent-task-spawner.js` (Universal Task Spawner v2.0.0) checks concurrency limits on the input side; `task-gate-spawner.js` checks `tool_response.status === 'pending_review'` (output-side). No overlap.

**Task Safety — No Silent Deletion**: Every delete path in `todo-db` archives before removing. `delete_task` archives tasks of any status (not just completed) and accepts an optional `reason` parameter recorded in `archived_tasks.deletion_reason`. `get_task` falls back to `archived_tasks` before returning "not found" — returning the archived record with `archived: true`, `original_status`, and `deletion_reason`. Spawned agents (`CLAUDE_SPAWNED_SESSION=true`) are blocked from deleting non-completed tasks — only CTO/interactive sessions may remove active work. `gate_kill_task` and local-mode auto-kill paths in `task-gate-spawner.js` also archive before deleting. `todo-maintenance.js` and the `cleanup` handler populate `original_status` and `deletion_reason` on all archive writes. Schema: `archived_tasks` table gains `original_status TEXT` and `deletion_reason TEXT` columns (auto-migrated via idempotent `ALTER TABLE`). **Session cascade on deletion**: The `task-deletion-cascade.js` PostToolUse hook fires on `delete_task` and calls `cancelSessionsByTaskId()` (from `session-queue.js`) to terminate all active sessions linked to the deleted task — preventing zombie sessions from continuing work on deleted tasks.

## Universal Audit Gate System

Non-exempt task completions are independently audited to verify that work was genuinely completed before the task is marked `completed`. This is separate from the plan-level verification audit gate (which uses `plan-auditor`) — the Universal Audit Gate covers todo-db tasks and persistent tasks.

**Mandatory gate**: Non-exempt tasks MUST include `gate_success_criteria` (or its alias `verification_strategy`) when calling `create_task` or `activate_persistent_task`. The server rejects completion attempts for tasks that lack these fields with a clear error message directing the caller to provide measurable success criteria. Gate-exempt categories (Triage & Delegation, Project Management, Workstream Management) are excluded from this requirement.

**Trigger**: When a non-exempt task has `gate_success_criteria` set, `universal-audit-spawner.js` intercepts the completion call, transitions the task to `pending_audit`, and enqueues an independent `universal-auditor` agent in the `audit` session lane.

**Task state extension**: `pending_audit` status added between `in_progress` and `completed`. Tasks in `pending_audit` cannot be re-completed or modified by the original agent. The `gate-confirmation-enforcer.js` PreToolUse hook blocks any `complete_task` or `complete_persistent_task` call while `pending_audit` is active.

**Universal Auditor agent** (`agents/universal-auditor.md`): Sonnet-tier. Runs in the `audit` lane (signal-excluded, 8-min TTL). Reads the `gate_success_criteria` and `gate_verification_method` from its prompt, executes the verification steps against actual artifacts (files, git state, test output, PR status, demo results), and renders exactly one verdict:
- `task_audit_pass` / `pt_audit_pass` — task transitions `pending_audit → completed`, normal cascade runs
- `task_audit_fail` / `pt_audit_fail` — task reverts to `in_progress` with failure reason injected into the next spawn prompt

**Routing by task type** (`lib/auditor-prompt.js`, `resolveAuditTools()`): Four task types are supported.
- `'todo'` → `universal-auditor` agent, `task_audit_pass`/`task_audit_fail` on `todo-db` server
- `'persistent'` → `universal-auditor` agent, `pt_audit_pass`/`pt_audit_fail` on `persistent-task` server
- `'plan'` → `plan-auditor` agent, `verification_audit_pass`/`verification_audit_fail` on `plan-orchestrator` server
- `'authorization'` → `authorization-auditor` agent, `cto_decision_audit_pass`/`cto_decision_audit_fail` on `agent-tracker` server

`buildAuditorSessionSpec()` in `lib/auditor-prompt.js` is the single source of truth for spawning auditors across all four types. `universal-audit-spawner.js` (first spawn), `authorization-audit-spawner.js` (CTO authorization audits), and `session-queue.js` Step 1b.5 (revival spawn) consume this shared module.

**Gate-exempt categories**: Triage & Delegation, Project Management, and Workstream Management categories complete directly without audit (their work is coordination, not deliverable artifacts).

**Signal compliance gate**: The `signal-compliance-gate.js` PreToolUse hook validates all inter-agent signals via `send_session_signal` against a registered schema before delivery. Directive signals (requiring acknowledgment) MUST be acknowledged before the receiving agent can complete its task — enforced by `signal-reader.js` tracking.

## Global Deputy-CTO Monitor

An always-on persistent deputy-CTO session operating in continuous alignment monitoring mode. **Auto-spawned** by the `global_monitor_health` block in `hourly-automation.js` (5-minute cycle, gate-exempt). The automation auto-creates the persistent task (with `task_type: "global_monitor"`, `do_not_complete: true`) if none exists, and re-enqueues the monitor at `critical` priority in the `persistent` lane if it dies. No manual bootstrap required. Opt-**out** only: disable via `globalMonitorEnabled: false` automation toggle (or `/global-monitor off`). When spawned with `GENTYR_DEPUTY_CTO_MONITOR=true` in its environment, the deputy-CTO runs a 5-minute polling loop: enumerates active tasks and persistent tasks, dispatches user-alignment sub-agents in the `alignment` session lane (sub-limit: 3 concurrent) to verify work matches CTO intent before code is written, reads alignment results, sends corrective signals to drifting agents, detects zombies (sessions alive >2h with no recent tool calls), and oversees stuck audit gates.

**Escalation framework**: Signals for minor drift (~50%), self-created correction tasks for moderate misalignment (~35%), and `submit_bypass_request` on the affected task for significant drift or systemic issues (~15%).

**Bypass request routing**: When any agent calls `submit_bypass_request`, the `bypass-request-router.js` PostToolUse hook checks if the global monitor is active. If so, it sends a `BYPASS_REQUEST` directive signal to the monitor, giving it ~5 minutes to triage the request before the CTO sees it. The CTO's `session-briefing.js` and `cto-notification-hook.js` apply a 5-minute grace period: pending requests younger than 5 minutes are hidden while the monitor is active. Requests explicitly escalated by the monitor (`deputy_escalated = 1`) bypass the grace period and appear to the CTO immediately. If the monitor is not active, requests appear to the CTO immediately (no grace period).

**Deputy bypass resolution**: 3 exclusive MCP tools on the `agent-tracker` server — `deputy_resolve_bypass_request`, `deputy_approve_deferred_action`, `deputy_escalate_to_cto` — allow the global monitor to handle CTO bypass requests autonomously. Enforced by 3-layer identity verification (env var → session-queue.db metadata → persistent-tasks.db cross-check). CTO-only actions (release-ledger, lockdown, staging) are permanently blocked.

**Signal throttling**: Max 1 signal per agent per 30 minutes. If >5 signals are firing per hour, the monitor self-pauses and escalates a diagnostic report to the CTO.

**Lifecycle**: Runs in the `persistent` lane (no concurrency cap, always spawns immediately). Survives crashes via the persistent task revival system (circuit breaker, heartbeat-stale detection). The `alignment-monitor-briefing.js` PostToolUse hook delivers cross-session alignment summaries on each tool call.

## Task Category System

Task categories replace the legacy hardcoded `section` routing. A category defines an agent pipeline (ordered sequence of sub-agent types), prompt template, model tier, creator restrictions, and urgency authorization — all stored in `todo.db` and editable at runtime without code changes.

**`task_categories` table** (in `todo.db`, auto-migrated): `id`, `name`, `description`, `sequence` (JSON array of `{ agent_type, label }` steps), `prompt_template` (optional custom prompt; if absent, the standard multi-step workflow is generated), `model`, `creator_restrictions` (JSON array of authorized `assigned_by` values, or null for open), `force_followup` (boolean), `urgency_authorized` (boolean — whether this category's tasks bypass the urgency downgrade), `is_default` (boolean), `deprecated_section` (the legacy section string this category replaces, for backward-compat lookup).

**8 seeded categories**: `Standard Development` (6-step pipeline: investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager), `Deep Investigation` (investigator-only), `Test Suite Work` (test-writer → code-reviewer → project-manager), `Triage & Delegation` (deputy-cto-only), `Demo Design` (demo-manager-only), `Project Management` (project-manager-only), `Product Analysis` (product-manager-only), `Workstream Management` (workstream-manager-only). Additional categories can be created at runtime via MCP tools.

**`category_id` dual-write**: `create_task` accepts an optional `category_id`. If provided, it is stored on the task. If absent but `section` is provided, the category is resolved by `deprecated_section` lookup. `list_tasks` returns `category_id` and `category_name` on each task. `list_tasks` also supports `category_id` as a filter.

**5 CRUD tools** (on `todo-db` server):
- `list_categories` — list all categories with their sequences
- `get_category` — retrieve a single category by ID
- `create_category` — define a new category with a custom pipeline sequence
- `update_category` — modify an existing category (name, description, sequence, model, etc.)
- `delete_category` — remove a category (cannot delete the default category)

**Shared module** (`lib/task-category.js`): Single source of truth replacing the three previous copies of `SECTION_AGENT_MAP` and `buildTaskRunnerPrompt()` across spawner scripts. Exports `resolveCategory(dbPath, { section?, category_id? })`, `getAllCategories(dbPath)`, `getPipelineStages(category)`, `buildSequenceList(sequence)`, and `buildPromptFromCategory(task, category, agentId, worktreePath, options)`. All three spawners (`hourly-automation.js`, `urgent-task-spawner.js`, `force-spawn-tasks.js`) and `progress-tracker.js` now consume this module. Resolution priority: `category_id` → `deprecated_section` → default category.

**`progress-tracker.js` integration**: Pipeline stage tracking (`PIPELINE_TEMPLATES`) is now derived from `category.sequence` via `getPipelineStages()`. Falls back to the legacy hardcoded sequence if category resolution fails (non-fatal, backward-compatible).

## Feature Stability Registry

CTO-gated mechanism to lock features and prevent endless agent nitpick chains on solid features.

**`feature_stability` table** (in `user-feedback.db`): Stores stability locks linked to features via `feature_id` FK (CASCADE delete).

**4 MCP tools** (on `user-feedback` server):
- `lock_feature` — CTO-gated (only `cto` or `human` caller); creates a stability lock
- `unlock_feature` — CTO-gated; removes a stability lock
- `list_stable_features` — JOINs to features table; returns locked features with reasons
- `check_feature_stability` — Checks file patterns and feature name against locked features; used by the gate agent to auto-kill tasks targeting stable features

**CTO workflow**: Lock/unlock features in interactive sessions. Product-manager can request locks via deputy-CTO escalation.

## Persistent Task System

Lets the CTO delegate complex multi-step objectives to a dedicated monitor session that orchestrates sub-agents to completion.

**State machine**: `draft` → `active` → `paused` / `completed` / `cancelled` / `failed`. Activation spawns the persistent monitor agent.

**`persistent-task` MCP server** (`packages/mcp-servers/src/persistent-task/`): State in `.claude/state/persistent-tasks.db` (SQLite, WAL mode). Tier 2 (stateful, per-session stdio).

**13 tools**: `create_persistent_task`, `activate_persistent_task`, `get_persistent_task`, `list_persistent_tasks`, `amend_persistent_task`, `acknowledge_amendment`, `pause_persistent_task`, `resume_persistent_task`, `cancel_persistent_task`, `complete_persistent_task`, `link_subtask`, `get_persistent_task_summary`, `inspect_persistent_task`.

**Amendment system**: After activation the CTO can amend a task (`amend_persistent_task`) with `addendum`, `correction`, `scope_change`, or `priority_shift` types. The monitor polls for unacknowledged amendments on each cycle and must call `acknowledge_amendment` before proceeding. **Auto-resume on amendment**: If the task is paused when an amendment is added, `amendPersistentTask()` automatically transitions the task back to `active` and the spawner hook fires immediately to launch a new monitor session — no manual `resume_persistent_task` call needed.

**`persistent-monitor` agent** (`agents/persistent-monitor.md`): Opus-tier. Read-only for files — orchestrates sub-agents via `todo-db` task creation, not direct edits. Never executes sub-tasks itself and never uses the Task tool to spawn code-writers — all code changes must go through `create_task` + `force_spawn_tasks` so they are tracked, gated, and run in provisioned worktrees. The Task tool is permitted only for immediate, lightweight investigation work (investigator sub-agents). Runs a polling loop: check sub-task progress → verify child claims → spawn new tasks as needed → check for amendments → heartbeat → sleep. Completes when outcome criteria are satisfied or the task is cancelled. **Skepticism protocol** (Step 1b): Monitors do NOT accept child agent success claims at face value. When a child reports completion, passing tests, or a working demo, the monitor must `inspect_persistent_task` and `peek_session` to find concrete evidence (exit codes, PASS/FAIL strings, `check_demo_result` with `status: 'passed'`, PR merge confirmations). When evidence is missing, the monitor sends a `send_session_signal` directive demanding proof before `complete_task` may be called. If the child has already exited unverified, a new re-verification task is created. `persistent-task-briefing.js` reinforces this: it adds a skepticism nudge when completed sub-tasks exist and promotes `inspect_persistent_task` as the primary monitoring tool. **Supersession protocol**: When a `scope_change` amendment indicates the task is superseded, monitors must call `cancel_persistent_task` (not `pause_persistent_task`) to permanently stop the task and prevent auto-reviver loops. Pausing a superseded task creates an infinite cycle: the stale-pause auto-resume wakes the monitor every 30 min, the monitor re-reads the amendment, pauses again, and the cycle repeats. The `do_not_auto_resume` metadata flag (set by the self-pause circuit breaker after 2+ pauses in 2 hours) is the backup safety net. **CTO-blocking situations**: When the monitor is genuinely blocked and needs CTO authorization (access issues, conflicting requirements, external dependencies), it must call `submit_bypass_request` instead of `pause_persistent_task` directly. `submit_bypass_request` records the reason, signals the CTO, and then the agent MUST call `summarize_work` and exit — it must not continue working.

**Session queue `persistent` lane**: Independent of the global concurrency cap. No sub-limit — persistent monitors always spawn immediately (the former `PERSISTENT_LANE_LIMIT = 3` cap was removed). Exempt from the session reaper. **Immediate revival on death**: `drainQueue()` calls `requeueDeadPersistentMonitor()` in Step 1b after the sync reap pass — if a persistent monitor's PID is found dead, a new monitor is re-enqueued at `critical` priority in the same drain cycle, reducing revival latency to seconds instead of the 15-minute automation cycle. **Crash-loop circuit breaker**: Two-layer guard in `requeueDeadPersistentMonitor()`. Layer 1 (fast): in-memory rate limiter (`_monitorRevivalTimestamps` Map) — max 3 revivals per task in 10 minutes, immune to SQLite WAL visibility delays. Layer 2 (slow): DB-based check — max 5 revivals per task per hour sourced from `session-queue-reaper`. When the DB limit is hit, the persistent task is auto-paused (status set to `paused` in `persistent-tasks.db`) with `do_not_auto_resume: true` set in its metadata to stop the crash loop and prevent stale-pause auto-resume from fighting the breaker; `propagatePauseToPlan` is called on both circuit-breaker paths so the linked plan's `blocking_queue` is populated; the task must be manually resumed by the CTO. **Heartbeat-stale revivals are excluded from the circuit breaker count** — only true crashes (`reapReason != 'stale_heartbeat'`) increment the counter, preventing the breaker from tripping on monitors that are alive but momentarily slow to heartbeat. **Step 1c orphan catch-all**: After the dead-PID check, `drainQueue()` also queries `persistent-tasks.db` for `active` tasks that have no corresponding `queued`, `running`, or `spawning` queue item in any lane — a scenario that can arise if the hook fired but the enqueue silently failed. Each orphan is passed to `requeueDeadPersistentMonitor()` for immediate revival. This is a belt-and-suspenders guard that runs on every drain cycle.

**3 PostToolUse hooks**:
- `persistent-task-briefing.js` — injects the current task state into the monitor's context on each tool call (prompt reinforcement)
- `persistent-task-linker.js` — auto-links newly created todo-db tasks that carry a `persistent_task_id` to their parent persistent task
- `persistent-task-spawner.js` — fires on `activate_persistent_task`, `resume_persistent_task`, `amend_persistent_task`, `pause_persistent_task`, and `cancel_persistent_task`. For activate/resume/amend: enqueues the monitor session in the `persistent` lane (amendment responses use `persistent_task_id || id` for task ID extraction); on `resume_persistent_task` additionally calls `propagateResumeToPlan` to resolve any `blocking_queue` entries in linked plans. For pause/cancel: emits `persistent_task_paused` / `persistent_task_cancelled` audit events to `session-audit.log` and exits without spawning. Callers should NOT manually spawn monitors after these calls.

**Hourly automation**: 15-minute health check detects monitors with stale heartbeats and reports dead monitors to the deputy-CTO. This is now a tertiary safety net — primary revival happens immediately in `drainQueue()` via `requeueDeadPersistentMonitor()`, and the sync-pass reaper (`reapSyncPass`) now also kills stale monitors directly (using `persistent_heartbeat_stale_minutes`, default 5 min) for near-instant revival.

**Stale-pause auto-resume**: `hourly-automation.js` runs a `persistent_stale_pause_resume` check every 5 minutes. If a task has been `paused` for longer than `persistent_stale_pause_threshold_minutes` (default 30 min) AND no monitor is already queued or running for it, a new monitor is automatically enqueued. This handles self-paused monitors that forgot to self-resume (e.g., after writing a deputy-CTO report and pausing). The resumed task transitions back to `active` via `resume_persistent_task`, and the spawner hook fires to launch a new monitor. After enqueuing, `propagateResumeToPlan` is called to resolve any `blocking_queue` entries in linked plans. Three suppression guards prevent unwanted auto-resume: (1) `do_not_auto_resume: true` in task metadata permanently suppresses auto-resume; (2) self-pause circuit breaker detects tasks that have paused 2+ times in the last 2 hours (monitor keeps waking up and re-pausing per an amendment directive) and auto-sets the `do_not_auto_resume` flag; (3) CTO bypass request guard skips tasks with pending bypass requests.

**Crash-loop login resume** (`crash-loop-resume.js` SessionStart hook): On interactive session start, detects persistent tasks paused by the crash-loop circuit breaker (`reason: 'crash_loop_circuit_breaker'` in the most-recent `paused` event) and auto-resumes them by setting `status = 'active'` and enqueuing a new monitor at `critical` priority. Manually paused tasks are left untouched. Tasks with `do_not_auto_resume: true` in their metadata are permanently skipped — the CTO sees a note in `systemMessage` listing these blocked task titles so they can decide to intervene. Tasks with a pending CTO bypass request are also skipped (checked via `lib/bypass-guard.js` `checkBypassBlock()`). Skipped entirely for spawned sessions (`CLAUDE_SPAWNED_SESSION=true`). Uses a TOCTOU-safe `UPDATE ... WHERE status = 'paused'` guard and deduplicates against in-flight queue items before enqueuing. Rollback sets the task back to `paused` if monitor enqueue fails. All errors are accumulated in `systemMessage` (never stderr, per SessionStart rules). Session briefing shows a PAUSED TASKS section with pause reason (crash-loop / bypass-request / manual) to give the CTO visibility at login.

**`buildPersistentMonitorRevivalPrompt()` helper**: Shared module at `lib/persistent-monitor-revival-prompt.js`, consumed by `hourly-automation.js` (dead monitor path and stale-pause auto-resume), `session-queue.js` revival paths, and `crash-loop-resume.js`. Accepts `(task, revivalReason, projectDir)` and builds the full revival prompt with correct demo/strict-infra flags and revival metadata. Internally calls `buildRevivalContext()` from `lib/persistent-revival-context.js` to assemble enriched context from `last_summary`, recent amendments, and sub-task status. `hourly-automation.js` uses a local `buildRevivalPrompt()` wrapper that binds `PROJECT_DIR`.

**`last_summary` field**: `persistent_tasks` table carries a `last_summary TEXT` column (auto-migrated on DB open). Monitors write their current progress summary here before each sleep cycle. Revival prompts include this field so revived monitors know what was accomplished before the session died, reducing repeated work after crashes.

**`lib/persistent-revival-context.js`** (shared module): Read-only module that assembles a structured revival context block from `persistent-tasks.db` (`last_summary`, amendments), `todo.db` (sub-task status), and session JSONL files (compaction context). Now also includes a **failure diagnosis section** when active `blocker_diagnosis` records exist for the task — revived monitors see their prior failure classification, fix attempts, and fix task IDs so they can pick up where self-healing left off. All reads are wrapped in try/catch and degrade gracefully. Consumed by `hourly-automation.js` and `session-queue.js` revival paths.

**Self-Healing System** (`lib/blocker-auto-heal.js`): Orchestrates automatic diagnosis and recovery when persistent monitors crash repeatedly. Called from `requeueDeadPersistentMonitor()` after the crash-loop circuit breaker's rate-limit cooldown pass. Decision tree: (1) `rate_limit` transient errors → return `cooldown` action (caller handles backoff); (2) `unknown` error or zero consecutive errors → `retry` (normal revival); (3) fix already in-flight (checked via `blocker_diagnosis` status and `todo.db` self-heal tasks) → `retry` without spawning a duplicate; (4) max fix attempts not yet reached → create a `Deep Investigation` task in `todo.db` with `assigned_by: 'self-heal-system'` and targeted investigation steps for the error type; (5) max fix attempts exceeded → submit a bypass request to `bypass-requests.db`, pause the persistent task with `reason: 'self_heal_exhausted'`, and return `escalated`. Deduplicates via the `blocker_diagnosis` table in `persistent-tasks.db`. Error types classified by `diagnoseSessionFailure()`: `rate_limit` (transient, cooldown), `auth_error` (credential investigation), `crash` (code/infra investigation), `unknown` (generic retry). Fix attempts and linked fix task IDs are tracked across revivals in `blocker_diagnosis`. Configurable via `self_heal_max_fix_attempts` (default 3) in `automation-config.json`. Log at `.claude/blocker-auto-heal.log`.

**`blocker_diagnosis` table** (in `persistent-tasks.db`, auto-migrated): Tracks self-healing state per persistent task per error type. Fields: `id`, `persistent_task_id`, `error_type`, `is_transient`, `diagnosis_details` (JSON from `diagnoseSessionFailure()`), `fix_attempts`, `max_fix_attempts`, `fix_task_ids` (JSON array), `status` (`active` / `fix_in_progress` / `cooling_down` / `resolved` / `escalated`), `cooldown_until`, `resolved_at`, `created_at`. One active record per `(persistent_task_id, error_type)` pair — subsequent failures with the same type increment `fix_attempts` on the existing record. Resolved automatically when `self_heal_fix_check` in `hourly-automation.js` detects the fix task completed successfully; escalated when `fix_attempts >= max_fix_attempts`.

**Hourly automation self-heal cycles**: Two new `runIfDue` blocks in `hourly-automation.js`:
- `cooldown_recovery` (10-minute cooldown): Queries `blocker_diagnosis` rows with `status = 'cooling_down'` whose `cooldown_until` timestamp has elapsed, marks them `resolved`, and allows the next circuit-breaker pass to attempt normal revival.
- `self_heal_fix_check` (15-minute cooldown): Queries `blocker_diagnosis` rows with `status = 'fix_in_progress'`, checks each linked fix task's status in `todo.db`. If the fix task is `completed`, marks the diagnosis `resolved`. If all fix attempts exhausted, escalates to CTO. If still in progress, leaves the record unchanged.

**Demo validation protocol**: When `demo_involved: true` is set on the task (stored in `metadata`), monitor prompts include specialized instructions from `lib/persistent-monitor-demo-instructions.js`: run demos headed with video recording, review video frames at key moments, keep Playwright timeouts tight, and iterate rapidly. Injected by `persistent-task-spawner.js`, `hourly-automation.js` revivals, and `requeueDeadPersistentMonitor()` in `session-queue.js`. The `/persistent-task` create command now asks about demo involvement during clarification and passes `demo_involved` to `create_persistent_task`. When `demo_involved: true` is set on the task (stored in `metadata`), monitor prompts include specialized instructions from `lib/persistent-monitor-demo-instructions.js`: run demos headed with video recording, review video frames at key moments, keep Playwright timeouts tight, and iterate rapidly. Injected by `persistent-task-spawner.js`, `hourly-automation.js` revivals, and `requeueDeadPersistentMonitor()` in `session-queue.js`. The `/persistent-task` create command now asks about demo involvement during clarification and passes `demo_involved` to `create_persistent_task`.

**Strict Infrastructure Guidance** (`strict_infra_guidance` flag): An opt-in flag that adds three things to persistent task monitors and their child agents: (1) a detailed MCP-only infrastructure instruction block from `lib/strict-infra-guidance-prompt.js` (via `buildStrictInfraGuidancePrompt()`), enforcing Bash prohibition for builds, dev servers, secrets, and demos; (2) `strict-infra-nudge-hook.js` PostToolUse enforcement that detects prohibited Bash infrastructure commands and redirects agents to the correct MCP tools; (3) shared resource coordination guidance for `display`, `chrome-bridge`, and `main-dev-server` resources. Env var `GENTYR_STRICT_INFRA_GUIDANCE=true` is injected into spawned sessions when the flag is set. When a persistent task has `strict_infra_guidance: true` in its `metadata`, the monitor's prompt is augmented with `lib/persistent-monitor-strict-infra-instructions.js` (via `buildPersistentMonitorStrictInfraInstructions()`), which instructs the monitor to propagate `strict_infra_guidance: true` to all child tasks that touch infrastructure. Worktrees already have per-worktree port isolation (base 3100, +100 per worktree) — demos and dev servers run directly from the worktree on isolated ports, no merge needed. Child agents that fail MUST diagnose and retry at least once before reporting blocked; only create a new fix task if the issue is confirmed to be in code, not infrastructure.

**Cross-system wiring**: `todo-db` `create_task` accepts `persistent_task_id`; `stop-continue-hook.js` blocks the normal stop flow for active monitor sessions and forwards `GENTYR_PERSISTENT_TASK_ID` env var — when a monitor is blocked and needs CTO intervention, the hook directs it to use `submit_bypass_request` (not raw `pause_persistent_task`) before stopping; `session-briefing.js` includes a persistent task summary in interactive session briefings; `cto-notification-hook.js` shows active monitor count in the status line and injects pending bypass request details into `additionalContext` on every CTO prompt — the model sees bypass requests directly (not just the terminal UI) so the CTO is never left unaware of blocked work.

**CTO Dashboard**: `PersistentTaskSection` component reads from `persistent-tasks.db` via `packages/cto-dashboard/src/utils/persistent-task-reader.ts`. Rendered on `/cto-report` (static) and `/cto-dashboard` (live TUI).

**4 slash commands**:
- `/persistent-task` — create flow: researches context, refines the CTO's input into a high-specificity prompt, previews the draft, creates and activates on approval
- `/persistent-tasks` — management view: lists all tasks, shows monitor health, and provides amend/pause/resume/cancel/revive actions
- `/monitor` — continuous monitoring loop that shows raw data from plans, persistent tasks, todo-db tasks, running sessions, and the session queue. Each round calls MCP tools directly (no investigator sub-agents) and displays verbatim indexed session messages via `browse_session`. Subscribes the CTO interactive session to verbatim-tier summaries from monitored agents for automatic delivery. Tracks unverified success claims across rounds in `successClaimsUnverified`; classifies evidence as `confirmed`/`unverified`/`refuted` in `evidenceLog`; signals monitors when claims are refuted. Accepts optional argument: `plans` (focus on plans), `persistent` (focus on persistent task monitors), a plan/task-ID prefix (monitor a specific item), or bare (monitors everything). Stops automatically on intervention-needed conditions: monitor dead with no revival queued, task self-paused, task completed/cancelled, critical memory pressure for 3+ rounds, child agent stale 15+ minutes, plan fully blocked with no parallel work for 3+ rounds, or a systemic error pattern across 3+ child attempts.
- `/status` — one-shot version of `/monitor`. Same data gathering and display format (plans, persistent tasks, tasks, sessions, queue) but runs once and exits — no sleep loop, no state file, no reminder hook. When sessions appear idle (no recent tool calls), the investigator checks `peek_session` for `activeSubagents` and displays a sub-agent tree showing nested Agent tool sub-agents and their current activity.


## Report Auto-Resolution

Polls for recently merged PRs every 2 minutes via `hourly-automation.js` (`runIfDue('report_auto_resolve', 2)`), feeds PR diffs + pending reports to Haiku via structured JSON output (`--json-schema`), and auto-resolves reports the LLM confirms are fixed. Gate-exempt (runs before the CTO gate check).

**Shared LLM Client** (`.claude/hooks/lib/llm-client.js`): Extracted `callLLMStructured(prompt, systemPrompt, jsonSchema, opts)` from `scripts/session-activity-broadcaster.js`. Calls `claude -p --model haiku --output-format json --json-schema <schema>` via `execFile`. Double-parses the JSON envelope (`data.result` as string). Returns parsed object or `null` on failure. Injects `CLAUDE_SPAWNED_SESSION=true`. Accepts `opts.model` and `opts.timeout` overrides. Test-hookable via `_setTestHandler(fn)`.

**Report Auto-Resolver** (`.claude/hooks/lib/report-auto-resolver.js`): Core logic module. Two exports:
- `runReportAutoResolve(log, lastMergedPRTimestamp)` — queries pending reports from `.claude/cto-reports.db`, detects recently merged PRs via `gh pr list --state merged`, gets PR diffs via `gh pr diff`, calls Haiku to match, auto-resolves. Returns `{ processedPRs, resolved, deduped, latestMergedAt }` or `null`.
- `runReportDedup(log)` — standalone dedup pass (30-minute cooldown, `runIfDue('report_dedup', 30)`). Skips when fewer than 3 pending reports. Returns `{ deduped }` or `null`.

**DB updates** (in transaction): Resolved reports get `triage_status='self_handled'`, `triage_outcome='Auto-resolved by PR #N: <reason>'`. Deduped reports get `triage_status='dismissed'`, `triage_outcome='Duplicate of report <keep_id>: <reason>'`. All UPDATEs include `WHERE triage_status = 'pending'` guard. All LLM-returned report IDs are validated against the pending set before update (rejects hallucinated IDs).

**Fast-exit paths** (no LLM call): 0 pending reports, 0 new merged PRs, or fewer than 3 pending reports (dedup only).

**Cooldown defaults** in `config-reader.js`: `report_auto_resolve: 2` (minutes), `report_dedup: 30` (minutes).

## Two-Tier Report Triage

The `triage_check` block in `hourly-automation.js` (default 5-minute cooldown) now routes reports to tier-specific triage agents based on the `tier` column of the `reports` table in `cto-reports.db`.

**Three triage paths** (all dispatched in the same `runIfDue` cycle):
- **Preview-tier** (`tier = 'preview'`): Spawns `spawnPreviewTriage()`. Preview-tier agents cannot escalate directly to production; reports are scoped to preview quality.
- **Staging-tier** (`tier = 'staging'`): Spawns `spawnStagingTriage()`. Staging-tier agents can escalate to the deputy-CTO for blocking production promotion.
- **Legacy (null-tier)**: Reports with no `tier` value use the original `spawnReportTriage()` for backward compatibility.

**Tier injection**: When a worktree is provisioned via `createWorktree()`, the `agent-reports` MCP server entry in the worktree-local `.mcp.json` receives `GENTYR_REPORT_TIER` injected based on the worktree's `baseBranch` (`'staging'` when branching from staging; `'preview'` otherwise). This ensures reports filed from staging worktrees are automatically tagged with the staging tier.

**`hasReportsReadyForTriageByTier(tier)`** in `hourly-automation.js`: Queries `cto-reports.db` for pending reports matching the given tier (or `IS NULL` for legacy). Fast-exit if the DB is missing. Returns `false` on error (non-fatal).

## Staging Reactive Review

Automated 4-review-stream analysis of every new commit on staging that hasn't been promoted to main. Controlled by `stagingReactiveReviewEnabled: true` in `automation-config.json` (default off, skipped in local mode). Cooldown: `staging_reactive_review` (default 60 minutes).

**How it works** (`runIfDue('staging_reactive_review', ...)` in `hourly-automation.js`):
1. Fetches `origin/staging` and `origin/main`; exits early if either branch is absent
2. Lists commits staging has ahead of main (`git log origin/main..origin/staging`)
3. Checks `state.lastStagingReviewedSha` against the current staging SHA — skips if unchanged since the last review cycle
4. Spawns 4 concurrent `staging-reviewer` sessions (one per review focus):
   - `antipattern` — checks for G001–G019 anti-pattern violations
   - `code-quality` — security, correctness, performance, maintainability
   - `user-alignment` — verifies changes align with original user intent from prompts
   - `spec-compliance` — verifies adherence to project specifications
5. Records `state.lastStagingReviewedSha = currentSha` so the same set of commits is not reviewed again

**`staging-reviewer` agent** (`agents/staging-reviewer.md`): Sonnet-tier. Receives `review_focus` in its prompt, runs `git diff origin/main..origin/staging`, reports critical issues via `mcp__agent-reports__report_to_deputy_cto`, and spawns `code-writer` sub-agents for fixes. Reports are automatically tagged `tier: 'staging'` via `GENTYR_REPORT_TIER=staging` injected into the session environment. Maximum 3 reports per session to prevent noise. Only critical issues are escalated; minor style issues are ignored.

## CTO Session Search

The `search_cto_sessions` tool on the `agent-tracker` MCP server filters session files to user-only (non-autonomous) sessions before searching.

- Scans `~/.claude/projects/{encoded-project-path}/` for session JSONL files
- Reads first 2KB of each file; skips sessions containing `[Automation]`, `[Task]`, or `[AGENT:` markers (autonomous)
- Searches remaining files for the query string (case-insensitive)
- Returns matching excerpts with surrounding context lines
- Used by the gate agent to check if the CTO recently discussed a topic (CTO intent check)

## Compaction-Aware Session Reading

Agent-tracker session introspection tools detect and recover context lost when Claude Code compacts a session's context window. When compaction occurs, the `.jsonl` file contains a `compact_boundary` marker followed by a system-injected summary of pre-compaction work.

**3 tools with compaction awareness** (on `agent-tracker` server):

- `peek_session` — reads session tail and returns `compactionDetected: boolean` at zero cost. Pass `include_compaction_context: true` to trigger a backward file scan that retrieves the full compaction summary, boundary count, most-recent timestamp, and pre-compaction token total. Also returns `activeSubagents` (array of sub-agent session IDs detected via the `subagents/` directory) so monitoring tools can see Agent tool sub-agents spawned by the session. Pass `subagent_id` to drill into a specific sub-agent's activity instead of the parent session. Accepts `agent_id` (format `agent-xxx`), `queue_id` (format `sq-xxx`), or `session_id` (raw Claude session UUID) — `session_id` is required for interactive CTO sessions which have no `agent_id` or `queue_id`. For `--resume` sessions where the agent marker may fall outside the scan window, `peek_session` falls back to the `resume_session_id` column in `session-queue.db` to locate the correct JSONL file.
- `browse_session` — message-indexed session browsing for CTO monitoring. Returns numbered messages (`index`, `type`, `timestamp`, `content`/`tool`/`result_preview`) with backward pagination via `before_index`. Designed for raw session viewing — shows verbatim content with minimal processing. Files >10MB fall back to `peek_session`. Used by `/monitor` to display indexed session history. Also supports `subagent_id` parameter for drilling directly into a sub-agent's session. Accepts `session_id` (raw Claude session UUID) for inspecting interactive CTO sessions that have no `agent_id` or `queue_id`.
- `inspect_persistent_task` — deep inspection tool for persistent task monitors. Auto-includes compaction context for the monitor session (full backward scan at 6000-char summary limit); returns `compactionDetected` for each child session.
- `get_session_activity_summary` — per-session summary includes `compacted: boolean` flag. `extractActivity()` emits `compaction_boundary` activity entries and suppresses system-injected compaction summary messages to avoid polluting the activity log with noise.

**`CompactionContext` shape**: `{ boundaryCount, mostRecentSummary, mostRecentTimestamp, preTokensTotal }`. The `mostRecentSummary` field contains the compaction summary text (up to `maxSummaryChars`), which persistent monitors use to reconstruct context after revival into a fresh session.

**Agent-initiated compaction** (`request_self_compact` tool on `agent-tracker` server): Allows a spawned agent to request context compaction when its context window is growing large. The tool records the request to `.claude/state/compact-tracker.json` (keyed by session ID), captures the current token count from the session JSONL tail, and returns instructions telling the agent to call `summarize_work` and exit. After the session dies, `spawnQueueItem` in `session-queue.js` detects `spawn_type === 'resume'` and calls `compactSessionIfNeeded()` from `compact-session.js` before re-spawning — this runs `claude --resume <sessionId> -p /compact` in the worktree directory, compressing the dead session's context window before the revived session inherits it. Configurable thresholds: `revival_compact_min_tokens` (default 200K), `revival_compact_max_minutes` (default 30 min since last compaction), `revival_compact_timeout_ms` (default 120s).

**Context pressure monitoring** (`context-pressure-hook.js` PostToolUse): Fires on every tool call in spawned sessions. Monitors two dimensions simultaneously: context window token count (read from JSONL tail) and wall-clock session age. Three configurable tiers per dimension — `suggestion`, `warning`, and `critical` — with per-tier cooldowns (default 5 min) to prevent nudge spam. At the critical tier the hook calls `mcp__agent-tracker__request_self_compact` automatically. All thresholds are configurable in `automation-config.json`: `context_pressure_suggestion_tokens` (200K), `context_pressure_warning_tokens` (300K), `context_pressure_critical_tokens` (400K), `context_pressure_suggestion_minutes` (15), `context_pressure_warning_minutes` (30), `context_pressure_critical_minutes` (60), `context_pressure_nudge_cooldown_minutes` (5). The CTO notification hook gains a live context-window display line showing current token count and percentage bar.

## User Prompt References System

Traceability chain from user prompts through tasks, specs, and implementations. Every task and spec can carry references to the original user prompts that motivated them, allowing the `user-alignment` agent to verify delivered code matches user intent before it ships.

**Prompt index** (in `agent-tracker` DB, `user_prompts` table): SQLite FTS5 virtual table indexes user/human messages from session JSONL files. UUIDs are deterministic: `up-{sessionId[0:8]}-{hash}-{lineNumber}`. Auto-indexed on SessionStart.

**3 MCP tools** (on `agent-tracker` server):
- `get_user_prompt` — look up a prompt by UUID; `nearby: N` returns N surrounding messages for context
- `search_user_prompts` — FTS5 ranked search (falls back to LIKE); returns UUID, timestamp, content preview, relevance rank
- `list_user_prompts` — list recent prompts; optional `session_id` filter

**Schema extensions**:
- `todo-db` tasks: `user_prompt_uuids TEXT` column (JSON array of UUIDs); auto-migrated on DB open. `ListTasksInput` gains `prompt_uuid` filter.
- `specs-browser` specs: `user_prompt_refs` field (UUID array) in spec frontmatter.

**Prompt injection** (`.claude/hooks/lib/user-prompt-resolver.js`): Shared module that resolves UUIDs to content by scanning session JSONL files directly (no DB dependency). Called by `urgent-task-spawner.js` and `hourly-automation.js` to prepend a `## Referenced User Prompts` block into agent prompts when `user_prompt_uuids` is set on the task. Caps at 5 UUIDs per task, 2000 chars per prompt.

**`user-alignment` agent** (`agents/user-alignment.md`): Read-only auditor that runs after the code-reviewer in the standard development workflow. Looks up `user_prompt_uuids` on the task (falls back to keyword search), checks `userPromptRefs` in related specs, reviews `git diff`, and verifies the implementation addresses user intent. Creates `CODE-REVIEWER` fix tasks for misalignments; escalates significant drift to the deputy-CTO. Does NOT edit files or commit.

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by unexpected process death. Dead Agent Recovery Hook runs at SessionStart; Session Reviver runs every 10 minutes from hourly automation.

**Revival daemon** (`scripts/revival-daemon.js`): Persistent `fs.watch()` + polling daemon for sub-second crash detection. Integrated as a launchd/systemd service via `setup-automation-service.sh`.

**Memory pressure rate limiting** (`lib/memory-pressure.js`): Shared module monitoring free RAM (macOS `vm_stat` / Linux `/proc/meminfo`). Blocks all spawning at critical pressure; defers non-urgent spawning at high pressure. Exception: spawns with `priority: 'cto'` or `priority: 'critical'` are always allowed even at critical pressure — this ensures persistent monitor revival (which re-enqueues at `critical` priority) is never blocked by memory. Used by stop hook, session reviver, universal task spawner, hourly automation, and the session queue drain path.

> Full details: [Automatic Session Recovery](docs/CLAUDE-REFERENCE.md#automatic-session-recovery)

## Centralized Session Queue

All agent spawning routes through a single SQLite-backed queue (`session-queue.db`). Every call site that previously called `registerSpawn() + spawn('claude', ...) + updateAgent()` now calls `enqueueSession()`. The queue enforces a global concurrency limit, priority ordering, and lane-based sub-limits.

**Queue module** (`.claude/hooks/lib/session-queue.js`): Core module. DB at `.claude/state/session-queue.db` (WAL mode). Log at `.claude/session-queue.log`. **DB corruption auto-recovery**: `getDb()` runs `PRAGMA integrity_check(1)` on every open. If the DB is malformed (e.g., from power loss mid-write), the corrupted DB plus `-wal` and `-shm` files are renamed aside as `.corrupt.{timestamp}`, a fresh DB is created, and a `session_queue_db_recovered` audit event is emitted. The session queue is ephemeral — running sessions track their own PIDs independently and are re-discovered by the revival daemon.

**Schema**: `queue_items` table (status, priority, lane, spawn_type, agent_type, hook_type, prompt, model, cwd, pid, enqueued_at, spawned_at, completed_at, expires_at) + `queue_config` table (key/value for `max_concurrent_sessions`).

**Priority ordering**: `cto` > `critical` > `urgent` > `normal` > `low`.

**Status values**: `queued`, `spawning`, `running`, `suspended`, `completed`, `failed`, `cancelled`.

**Lane sub-limits**: The `gate` lane (Haiku gate agents) is capped at 5 concurrent regardless of the global limit. The `automated` lane has no concurrency limit — 22 background automation sources (`hourly-automation`, `demo-failure-spawner`, `antipattern-hunter-hook`, `session-reviver`, `drain-step-1d`, `session-reaper-audit-revival`, and others) are auto-promoted from `standard` to `automated` on enqueue via `AUTOMATED_SOURCES` in `session-queue.js`. Automated sessions do not consume standard concurrency slots, so background system work never blocks CTO-directed tasks. Only auto-promoted when the incoming `spec.lane` is unset or `standard` — explicit lane assignments (`persistent`, `gate`, `audit`, etc.) are always respected.

**Default TTL**: Queued items expire after 30 minutes if not drained.

**Default concurrency**: 10 (configurable 1–50 via `set_max_concurrent_sessions` MCP tool or `/concurrent-sessions N` slash command).

**Inline preemption** (`preemptLowestPriority()`): When a `cto` or `critical` item is dequeued and the queue is at capacity, `drainQueue()` suspends the lowest-priority running session via SIGTSTP instead of waiting for a free slot. The suspended session's status is set to `suspended` (does not count toward the global concurrency limit). After the high-priority session completes and capacity frees up, Step 6 of `drainQueue()` resumes suspended sessions via SIGCONT. If a session dies while suspended, its linked TODO task is reset to `pending`. Emits `session_suspended` and `session_preempted` audit events. Unlike the legacy `preemptForCtoTask()` (which killed and re-enqueued), this is non-destructive — the session resumes from exactly where it stopped.

**5 MCP tools** (on `agent-tracker` server):
- `get_session_queue_status` — running items (with PID liveness), queued items, suspended items, capacity info, memory pressure level, and 24h throughput; check `memoryPressure` field when items are queued but not spawning. Returns `standardRunning` (sessions consuming concurrency slots) and `automatedRunning` (automated-lane sessions, no slot cost) separately; `availableSlots` is computed from `standardRunning` only
- `set_max_concurrent_sessions` — update global limit (1–50); takes effect on next drain cycle
- `cancel_queued_session` — cancel a queued (not yet running) item by queue ID
- `drain_session_queue` — trigger an immediate drain; returns `memoryBlocked` count if memory pressure prevented spawning
- `activate_queued_session` — instantly activate a queued session by promoting it to CTO priority and spawning it; if at capacity, suspends the lowest-priority running session to make room

**Dashboard integration**: `SessionQueueSection` React component on CTO Dashboard Page 1. Data read from `session-queue.db` via `packages/cto-dashboard/src/utils/session-queue-reader.ts`. Green/yellow/red color coding for capacity utilization.

**Slash commands**: `/session-queue` (show queue status via `show_session_queue`) and `/concurrent-sessions [N]` (view or update concurrency limit).

**Revival integration**: `scripts/revival-daemon.js` calls `drainQueue()` on agent death to unblock queued items when capacity frees up.

**Dedup-by-taskId**: `enqueueSession()` checks for an existing `queued`, `running`, or `spawning` item with the same `metadata.taskId` **and the same lane** before inserting. If found, returns the existing queue item immediately (no duplicate spawn). Lane-scoped dedup ensures audit-lane auditors are not blocked by the original task running in the standard lane — the same `taskId` can exist in different lanes simultaneously (e.g., the task agent in `standard` and its auditor in `audit`). A second dedup layer checks `metadata.persistentTaskId` for persistent-lane items, preventing duplicate monitor spawns when multiple revival mechanisms fire concurrently for the same persistent task. A third dedup layer checks `tagContext` for values ending in `-promotion` — prevents duplicate preview-promoter sessions when hourly automation re-triggers while an existing promoter is still running.

**Agent definition loading** (`--agent` flag): The `queue_items` schema includes an `agent TEXT` column. When `spec.agent` is passed to `enqueueSession()`, `spawnQueueItem()` adds `--agent <name>` to the Claude CLI args, causing the spawned session to load the corresponding `.claude/agents/<name>.md` agent definition. This enforces model, allowedTools, and behavioral instructions from the agent definition. Key agent mappings: plan-manager monitors pass `agent: 'plan-manager'`, regular persistent monitors pass `agent: 'persistent-monitor'`, demo repair agents pass `agent: 'demo-manager'`. The shared revival prompt builder (`buildPersistentMonitorRevivalPrompt`) returns the `agent` field alongside `prompt`, `extraEnv`, and `metadata`.

**Reserved Pool Slots** (`getReservedSlots`/`setReservedSlots`): An integer number of concurrency slots (0–10) that are held back for priority-eligible sessions (`cto`, `critical`, `urgent`). Non-priority-eligible items see `maxConcurrent - reservedSlots` as their effective cap, while priority-eligible items always see the full `maxConcurrent`. `isPriorityEligible()` determines eligibility based on item priority. **Auto-activate**: When the `persistent-task-spawner.js` hook fires on `activate_persistent_task` or `resume_persistent_task`, it sets 2 reserved slots to ensure the newly spawned monitor and any urgent follow-up agents are never blocked by low-priority queue traffic. **Auto-deactivate**: `hourly-automation.js` resets reserved slots to 0 when no persistent tasks are `active` or `paused`. **Auto-restore timer**: `setReservedSlots(n, { restoreAfterMinutes: N })` persists a restore record in `queue_config`; `drainQueue()` (Step 2.5) checks and auto-restores to the prior default after the timer elapses. **2 MCP tools** (on `agent-tracker` server): `set_reserved_slots` (set count + optional auto-restore timer) and `get_reserved_slots` (read current value and pending restore info). Reported in `get_session_queue_status` under `reservedSlots` and `reservedSlotsRestore`.

**Focus Mode**: Blocks all automated agent spawning except CTO-directed work, persistent task monitors, and session revivals. State persisted at `.claude/state/focus-mode.json`. Gate applied inside `enqueueSession()` — blocked spawns return `{ queueId: null, blocked: 'focus_mode' }` immediately. **Allowed through focus mode**: `priority: cto/critical`, `lane: persistent/gate/revival/automated`, `source: force-spawn-tasks/persistent-task-spawner/stop-continue-hook/session-queue-reaper/sync-recycle`, and any item with `metadata.persistentTaskId` set. **2 MCP tools** (on `agent-tracker` server): `set_focus_mode` (enable/disable) and `get_focus_mode` (read state + list of allowed sources). **Session briefing**: When focus mode is active, a prominent notice appears at the top of the interactive session briefing. **Slash command**: `/focus-mode` — reads current state and toggles to the opposite. Reported in `get_session_queue_status` under `focusMode`.

### Session Reaper

Two-pass reaping engine that detects and cleans up dead or stuck sessions in the queue.

**Sync pass** (`reapSyncPass(db)`): Called from `drainQueue()` on every drain cycle. Fast, synchronous, no process kills. Detects dead PIDs (process.kill(pid, 0) fails) and classifies them: sessions that died within 30 seconds of spawning with no JSONL output are marked `failed` with `error = 'no_output_crash'` (crash death classification); all others are marked `completed`. Emits `session_reaped_dead` audit events and returns a `stuckAlive` list for the async pass and an `auditRevivals` list for Step 1b.5 auditor re-spawning. Also kills stale persistent monitors directly in the sync pass (stale heartbeat detected via `persistent_heartbeat_stale_minutes`, default 5 min — configurable), triggering immediate revival via `requeueDeadPersistentMonitor()` in Step 1b rather than waiting for the async pass. **Audit revival detection**: When a dead session is in the `audit` lane and its linked task is still `pending_audit`, the sync pass preserves the audit gate state (does NOT reset the task to `pending`) and adds the item to `auditRevivals[]` for `drainQueue()` Step 1b.5 to re-spawn a fresh auditor. Handles four task types: todo-db tasks (queries `todo.db`), persistent tasks (queries `persistent-tasks.db`), plan tasks (`taskType === 'plan'` or `metadata.planId` set — queries `plans.db` for the `plan_tasks` row, checks `status === 'pending_audit'`), and authorization tasks (`taskType === 'authorization'` — queries `cto_decisions` table in `bypass-requests.db`, checks `status === 'audit_pending'`). All four paths use `buildAuditorSessionSpec()` from `lib/auditor-prompt.js` for the revival spawn.

**Auth-stall detection** (`isAuthStalled(sessionFile)`): Reads the JSONL tail of a running session's file. If the last 3+ consecutive entries are all auth errors (`"authentication_error"`, `"permission_error"`, or similar), the session is considered auth-stalled. The sync pass applies this check to ALL running sessions whose JSONL file hasn't been updated in `auth_stall_detection_minutes` (default 2 min). Auth-stalled sessions are killed immediately with `reapReason: 'auth_stall'` and linked TODO tasks are reset to `pending`.

**Failure diagnosis** (`diagnoseSessionFailure(sessionFile)`): Exported from `session-reaper.js`. Reads the JSONL tail and classifies the terminal failure mode — scanning backward through the last N lines to count consecutive error entries. Returns `{ stalled, error_type, is_transient, consecutive_errors, sample_error, suggested_action }`. Error types: `rate_limit` (rate-limit or usage-limit messages, `is_transient: true`), `auth_error` (401/authentication errors, `is_transient: false`), `crash` (any other consecutive error pattern, `is_transient: false`), `unknown` (no error pattern detected). Used by the sync pass for persistent-lane dead sessions (attaches `diagnosis` to each reaped item) and by auth-stall detection. The structured output feeds directly into `handleBlocker()` in `blocker-auto-heal.js` to drive self-healing decisions. `isAuthStalled()` is now a thin backward-compat wrapper around `diagnoseSessionFailure().stalled`.

**Async pass** (`reapAsyncPass(projectDir, stuckAliveItems)`): Called from `hourly-automation.js`. For sessions alive longer than `session_hard_kill_minutes` (default 60 min), performs multi-signal completion check — JSONL last-message analysis (no pending tool_use), terminal tool detection (`complete_task`/`summarize_work` in last 16KB), and zombie/stopped process state. If any signal is positive, the session is killed and marked `completed` (reaped). If no signal, it's hard-killed and marked `failed`. Hard kills reset the linked TODO task to `pending` and write a deputy-CTO report. **Per-task override**: If the session is linked to a persistent task with `hard_kill_minutes` set in its `metadata` JSON, that value overrides the global `session_hard_kill_minutes` threshold for that session, enabling long-running tasks (e.g., multi-hour demos) to avoid premature termination.

**TODO reconciliation**: After reaping, `reconcileTodo()` updates the linked `todo.db` task — `completed` for reaped sessions where a terminal tool was detected, `pending` (reset) for hard-killed sessions.

**Gate lane exemption**: Gate-lane agents (Haiku task gate) are exempt from both passes — they're lightweight and short-lived.

**Configurable thresholds**: `session_hard_kill_minutes` (default 60), `persistent_heartbeat_stale_minutes` (default 5), and `auth_stall_detection_minutes` (default 2) — all in `automation-config.json`. Per-task override: set `hard_kill_minutes` in a persistent task's `metadata` JSON to override the global hard-kill threshold for that task's monitor sessions.

**Key files**: `.claude/hooks/lib/session-reaper.js` (core), `.claude/hooks/hourly-automation.js` (async pass trigger via `runIfDue('session_reaper', ...)`).

**Legacy coexistence**: `scripts/reap-completed-agents.js` (deprecated) still operates on `agent-tracker-history.json` for any agents not routed through the queue. Both coexist.

### Shared Resource Registry

SQLite-backed multi-resource coordination system. Worktree agents acquire exclusive access to shared main-tree resources via acquire/release/renew/queue semantics, preventing concurrent conflicts (e.g., overlapping headed demos, simultaneous chrome-bridge sessions, or competing dev server owners).

**Module**: `.claude/hooks/lib/resource-lock.js` (canonical). `.claude/hooks/lib/display-lock.js` is a 19-line backward-compat re-export shim — all existing callers continue to work unchanged. DB at `.claude/state/display-lock.db` (same file, migrated schema). Logs to `session-queue.log`.

**Built-in resources**: `display` (headed browser / ScreenCaptureKit, TTL 15 min), `chrome-bridge` (real Chrome via Claude for Chrome extension, TTL 15 min), `main-dev-server` (port 3000 dev server, TTL 30 min). Additional resources can be registered dynamically via `register_shared_resource`.

**Lock semantics** (per resource): TTL auto-expiry prevents orphaned locks when holders die. Holder must renew every ~5 min to stay alive. On expiry or dead-holder detection: `checkAndExpireResources()` (called from `drainQueue()`) checks holder PID liveness first (fast-path via `getAgentPid()` + `isPidAlive()` cross-referencing `session-queue.db`) — dead holders are released immediately without waiting for TTL. Live holders that have passed TTL are also released. After clearing the lock, `promoteNextWaiter()` loops through waiting agents, skipping any whose PID is confirmed dead (marks them `status = 'skipped'`), and promotes the first live waiter found. On agent death: session-reaper calls `releaseAllResources()` and `removeFromAllQueues()` for all resources held or queued by the dead agent. Headless demos do NOT need the display lock.

**6 MCP tools** (on `agent-tracker` server):
- `acquire_shared_resource` — request exclusive access to a named resource; returns `{ acquired: true }` or `{ acquired: false, position: N, holder: {...} }` with auto-enqueue on contention
- `release_shared_resource` — release a resource after work completes; promotes next waiter
- `renew_shared_resource` — heartbeat to prevent TTL expiry (call every ~5 min during long sessions)
- `get_shared_resource_status` — status of one resource (by `resource_id`) or all registered resources (omit argument)
- `register_shared_resource` — add a new resource type to the registry with a custom `default_ttl_minutes`
- `force_release_shared_resource` — CTO override: force-releases a lock regardless of holder identity, purging dead waiters before promoting the next live one; use when the holder is confirmed dead/stuck and waiting for TTL expiry is unacceptable. **Blocked for spawned sessions** (`CLAUDE_SPAWNED_SESSION=true`) — spawned agents cannot seize CTO-held locks; they must use `acquire_shared_resource` and wait in the queue. Locks marked `protected_by` additionally require `ctoOverride: true` to release.

**Playwright server display lock tools** (`acquire_display_lock`, `release_display_lock`, `renew_display_lock`, `get_display_queue_status`) remain available as backward-compat aliases via the shim.

**Auto-acquire in `run_demo`**: When `recorded: true` (the default, which sets headed mode), `run_demo` automatically acquires the `display` resource if not already held (tracked in `DemoRunState`). Released automatically on demo completion, crash, or stop. Agents may also acquire manually before calling `run_demo`.

**`forceAcquireResource(resourceId, agentId, queueId, title, opts)`** (exported from `resource-lock.js`): Programmatic force-acquisition for non-MCP callers. Atomically displaces the current holder (if any), re-enqueues them as an `urgent`-priority waiter (configurable via `opts.reEnqueuePriority`), and assigns the lock to the caller. Returns `{ acquired: boolean, prev_holder?: { agent_id, queue_id, title, acquired_at } }`. Emits a `resource_lock_force_acquired` audit event. Accepts `opts.protectedBy` (string): when set, the value is stored in the `protected_by` column on the lock row; subsequent `forceReleaseResource` calls are refused unless `opts.ctoOverride` is passed, protecting CTO-held locks from being seized by spawned agents. Used by `packages/cto-dashboard-live/utils/display-lock-manager.ts` (`preemptForCtoDashboardDemo`) to atomically take display + chrome-bridge when the CTO launches a dashboard demo (with `protectedBy: 'cto-dashboard'`), with a follow-up signal to the displaced agent to pause and resume.

**Session reaper integration**: `reapSyncPass()` calls `releaseAllResources(agentId)` and `removeFromAllQueues(agentId)` for any agent it marks as dead, releasing all resources at once regardless of how many the agent held.

**Audit events**: `display_lock_acquired`, `display_lock_released`, `display_lock_renewed`, `display_lock_expired`, `display_lock_enqueued`, `display_lock_promoted`, `resource_lock_force_released`, `resource_lock_force_acquired` — all emitted to `session-audit.log` (event names preserved for backward compatibility; `resource_lock_force_released` is emitted on CTO MCP override or dead-holder auto-release; `resource_lock_force_acquired` is emitted by `forceAcquireResource()` when a new caller atomically displaces the current holder).

### Session Audit Log

Structured JSON-lines audit trail covering the full session lifecycle.

**Log file**: `.claude/state/session-audit.log`. JSON-lines format, one event per line. 30-day retention, 50MB cap (halved on overflow), atomic tmp+rename cleanup.

**Event types**: `session_enqueued`, `session_spawned`, `session_completed`, `session_failed`, `session_cancelled`, `session_ttl_expired`, `session_reaped_dead`, `session_reaped_complete`, `session_hard_killed`, `session_revival_triggered`, `session_suspended`, `session_preempted`, `session_sync_recycled`, `session_sync_revived`, `display_lock_acquired`, `display_lock_released`, `display_lock_renewed`, `display_lock_expired`, `display_lock_enqueued`, `display_lock_promoted`, `persistent_task_paused`, `persistent_task_cancelled`, `audit_revival_candidate` (sync pass flagged a dead auditor for re-spawn), `audit_session_revived` (Step 1b.5 spawned a fresh auditor), `session_queue_db_recovered` (DB corruption detected and fresh DB created). Task lifecycle events (emitted by `todo-db` MCP server): `task_created`, `task_completed`, `task_deleted`, `task_gate_killed`, `task_gate_approved`, `task_status_changed`.

**Emission points**: `session-queue.js` (all lifecycle transitions), `session-reviver.js` (all 3 revival modes), `stop-continue-hook.js` (inline revival), `revival-daemon.js` (dead agent detection and revival), `persistent-task-spawner.js` (pause and cancel lifecycle transitions), `cli/commands/sync.js` (`session_sync_recycled` on kill, `session_sync_revived` on re-enqueue), `todo-db/server.ts` (task lifecycle: create, complete, delete, gate approve/kill, status changes).

**Cleanup**: `cleanupAuditLog()` called from hourly-automation's `session_reaper` runIfDue block. Also triggered internally every 100 writes when file exceeds 50MB.

**Key file**: `.claude/hooks/lib/session-audit.js`.

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

### SessionStart Hooks — No stderr

`SessionStart` hooks must **never** write to `stderr` under any conditions. Claude Code treats any stderr output from a `SessionStart` hook as an error, displaying "SessionStart:startup hook error" in the UI even when the hook exits cleanly with valid JSON on stdout. This applies to all 9 `SessionStart` hooks: `gentyr-sync.js`, `gentyr-splash.js`, `todo-maintenance.js`, `credential-health-check.js`, `plan-briefing.js`, `playwright-health-check.js`, `dead-agent-recovery.js`, `crash-loop-resume.js`, and `session-briefing.js`.

Rules:
- **Never** call `process.stderr.write()` or `console.error()` in a `SessionStart` hook or any library it imports.
- Route all non-fatal errors to `systemMessage` in the JSON stdout response.
- Fatal/unexpected errors should exit with `{ continue: true, systemMessage: "..." }` — never with `process.exit(1)` or a raw stderr write.
- The cross-hook guard test at `.claude/hooks/__tests__/session-start-no-stderr.test.js` enforces this with static analysis + runtime subprocess checks (36 tests).

## CTO Bypass Request System

Agents blocked by access, authorization, or resource constraints can pause themselves and request CTO authorization rather than failing silently or spinning in retry loops. The CTO sees pending requests in the next interactive session briefing and resolves them with a single MCP tool call.

**DB**: `.claude/state/bypass-requests.db` (SQLite, auto-created). Three tables: `bypass_requests` with `id`, `task_type` (`persistent`/`todo`), `task_id`, `task_title`, `agent_id`, `category`, `summary`, `details`, `status` (`pending`/`approved`/`rejected`/`cancelled`), `resolution_context`, `resolved_at`, `resolved_by`, `pause_duration_minutes` (optional — when set, the pause auto-expires without CTO action), `auto_resume_at` (ISO timestamp — computed as `created_at + pause_duration_minutes` when `pause_duration_minutes` is set), `created_at`; `blocking_queue` (see below); and `deferred_actions` (see Deferred Protected Actions section). Two indexes on `status` and `(task_type, task_id)` for `bypass_requests`.

**Bypass categories** (passed as `category` to `submit_bypass_request`): guides the CTO on what kind of authorization is needed — e.g., `"infrastructure"`, `"secrets"`, `"scope"`, `"access"`, or any custom string.

**Agent workflow**: An agent that needs CTO authorization calls `submit_bypass_request` with `task_type`, `task_id`, `category`, `summary`, and `details`. Optionally, `pause_duration_minutes` (integer, 1–60) can be passed for short bounded pauses that do not require CTO approval — the pause auto-expires and the task resumes automatically when the timer elapses. Pauses >60 min or with no duration require CTO action. The tool pauses the relevant task (persistent → `paused` with `reason: 'cto_bypass_request'`; todo → `pending` so spawning is blocked by the bypass guard), emits a signal to the CTO's interactive session (unless the pause is timed), and returns instructions: write a `last_summary`, then exit. The agent MUST call `summarize_work` and stop — it must not continue working.

**Dedup guard**: `submit_bypass_request` checks for an existing `pending` request for the same `(task_type, task_id)` pair before inserting. Duplicate submissions are rejected with an error pointing to the existing request ID.

**CTO workflow**: Pending requests appear in the `=== CTO BYPASS REQUESTS AWAITING DECISION ===` section of the interactive session briefing (above the Persistent Tasks section) with title, type, category, age, summary, and the exact `resolve_bypass_request` invocation to copy. The CTO calls `resolve_bypass_request` with `request_id`, `decision` (`"approved"` or `"rejected"`), and `context` (instructions for the agent on how to proceed). On approval: persistent tasks are set to `active` and a monitor is immediately enqueued in the `persistent` lane at `critical` priority, with the CTO's approval context injected into the revival prompt. Todo tasks are left in `pending` — the bypass guard clears and normal spawning resumes on the next drain cycle, with the approval context injected via `getBypassResolutionContext()`. On rejection: persistent tasks stay `paused`, todo tasks stay `pending`, and the rejection context is injected into the next revival/spawn so the agent can take an alternative approach.

**Auto-cancel**: `list_bypass_requests` (and `resolve_bypass_request`) auto-cancel requests for tasks that no longer exist or are already `completed`/`cancelled`, returning `auto_cancelled: true` so the CTO knows no action is needed.

**Revival guard** (`lib/bypass-guard.js`): Shared read-only module with two exports:
- `checkBypassBlock(taskType, taskId)` — returns `{ blocked: true, requestId, summary, category, auto_resume_at? }` if a `pending` request exists; `{ blocked: false }` otherwise. `auto_resume_at` is included when the pause is timed (i.e., set to auto-expire). Fail-open on any error (never blocks revival due to DB unavailability).
- `getBypassResolutionContext(taskType, taskId)` — returns the most-recent resolved (`approved`/`rejected`) request's `{ decision, context, requestId, category, summary }` for injection into revival prompts.

**Integration points** (bypass guard applied at 4 locations):
- `session-queue.js` `requeueDeadPersistentMonitor()` — skips revival if a pending bypass request exists
- `session-queue.js` `spawnQueueItem()` — injects approval/rejection context into spawn prompt when a resolved request exists
- `hourly-automation.js` `persistent_stale_pause_resume` — skips auto-resume for tasks with pending bypass requests
- `crash-loop-resume.js` SessionStart hook — skips crash-loop auto-resume for tasks with pending bypass requests
- `session-reviver.js` — skips revival for tasks with pending bypass requests
- `persistent-monitor-revival-prompt.js` — injects bypass resolution context block when `getBypassResolutionContext()` returns a result

**Session briefing integration**: `session-briefing.js` adds a `=== CTO BYPASS REQUESTS AWAITING DECISION ===` block to the interactive briefing when pending requests exist. Pause reason detection extended to include `'bypass-request'` alongside `'crash-loop'` and `'manual'` — the PAUSED TASKS summary line now shows the breakdown (e.g., `"2 bypass-request, 1 crash-loop, 1 manual"`). A separate `=== WORK BLOCKED — CTO ACTION REQUIRED ===` section lists active `blocking_queue` items (grouped by blocking level) when any exist. The CTO notification hook's status line also shows a `N BLOCKING` prefix when blocking queue items are active.

**Blocking queue** (`blocking_queue` table in `bypass-requests.db`): Tracks work-stopping items with hierarchical severity. Populated automatically by `pause-propagation.js` when a persistent task pause propagates up to the plan layer. Fields: `id`, `bypass_request_id` (optional link to a bypass request), `source_task_type`, `source_task_id`, `persistent_task_id`, `plan_task_id`, `plan_id`, `plan_title`, `blocking_level` (`task` / `persistent_task` / `plan`), `impact_assessment` (JSON: blocked_tasks, blocks_phase, is_gate, parallel_paths_available), `summary`, `status` (`active` / `resolved` / `superseded`), `resolved_at`, `resolution_context`. Resolved automatically when `propagateResumeToPlan()` fires on persistent task resumption; can also be resolved manually via `resolve_blocking_item`.

**3 blocking queue MCP tools** (on `agent-tracker` server):
- `list_blocking_items` — list active (or all) blocking queue items, optionally filtered by `plan_id`
- `resolve_blocking_item` — manually mark a blocking item resolved with optional `resolution_context`
- `get_blocking_summary` — aggregate count of active blocking items by level and plan

**Timed pause auto-resume**: `hourly-automation.js` runs a `timed_pause_auto_resume` gate-exempt check every 1 minute. It queries `bypass_requests` for `pending` rows where `auto_resume_at IS NOT NULL AND auto_resume_at <= now`. For each expired timed pause: the bypass request is auto-resolved (status set to `approved`, `resolved_by: 'timed_pause_auto_resume'`), the linked persistent task is re-activated via `resume_persistent_task`, and `propagateResumeToPlan` clears any `blocking_queue` entries. CTO is NOT notified for timed pauses — they resolve autonomously. Cooldown key: `timed_pause_auto_resume: 1` in `config-reader.js` DEFAULTS.

**3 MCP tools** (on `agent-tracker` server, version 9.3.0):
- `submit_bypass_request` — agent-facing; submits a bypass request and pauses the task. Accepts optional `pause_duration_minutes` (1–60) for short auto-expiring pauses that don't require CTO approval. After submitting, the agent MUST summarize work and exit.
- `resolve_bypass_request` — CTO-facing; approves or rejects a pending request. On approval of a persistent task, immediately enqueues a revival monitor.
- `list_bypass_requests` — CTO-facing; lists requests by status (default: `pending`). Auto-cancels stale requests for gone/completed tasks.

## Deferred Protected Actions

Both interactive and spawned sessions now use the deferred action system when hitting protected action blocks. When a session hits a protected action block, `protected-action-gate.js` stores the exact tool call (server, tool, args) in a persistent DB and the agent presents the deferred action to the CTO via `record_cto_decision`. The CTO does NOT need to type a phrase or approve code — the agent records the CTO's verbatim response, and the authorization audit chain executes the action autonomously after audit pass.

**Key distinction from old approval system (deprecated)**: The old `APPROVE <phrase> <code>` pattern required the requesting agent to be alive and retry. The deferred action system is fully asynchronous — the requesting agent exits immediately after calling `record_cto_decision`, and `deferred-action-audit-executor.js` executes the blocked call autonomously after the `authorization-auditor` passes it.

**Interactive session gate response** (Phase 3): When `protected-action-gate.js` creates a deferred action for an interactive session, it outputs a `permissionDecision: 'deny'` response with the deferred action ID and instructs the agent to call `record_cto_decision` with the CTO's verbatim approval. No phrase or code required — the session JSONL is the audit trail.

**Spawned agent gate response**: When `protected-action-gate.js` creates a deferred action for a spawned agent, it outputs a `permissionDecision: 'deny'` response with `permissionDecisionReason` containing the deferred action ID and the exact `submit_bypass_request` arguments the agent must call before exiting. This ensures spawned agents always file a bypass request so the CTO can unblock stalled work.

**DB**: `deferred_actions` table in `.claude/state/bypass-requests.db` (shared with `bypass_requests` table). Fields: `id`, `server`, `tool`, `args` (JSON), `args_hash` (SHA256 of args), `source_hook` (which hook created this entry), `code` (6-char approval code — legacy, present for backward compat), `phrase` (legacy), `pending_hmac`, `approved_hmac`, `status` (`pending`/`approved`/`executing`/`completed`/`failed`/`expired`/`cancelled`), `requester_agent_id`, `requester_session_id`, `requester_task_type`, `requester_task_id`, `execution_result`, `execution_error`, timestamps.

**Status lifecycle**: `pending` → `approved` → `executing` → `completed` or `failed`. Atomic transition from `approved` to `executing` prevents double-execution. `expired` for past-TTL pending items; `cancelled` for CTO-cancelled items.

**Execution routing**: Deferred auto-execution supports three paths: Tier 1 servers are called via the shared MCP daemon on port 18090; Bash commands are executed directly via `child_process.execFile` in the deferred action's recorded CWD; and specific Tier 2 state changes (`set_lockdown_mode`, `set_local_mode`) have inline execution paths in the executor that write the state files directly (`automation-config.json` and `local-mode.json` respectively). Other Tier 2 servers require per-session stdio and cannot be auto-executed — the executor shows a manual execution hint for these.

**Authorization audit chain** (new in Phase 1): After `record_cto_decision` is called with the CTO's verbatim approval:
1. `authorization-audit-spawner.js` (PostToolUse) fires. For `lockdown_toggle` and `local_mode_toggle` decisions, execution is **inline** — the spawner directly writes `automation-config.json` or `local-mode.json` and transitions the decision to `audit_passed` without spawning an auditor (interactive sessions have no `agent_id`/`queue_id` so `peek_session` cannot verify them; the JSONL quote verification in `record_cto_decision` is sufficient proof). For all other decision types, the spawner enqueues an `authorization-auditor` in the `audit` lane.
2. The `authorization-auditor` uses `peek_session` with the CTO's `session_id` to read the session JSONL — verifies context accuracy and scope match
3. On pass: `deferred-action-audit-executor.js` (PostToolUse on `cto_decision_audit_pass`) executes the blocked action via MCP daemon or Bash
4. On fail: the blocked action is not executed; the agent is signaled with the mismatch reason
5. Stale `authorization-auditor` sessions are auto-revived by `session-reaper.js` Step 1b.5

**`cto_decisions` table** (in `bypass-requests.db`, auto-migrated): Tracks CTO authorization decisions for the audit chain. Fields: `id`, `decision_type`, `decision_id`, `verbatim_text`, `session_id`, `session_file_hash`, `hmac`, `status` (`pending`/`verified`/`audit_pending`/`audit_passed`/`audit_failed`/`consumed`), `decision_context` (JSON — what will actually be executed), `audit_session_id`, `audit_verdict`, `audit_evidence`, `audit_completed_at`, `consumed_at`, `created_at`. The `decision_type` field routes to different verification logic: `'bypass_request'`, `'lockdown_toggle'`, `'deferred_action'`, `'audit_override'`.

**Security model**:
- CTO approval is recorded verbatim + hashed in `cto_decisions` — agents cannot fabricate or alter it
- Independent auditor reads the actual session JSONL via `peek_session` — not agent claims or summaries
- `args_hash` binding prevents bait-and-switch (executed args must match stored args)
- Audit-override decision type (`'audit_override'`) skips the auditor for CTO-initiated force-overrides
- Fail-closed: session unavailable or compacted beyond recovery → FAIL verdict
- Stale auditors are auto-revived (never permanently stuck in `audit_pending`)

**Legacy CTO workflow** (deprecated, pending Phase 5 cleanup): Pending deferred actions still appear in the `=== DEFERRED PROTECTED ACTIONS AWAITING APPROVAL ===` section of the interactive session briefing. `protected-action-approval-hook.js` (UserPromptSubmit) is deprecated but preserved for the HOTFIX flow.

**Dedup guard**: If the same `server + tool + args_hash` combination already has a `pending` deferred action, the gate hook returns the existing entry rather than creating a duplicate.

**Key modules**:
- `lib/deferred-action-db.js` — DB operations: `createDeferredAction`, `getDeferredActionByCode`, `listPendingDeferredActions`, `markApproved`, `markExecuting`, `markCompleted`, `markFailed`, `cancelAction`, `expireStaleActions`, `findDuplicatePending`
- `lib/deferred-action-executor.js` — Legacy MCP HTTP execution pipeline (pre-Phase 3); retained for reference
- `.claude/hooks/deferred-action-audit-executor.js` — Phase 1 executor: fires on `cto_decision_audit_pass`, loads deferred action, executes via MCP daemon (Tier 1) or Bash (Tier 2), signals original agent

## Hooks Reference

Individual hook specifications for all GENTYR hooks (auto-sync, CTO notification, branch drift, branch checkout guard, main tree commit guard, uncommitted change monitor, PR auto-merge nudge, project-manager reminder, credential health check, credential file guard, playwright CLI guard, playwright health check, worktree path guard, worktree CWD guard, interactive agent guard, interactive session lockdown guard, progress-tracker, long-command-warning).

The **Interactive Session Lockdown Guard** (`.claude/hooks/interactive-lockdown-guard.js`) enforces the deputy-CTO console model: in interactive (non-spawned) sessions, only read/observe tools and GENTYR task/agent management MCP tools are permitted. File-editing tools (`Edit`, `Write`, `NotebookEdit`) and code-modifying sub-agent types are blocked. Spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted. Toggle via `/lockdown on|off` or `mcp__agent-tracker__set_lockdown_mode`. **Plan file whitelist**: writes to `.claude/plans/` and `EnterPlanMode`/`ExitPlanMode` tool calls are always permitted even when lockdown is active, so the CTO can write plan files without disabling lockdown; path traversal is defended via `path.resolve()`. **Memory file whitelist**: writes to `~/.claude/projects/*/memory/` are also always permitted — memory files are auto-memory persistence, not code. **`claude-sessions` tool whitelist**: All `mcp__claude-sessions__` tools (`search_sessions`, `list_sessions`, `read_session`, `list_projects`, `session_stats`) are allowed through lockdown — these are read-only session introspection tools safe for interactive use. **1Password tool whitelist**: 6 `onepassword` MCP tools are individually allowed through lockdown: `check_auth`, `list_items`, `op_vault_map` (read-only, no secret values), `read_secret` (default `include_value: false` only confirms existence — no secret values exposed), `create_item`, and `add_item_fields` (write tools where secret values go direct to `op` CLI, never in agent context). **Authorization required to disable** (Phase 2, implemented): `set_lockdown_mode({ enabled: false })` creates a deferred action in `bypass-requests.db`. The agent presents the deferred action ID to the CTO, records the CTO's verbatim approval via `record_cto_decision({ decision_type: "lockdown_toggle", ... })`, and `authorization-audit-spawner.js` executes inline — it directly writes `automation-config.json` and marks the CTO decision `audit_passed` without spawning an auditor (interactive sessions have no `agent_id`/`queue_id`, so `peek_session` cannot verify them; the JSONL quote verification in `record_cto_decision` is sufficient proof). **Auto-worktree provisioning on disable**: When lockdown is disabled, `authorization-audit-spawner.js` also auto-provisions a `cto-interactive` git worktree and stores its path in `automation-config.json` as `ctoWorktreePath`. When lockdown is re-enabled, `ctoWorktreePath` is cleared. **Lockdown-off enforcement** (safe worktree workflow): Even with lockdown disabled, `interactive-lockdown-guard.js` enforces a safe editing workflow — `Write`/`Edit`/`NotebookEdit` to main-tree files are BLOCKED to prevent conflicts with other running agents. Allowed paths: files inside `.claude/worktrees/` (the provisioned CTO worktree), `.claude/` framework files, and `~/.claude/` memory files. Every approved tool call injects workflow guidance pointing the CTO to their provisioned worktree path. **Lockdown-off agent access**: When lockdown is disabled, `interactive-agent-guard.js` allows ALL agent types including code-modifying agents (`code-writer`, `code-reviewer`, `test-writer`) — previously these were blocked even with lockdown off. `set_local_mode({ enabled: false })` uses the same pattern with `decision_type: "local_mode_toggle"`, writing `local-mode.json` inline. **Legacy bypass** (`bypass-approval-hook.js`, `bypass-approval-token.js`): deprecated, preserved for HOTFIX flow only — lockdown and local-mode no longer use it. **Security invariant**: spawned sessions can never call `set_lockdown_mode({ enabled: false })` — the server-side spawned-session guard fires first, preventing any spawned or misbehaving agent from removing its own constraints. Lockdown toggles emit `lockdown_enabled`/`lockdown_disabled` audit events to `session-audit.log`.

> Full details: [Hooks Reference](docs/CLAUDE-REFERENCE.md#hooks-reference)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos. Uses project-agnostic config discovery from `playwright.config.ts`. Key tools: `launch_ui_mode`, `run_tests`, `run_demo`, `check_demo_result`, `preflight_check`, `run_auth_setup`, `open_video`, `get_demo_screenshot`, `extract_video_frames`, `get_fly_status`, `set_fly_machine_ram`, `get_fly_machine_ram`.

**Remote Playwright Execution (Fly.io)**: When the `fly` section is configured in `services.json`, `run_demo` routes to ephemeral Fly.io machines by default. Key behaviors:
- `run_demo` defaults to `remote: true` — auto-routes to Fly.io when configured. Pass `remote: false` to force local.
- `run_demo` also defaults to `recorded: true` — runs headed with video recording (ScreenCaptureKit locally, Xvfb + ffmpeg on Fly.io). Set `recorded: false` for headless without recording. The low-level `headless` and `skip_recording` params still work as explicit overrides.
- `run_demo_batch` runs multiple scenarios in parallel across Fly machines (limited by `fly.maxConcurrentMachines`, default 10). When all pool slots are contended, the batch waits up to 10 minutes before timing out with a pool contention error.
- Chrome-bridge scenarios and extension demos always run locally. Scenarios with `remote_eligible=false` in the DB are also forced local — this is the authoritative override that takes priority over all heuristic checks. Scenarios with `stealth_required=true` or `dual_instance=true` route exclusively to Steel.dev (Tier 0) and fail-closed if Steel is not configured. `DEMO_HEADLESS` is set dynamically from the resolved `headless` flag (`'0'` when headed, `'1'` otherwise).
- **Worktree branch auto-push**: Before spawning a Fly machine, `server.ts` checks if the current `gitRef` exists on the remote (`git ls-remote --heads origin <ref>`). If not (worktree branches are local-only), it pushes the branch automatically (`git push -u origin HEAD:<ref>`) so the Fly machine can clone it. Falls back to `preview` or `main` if the push fails.
- **Machine kill timeout**: Fly machines are configured with `stop_config.timeout: '75s'` (API) and `kill_timeout = "75s"` in `fly.toml.template` to allow the EXIT trap's 60-second artifact-retrieval window to complete before Fly force-kills the machine.
- `check_demo_result` returns `execution_target` (`'local'` | `'remote'` | `'steel'`), `fly_machine_id`, `fly_region`, `remote_routing_warning` (non-empty when auto-routing fell back to local), `steel_session_id` (for Steel.dev runs), `steel_recording_path` and `fly_recording_path` (for dual-instance scenarios), and — when a recording was captured — `recording_path`, `recording_source` (`'window'`), `failure_frames`, and `screenshot_hint` (identical fields to local). Also returns `run_id` (unique demo run identifier) and, when telemetry was enabled, `telemetry_dir` and `telemetry_summary`. Screenshots are extracted from the Fly recording via `extractScreenshotsFromRecording()` at 3-second intervals and placed in `.claude/recordings/demos/{scenarioId}/screenshots/` using the same `screenshot-XXXX.png` naming convention as local macOS captures, so `get_demo_screenshot` works identically for both local and remote runs.
- `get_fly_status` reports configured/healthy state, current machine count, region, `imageDeployed` (if `false`, no Docker image has been pushed and remote execution will fail silently), `imageStale` (boolean — true when infra files changed since last deploy), `machineRamHeadless`, and `machineRamHeaded` (current per-mode RAM settings from the state file).
- **Image freshness detection**: `get_fly_status` also returns `imageAgeHours` (hours since last deployment) and `imageMetadata` (deployment timestamp, app name, file hashes). `deploy_fly_image` writes `.claude/state/fly-image-metadata.json` with SHA-256 hashes of the infra files after successful deployment. `run_demo` includes a non-blocking `image_staleness_warning` in its response when the image is stale. Session briefing shows a one-line Fly.io image health status at login. Hourly automation checks image freshness every 60 minutes and files a deputy-CTO report when stale. Shared module: `.claude/hooks/lib/fly-image-freshness.js`. The module also exports `readProjectImageMetadata()` and `checkProjectImageStaleness()` for project-image-specific lifecycle checks (lockfile hash comparison, stuck-deploy detection). **`preflight_check` also surfaces Fly.io image health** via two new checks: `fly_image` (check 10a — verifies the base image is deployed and infra files match stored hashes; fail if not deployed, warn if stale) and `project_image_branch` (check 10b — during releases, warns when the project image was built from a branch other than `staging`). Both checks are gated on `fly.enabled` and run without network calls.
- **Per-mode RAM configuration**: `set_fly_machine_ram` and `get_fly_machine_ram` MCP tools configure RAM independently for headless vs headed Fly machines. State persisted at `.claude/state/fly-machine-config.json` (always writable, no root protection, no `npx gentyr sync` needed). Defaults: headless 2048MB (~900MB actually needed), headed 4096MB (~2GB for Xvfb + ffmpeg + headed Chromium). Changes take effect immediately on the next `run_demo` — no restart required. The `machineRam` field in `services.json` is now superseded by the per-mode values from the state file.
- Infrastructure: `infra/fly-playwright/` contains the Dockerfile, fly.toml template, and provisioning scripts. Setup via `/setup-fly` slash command; step 8 calls `deploy_fly_image()` MCP tool to build and push the Docker image after app creation. Step 6b of `/setup-fly` covers adding `GITHUB_TOKEN` to `secrets.local` for private repositories — the token is resolved at runtime and passed as `GIT_AUTH_TOKEN` to the Fly.io machine for authenticated git clone; the value never enters agent context.
- Config fields in `services.json` `fly` object: `apiToken` (op:// ref), `appName`, `region`, `machineSize`, `machineRam` (legacy flat value, now superseded by per-mode state file), `maxConcurrentMachines` (default 10), `enabled`.
- `FLY_API_TOKEN` is in the `INFRA_CRED_KEYS` set — treated as an infrastructure credential by the secret-sync server.

**Batch Diagnostic Enrichment**: Failed batch scenarios include per-scenario diagnostic fields: `stderr_tail` (last 5KB of stderr/stdout/error.log captured during machine polling), `fly_machine_log` (dmesg/process list/memory captured via exec while machine is alive), `failure_classification` (one of `test_failure`, `build_failure`, `oom`, `timeout`, `startup_failure`, `external_kill`, `recording_failure`, `install_timeout`, `unknown`), `failure_suggestion` (actionable fix guidance), and `elastic_query_hint` (Elastic log query when configured). The shared `classifyFailure()` function in `server.ts` centralizes failure classification for both single-demo and batch paths. `install_timeout` specifically identifies cold-install stall-outs (base image fallback with slow `pnpm install`) distinct from mid-test timeouts.

**Per-Scenario Retry**: `run_demo_batch` accepts `retry_infra_failures` (default 1, max 3). After all scenarios complete, infra-classified failures (`oom`, `timeout`, `startup_failure`, `external_kill`) are automatically retried. OOM retries auto-upgrade to `compute_size: 'large'`. `retried_scenarios` array on the batch result tracks retry outcomes.

**Batch Timeouts**: `run_demo_batch` accepts `scenario_timeout` (default 600000ms = 10 min per scenario) and `batch_timeout` (default 1800000ms = 30 min total). Scenarios exceeding their timeout are killed and classified as `timeout`. Exceeding the batch timeout skips remaining scenarios.

**All Demos Run Headed**: The `headed` DB column and `headless` parameter are deprecated. All demos run headed with video recording (Xvfb+ffmpeg on Fly.io, ScreenCaptureKit locally). `DEMO_HEADLESS` is always `'0'`. The `headless` param in `RunDemoArgsSchema` and `RunDemoBatchArgsSchema` is ignored.

**Shared Machine Slot Pool** (`packages/mcp-servers/src/playwright/machine-pool.ts`): SQLite-backed pool at `.claude/state/fly-machine-pool.db` coordinates Fly.io machine capacity across concurrent batch runs. `acquireSlot()` / `releaseSlot()` with dead-PID cleanup and TTL expiry. Seeds `max_slots` from `services.json` `fly.maxConcurrentMachines` (default 10). `check_demo_batch_result` returns `pool_status` showing active slots, max, and per-batch breakdown. Replaces the chunk-based batch loop with a streaming slot-aware execution model. When the pool has zero available slots, acquisition waits up to 10 minutes before returning a pool contention error — preventing indefinite batch starvation. `check_demo_batch_result` also accepts a `compact: true` parameter that reduces the response payload from ~4KB to ~500B (omitting per-scenario detail fields) to prevent context burn during rapid polling. A 10-second server-side throttle cache prevents redundant processing on back-to-back polls.

**`batch_size` Default**: `run_demo_batch` defaults `batch_size` to `maxConcurrentMachines` from fly config (typically 10), not a fixed value. Multiple concurrent batches share the machine pool.

**Project-Specific Docker Images**: `deploy_project_image` MCP tool builds Docker images with project dependencies pre-installed, reducing cold start from ~90s to ~10s. `resolveAppImage()` prefers `project-*` registry tags when `fly.projectImageEnabled: true`. **Staleness model**: lockfile hash comparison is informational only — a mismatched lockfile does NOT trigger "stale" warnings, timeout extensions, or deploy instructions. `pnpm install` on the machine handles the lockfile delta (~30s). The `get_fly_status` response provides `projectImageAgeHours`, `projectImageLockfileMatch` (informational boolean), and `projectImageRecommendation` (age-based suggestion, null when image is fresh). Agents evaluate image health via these fields and decide when to deploy — there is no automated staleness-triggered deployment. `deploy_project_image` has a 2-hour cooldown (non-forced deploys within 2 hours of the last successful deploy are rejected with an informational message). **Project image lifecycle protection** (multi-layer, added PR #633): (1) `checkProjectImageStaleness()` in `fly-image-freshness.js` — returns `freshnessTier` (`fresh`/`warm`/`stale`/`missing`/`deploying`) for informational/logging use; `stale` is always `false` (project image is usable when deployed); (2) `recoverStuckProjectDeploy()` — auto-clears metadata stuck in `deploying` state after 30 minutes, preventing permanent lockout from a crashed deploy; (3) auto-enable — `deploy_project_image` writes `projectImageEnabled: true` back to `services.json` after a successful deploy so subsequent runs use the fast image automatically; (4) adaptive stall timeouts — only extend timeouts when NO project image exists (true base-image fallback); when a project image exists (even with mismatched lockfile), no timeout extension is applied; (5) `install_timeout` failure classification — identifies cold-install stall-outs as a distinct failure type from `timeout`, enabling targeted repair guidance.

**Live Log Capture**: `captureRunningMachineLogs()` runs every 30s during the batch polling loop AND at scenario completion, capturing stderr/stdout/error.log and system diagnostics (dmesg/ps/meminfo) via exec while the machine is alive. This is the primary log capture mechanism — the Fly NATS SSE stream is live-only and returns empty for dead machines.

**Demo Run IDs and Telemetry**: Every demo run gets a unique `run_id` (format: `dr-{scenarioId}-{ts}-{hex}`) returned in both `run_demo` and `check_demo_result` responses. This ID is the correlation key across all telemetry, artifacts, and Elastic logs for a single run.

**Demo Telemetry (Maximum Capture Mode)**: Optional deep observability for debugging. Enable per-scenario (`update_demo_scenario({ id, telemetry: true })`) or per-run (`run_demo({ ..., telemetry: true })`). When enabled, captures:
- Browser console logs from ALL open tabs (log/warn/error/info/debug) via CDP
- Network requests and responses (method, URL, status, timing, headers) via CDP
- JavaScript errors and unhandled exceptions with full stack traces
- Performance metrics (Web Vitals: LCP, FCP, CLS, TTFB, navigation timing)
- System metrics (CPU%, memory, load averages) sampled every 2 seconds from `packages/mcp-servers/src/playwright/telemetry-capture.ts`
- On remote Fly.io machines: system metrics also polled inside `infra/fly-playwright/remote-runner.sh`

Browser-level telemetry is injected via `--import .claude/hooks/lib/playwright-telemetry-setup.mjs` (Node.js ESM loader monkey-patch) applied to the Playwright child process. Telemetry files stored as JSONL at `.claude/recordings/demos/{scenarioId}/telemetry/` (`console-logs.jsonl`, `network-log.jsonl`, `js-errors.jsonl`, `performance-metrics.jsonl`, `system-metrics.jsonl`). `check_demo_result` returns `telemetry_summary` with counts of each type and `telemetry_dir` path. Telemetry is shipped to Elastic (index `logs-demo-telemetry-{date}`) when `ELASTIC_CLOUD_ID` or `ELASTIC_ENDPOINT` and `ELASTIC_API_KEY` env vars are set — fire-and-forget, silent no-op when credentials are missing. Query pattern: `demo.run_id:"dr-xxx"` in `mcp__elastic-logs__query_logs`. The `telemetry` field on `demo_scenarios` table in `user-feedback.db` (auto-migrated, settable via `create_demo_scenario`/`update_demo_scenario`) persists per-scenario telemetry configuration.

**Steel.dev Cloud Browser (Tier 0 — stealth scenarios)**: When the `steel` section is configured in `services.json`, scenarios with `stealth_required=true` or `dual_instance=true` route to Steel.dev instead of Fly.io. Routing is fail-closed: if Steel is configured but unhealthy, or at session capacity, `run_demo` returns an error rather than silently falling back to a non-stealth execution path. `resolveExecutionTarget()` in `packages/mcp-servers/src/playwright/execution-target.ts` implements a four-tier priority system: Tier 0 (Steel stealth) > Tier 1 (forced local) > Tier 2 (forced remote) > Tier 3 (auto-routing). Config fields in `services.json` `steel` object: `apiKey` (op:// ref), `orgId` (optional), `enabled`, `defaultTimeout`, `extensionId` (pre-uploaded extension for Steel sessions), `proxyConfig` (`enabled`, `country`), `maxConcurrentSessions`. The `checkSteelHealth()` utility in `execution-target.ts` probes `https://api.steel.dev/v1/sessions` with a configurable timeout (default 5s). GENTYR provides the generic Steel REST API client (`steel-runner.ts`), MCP tools (`steel_health_check`, `upload_steel_extension`), and env var passthrough (`STEEL_CDP_URL`, `STEEL_SESSION_ID`, `STEEL_DUAL_INSTANCE`). Target project test code handles CDP connection, extension loading, and bridge wiring.

> Full details: [Playwright MCP Server](docs/CLAUDE-REFERENCE.md#playwright-mcp-server)

## Playwright Helpers Package

Shared TypeScript utilities for Playwright-based feedback agents and demo scenarios. Located at `packages/playwright-helpers/`. Published as `@gentyr/playwright-helpers`. Exports helper functions for persona overlay injection, cursor highlighting, tab management (open/switch/close), terminal interaction (type commands, wait for output), editor interaction (type code, run code), and interrupt signaling (`isInterrupted`, `throwIfInterrupted`, `getInterruptPromise`, `enableDemoInterrupt` — used by the Escape key demo interrupt mechanism). Built to `dist/` (gitignored). Consumed by feedback agents and demo scenario implementations via `@playwright/test` peer dependency.

```bash
cd packages/playwright-helpers && npm run build
```

## Demo Scenario System

Curated product walkthroughs mapped to personas. Managed by product-manager agent, implemented by code-writer agents. Only `gui` and `adk` consumption_mode personas can have scenarios. `*.demo.ts` naming convention enforced.

**Demo task enforcement** (4 layers):
- **`create_task` auto-correction**: Tasks with `demo_involved: true` automatically get `strict_infra_guidance: true` and are rerouted to the `demo-design` category. Warnings are returned in the response.
- **`secret_run_command` blocklist**: `validateCommand()` in the secret-sync server blocks `playwright test` and `playwright show-report` commands with an error redirecting to `run_demo`/`run_tests` MCP tools.
- **`playwright-cli-guard` scope**: The PreToolUse hook intercepts both `Bash` and `mcp__secret-sync__secret_run_command` tool calls, blocking Playwright CLI patterns on both paths.
- **Task gate demo check**: When `demo_involved: true`, the gate agent checks task descriptions for anti-patterns: direct CLI commands via `secret_run_command`, "main tree" / "DO NOT worktree" instructions, and wrong category routing.

**`headed` flag on scenarios** (`demo_scenarios.headed` column in `user-feedback.db`): Boolean field (default `false`) indicating a scenario requires a headed browser (i.e., display access). When `headed: true`, `run_demo` automatically acquires the display lock before launching (if not already held), serializing access to avoid window capture conflicts. Set via `create_demo_scenario`/`update_demo_scenario` tools on the `user-feedback` server.

**`remote_eligible` flag on scenarios** (`demo_scenarios.remote_eligible` column in `user-feedback.db`): Boolean field (default `true`) indicating whether a scenario can run on remote Fly.io machines. Set `false` for scenarios that require local Chrome, extension sockets, or headed display access that cannot be replicated remotely. When `remote_eligible=false`, `resolveExecutionTarget()` in `packages/mcp-servers/src/playwright/execution-target.ts` routes the scenario to local execution unconditionally — this DB-level override takes precedence over all heuristic checks (including chrome-bridge detection). An explicit `remote: true` call is also overridden and falls back to local. On migration, the DB auto-seeds existing headed and chrome-bridge/extension scenarios as `remote_eligible=0` (detected via `headed=1` or test file path patterns for `ext-`, `platform`, `/extension/`, `/platform-fixtures`). Set via `create_demo_scenario`/`update_demo_scenario` tools; filterable in `list_scenarios` via the `remote_eligible` query parameter. In the CTO Dashboard Page 2, scenarios with `remote_eligible=false` display a `local-only` tag in their metadata line and are blocked from remote launch with a status-bar error message when REMOTE mode is active.

**`stealth_required` flag on scenarios** (`demo_scenarios.stealth_required` column in `user-feedback.db`): Boolean field (default `false`). When `true`, the scenario requires anti-bot stealth — it routes to Steel.dev cloud browser (Tier 0) instead of Fly.io or local execution. Fail-closed: if Steel is not configured in `services.json`, not reachable, or at session capacity, `run_demo` returns an error. Set via `create_demo_scenario`/`update_demo_scenario` tools; filterable in `list_scenarios` via the `stealth_required` query parameter. Auto-migrated on DB open.

**`dual_instance` flag on scenarios** (`demo_scenarios.dual_instance` column in `user-feedback.db`): Boolean field (default `false`). When `true`, the scenario requires parallel execution across two compute tiers: Fly.io runs the Playwright orchestration process while Steel.dev provides the stealth cloud browser connected via bridge. Implies `stealth_required` semantics — also routes through Tier 0 and is fail-closed on both Steel and Fly availability. `check_demo_result` returns both `steel_recording_path` (user-facing view from the Steel browser) and `fly_recording_path` (test orchestration view). Auto-migrated on DB open.

**`telemetry` flag on scenarios** (`demo_scenarios.telemetry` column in `user-feedback.db`): Boolean field (default `false`). When `true`, enables maximum telemetry capture for every run of this scenario — browser console, network, JS errors, performance metrics, and system metrics. Can also be enabled per-run via `run_demo({ telemetry: true })`. Set via `create_demo_scenario`/`update_demo_scenario` tools. See Demo Telemetry section under Playwright MCP Server for full details. Auto-migrated on DB open.

**`verify_demo_completeness` tool** (on `user-feedback` server): Machine-checkable gate for the production promotion pipeline. Queries all enabled scenarios and returns whether each has a `passed` result and a fresh recording since a given `since` ISO timestamp (and optional `branch` filter, applied only when the `branch` column exists). Returns `{ complete: boolean, total_scenarios: number, scenarios_missing_pass: DemoCompletenessScenarioStatus[], scenarios_missing_recording: DemoCompletenessScenarioStatus[] }`. Each `DemoCompletenessScenarioStatus` includes `scenario_id`, `title`, `persona_name`, `latest_result_status` (`passed`/`failed`/`none`), `latest_result_at`, `has_fresh_recording`, `recording_path`, and `last_recorded_at`. Used by the Phase 4 plan-auditor during production promotion to confirm `complete: true` before marking the task done.

**Remote-ineligible exclusion from promotion**: `verify_demo_completeness` filters to `remote_eligible=1` scenarios only. Remote-ineligible demos (chrome-bridge, local-only) cannot be validated on Fly.io and are excluded from the production promotion gate.

**Demo local execution guard** (`demo-local-guard.js` PreToolUse hook): Spawned agents are blocked from running demos locally (`run_tests`, `launch_ui_mode`, `run_demo` with `remote: false`, `run_demo_batch` with `remote: false`) without CTO HMAC bypass approval. CTO interactive sessions and the CTO Dashboard GUI are exempt. Root-owned via `criticalHooks` in `protect.js`. When `remote: true` is passed to `run_demo_batch`, remote-ineligible scenarios are skipped (not run locally).

**Scenario flag protection**: Spawned agents cannot change `remote_eligible`, `enabled`, or `headed` flags on demo scenarios without CTO approval. These fields control which demos run in the production promotion pipeline. The `update_demo_scenario` and `create_demo_scenario` handlers block protected field changes for `CLAUDE_SPAWNED_SESSION=true` with instructions to file a bypass request.

> Full details: [Demo Scenario System](docs/CLAUDE-REFERENCE.md#demo-scenario-system)

### Demo Command Decision Tree

| User Request | Command |
|---|---|
| "Show me everything working" | `/demo-all` (headed, watchable speed, full suite) |
| "Run all demos" | `/demo-bulk` (headless, batched) |
| "Show me these specific demos" | `/demo-session` (headed, curated selection) |
| "Are all demos passing?" | `/demo-validate` (headless, fast, pass/fail only) |
| "Show me this one scenario" | `/demo-autonomous` (headed, single scenario) |
| "Browse tests interactively" | `/demo` (Playwright UI mode) |
| "Register demo setup commands" | `register_prerequisite` MCP tool |

**Bulk defaults** (`/demo-bulk` or `run_demo_batch`):
headless=true, batch_size=5, slow_mo=0

**Session defaults** (`/demo-session` or `run_demo_batch` with headed):
headless=false, slow_mo=800

Video recording is automatic in headed demo modes on macOS and in remote Fly.io demos. Scenario videos: `.claude/recordings/demos/{scenarioId}.mp4`

**Window recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` spawns Playwright first, then waits for Chrome to appear (up to 30s via AppleScript `waitForChromeWindow`), then starts the `WindowRecorder` Swift CLI and screenshot capture. Chrome is maximized via `--start-maximized` (set by `DEMO_MAXIMIZE=1`) — native macOS fullscreen (`AXFullScreen`) is NOT used because it intercepts the Escape key at the OS level, preventing the demo interrupt feature from working. `startWindowRecorder()` always passes `--skip-snapshot` to the `WindowRecorder` binary because the recorder starts after Chrome is already running. The `--skip-snapshot` flag instructs the binary to match ANY existing window (not just newly-appearing ones), fixing the prior bug where Chrome was excluded because it already existed in the window list when the recorder launched. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space — recording quality is identical to fullscreen since the recorder captures window pixels directly, not the screen. The recorder streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()`; temp files are cleaned up automatically. `stop_demo` and `check_demo_result` also handle window recorder teardown gracefully: SIGINT is sent first; if the process exits cleanly within 10s, the MP4 is persisted; if SIGKILL is required (process did not exit in time), persistence is skipped because SIGKILL prevents AVAssetWriter from writing the moov atom (corrupted MP4). All teardown paths gate persistence on the recorder's clean exit. `check_demo_result` returns `recording_path` and `recording_source` (`'window' | 'none'`) indicating whether a recording was persisted.

**Window recording via Xvfb + ffmpeg** (remote Fly.io demos — when headed): `remote-runner.sh` conditionally starts Xvfb and ffmpeg only when `DEMO_HEADLESS != 1`. When active: Xvfb starts on `:99` at `1920x1080` (configurable via `GENTYR_RECORDING_RESOLUTION`), `DISPLAY=:99` and `DEMO_MAXIMIZE=1` are exported, then ffmpeg captures the display to `/app/.recording.mp4` at `GENTYR_RECORDING_FPS` fps (default 25). When `DEMO_HEADLESS=1` (the default for remote runs), Xvfb and ffmpeg are skipped entirely and Playwright runs headless. In both modes a comprehensive `trap cleanup EXIT` fires on ANY exit (including early failures like git clone) and: (1) writes `/app/.exit-code` immediately so the proactive artifact poll can detect completion, (2) stops ffmpeg gracefully if running (SIGINT → up to 10s wait → SIGKILL, ensuring the moov atom is written), (3) stops Xvfb if running, (4) copies whatever artifacts exist to `/app/.artifacts/` (even partial logs from early failures), and (5) sleeps 60s for MCP artifact retrieval before the machine is destroyed. Ten `setup` progress events are emitted to the progress JSONL file (created at script start, not after Playwright launches) at key phases (clone_start, clone_done, install_start, install_done, prerequisites_start, prerequisites_done, devserver_start, devserver_ready, test_start) to prevent the stall detector from timing out during long setup steps. A background heartbeat process additionally emits `install_progress` events every 30 seconds during `pnpm install` to keep the stall detector alive during the 2–4 minute install phase (cold machines with 1600+ packages emit no output between `install_start` and `install_done`). The MCP polling loop in `server.ts` also attempts a last-chance artifact pull when the machine dies unexpectedly — if an exit-code file is recovered, the demo result is resolved to `passed` or `failed` instead of `unknown`. `fly-runner.ts` pulls `recording.mp4` and `ffmpeg.log` as individual artifacts. `check_demo_result` for remote runs persists the recording via `persistScenarioRecording()`, extracts failure frames from the last 3 seconds on failure, and returns `recording_path`, `recording_source: 'window'`, and `failure_frames` — identical fields to local macOS recording. If Xvfb or ffmpeg fails to start, the runner falls back to headless execution with no recording (`recording_source: 'none'`).

**Periodic screenshot capture** (headed demos — macOS local and remote Fly.io): Local macOS demos: `run_demo` calls `getChromeWindowId()` (uses `swift -e` + CoreGraphics `CGWindowListCopyWindowInfo` to find Chrome's CGWindowID) and passes the result to `startScreenshotCapture()`. When a `windowId` is available, `screencapture` is invoked with `-l <windowId>` to capture only that specific Chrome window instead of the full screen, producing clean window-only screenshots at the display's native resolution. `startScreenshotCapture()` runs `screencapture -x` every 3 seconds throughout the demo. Screenshots are stored in `DemoRunState` as `screenshot_dir`, `screenshot_start_time`, and `screenshot_interval`. Remote Fly.io demos: `check_demo_result` calls `extractScreenshotsFromRecording()` to extract frames from the pulled recording via ffmpeg at 3-second intervals, renames them to `screenshot-XXXX.png` (XXXX = elapsed seconds, zero-padded), cleans stale screenshots from prior runs, and stores them in `.claude/recordings/demos/{scenarioId}/screenshots/`. Both paths: `check_demo_result` returns `screenshot_hint` (path pattern for retrieving screenshots) and `analysis_guidance` (REQUIRED instructions for agents to analyze captured screenshots and verify UI state matches user requirements). When a demo fails with video recording, failure frames are auto-extracted from 3 seconds before the failure end using `extract_video_frames` (ffprobe+ffmpeg at 0.5s intervals) and returned as `failure_frames` in the result. `check_demo_result` also returns `duration_seconds` for the total demo run time. The `get_demo_screenshot` MCP tool retrieves screenshots by timestamp and works identically for local and remote runs; `extract_video_frames` extracts frames from any recording around a given timestamp.

**Automatic Screenshot Reminder** (`screenshot-reminder.js` PostToolUse hook): Fires on every tool call. When a tool response contains a screenshot file path (e.g., `[Screenshot saved: /path/to/file.png]`, `"file_path": "...png"`, or `"screenshot_hint": "..."`), injects a `hookSpecificOutput.additionalContext` reminder instructing the agent to use the `Read` tool to view the screenshot before proceeding. Fast path: exits in under 1ms when no screenshot path is present (regex-only check). Skips reminder when the current tool is `Read` (agent is already viewing a screenshot). Caps at 5 paths per response. Registered in the global empty-matcher PostToolUse block in `settings.json.template`.

**Screenshot and recording cleanup** (30-day retention): The `screenshot_cleanup` runIfDue block in `hourly-automation.js` (24h cooldown) walks `.claude/screenshots/` and `.claude/recordings/demos/`, removes `.png` and `.mp4` files whose `mtime` is older than 30 days, and prunes empty directories. Non-fatal on any I/O error. Empty parent directories are removed after their contents are pruned.

**Escape key interrupt** (headed demos): Pressing Escape during a headed demo triggers a clean interrupt. The persona overlay immediately shows "Demo Interrupted — interact freely" (updated directly by the Chrome extension content script for instant visual feedback). All in-progress helper actions in `playwright-helpers` (cursor highlight, terminal/editor tab operations, persona overlay interactions) check `isInterrupted()` and exit early. On the server side, the Playwright MCP server detects the interrupt (via progress JSONL event or signal file — see Interrupt mechanism below), discards any in-progress recording (window recorder is killed without persisting the MP4), keeps the browser alive for manual inspection, and returns `status: 'interrupted'` with `interrupted_at` and `interrupt_reason` fields from `stopDemo`/`check_demo_result`. The associated task (if any) is paused via `submit_bypass_request` so the parent persistent task monitor receives a signal to wait rather than retrying.

**Interrupt mechanism**: Two paths deliver the interrupt signal, one framework-level and one in-process:

- **Framework-level (automatic, no target project changes)**: The gentyr Chrome extension content script (`tools/chrome-extension/extension/assets/demo-interrupt-listener.js`) detects Escape keydown, updates the persona overlay DOM directly for instant visual feedback, then sends a `demo_interrupt` message to the service worker (`service-worker-loader.js`). The service worker forwards it via `chrome.runtime.sendNativeMessage` to the native host (`host.cjs`), which writes a signal file at `/tmp/gentyr-demo-interrupt.signal`. The Playwright MCP server background monitor (5s poll interval) detects the file, consumes it, sets `interruptDetectedAt`, appends a `demo_interrupted` event to the progress JSONL with `source: 'escape_key_extension'`, and the existing interrupt handling takes over. Any stale signal file from a previous demo is deleted at demo start to prevent false interrupts.

- **In-process (faster, requires target project wiring)**: `page.exposeFunction('__gentyrDemoInterrupt')` bridge + JSONL progress file. The browser-side listener calls `window.__gentyrDemoInterrupt()` which triggers the Node-side handler immediately (no 5s polling delay). Two setup paths: (1) `enableDemoInterrupt(page)` from `@gentyr/playwright-helpers` (called automatically by `injectPersonaOverlay` in demo mode), and (2) `setupDemoInterrupt(context)` from `.claude/hooks/lib/demo-interrupt-setup.js` — a standalone module for target projects that auto-wires all pages in a BrowserContext. Target projects should call `setupDemoInterrupt(context)` once in their Playwright fixtures after creating the context. The content script attempts the in-process path first (via injected inline script) and falls through to the extension path if CSP blocks it.

Agents handling `status: 'interrupted'` results should NOT spawn repair agents — the CTO will resolve the bypass request to resume.

Dev server is auto-started if not running — no manual setup needed.

### Demo Prerequisites

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

**When to assign to DEMO-MANAGER:**
- Creating or modifying `.demo.ts` files
- Registering or updating demo prerequisites
- Planning persona feedback feature scenarios (scaffolding prerequisites, coverage audits)
- Repairing failed demo scenarios
- Any demo-related work that other agents encounter

**Rules:** Only modifies `.demo.ts` files and demo configuration. Does NOT commit (project-manager handles git). Other agents (`code-writer`, `test-writer`, `feedback-agent`) are explicitly forbidden from modifying `.demo.ts` files. When any agent encounters demo-related work, it MUST create a `Demo Design` category task.

**Failure-triggered automation:** A PostToolUse hook on `check_demo_result`, `check_demo_batch_result`, and `run_demo` detects failures, deduplicates against in-flight repairs, and spawns demo-manager agents in isolated worktrees. Repair prompts are enriched with prerequisite context (global, persona, and scenario-scoped prerequisites queried from `user-feedback.db`) so agents diagnose prerequisite failures before modifying `.demo.ts` files. The `run_demo` hook handles immediate failures (e.g., prerequisite failure before test execution begins), with title and test file fallback lookup from `user-feedback.db` when the tool response lacks them. **Repair prompt enrichments**: `failure_classification` (from batch diagnostic enrichment) is passed through to repair prompts so agents know the classified failure mode upfront. When `error` contains `ECONNREFUSED`/`connection refused`/`ERR_CONNECTION`, an `infraGuidance` block is injected with step-by-step instructions to register a background prerequisite rather than patching the `.demo.ts` file. **Skipped scenario accountability**: On completed batches with skipped scenarios, a `skippedContext` block is injected into `additionalContext` mandating the agent either fix the skip reason or create a DEMO-MANAGER task — it cannot silently ignore skipped scenarios. When escalation is also triggered, `skippedContext` is prepended to the escalation message (single stdout write prevents dual output).

## Chrome Browser Automation

The chrome-bridge MCP server provides 28 tools for browser automation. 17 tools communicate via local Unix domain socket using the Claude for Chrome extension. 2 tools (`list_chrome_extensions`, `reload_chrome_extension`) are server-side AppleScript-based tools (macOS only) that operate without a socket connection. 4 tools (`find_elements`, `click_by_text`, `fill_input`, `wait_for_element`) are server-side convenience tools that compose existing socket tools via accessibility tree parsing — these work reliably on React/SPA frameworks because they use element references (MAIN world), not JavaScript execution (ISOLATED world). Use these instead of `javascript_tool` for element interaction. 4 tools (`react_fill_input`, `click_and_wait`, `page_diagnostic`, `inspect_input`) are server-side React automation tools that use direct JavaScript execution in the MAIN world to handle React controlled components: `react_fill_input` uses the native-setter + `_valueTracker` reset + direct `onChange` dispatch pattern to reliably update React controlled inputs; `click_and_wait` atomically clicks an element and waits for a URL/text/element transition; `page_diagnostic` dumps all form inputs/buttons with their React state indicators for selector discovery; `inspect_input` deep-inspects a single input's DOM, React internal value, and event handler wiring. Use `page_diagnostic` first to discover selectors, then `react_fill_input` when standard `fill_input` produces empty submissions. 1 tool (`health_check`) is a server-side diagnostics tool — call it first when other chrome-bridge tools fail with connection errors.

**Auto-screenshot after mutating actions**: After every mutating browser action, the server automatically captures a screenshot and saves it to `.claude/screenshots/chrome-bridge/{tabId}/`. The file path is appended to the tool response as `[Screenshot saved: /path/to/file.png]`. Screenshot failures are non-fatal and never block the action. Three categories trigger auto-screenshots: (1) server-side tools: `click_by_text`, `fill_input`, `react_fill_input`, `click_and_wait`, `find_elements`, `wait_for_element`; (2) socket-proxied tools: `navigate`, `form_input`; (3) `computer` tool mutating actions: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `left_click_drag`, `scroll`. The `computer screenshot` action is excluded to prevent infinite loops. Screenshots are scoped by `tabId` subfolder (`default` when no tabId is provided).

### Gentyr Browser Automation Extension

A stripped-down Chrome extension (`tools/chrome-extension/`) for headless browser automation. Forked from Claude Chrome Extension v1.0.66 with all authentication, permission prompts, side panel UI, and analytics removed. All 17 socket-based browser automation tools work identically via auto-approved permissions (`source:'bridge'` + `permissionMode:'skip_all_permission_checks'`).

**Extension ID**: `dojoamdbiafnflmaknagfcakgpdkmpmn`

**Components:**
- `extension/` — Chrome extension (manifest.json, service worker, content scripts, assets copied from v1.0.66)
- `native-host/host.js` — Node.js native messaging host; bridges Chrome native messaging (stdin/stdout) to Unix domain sockets at `/tmp/claude-mcp-browser-bridge-{username}/{pid}.sock`. Handles request routing, reference-counted `mcp_connected`/`mcp_disconnected`, socket directory security validation, and Chrome's 1MB message size limit.
- `native-host/install.sh` — Registers the native messaging host with Chrome

**Install**: Run `npx gentyr sync` (step 7c) or manually:
```bash
tools/chrome-extension/native-host/install.sh
```

The extension must be loaded in Chrome as an unpacked extension from `tools/chrome-extension/extension/`. `scripts/grant-chrome-ext-permissions.sh` grants the required debugger permissions for both the official Claude extension and this Gentyr extension.

### @gentyr/chrome-actions Package

TypeScript bindings for the Chrome Extension's Unix domain socket protocol. Located at `packages/chrome-actions/`. Published as `@gentyr/chrome-actions`. Provides typed methods for all 17 socket-based chrome-bridge MCP tools plus the `waitForUrl` convenience helper, and 4 React automation methods (`reactFillInput`, `clickAndWait`, `pageDiagnostic`, `inspectInput`) that mirror the server-side React tools. Lets target project test code (`.demo.ts` files) directly control Chrome without Claude in the loop. The 2 server-side AppleScript tools (`list_chrome_extensions`, `reload_chrome_extension`) are not included here — they are invoked directly via MCP. Built to `dist/` (gitignored).

```bash
cd packages/chrome-actions && npm run build
```

> Full details: [Chrome Browser Automation](docs/CLAUDE-REFERENCE.md#chrome-browser-automation)

## Shared MCP Daemon

Tier 1 (stateless/read-only) MCP servers can be hosted in a single shared daemon process using HTTP transport instead of per-session stdio processes. A single daemon replaces up to 15 per-session stdio processes, saving ~750MB RAM per concurrent agent.

**Tier 1 servers** (hosted in daemon): `github`, `cloudflare`, `supabase`, `vercel`, `render`, `codecov`, `resend`, `elastic-logs`, `onepassword`, `secret-sync`, `feedback-explorer`, `cto-report`, `specs-browser`, `setup-helper`, `show`.

**Key files:**
- `scripts/mcp-server-daemon.js` — Daemon entry point; binds the HTTP server first (two-phase startup), then resolves 1Password credentials in parallel via `Promise.allSettled`. Handles graceful SIGTERM shutdown. Hosts all Tier 1 servers via `lib/shared-mcp-config.js`
- `lib/shared-mcp-config.js` — Single source of truth for `TIER1_SERVERS` list, default port (`18090`), and project-local server preservation helpers (`extractProjectServers`, `mergeProjectServers`)
- `packages/mcp-servers/src/shared/http-transport.ts` — HTTP transport adapter with path-based routing (`/mcp/<server-name>`). Health endpoint returns `{ status: 'starting' }` while credentials are still resolving and `{ status: 'ok' }` once ready.

**Activation:** `setup-automation-service.sh` installs a KeepAlive launchd service (`com.local.gentyr-mcp-daemon`, macOS) or systemd user service (`gentyr-mcp-daemon`, Linux) on port `18090`. A 1-second delay after `launchctl load` prevents the health check from racing the launchd startup. Once the service is installed, `config-gen.js` auto-detects it (via plist/service/state-file presence) and converts Tier 1 stdio entries in `.mcp.json` to HTTP entries pointing at `http://127.0.0.1:18090/mcp/<server-name>`.

**Startup health polling:** `sync.js` `ensureMcpDaemonHealthy()` recognizes the `status:'starting'` state (daemon HTTP server is up but credentials are still resolving) and polls for up to 30 seconds. It also has a `launchctl load` fallback for the case where the plist exists but the service was never loaded into launchd.

**Conditional stdio start:** Each Tier 1 server only calls `server.start()` if `MCP_SHARED_DAEMON` is not set. When running inside the daemon, `MCP_SHARED_DAEMON=1` suppresses stdio startup — the same compiled `dist/` is shared between both execution modes.

**Transport details:** Binds to `127.0.0.1` only (no network exposure). Uses MCP Streamable HTTP with JSON-RPC 2.0 over HTTP POST. Body size capped at 1MB. Session management via `Mcp-Session-Id` header.

**Logs:** `.claude/mcp-daemon.log` in the project directory.

**Status check:**
```bash
scripts/setup-automation-service.sh status --path /project   # includes MCP daemon health
curl -sf http://localhost:18090/health                        # direct health check
```

## Project-Local MCP Servers

Target projects can add their own MCP servers to `.mcp.json` that survive `npx gentyr sync` and SessionStart auto-regeneration. Gentyr preserves these by detecting non-template server names before overwriting `.mcp.json` and merging them back afterward. Gentyr-owned names always win on collision; dynamic server names (`plugin-manager`, `plugin-*`) are excluded from the preserved set.

**`stage_mcp_server` tool** (on `agent-tracker` server): Agents and the CTO can add a project-local server without manual file editing. Writes directly to `.mcp.json` when writable; falls back to staging in `.claude/state/mcp-servers-pending.json` when the file is root-owned (EACCES). Rejects names that collide with any GENTYR template server. After installation, a Claude Code session restart is required for the new MCP tools to appear.

**`sync.js` step 1.7**: On every `npx gentyr sync`, any pending servers in `mcp-servers-pending.json` are applied to `.mcp.json` and the pending file is removed.

**`mcp-guidance-hook.js`** (UserPromptSubmit hook): Fires when the user prompt contains "mcp" (30-minute cooldown) or when `mcp-servers-pending.json` exists (no cooldown). Injects `additionalContext` guidance about the `stage_mcp_server` tool and pending sync notification. Silent — no `systemMessage`.

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

The secret-sync MCP server orchestrates secrets from 1Password to deployment platforms without exposing values to agent context. 13 tools available. Secret values never pass through agent context window. The `update_services_config` and `get_services_config` tools allow agents to read and update `services.json` config fields (e.g., `worktreeBuildCommand`, `worktreeInstallTimeout`, `devServices`) without CTO manual intervention. `update_services_config` validates updates against `ServicesConfigSchema`, writes directly when the file is writable, and stages to `.claude/state/services-config-pending.json` on EACCES (root-owned file); staged changes are applied by `sync.js` step 1.5 on the next `npx gentyr sync`. The `secrets` key is blocked on both paths.

**Atomic write safety (`safe-json-io`)**: All three write paths in the secret-sync server (`updateServicesConfig`, `populateSecretsLocal`, `writeServicesConfig`) and `sync.js` steps 1.5 and 1.6 use atomic tmp+rename writes via `safeWriteJson` / `safeReadJson` (TypeScript: `packages/mcp-servers/src/shared/safe-json-io.ts`; JS: `lib/safe-json-io.js`). A `.bak` backup is written before each overwrite; if a subsequent read finds the primary file corrupt or empty, the backup is automatically restored. This prevents `services.json` data loss from mid-write crashes or process kills.

**Secret Profile Management**: 4 tools manage named profiles in `services.json` that bundle secret key sets for reuse: `register_secret_profile` (create/update a profile with optional `commandPattern`/`cwdPattern` auto-match rules), `get_secret_profile` (retrieve a profile by name), `list_secret_profiles` (list all profiles), `delete_secret_profile` (remove a profile). The `secret_run_command` tool accepts a `profile` parameter to merge a named profile's `secretKeys` with any explicit `secretKeys`. The `secret-profile-gate.js` PreToolUse hook fires on `secret_run_command` calls — when a matching profile exists but the agent did not specify one, the call is blocked on first attempt (agents must re-invoke with the profile or re-invoke without it a second time to prove intent).

**Auto-background gate**: `secret_run_command` automatically promotes commands with `timeout > 55s` to background mode to avoid the Claude Code MCP transport's ~60-second hard limit. When auto-backgrounded, a JSONL progress file at `.claude/state/run-command-{label}-{timestamp}.jsonl` captures stdout/stderr/exit events and the response includes `mode: "auto_background"` with the progress file path and a poll hint. The `secret_run_command_poll` tool retrieves results by `label` or `pid` — returns running state, exit code, recent output lines, and progress file path. The `long-command-warning.js` PostToolUse hook detects two failure modes after `secret_run_command` calls: (1) auto-backgrounded responses (guides the agent to poll), and (2) empty foreground output where the MCP transport silently killed the call (warns and suggests background mode). `MAX_OUTPUT_LINES` is 500 (raised from 50).

**`populate_secrets_local` tool**: Allows agents to add `op://` references to `secrets.local` in `services.json` without CTO involvement. Accepts `{ entries: Record<string, string> }` where values must be `op://` references. If the file is root-owned, stages to `.claude/state/secrets-local-pending.json` for the next `npx gentyr sync` (step 1.6). Use `mcp__onepassword__op_vault_map` to discover available `op://` references first.

**`op_vault_map` tool** (on the 1Password MCP server): Full map of all items and their `op://` field references across all accessible vaults. Returns reference paths (NOT secret values). Use to discover the correct `op://` references for `populate_secrets_local`.

**`create_item` tool** (on the 1Password MCP server, version 3.0.0): Creates a new item in a 1Password vault. Accepts `title`, `category` (e.g. `"API Credential"`, `"Login"`, `"Database"`, `"Secure Note"`), optional `vault`, `fields` (array of `{ field, value, type, section }`), `tags`, `url`, `generate_password`, and `notes`. Returns `op://` field references (NOT raw values) for use with `populate_secrets_local`. Secret values are passed directly to the `op` CLI and never appear in agent context.

**`add_item_fields` tool** (on the 1Password MCP server, version 3.0.0): Adds or updates fields on an existing 1Password item. Accepts `item` (name or ID), optional `vault`, and `fields` (array of `{ field, value, type, section }`). Returns `op://` references for the added/updated fields only. Use to enrich existing items (e.g. adding a service-role-key to an existing Supabase item) without recreating the item.

**`secrets-local-health.js` UserPromptSubmit hook**: Warns on every message (5-minute cooldown) if `secrets.local` is empty or missing keys referenced by secret profiles. Instructs agents to call `op_vault_map` + `populate_secrets_local` immediately, and instructs them to ask the CTO to run `npx gentyr sync` when entries are staged but not yet applied. Skipped in local mode and spawned sessions.

**`pending-sync-notifier.js` UserPromptSubmit hook**: In interactive (CTO) sessions only, warns when any pending configuration files exist that require `npx gentyr sync` to apply. Checks all 4 pending file types: `secrets-local-pending.json`, `services-config-pending.json`, `mcp-servers-pending.json`, and `fly-config-pending.json`. Shows a `systemMessage` in the terminal listing each pending file and its contents — does NOT inject into model context. 10-minute cooldown. Skipped for spawned sessions.

**`loadTest` section in `ServicesConfigSchema`**: Optional section in `services.json` enabling autocannon-based load testing during the promotion pipeline. Fields: `enabled` (boolean, default false), `duration` (seconds per route, 5–300, default 30), `connections` (concurrent connections per route, 1–500, default 50), `routes` (array of API paths to test, default `['/api/health', '/api/auth/session']`). When enabled, the promotion pipeline runs load tests against each configured route and records results. `autocannon` must be installed in the target project. Cooldown key `load_test` (default 360 minutes; only fires during promotion, not on every hourly cycle). Configured via `mcp__secret-sync__update_services_config`. Implementation: `.claude/hooks/lib/load-test-runner.js`.

**`elastic` section in `ServicesConfigSchema`**: Optional section in `services.json` enabling centralized Elastic Cloud log shipping from all project components. Fields: `apiKey` (op:// ref, required), `cloudId` (op:// ref, Elastic Cloud), `endpoint` (op:// ref, Serverless — mutually exclusive with cloudId at runtime), `queryApiKey` (op:// ref, optional read-only key for querying), `enabled` (boolean, default true), `indexPrefix` (string, default `'logs'`; produces indices named `{prefix}-{service}-{date}`). Configured via `mcp__secret-sync__update_services_config`. Credentials for local dev and demos are added to `secrets.local` via `mcp__secret-sync__populate_secrets_local`. Deployment credentials (renderProduction, renderStaging, vercel) must be configured separately and synced via `/push-secrets`. Session briefing shows a one-line logging health status at login. Use `mcp__elastic-logs__verify_logging_config` to check configuration completeness across all environments.

**Elastic credentials in Playwright server**: The `playwright` server's `credentialKeys` in `protected-actions.json` include `ELASTIC_API_KEY`, `ELASTIC_CLOUD_ID`, and `ELASTIC_ENDPOINT`. These are resolved from 1Password by `mcp-launcher.js` and injected into the Playwright server process, enabling `elastic_query_hint` on batch results and demo telemetry shipping.

> Full details: [Secret Management](docs/CLAUDE-REFERENCE.md#secret-management)

## Icon Processor MCP Server

The icon-processor MCP server provides 12 tools for sourcing, downloading, processing, and storing brand/vendor icons into clean square SVG format. Consumed by the `icon-finder` agent. Global icon store at `~/.claude/icons/`.

> Full details: [Icon Processor MCP Server](docs/CLAUDE-REFERENCE.md#icon-processor-mcp-server)

## Production Promotion System (Phase 0)

Two components that form the foundation of the production promotion overhaul — tracking releases with a full evidence chain and preventing staging contamination during active releases.

### Release Ledger MCP Server

The release-ledger MCP server (`packages/mcp-servers/src/release-ledger/`) tracks production releases from staging lock through CTO sign-off. State is in `.claude/state/release-ledger.db` (SQLite, WAL mode). Tier 2 (stateful, per-session stdio).

**13 tools**: `create_release`, `get_release`, `list_releases`, `update_release`, `sign_off_release`, `cancel_release`, `add_release_pr`, `update_release_pr_status`, `add_release_session`, `add_release_report`, `add_release_task`, `get_release_evidence`, `generate_release_report`.

**5-table SQLite schema**: `releases`, `release_prs`, `release_sessions`, `release_reports`, `release_tasks`. The `releases` table tracks `version`, `status` (`in_progress`/`signed_off`/`cancelled`), `plan_id`, `persistent_task_id`, `staging_lock_at`/`staging_unlock_at`, `signed_off_at`/`signed_off_by`, and `report_path`. The `get_release_evidence` tool returns the full evidence chain for a release (PRs, sessions, reports, tasks). `generate_release_report` produces a human-readable markdown summary.

### Staging Lock Guard

**Shared module**: `.claude/hooks/lib/staging-lock.js` — manages lock state at `.claude/state/staging-lock.json`. Exports `lockStaging(releaseId, options)`, `unlockStaging(releaseId, options)`, `isStagingLocked()`, `getStagingLockState()`. Best-effort GitHub branch protection via `gh api` (non-fatal — local state file is the primary enforcement mechanism).

**PreToolUse hook**: `.claude/hooks/staging-lock-guard.js` — blocks Bash commands that would create PRs targeting staging or merge into staging. Blocked patterns: `gh pr create --base staging` (and `--base=staging`, `-B staging`), `gh pr merge` targeting staging (runtime PR target check via `gh pr view`), `git push origin staging` (including refspecs like `HEAD:staging`), `git merge staging`. Uses the same shell tokenizer as `main-tree-commit-guard.js`. Fast exit: `GENTYR_PROMOTION_PIPELINE=true` passes through unconditionally. The guard is always-on — staging operations are blocked regardless of lock state for non-pipeline agents. Fail-open on `gh pr view` timeout (2s) and unexpected errors.

**Manual promotion**: `/promote-to-staging` slash command calls `mcp__deputy-cto__trigger_preview_promotion` which spawns the preview-promoter agent directly via `enqueueSession({ agent: 'preview-promoter' })` with `GENTYR_PROMOTION_PIPELINE=true`. Do NOT use `create_task` or `force_spawn_tasks` for staging promotion — the task system routes through category-based resolution which does not load the preview-promoter agent definition.

### /promote-to-prod — CTO-Initiated Production Release

The ONLY path to production. Replaces the former automated midnight-window promotion pipeline.

**Command**: `/promote-to-prod`

**Prerequisites**: staging and main branches exist, no active release in progress.

**8-Phase Release Plan**:

| Phase | Name | Gate | Description |
|-------|------|------|-------------|
| 1 | Per-PR Quality Review | Yes | Persistent task per PR: antipattern, code-review, user-alignment, spec-enforcement |
| 2 | Initial Triage | No | Deputy-CTO triages Phase 1 findings |
| 3 | Meta-Review | Yes | Cross-PR consistency check across all changes |
| 4 | Test & Demo Execution | Yes | All unit/integration/playwright tests + all demo scenarios via Fly.io; `verify_demo_completeness` must return `complete: true` |
| 5 | Demo Coverage Audit | Yes | Verify every new feature has demo coverage with screenshot proof |
| 6 | Final Triage | No | Pre-release readiness check |
| 7 | CTO Sign-off | Yes | CTO reviews and explicitly approves the release |
| 8 | Release Report | No | 8-section structured report generated (.md + .pdf) |

**Flow**: CTO runs `/promote-to-prod` -> enumerates PRs -> locks staging (GitHub API + local) -> creates release plan -> plan-manager drives phases -> CTO signs off -> staging merges to main -> report generated -> staging unlocked.

**Monitoring**: `/plan-progress`, `/monitor`, `/persistent-tasks`

**Staging Lock**: During a release, all merges to staging are blocked (GitHub branch protection + `staging-lock-guard.js` PreToolUse hook). `GENTYR_PROMOTION_PIPELINE=true` agents are exempt.

**Release Artifacts**: Collected in `.claude/releases/{release-id}/` — JSONL transcripts, session summaries, screenshots, test/demo results, triage actions, CTO decisions.

**Release Ledger**: `release-ledger` MCP server tracks PRs, sessions, reports, and tasks per release for post-mortem traceability.

### /promote-to-prod-force — Emergency Force Promotion

Emergency bypass for directly merging staging to main without quality gates. CTO-gated via the authorization system.

**Command**: `/promote-to-prod-force`

**Flow**: CTO reviews staging drift → types confirmation → agent calls `record_cto_decision` (type `force_prod_promotion`) → calls `mcp__deputy-cto__force_promote_to_prod({ decision_id })` → tool verifies CTO decision exists and is verified → creates or reuses a PR from staging to main → merges with `--admin` CI bypass → marks decision consumed → returns PR URL.

**Gate enforcement**: `force_promote_to_prod` is registered in `protected-actions.json` so spawned agents are blocked by `protected-action-gate.js`. Only interactive CTO sessions can invoke the tool.

**When to use**: Production incidents where the full `/promote-to-prod` quality pipeline cannot complete in time. Not for routine promotion.

## Plan Orchestrator MCP Server

The plan-orchestrator MCP server (`packages/mcp-servers/src/plan-orchestrator/`) manages structured execution plans with phases, tasks, substeps, dependencies, and cross-DB integration with `todo.db` and the persistent task system. State is in `.claude/state/plans.db` (SQLite, WAL mode). Tier 2 (stateful, per-session stdio).

**22 tools**: `create_plan`, `get_plan`, `list_plans`, `update_plan_status`, `add_phase`, `update_phase`, `add_plan_task`, `update_task_progress`, `link_task`, `add_substeps`, `complete_substep`, `add_dependency`, `get_spawn_ready_tasks`, `plan_dashboard`, `plan_timeline`, `plan_audit`, `plan_sessions`, `force_close_plan`, `check_verification_audit`, `verification_audit_pass`, `verification_audit_fail`, `get_plan_blocking_status`.

**`force_close_plan`**: CTO-only tool (requires `cto_bypass: true`). Cancels a plan and cascades by default — auto-cancels the plan's manager persistent task and all plan-task persistent tasks in one call. Set `cascade: false` to skip cascading and return persistent task IDs for manual cancellation. Irreversible.

**7-table SQLite schema**: `plans`, `phases`, `plan_tasks`, `substeps`, `dependencies`, `state_changes`, `plan_audits`. Cycle detection on dependency graph. Progress rollup from substep → task → phase → plan.

**Plan completion gate enforcement**: Multi-layer protection preventing plans from being marked "completed" when verification phases were skipped:
- **Skip guard**: `update_task_progress` with `status: "skipped"` requires `skip_reason` and `skip_authorization` (`cto`, `blocked_external`, `superseded`). Tasks in gate phases cannot be skipped (server-side rejection).
- **Auto-completion cascade**: When ALL tasks in a phase are skipped, the phase becomes `skipped` (not `completed`). Plans with any skipped required phase do NOT auto-complete — they require explicit `update_plan_status` with `force_complete: true` + `completion_note`.
- **Phase metadata**: `phases` table has `required` (default 1) and `gate` (default 0) columns. Set `gate: true` on verification/proof phases to block any task skipping. Set `required: false` on optional phases that don't block plan completion.
- **Stop hook escape hatch**: Plan-managers blocked by external dependencies can pause their persistent task, and the stop hook will allow exit instead of pressuring them to skip tasks.
- **`update_plan_status` validation**: Transitioning to `completed` requires all phases to be resolved. If any phase is skipped, `force_complete: true` with `completion_note` is required.

**Verification audit gate**: Independent auditor agents verify plan task completion claims before they can be marked complete. `verification_strategy` is **mandatory** for all plan tasks — `add_plan_task` and inline tasks in `create_plan` are rejected by the server when `verification_strategy` is absent. Tasks with this field enter `pending_audit` instead of `completed` when marked done. A Sonnet-tier `plan-auditor` agent spawns in the `audit` lane (5 concurrent limit, signal-excluded — auditors cannot receive messages from plan managers), verifies the strategy against actual artifacts, and renders a pass/fail verdict via `verification_audit_pass` or `verification_audit_fail`. On pass: task transitions to `completed` and the normal phase/plan cascade runs. On fail: task reverts to `in_progress` for the plan manager to investigate. CTO bypass: `update_task_progress(status: 'completed', force_complete: true)` skips the audit gate. The `plan-persistent-sync.js` hook also routes through `pending_audit` when `verification_strategy` exists. Stale `pending_audit` tasks (auditor died) are detected by `session-reaper.js` and re-enqueued via `buildAuditorSessionSpec({ taskType: 'plan' })`. Stale tasks can also be re-attempted by calling `update_task_progress(status: 'completed')` again or force-completed by the CTO. `plan_audits` table tracks audit history (verdicts, evidence, retry counts). **Direct `pending_audit` transitions are blocked** — `update_task_progress(status: 'pending_audit')` returns an error; tasks must use `status: 'completed'` and let the gate route automatically, otherwise no auditor is spawned and the task gets stuck.

**3 verification audit tools** (on `plan-orchestrator` server):
- `check_verification_audit` — read-only poll: returns verdict status (pending/pass/fail), evidence, and attempt number
- `verification_audit_pass` — auditor-only: marks audit passed, transitions task `pending_audit → completed`, runs cascade
- `verification_audit_fail` — auditor-only: marks audit failed, transitions task `pending_audit → in_progress`

**Plan audit spawner hook** (`plan-audit-spawner.js`, PostToolUse): Fires on `update_task_progress`. When the response shows `status: 'pending_audit'`, enqueues a Sonnet-tier `plan-auditor` in the `audit` lane with 8-minute TTL via `buildAuditorSessionSpec({ taskType: 'plan' })`. The auditor's prompt includes the task title and `verification_strategy`.

**Plan-persistent task marriage schema**: Plans and persistent tasks are linked at two levels. The `plans` table carries `persistent_task_id` (the plan manager's own persistent task), `manager_agent_id`, `manager_pid`, `manager_session_id`, and `last_heartbeat`. The `plan_tasks` table carries `persistent_task_id` (the persistent task executing that plan step) and `category_id`. Plan status now includes `cancelled` in addition to `draft`, `active`, `paused`, `completed`, and `archived`. Plan task status now includes `paused` (added by hierarchical pause propagation — a plan task is set to `paused` when its linked persistent task is paused, blocking downstream dependencies). `add_plan_task` accepts an optional `category_id` for routing.

**Hierarchical pause propagation** (`lib/pause-propagation.js`): When a persistent task is paused (via bypass request or stop-continue hook), three functions propagate the pause up to the plan layer and back: `propagatePauseToPlan(persistentTaskId, pauseReason, bypassRequestId)` — updates the linked plan task to `paused`, assesses downstream impact (blocked tasks, gate phases, parallel paths), auto-pauses the plan itself when blocking level is `plan`, and inserts a `blocking_queue` entry; `propagateResumeToPlan(persistentTaskId)` — resumes the plan task, resolves active `blocking_queue` entries, and auto-resumes the plan if no other tasks remain paused; `assessPlanBlocking(planId)` — read-only snapshot of which tasks are paused, what work is blocked, and what parallel work is still available. Wired into `persistent-task-spawner.js` (pause handler) and `submit_bypass_request` / `resolve_bypass_request` in the agent-tracker server. Non-fatal throughout: if the plan linkage is absent or the DB is missing, functions return `{ propagated: false }` and callers proceed normally.

**`get_plan_blocking_status`** (on `plan-orchestrator` server): Returns whether a plan is fully or partially blocked, which plan tasks are paused with their downstream blocked task IDs, what parallel work is still available, and active `blocking_queue` items. Plan managers call this each cycle to decide whether to continue with parallel work or wait for the CTO to resolve a bypass request.

**Cross-DB integration**: `add_plan_task` optionally creates a corresponding `todo.db` task and links them via `todo_task_id`. `plan-merge-tracker.js` hook detects `gh pr merge` calls (PostToolUse Bash) and auto-advances linked plan tasks to `completed`, then cascades `ready` status to unblocked dependents.

**Plan-persistent sync hook** (`plan-persistent-sync.js`, PostToolUse): Fires on `complete_persistent_task`. When the completed persistent task has `plan_task_id` in its metadata, auto-marks the linked plan task as `completed`, cascades phase completion when all tasks in the phase are done (phases with ALL tasks skipped become `skipped` not `completed`), and cascades plan completion only when all phases are `completed` with no skipped required phases. Non-fatal — always exits 0. **Cross-check guard**: Before cascading, verifies that the plan task's linked `todo_task_id` (if set) is already `completed` in `todo.db`. If the linked todo task is still `pending`, `in_progress`, or `pending_audit`, the cascade is blocked and `additionalContext` warns the agent — preventing plan task completion from outrunning the actual work completion.

**Plan activation spawner hook** (`plan-activation-spawner.js`, PostToolUse): Fires on `update_plan_status`. When a plan transitions to `active` and has no `persistent_task_id`, atomically creates a persistent task for the plan-manager, links it to the plan (TOCTOU-safe via `UPDATE ... WHERE persistent_task_id IS NULL`), and enqueues the monitor in the `persistent` lane at `critical` priority. This ensures plans always have an automated orchestrator driving phase advancement. If the enqueue is blocked (focus mode, etc.), the persistent task exists and will be picked up when the block clears. Emits `plan_manager_spawned` audit event.

**Plan orphan detection** (`hourly-automation.js`, gate-exempt, 10-minute cooldown): Detects active plans whose plan-manager persistent task is missing, dead, or in a terminal state (`completed`/`cancelled`/`failed`), or permanently blocked (`paused` with `do_not_auto_resume` flag). Three revivable orphan scenarios each create a new plan-manager persistent task (without the `do_not_auto_resume` flag), link it to the plan (TOCTOU-safe), and enqueue it at `critical` priority: (1) plan has no `persistent_task_id` (activation hook failed), (2) `persistent_task_id` points to a nonexistent task, (3) `persistent_task_id` points to a terminal-state task (plan-manager completed prematurely). One non-revivable scenario: (4) `persistent_task_id` points to a `paused` task with `do_not_auto_resume=true` (crash-loop circuit breaker gave up permanently) — in this case the plan itself is auto-paused via `UPDATE plans SET status = 'paused'` rather than creating a new task, breaking the zombie-manager proliferation loop. The CTO must resolve the blocked persistent task before the plan can resume. Plans with `active` persistent tasks are handled by the existing persistent monitor revival system (Step 1c orphan catch-all in `drainQueue()`). Plans with `paused` persistent tasks without `do_not_auto_resume` are handled by `persistent_stale_pause_resume`. Emits `plan_manager_revived` audit event.

**Plan-manager env var preservation on revival**: When a plan-manager monitor crashes or is resumed, all revival/spawn paths extract `plan_id` from the persistent task's `metadata` JSON and inject `GENTYR_PLAN_MANAGER=true` and `GENTYR_PLAN_ID` into the session's environment. This is applied in: `requeueDeadPersistentMonitor()` (session-queue.js), `buildPersistentMonitorRevivalPrompt()` (persistent-monitor-revival-prompt.js), `persistent-task-spawner.js` (resume/amend hook), and `reviveOrphanedPlan()` (hourly-automation.js). The revival prompt also includes plan-manager role context so the revived monitor knows it must follow plan-manager agent instructions. The `stop-continue-hook.js` plan completion gate reads `GENTYR_PLAN_MANAGER` and `GENTYR_PLAN_ID` to verify plan completion before allowing the monitor to stop.

**6 hooks registered in `settings.json.template`**:
- `plan-briefing.js` (SessionStart) — briefs the active session on current plan state
- `plan-work-tracker.js` (PostToolUse `summarize_work`) — records agent work against plan tasks
- `plan-merge-tracker.js` (PostToolUse Bash) — detects PR merges and auto-completes plan tasks
- `plan-persistent-sync.js` (PostToolUse) — syncs persistent task completion back to the linked plan task; routes through `pending_audit` when `verification_strategy` exists
- `plan-activation-spawner.js` (PostToolUse) — spawns plan-manager persistent task on plan activation
- `plan-audit-spawner.js` (PostToolUse `update_task_progress`) — spawns independent auditor on `pending_audit` status

**5 slash commands**: `/plan`, `/plan-progress`, `/plan-timeline`, `/plan-audit`, `/plan-sessions`.

**CTO Dashboard integration**: 5 sections (`plans`, `plan-progress`, `plan-timeline`, `plan-audit`, `plan-sessions`) rendered via `PlanSection`, `PlanProgressSection`, `PlanTimelineSection`, `PlanAuditSection`, `PlanSessionSection` components. Data read from `plans.db` via `packages/cto-dashboard/src/utils/plan-reader.ts`; session correlation data from 7 sources via `packages/cto-dashboard/src/utils/plan-session-reader.ts`.

All 4 hooks are in the `criticalHooks` list in `cli/commands/protect.js` and are root-owned when protection is enabled.

### Plan Manager and Plan Updater Agents

**`plan-manager` agent** (`agents/plan-manager.md`): Opus-tier. A specialized persistent task monitor that executes a structured plan by spawning persistent tasks for each plan step. Runs as a persistent task itself (spawned via the persistent task system with `GENTYR_PLAN_MANAGER=true`, `GENTYR_PLAN_ID`, and `GENTYR_PERSISTENT_TASK_ID` env vars). On each cycle: checks ready tasks via `get_spawn_ready_tasks`, creates and activates persistent tasks for each ready plan task that lacks a `persistent_task_id`, monitors running persistent tasks via `inspect_persistent_task`, checks plan blocking state via `get_plan_blocking_status` (identifies which tasks are paused and whether parallel work is available), verifies auto-sync from `plan-persistent-sync.js` hook, processes CTO amendments, and checks for plan completion. Does NOT create standalone tasks in `todo.db`, edit files, or run Bash commands. Spawns `plan-updater` sub-agents for explicit progress sync.

**Plan task granularity rule**: Each plan task must represent a persistent-task-grade objective — work requiring multiple sessions. If a task can be completed by a single category sequence (one task-runner session), it should be a substep inside a plan task, NOT a standalone plan task.

**`plan-updater` agent** (`agents/plan-updater.md`): Haiku-tier lightweight sync agent. Given a `plan_task_id` and `plan_id`, reads completed standalone tasks for the linked persistent task, maps them to plan substeps by title/description matching, calls `complete_substep` for each match, and updates plan task progress. Completes in under 30 seconds. Does not create tasks or edit files.

**`plan-auditor` agent** (`agents/plan-auditor.md`): Sonnet-tier independent verification agent. Spawned automatically when a plan task with `verification_strategy` enters `pending_audit`. Verifies completion claims against actual artifacts (files, test output, PR status, directory contents). Renders exactly one verdict via `verification_audit_pass` or `verification_audit_fail`, then exits. Runs in the `audit` lane — cannot receive signals or messages from the plan manager. 8-minute TTL. Does not edit files or create tasks. Stale `plan-auditor` sessions in the `audit` lane are detected and re-enqueued by `session-reaper.js` via the plan task audit revival path in `reapSyncPass()`.

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports `--mock` for development and `--page N` to split rendering across 3 pages. `/cto-report` runs all three pages. Includes WORKLOG system for agent work tracking via `summarize_work` tool.

**Live CTO Dashboard** (`packages/cto-dashboard-live/`): Real-time Ink/React TUI that polls live data every 3 seconds. Launched via `/cto-dashboard` slash command (macOS only — opens a Terminal.app window). Five pages navigated via Tab / `1` / `2` / `3` / `4` / `5`. Built automatically by `npx gentyr sync` (step 7d); if `dist/` is missing, the `/cto-dashboard` command instructs the user to run sync rather than building inline (blocked by lockdown guard). Built `dist/` is gitignored.

**Page 1 — Observe**: Session list showing all sessions with persistent task hierarchy (monitors at top level, child sessions indented beneath). Keyboard navigation: arrow keys to select sessions, Enter to send a signal/message to the selected session (or resume a dead session), `[` / `]` to browse session summaries, `pgUp`/`pgDn` to scroll the activity stream (pgUp=older, pgDn=newer), `end` to jump back to latest activity. When scrolled up, the viewport is pinned — new entries do not auto-scroll — and the stream title shows `scrolled (N, end to follow)`. Activity content persists after session death with a `session_end` marker appended. Session items are two-line: status icon + id + title + elapsed on line 1, agent type + priority badge + last action on line 2.

**Page 2 — Demos & Tests**: Three-column layout — left panel lists demo scenarios from `user-feedback.db`; middle panel (`ScenarioDetailPanel`) shows the selected scenario's description, last-passed timestamp, recording path for the last successful run, and a run-history list filtered by the currently selected branch; right panel lists Playwright test files discovered from `playwright.config.ts`. Select an item with arrow keys, press Enter to launch it (demos run headed via `DEMO_HEADED=1`; tests run headless). Press `s` or `x` to stop a running process, Escape to clear finished output. Stopping a demo via `s` records a `failure_reason: 'stopped'` entry in the run history. A live output panel expands at the bottom while a process is running, tailing the process output file in real time. Switch panels with left/right arrow keys. Keyboard input is gated by `isActive` so only the visible page captures keystrokes. Process launching and tracking is handled by `utils/process-runner.ts` (`launchDemo`, `launchTest`, `checkProcess`, `killProcess`); output tailing by `hooks/useProcessOutput.ts`; data polling by `hooks/usePage2Data.ts`. **Branch selector**: Press `e` to cycle through branches (Preview / Staging / Prod). The selector is always visible — no services.json configuration required. Each option auto-pulls the corresponding git branch before running a demo: Preview pulls `preview`, Staging pulls `staging`, Prod pulls `main`. When a URL-based remote environment is selected (configured via `services.json`), `PLAYWRIGHT_BASE_URL` is set to the deployed URL and local dev server startup, health checks, and prerequisites are skipped entirely — Playwright test files still come from the current working tree, only the target URL changes. Additional URL-based environments can be added in `services.json` under the `environments` field: `{ "environments": { "staging": { "baseUrl": "https://staging.example.com", "label": "Staging", "branch": "staging" } } }`. The `label` and `branch` fields are optional (`label` defaults to the capitalized key name; `branch` enables auto-pull). The default selection is `preview`. **Execution mode toggle**: Press `r` to switch between LOCAL and REMOTE execution. Remote runs the Playwright test on a Fly.io machine instead of locally — requires `fly` section in `services.json` (configured via `/setup-fly`). When Fly.io is not configured, pressing `r` shows a guidance message. The mode bar (showing LOCAL/REMOTE tabs) only appears when Fly.io is configured. Both the branch selector and mode toggle are in a single control bar above the demo/test panels. Scenarios with `remote_eligible=false` display a `local-only` tag in their metadata line; pressing Enter on such a scenario while REMOTE mode is active shows a blocking status-bar message and does not launch the demo. **Demo result history**: Each scenario shows its last pass/fail status with a local/remote badge in the metadata line (e.g., `\u2713L 5m ago` for passed locally, `\u2717R 1h ago` for failed remotely). The scenario dot color reflects the last result: green=passed, red=failed, yellow=no results, gray=disabled. Results are stored in a `demo_results` table in `user-feedback.db` (auto-migrated), recording `scenario_id`, `execution_mode` (local/remote), `status` (passed/failed), `duration_ms`, `fly_machine_id` for remote runs, `branch` (git branch the demo ran against), `failure_reason` (one of `stopped` / `killed` / `interrupted` / `test_failure`, or null for passed runs), and `recording_path` (path to the MP4 for the last successful run). `branch` and `failure_reason` columns are auto-migrated on first write. Results are recorded automatically when a demo completes or is manually stopped (both local and remote). The Playwright MCP server's `run_demo`, `check_demo_result`, and `stop_demo` paths all call `persistDemoResult()` in `server.ts`, so agent-initiated runs appear in the same `demo_results` table as dashboard-initiated runs. A `result_persisted` dedup flag on each run entry prevents double-writes when multiple completion paths fire for the same demo. The `ScenarioDetailPanel` middle column reads run history via `readScenarioHistory()` in `live-reader.ts`, filtering by the currently selected branch. `readScenarioDetail()` returns full detail including `lastPassedAt` and `lastSuccessRecordingPath`. **Demo launch pipeline**: `launchDemo()` mirrors the `run_demo` MCP pipeline exactly — (0) **auto-pull**: when the selected environment has a `branch` set, `autoPullBranch()` fetches, stashes local changes, checks out the branch, pulls `--ff-only`, and pops the stash — ensuring the main tree has the latest code before the dev server starts; (1) `resolveServicesSecrets()` reads credentials from `services.json` secrets.local (same source as the MCP server), fail-closed on any op:// resolution failure; (2) `executeDashboardPrerequisites()` reads `user-feedback.db` and runs global/persona/scenario prerequisites with health-check skip logic (skipped for remote environments); (3) `ensureDashboardDevServer()` checks dev server health and auto-starts from `devServices` config or `pnpm dev` fallback (skipped for remote environments); (4) `PLAYWRIGHT_BASE_URL` is injected into the Playwright child env so it skips its webServer startup block; (5) `demoDevModeEnv` is applied only when the dev server is confirmed healthy. Auto-pull is skipped for remote environments (they have their own URL). Preflight status lines are written to the output file so the live output panel shows pipeline progress before Playwright starts. **Display lock preemption**: When the CTO launches a demo (Enter key), `launchDemo()` calls `preemptForCtoDashboardDemo()` from `utils/display-lock-manager.ts`, which force-acquires the `display` and `chrome-bridge` resources and signals any displaced agent to pause display-dependent work. On demo completion or manual stop (`s`/`x`), `releaseCtoDashboardDemo()` releases both locks (auto-promoting the displaced agent back to the front of the queue) and signals it to resume. Lock operations are non-fatal — if the resource-lock module is unavailable, the demo launches without lock integration.

**Page 3 — Plans**: Two-panel layout with plan list on the left and a phase/task/substep detail tree on the right. Shows plan status, progress bars (plan-level and per-phase), dependency display, linked persistent task IDs, and the 5 most recent state changes from `state_changes` table. Tasks with a `verification_strategy` display inline audit info beneath them: a pending audit shows a magenta hourglass with the strategy description; a passed audit shows a green checkmark with evidence; a failed audit shows a red X with the failure reason and evidence. `pending_audit` tasks render with a magenta status dot and report 95% progress in the progress bar. Data sourced from `plans.db` via `readPage3Data()` in `packages/cto-dashboard-live/live-reader.ts` (note: not the legacy `src/utils/data-reader.ts` path). Arrow keys to navigate; Enter to select a plan.

**Page 4 — Specs**: Two-panel layout with a category-grouped spec navigator on the left and a markdown content viewer on the right. Specs are discovered from the project's spec files (`.md` / `.mdx`) via the `specs-browser` MCP server's backing data. Left panel groups specs by suite/category; right panel renders spec content with word-wrap and a scrollable "more lines" indicator that correctly handles content overflow. Data sourced from the specs directory via `readPage4Data()`. Arrow keys to navigate; Enter to select a spec.

**Page 5 — Feed**: Live AI commentary feed powered by a background daemon. The LLM processing runs entirely outside the dashboard in `scripts/live-feed-daemon.js` (KeepAlive launchd service `com.local.gentyr-live-feed-daemon`). Every 60 seconds the daemon reads running sessions from `session-queue.db`, JSONL tails, summaries from `session-activity.db`, and plan status from `plans.db`, then spawns `claude -p --model haiku --output-format stream-json` to generate a 2-3 sentence ticker entry. Streaming progress is written to `.claude/state/live-feed-streaming.json`; completed entries are persisted to `.claude/state/live-feed.db` (max 500 entries, pruned on overflow). The dashboard is a pure read-only poller: `hooks/useLiveFeed.ts` polls `live-feed.db` every 3s for new entries and the streaming file every 2s for in-progress text. History is available immediately on load (no waiting for LLM). `components/CommentaryView.tsx` supports scroll-up pagination (`loadMore()` / `hasMore` props) with a "scroll up for older entries" indicator. Feed supports scroll (up/down arrows), page scroll (pgUp/pgDn), and auto-follow mode (`end` key). Key modules: `hooks/useLiveFeed.ts` (hook), `components/CommentaryView.tsx` (view), `live-reader.ts` exports `readFeedEntries()` (paginated DB reads), `readFeedStreamingState()` (streaming file reader), `readCommentaryContext()`, and `getActivityFingerprint()`. Mock data: `getMockPage5Data()` in `mock-data.ts`.

**Signal delivery states**: When a signal is sent to a running session, the status bar shows: `Pending` (sent, waiting for agent tool call), `Delivered` (signal file read), `Ack'd` (agent acknowledged via tool response), `Queued` (agent alive but unresponsive after 30s — will deliver on next tool call), or `Resumed` (agent died before reading — auto-escalated to `resumeSessionWithMessage`, opening a new Terminal.app window). Dead-session detection uses PID liveness as the primary ground truth; JSONL staleness is a secondary signal with a 120-second threshold (raised from 30s to prevent false positives from temporary write pauses). When PID liveness confirms a session is alive, signals route through `sendDirectiveSignal` regardless of JSONL age — `resumeSessionWithMessage` is reserved for sessions that are genuinely dead. The `session_end` activity marker is also checked to handle the race where the PID is still alive but the session has ended.

> Full details: [CTO Dashboard Development](docs/CLAUDE-REFERENCE.md#cto-dashboard-development)

## Control Surface Inventory

GENTYR guides Claude Code agents through **8 distinct control surface categories**, each operating at a different point in the agent lifecycle. This inventory is the authoritative reference for understanding how GENTYR shapes agent behavior.

### Overview

| Category | Count | When It Fires | What It Controls |
|----------|-------|---------------|-----------------|
| 1. Hooks | 91 JS files | Every tool call, session start/stop, user prompt | Real-time guardrails, context injection, lifecycle management |
| 2. Agent Definitions | 23 shared + 2 repo-specific | At agent spawn | Model tier, allowed tools, behavioral instructions, workflow |
| 3. MCP Servers/Tools | ~38 servers, ~730+ tools | On tool invocation | What actions agents can take, what data they can access |
| 4. Slash Commands | 46 commands | User-initiated | Workflows, dashboards, configuration |
| 5. CLAUDE.md (managed section) | 1 template | Every conversation turn | Persistent behavioral instructions in system prompt |
| 6. Session Briefing | 1 hook + content | Session start | One-time context dump: queue status, active tasks, bypass requests |
| 7. Prompt Templates | ~10 builders | Agent spawn | Task-specific instructions injected into spawn prompts |
| 8. Automation Scripts | 26 scripts | Cron/launchd/daemon | Background orchestration outside of agent sessions |

### What Each Category CAN and CANNOT Do

| Category | Can Block | Can Inject Context | Can Spawn Agents | Can Modify Code | Persists Across Sessions |
|----------|-----------|-------------------|-----------------|----------------|------------------------|
| PreToolUse hooks | **Yes** | No | No | No | No (stateless) |
| PostToolUse hooks | No | **Yes** | **Yes** | No | No (stateless) |
| SessionStart hooks | No | **Yes** | **Yes** | No | No (one-shot) |
| Agent Definitions | No | **Yes** (instructions) | No | Indirectly | **Yes** (file-based) |
| MCP Tools | No | **Yes** (returns) | No | Indirectly | **Yes** (DB-backed) |
| CLAUDE.md | No | **Yes** (system prompt) | No | No | **Yes** (file-based) |
| Prompt Templates | No | **Yes** (spawn prompt) | No | No | No (per-spawn) |
| Automation Scripts | No | No | **Yes** | No | **Yes** (daemon) |

### Hooks by Lifecycle Phase

#### PreToolUse (18 hooks — BLOCK dangerous actions)

| Hook | Matcher | Purpose |
|------|---------|---------|
| interactive-lockdown-guard.js | `""` (all) | Block file-editing tools in interactive CTO sessions |
| block-no-verify.js | `Bash` | Block `--no-verify` on git commands |
| credential-file-guard.js | `Bash,Read,Write,Edit,NotebookEdit,Grep,Glob` | Block access to credential files |
| playwright-cli-guard.js | `Bash,mcp__secret-sync__secret_run_command` | Block direct Playwright CLI via Bash or secret_run_command (use MCP tools) |
| branch-checkout-guard.js | `Bash` | Block branch switching in main tree |
| main-tree-commit-guard.js | `Bash` | Block git add/commit on protected branches |
| worktree-cwd-guard.js | `Bash` | Block Bash when CWD is deleted worktree |
| worktree-path-guard.js | `Write,Edit,NotebookEdit` | Block file writes outside worktree boundary |
| worktree-remove-guard.js | `Bash` | Block `git worktree remove` on worktrees owned by other active sessions (Bug #6 Layer 3) |
| interactive-agent-guard.js | `Agent` | Block code-modifying sub-agents in interactive sessions |
| block-team-tools.js | `TeamCreate,TeamDelete,SendMessage` | Block Team tools (use Agent tool instead) |
| secret-profile-gate.js | `mcp__secret-sync__secret_run_command` | Enforce secret profile usage |
| protected-action-gate.js | `mcp__*` | Block protected MCP actions; store as deferred action for spawned agents |
| staging-lock-guard.js | `Bash` | Block staging operations (gh pr create --base staging, gh pr merge targeting staging, gh pr merge --admin, git push, git merge) for ALL sessions without `GENTYR_PROMOTION_PIPELINE=true`; CI check verification on staging merges |
| worktree-sync-guard.js | `Bash,mcp__secret-sync__secret_run_command` | Block `gentyr sync` when CWD is inside a worktree (sync destroys the worktree directory) |
| gate-confirmation-enforcer.js | `mcp__todo-db__complete_task,mcp__persistent-task__complete_persistent_task` | Block task completion while `pending_audit` is active; prevents bypassing the audit gate |
| signal-compliance-gate.js | `mcp__agent-tracker__send_session_signal` | Validate inter-agent signals against schema before delivery; reject malformed or unauthorized signal types |
| demo-local-guard.js | `mcp__playwright__run_demo,mcp__playwright__run_demo_batch,mcp__playwright__run_tests,mcp__playwright__launch_ui_mode` | Block local demo execution for spawned agents (CTO HMAC bypass required) |

#### PostToolUse (39 hooks — REACT to actions, inject context, spawn agents)

| Hook | Matcher | Purpose |
|------|---------|---------|
| signal-reader.js | `""` (all) | Read inter-agent signals/directives |
| worktree-freshness-check.js | `""` (all) | Nag if worktree is stale (every 2 min) |
| agent-comms-reminder.js | `""` (all) | Remind agents to check for communications |
| alignment-reminder.js | `""` (all) | Remind agents to check task alignment |
| persistent-task-briefing.js | `""` (all) | Inject persistent task state into monitor context |
| progress-tracker.js | `""` (all) | Track pipeline stage progress |
| monitor-reminder.js | `""` (all) | Remind monitors to check sub-task status |
| uncommitted-change-monitor.js | `Write,Edit` | Warn after 5 uncommitted file edits |
| pr-auto-merge-nudge.js | `Bash` | Nudge to self-merge after PR creation |
| ai-pr-review-hook.js | `Bash` | Spawn Haiku gate agent to review PR diff on every PR creation; posts PR comments for critical findings, adds ai-reviewed label when clean (5-min TTL, gate lane) |
| plan-merge-tracker.js | `Bash` | Auto-advance plan tasks on PR merge |
| strict-infra-nudge-hook.js | `Bash` | Redirect agents from Bash infra commands to MCP tools |
| urgent-task-spawner.js | `create_task` | Auto-spawn urgent tasks |
| task-gate-spawner.js | `create_task` | Spawn gate agent for pending_review tasks |
| workstream-spawner.js | `create_task` | Auto-spawn workstream tasks |
| persistent-task-linker.js | `create_task` | Auto-link sub-tasks to persistent tasks |
| orchestration-guidance-hook.js | `create_task` | Analyze task complexity; nudge CTO toward parallel tasks, persistent tasks, or plans when complexity signals detected |
| task-deletion-cascade.js | `delete_task` | Cascade-kill running sessions linked to a deleted task via `cancelSessionsByTaskId` |
| project-manager-reminder.js | `summarize_work` | Remind to spawn project-manager |
| worktree-cleanup-gate.js | `summarize_work` | Remind to clean up worktree |
| plan-work-tracker.js | `summarize_work` | Record work against plan tasks |
| session-completion-gate.js | `summarize_work,complete_task` | Validate completion prerequisites |
| workstream-dep-satisfier.js | `complete_task` | Cascade workstream dependency satisfaction |
| demo-failure-spawner.js | `check_demo_result,check_demo_batch_result,run_demo` | Auto-spawn repair agents on demo failure; enriches repair prompts with `failure_classification` and ECONNREFUSED infrastructure guidance; injects skipped-scenario accountability context for completed batches |
| demo-remote-enforcement.js | `run_demo` | Enforce remote+batch execution for spawned agents; detect sequential local anti-pattern |
| long-command-warning.js | `secret_run_command` | Warn about MCP transport timeout |
| persistent-task-spawner.js | `activate/resume/amend/pause/cancel_persistent_task` | Spawn/stop persistent monitors |
| plan-persistent-sync.js | `complete_persistent_task` | Sync completion to plan tasks |
| plan-activation-spawner.js | `update_plan_status` | Spawn plan manager on plan activation |
| plan-audit-spawner.js | `update_task_progress` | Spawn independent auditor on pending_audit |
| screenshot-reminder.js | `""` (all) | Remind agents to Read screenshot paths in tool responses |
| context-pressure-hook.js | `""` (all) | Monitor spawned-agent context window size and session age; nudge at configurable tiers; call `request_self_compact` at critical threshold |
| release-artifact-collector.js | `complete_task,summarize_work` | Archive session transcripts to release artifact directory when GENTYR_RELEASE_ID is set |
| release-completion-hook.js | `complete_persistent_task` | On release plan-manager completion: unlock staging, generate report, emit audit event, broadcast signal |
| universal-audit-spawner.js | `complete_task,update_task_progress,complete_persistent_task` | Fire on task completion; when `gate_success_criteria` / `verification_strategy` set, transition to `pending_audit` and enqueue Haiku auditor in `audit` lane |
| alignment-monitor-briefing.js | `""` (all) | Deliver cross-session alignment violation summaries to active deputy-CTO monitor sessions |
| bypass-request-router.js | `submit_bypass_request` | Route bypass requests to global monitor via directive signal; CTO sees after 5-min grace period |
| authorization-audit-spawner.js | `mcp__agent-tracker__record_cto_decision` | On verified CTO decision: for `lockdown_toggle`/`local_mode_toggle`, executes inline (writes state files, skips auditor — interactive sessions have no `agent_id`/`queue_id`); for all others, transitions to `audit_pending` and enqueues `authorization-auditor` in `audit` lane (8-min TTL); skips auditor when `decision_type === 'audit_override'` |
| deferred-action-audit-executor.js | `mcp__agent-tracker__cto_decision_audit_pass` | On authorization audit pass, load linked deferred action and execute via MCP daemon (Tier 1) or Bash (Tier 2); signal original agent with result |

#### SessionStart (9 hooks — set initial context)

| Hook | Purpose |
|------|---------|
| gentyr-splash.js | Display GENTYR branding |
| gentyr-sync.js | Auto-rebuild MCP servers if stale, re-merge configs |
| todo-maintenance.js | Clean up stale tasks |
| dead-agent-recovery.js | Detect and revive dead agents |
| crash-loop-resume.js | Resume persistent tasks paused by circuit breaker |
| credential-health-check.js | Verify 1Password connectivity |
| playwright-health-check.js | Verify Playwright and browser availability |
| plan-briefing.js | Brief agent on active plan state |
| session-briefing.js | Comprehensive context dump: queue, tasks, deferred actions, bypass requests, focus mode, active persona profile; also warns when main has commits not in staging (merge-back needed) |

#### UserPromptSubmit (12 hooks — process user/CTO input)

| Hook | Purpose |
|------|---------|
| cto-notification-hook.js | Update CTO status line; inject pending bypass request details into model context on every prompt |
| secret-leak-detector.js | Scan for leaked secrets |
| bypass-approval-hook.js | Deprecated (Phase 2). Detect "APPROVE BYPASS" pattern — preserved for HOTFIX flow pending Phase 5 cleanup |
| protected-action-approval-hook.js | Deprecated (Phase 3). Previously detected approval phrase+code tokens and executed deferred actions via MCP daemon — superseded by authorization-audit-spawner.js + deferred-action-audit-executor.js |
| slash-command-prefetch.js | Pre-fetch data for slash commands |
| branch-drift-check.js | Check for upstream branch drift |
| comms-notifier.js | Notify about pending inter-agent communications |
| workstream-notifier.js | Notify about workstream updates |
| cto-prompt-detector.js | Detect CTO-directed prompts in spawned sessions |
| secrets-local-health.js | Warn about missing secrets.local entries |
| mcp-guidance-hook.js | Inject MCP server guidance and pending server notifications |
| pending-sync-notifier.js | Warn CTO when pending config files need npx gentyr sync |

#### Stop (1 hook — gate session termination)

| Hook | Purpose |
|------|---------|
| stop-continue-hook.js | Gate session stop, check unfinished work, trigger revival |

### Shared Hook Libraries (hooks/lib/ — 38 modules)

Key modules consumed by hooks:
- `session-queue.js` — Central queue management (enqueue, drain, spawn, suspend/resume)
- `session-reaper.js` — Dead session detection and cleanup (sync + async passes); includes audit revival detection in `reapSyncPass()` — stale `audit`-lane sessions for all four task types (`todo`, `persistent`, `plan`, `authorization`) are re-enqueued via `buildAuditorSessionSpec({ taskType })`
- `session-audit.js` — Audit event emission to session-audit.log
- `session-signals.js` — Inter-agent signal delivery
- `resource-lock.js` — Shared resource coordination (display, chrome-bridge, main-dev-server)
- `memory-pressure.js` — RAM monitoring for spawn gating
- `worktree-manager.js` — Worktree provisioning and cleanup
- `port-allocator.js` — Per-worktree port isolation
- `process-tree.js` — Process group management (killProcessGroup, killProcessesInDirectory)
- `task-category.js` — Task pipeline resolution (resolveCategory, buildPromptFromCategory)
- `bypass-guard.js` — CTO bypass request checking
- `blocker-auto-heal.js` — Self-healing orchestrator for persistent monitors: diagnoses crash type, spawns fix tasks, escalates to CTO after max attempts (`handleBlocker`)
- `pause-propagation.js` — Hierarchical pause/resume propagation between persistent tasks and plans (propagatePauseToPlan, propagateResumeToPlan, assessPlanBlocking)
- `persistent-monitor-revival-prompt.js` — Revival prompt builder (now includes self-heal context from blocker_diagnosis)
- `persistent-revival-context.js` — Revival context assembly (last_summary, amendments, sub-tasks, blocker_diagnosis)
- `persistent-monitor-demo-instructions.js` — Demo-specific monitor instructions
- `persistent-monitor-strict-infra-instructions.js` — Infrastructure guidance for monitors
- `strict-infra-guidance-prompt.js` — Bash prohibition prompts
- `user-prompt-resolver.js` — Resolve user prompt UUIDs to content
- `spawn-env.js` — Environment variable injection for spawned agents
- `feature-branch-helper.js` — Branch naming and detection
- `llm-client.js` — Shared `callLLMStructured` for Haiku structured JSON output via `--json-schema`
- `report-auto-resolver.js` — PR-based report auto-resolution and dedup (runReportAutoResolve, runReportDedup)
- `deferred-action-db.js` — Deferred protected action DB operations (create, read, list, mark approved/executing/completed/failed, dedup, expire)
- `deferred-action-executor.js` — MCP HTTP execution, HMAC verification with timing-safe comparison, full execution pipeline for deferred actions
- `staging-lock.js` — Staging lock state management (`lockStaging`, `unlockStaging`, `isStagingLocked`, `getStagingLockState`); persists lock to `.claude/state/staging-lock.json`; best-effort GitHub branch protection via `gh api`
- `release-orchestrator.js` — Production release artifact collection: `enumerateReleasePRs` (gh pr list with git fallback), `getArtifactDir` (create `.claude/releases/{id}/prs|sessions|reports/`), `collectSessionArtifact` (copy JSONL by agent marker), `collectDemoArtifacts` (copy screenshots/recordings + demo-results.json), `collectTriageArtifacts` (query cto-reports.db + deputy-cto.db)
- `release-report-generator.js` — Structured release report pipeline: `generateStructuredReport` reads release-ledger.db + artifacts, fills `templates/release-report-template.md` with 17 placeholders (including `{cto_approval}`), writes `report.md` to artifact dir; `convertToPdf` converts to PDF via headless Chromium; `generateCtoApproval` reads `cto-approval.json` to fill Section 9
- `cto-approval-proof.js` — CTO release approval cryptographic proof: `verifyQuoteInJsonl` (line-by-line JSONL scan for verbatim quote), `computeApprovalHmac` (HMAC-SHA256 with `cto-release-approval` domain separator), `verifyApprovalHmac` (constant-time verification), `computeFileHash` (SHA-256), `findCurrentSessionJsonl` (session discovery — encodes project path by replacing all non-alphanumeric chars with dashes to match canonical `~/.claude/projects/` directory naming). Consumed by `record_cto_approval` tool on release-ledger server. **TOCTOU defense**: `record_cto_approval` copies the live JSONL to a stable snapshot first, then verifies the quote and hashes the snapshot (not the live file), ensuring the archived hash matches the verified content. **Spawned-session guard**: `record_cto_approval` blocks `CLAUDE_SPAWNED_SESSION=true` sessions — only interactive CTO sessions can sign off releases. **`approval_text` minimum**: 10 characters (enforced by Zod schema) to ensure a substantive audit trail
- `compact-session.js` — Session compaction utilities: reads session context token counts from JSONL tails, tracks compaction events in `compact-tracker.json`, and executes `claude --resume <id> -p /compact` on dead sessions before revival when context is high. Exports `compactSessionIfNeeded(sessionId, cwd, opts)`. Consumed by `session-queue.js` `spawnQueueItem` for revival-time compaction of `resume`-type spawns.
- `auditor-prompt.js` — Single source of truth for building auditor session specs. Exports `buildAuditorSessionSpec()` consumed by `universal-audit-spawner.js` (first spawn), `authorization-audit-spawner.js` (CTO authorization audits), and `session-queue.js` Step 1b.5 (revival spawn). Also exports `buildAuthorizationAuditorSessionSpec()`. Internally calls `resolveAuditTools(taskType)` to dispatch across four task types: `'todo'` (universal-auditor + todo-db tools), `'persistent'` (universal-auditor + persistent-task tools), `'plan'` (plan-auditor + plan-orchestrator tools), `'authorization'` (authorization-auditor + agent-tracker cto_decision tools).
- `load-test-runner.js` — Lightweight autocannon-based load test runner. Reads route configuration from `services.json` (`loadTest` section), runs load tests per route, and returns structured performance results. `autocannon` must be installed in the target project. Used by the promotion pipeline when `loadTest.enabled: true`.
- `ai-compatibility-check.js` — LLM-powered (Haiku) dependency upgrade compatibility validator. Fetches npm registry metadata and changelogs, analyzes project usage patterns, and classifies upgrades as compatible/risky with specific breaking-change identification. Returns `{ compatible, risks, recommendation }`.
- `ai-pr-decomposition.js` — LLM-powered (Haiku) large-PR decomposer. When a PR exceeds 3000 lines, suggests how to split commits into independently-promotable groups by feature/concern. Returns `{ groups }` with each group's commits, rationale, and suggested branch name.

### Agent Definitions (24 shared)

| Agent | Model | Purpose | Key Constraints |
|-------|-------|---------|----------------|
| code-writer | opus | Write code | Must run in worktree, does NOT commit |
| code-reviewer | opus | Review code | Read-only, does NOT commit |
| test-writer | sonnet | Write/update tests | Must run in worktree, does NOT commit |
| project-manager | sonnet | Git operations | ONLY agent that commits, pushes, creates PRs, self-merges |
| investigator | opus | Research/diagnose | Read-only, no worktree needed |
| user-alignment | sonnet | Verify user intent | Read-only auditor, no file edits |
| deputy-cto | opus | Triage/escalation | Review promotion PRs, manage task queue; can operate as global alignment monitor |
| persistent-monitor | opus | Long-running orchestrator | Never edits files, spawns sub-agents via create_task |
| plan-manager | opus | Plan execution | Spawns persistent tasks for plan steps |
| plan-updater | haiku | Sync plan substeps | Lightweight, completes in <30s |
| plan-auditor | sonnet | Verify plan task completion | Independent, 8-min TTL, audit lane |
| universal-auditor | sonnet | Verify todo-db and persistent task completion | Independent, 8-min TTL, audit lane, signal-excluded; does NOT audit plan tasks |
| authorization-auditor | sonnet | Verify CTO authorization decisions against presented context | Independent, 8-min TTL, audit lane, signal-excluded; verifies via peek_session JSONL; fail-closed on missing session |
| demo-manager | sonnet | Demo lifecycle | Only agent that creates/modifies .demo.ts files |
| feedback-agent | sonnet | User persona testing | No source code access |
| product-manager | opus | PMF analysis | External research only |
| antipattern-hunter | sonnet | Anti-pattern detection | Read-only |
| icon-finder | opus | Icon sourcing | SVG processing pipeline |
| secret-manager | sonnet | Credential lifecycle | 1Password-based operations |
| repo-hygiene-expert | sonnet | Repo structure analysis | Read-only |
| workstream-manager | haiku | Queue dependency analysis | Read-only |
| staging-reviewer | sonnet | Staging reactive review (antipattern, code-quality, user-alignment, spec-compliance) | Read-only reviewer; spawns code-writer sub-agents for fixes |
| cicd-manager | sonnet | Deployment, promotion, rollback, release infrastructure | Single authority for CI/CD pipeline; does NOT edit source code |
| security-auditor | sonnet | OWASP Top 10 code security review (Injection, Auth, XSS, CSRF, IDOR, SSRF, Misconfiguration, Data Exposure) | Read-only; does NOT fix issues, reports via agent-reports; reviews recent git history |

### MCP Servers (~38 servers)

#### Core State Servers (Tier 2 — per-session, stateful)

| Server | Key Tools | Purpose |
|--------|-----------|---------|
| todo-db | create_task, list_tasks, complete_task, summarize_work, gate_approve_task, list_categories | Task CRUD, categories, gate approval |
| persistent-task | create/activate/amend/pause/resume/cancel/complete_persistent_task, inspect_persistent_task | Persistent task lifecycle |
| plan-orchestrator | create_plan, add_phase, add_plan_task, get_spawn_ready_tasks, plan_dashboard | Plans, phases, tasks, dependencies |
| agent-tracker | get_session_queue_status, set_max_concurrent_sessions, acquire/release_shared_resource, submit/resolve_bypass_request, list/resolve_blocking_item, get_blocking_summary, peek_session, browse_session, set_automation_toggle, get_automation_toggles, record_cto_decision, check_cto_decision, cto_decision_audit_pass, cto_decision_audit_fail | Session queue, signals, locks, bypass, blocking queue, automation toggles, CTO authorization chain |
| user-feedback | create_persona, register_feature, create_demo_scenario, register_prerequisite, lock/unlock_feature, create/archive/switch/list/get/delete_persona_profile, verify_demo_completeness | Personas, features, scenarios, prerequisites, persona profiles, demo completeness gate |
| product-manager | start_section, approve_section, get_section | PMF analysis pipeline |
| deputy-cto | create_report, list_reports, acknowledge_report, force_promote_to_prod | Reports, triage, delegation, CTO-gated force production promotion |
| release-ledger | create_release, get_release, list_releases, update_release, sign_off_release, cancel_release, add_release_pr, update_release_pr_status, add_release_session, add_release_report, add_release_task, get_release_evidence, generate_release_report, present_release_summary, record_cto_approval | Production release evidence chain (staging lock → CTO sign-off with cryptographic proof) |

#### Infrastructure Servers (Tier 1 — shared daemon)

| Server | Purpose |
|--------|---------|
| secret-sync | Credential resolution, services.json config, command execution with secrets |
| github | GitHub API (issues, PRs, repos) |
| cloudflare | DNS and worker management |
| supabase | Database operations |
| onepassword | 1Password read/write |
| vercel | Deployment management |
| render | Service management |
| codecov | Coverage tracking |
| resend | Email sending |
| elastic-logs | Log querying, logging config verification (`query_logs`, `get_log_stats`, `verify_logging_config`) |

#### Browser Automation Servers

| Server | Tool Count | Purpose |
|--------|-----------|---------|
| playwright | ~38 | Demo execution, test running, screenshots, video, prerequisites |
| chrome-bridge | 35 | 17 socket-based + 2 AppleScript + 4 convenience + 4 React automation + diagnostics |

#### Content/Display Servers
specs-browser, cto-report, cto-reports, show, setup-helper, feedback-explorer, icon-processor, docs-feedback, makerkit-docs

#### Feedback Agent Servers
feedback-reporter, playwright-feedback, programmatic-feedback

### Slash Commands (46)

**Demo**: demo, demo-all, demo-autonomous, demo-bulk, demo-interactive, demo-session, demo-validate
**Tasks**: spawn-tasks, task-queue, triage, persistent-task, persistent-tasks
**Monitoring**: monitor, status
**Plans**: plan, plan-progress, plan-timeline, plan-audit, plan-sessions
**Config**: automation-rate, concurrent-sessions, configure-personas, focus-mode, global-monitor, lockdown, local-mode, setup-gentyr, toggle-automation-gentyr, toggle-product-manager
**Operations**: cto-dashboard, deputy-cto, promote-to-prod, promote-to-prod-force, promote-to-staging, session-queue, show, workstream
**Infrastructure**: hotfix, push-migrations, push-secrets, overdrive-gentyr, setup-fly
**Analysis**: persona-feedback, product-manager, replay, run-feedback

### Prompt Injection Points (7 major sources)

| Source | When | What |
|--------|------|------|
| CLAUDE.md.gentyr-section | Every turn (system prompt) | Merge chain, agent workflow, commit rules, tool reference |
| session-briefing.js | Session start | Queue state, active tasks, bypass requests, focus mode |
| plan-briefing.js | Session start | Active plan state and progress |
| buildPromptFromCategory() | Agent spawn | 6-step pipeline (or custom category sequence) |
| buildPersistentMonitorRevivalPrompt() | Monitor revival | Last summary, amendments, sub-task status, demo/infra flags |
| persistent-task-briefing.js | Every tool call (monitors) | Current task state, amendment reminders, heartbeat |
| strict-infra-guidance-prompt.js | Agent spawn (when flagged) | MCP-only infrastructure instructions |

### Control Surface Interaction Flow

```
User/CTO Message
    |
    +-- UserPromptSubmit hooks (11) --> Context injection, leak detection, notification
    |
    v
Agent Reasoning (informed by CLAUDE.md + session briefing + plan briefing)
    |
    +-- PreToolUse hooks (14) --> BLOCK dangerous actions
    |
    v
Tool Execution (MCP tools, Bash, Read, Write, Edit, Agent)
    |
    +-- PostToolUse hooks (27) --> REACT: inject context, spawn agents, track progress
    |
    v
Agent Spawn (via Agent tool or session queue)
    |
    +-- Agent Definition (.md) --> Model, tools, behavioral constraints
    +-- Prompt Template --> Task-specific instructions, pipeline steps
    +-- SessionStart hooks (9) --> Initial context, health checks, briefing
    |
    v
Session Stop
    |
    +-- Stop hook (1) --> Gate completion, trigger revival if needed
    |
    v
Background Automation
    |
    +-- hourly-automation.js --> Spawn tasks, reap sessions, cleanup worktrees, auto-rollback
    +-- revival-daemon.js --> Detect dead agents, revive immediately
    +-- session-activity-broadcaster.js --> Generate and deliver session summaries
    +-- live-feed-daemon.js --> Generate Live Feed commentary entries to live-feed.db
    +-- preview-watcher.js --> Keep worktrees fresh
    +-- synthetic-monitor.js --> Probe health endpoints, write alerts for auto-rollback pipeline
```

## GENTYR Session Lifecycle — Complete Inventory

### Session Status Values & State Machine

```
queued → spawning → running → completed
  ↓                    ↓
  cancelled            suspended → running (SIGCONT)
                       ↓
  queued → failed      completed (if PID dies while suspended)
```

**Statuses:** `queued`, `spawning`, `running`, `suspended`, `completed`, `failed`, `cancelled`

### Session Entry (Enqueueing)

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

### Session Spawning (Drain Cycle)

**Function:** `drainQueue()` in `session-queue.js` — 7 steps per cycle

**Step 1: Reap stale running items** — Calls `reapSyncPass(db)`. Detects: dead PIDs, spawning zombies (5+ min no PID), stale persistent monitor heartbeats (default 5 min), auth-stalled sessions (default 2 min). Dead PID actions: mark `completed` (or `failed` with `no_output_crash` for sub-30s deaths with no JSONL), release all resource locks, remove from resource queues, reactive worktree cleanup (if clean), retire progress files, reset linked TODO task to `pending`.

**Step 1b: Re-enqueue dead persistent monitors** — Calls `requeueDeadPersistentMonitor()`. Circuit breaker: max 3 hard revivals per task in 10 min → exponential backoff (5→10→20→60 min). Rate-limit detection: scans session tail, applies 5-min cooldown (excluded from crash counter). Self-healing: calls `handleBlocker()` → may escalate to CTO or spawn fix task.

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

### Session Reaping (Death Detection)

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

### Session Revival (8 Overlapping Mechanisms)

| # | Mechanism | Trigger | Latency | Priority | Lane | Max Retries | Guards |
|---|-----------|---------|---------|----------|------|-------------|--------|
| 1 | **Revival daemon** (`scripts/revival-daemon.js`) | fs.watch on agent-tracker-history | <1s | urgent | revival | 5 (then escalating cooldown) | Memory pressure, bypass guard, suspended check, age <1h |
| 2 | **Session reviver** (`session-reviver.js`) | Hourly automation, 10-min cooldown | ~10 min | urgent | revival | 1 per cycle, max 3/cycle | Memory pressure, concurrency slots, bypass guard, suspended check |
| 3 | **Dead agent recovery** (SessionStart hook) | Every interactive session start | Immediate (CTO login) | N/A (no spawn) | N/A | 1 per login | Lock coordination, spawned-session skip |
| 4 | **Crash-loop resume** (SessionStart hook) | Every interactive session start | Immediate (CTO login) | N/A (informational) | N/A | N/A | Reports only — no auto-resume |
| 5 | **Stop-continue hook** (Stop hook) | Agent attempts to stop | Real-time | N/A (gates exit) | N/A | Blocks until conditions met | Persistent task status, plan completion, worktree cleanup |
| 6 | **Stale-pause auto-resume** (hourly automation) | Persistent task paused > 30 min | ~15 min cycle | critical | persistent | Unlimited (unless self-pause circuit breaker) | Bypass guard, 1Password check, do_not_auto_resume flag, self-pause circuit breaker |
| 7 | **Orphan catch-all** (drainQueue Step 1c) | Every drain cycle | Per-drain | critical | persistent | Unlimited | Bypass guard, dedup |
| 8 | **requeueDeadPersistentMonitor** (drainQueue Step 1b) | Dead persistent PID detected | Immediate | critical | persistent | 3/10-min (then exponential backoff) | Rate-limit detection, crash-loop circuit breaker, dedup, self-healing |

**Circuit Breaker (dual-layer):** Layer 1 (in-memory): `_monitorRevivalTimestamps` Map — max 3 hard revivals per task in 10 min. Layer 2 (DB): `revival_events` table — survives process restart. Backoff: 5 min → 10 → 20 → 60 min (exponential, capped). Stale heartbeat revivals excluded from crash counter.

### Session Suspension & Preemption

**Non-destructive (SIGTSTP/SIGCONT):** Trigger: CTO/critical item at capacity in drainQueue Step 5. `preemptLowestPriority()` suspends lowest-priority running session. State: `running → suspended` (doesn't count toward concurrency). Resume: drainQueue Step 6 sends SIGCONT when capacity frees.

**Destructive (legacy, `preemptForCtoTask()`):** Sends SIGTERM to victim, waits 5s, extracts session ID. Re-enqueues victim as `urgent` resume item. Resets victim's TODO task to `pending`.

### Task Lifecycle (todo.db)

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

### Persistent Task Lifecycle

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

### Plan Lifecycle

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

### Background Automation Affecting Lifecycle

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

### Daemons (Persistent Background Processes)

| Daemon | File | Interval | Purpose |
|--------|------|----------|---------|
| Revival daemon | `scripts/revival-daemon.js` | fs.watch + 10s poll | Sub-second dead agent detection, enqueues revival |
| Preview watcher | `scripts/preview-watcher.js` | 30s poll | Auto-merges base branch into worktrees, syncs deps |
| Session activity broadcaster | `scripts/session-activity-broadcaster.js` | 5 min | Generates per-session summaries, broadcasts to agents |
| Live feed daemon | `scripts/live-feed-daemon.js` | 60s | Generates AI commentary for CTO dashboard Page 5 |
| MCP shared daemon | `scripts/mcp-server-daemon.js` | Always-on | Hosts Tier 1 MCP servers on port 18090 |
| Synthetic monitor | `scripts/synthetic-monitor.js` | 60s prod / 5 min staging | Probes health endpoints from `services.json`; writes alerts to `synthetic-alerts.json`; stores metrics in `synthetic-metrics.db` |

### Cross-Cutting Guards

| Guard | Type | What it blocks |
|-------|------|---------------|
| Memory pressure | Spawn gate | Blocks non-critical spawns at high/critical RAM pressure |
| Focus mode | Enqueue gate | Blocks non-essential automation (allows CTO/critical/persistent) |
| Bypass request | Enqueue + revival gate | Blocks task spawn/revival when CTO decision pending |
| CTO activity gate | Automation gate | Blocks gate-required hourly automation when no CTO briefing in 24h |
| Worktree exclusivity | Enqueue gate | Blocks sessions targeting same worktree |
| Self-pause circuit breaker | Auto-resume guard | Sets `do_not_auto_resume` after 2+ self-pauses in 2 hours |
| Crash-loop circuit breaker | Revival guard | Exponential backoff after 3+ hard revivals in 10 min |
| Rate-limit cooldown | Revival guard | 5-min cooldown on rate-limited sessions |

### Resource Lock Lifecycle

Shared resources (`display`, `chrome-bridge`, `main-dev-server`) use acquire/release/renew/queue semantics. On agent death: `releaseAllResources()` + `removeFromAllQueues()` called by reaper. TTL expiry: `checkAndExpireResources()` in every drain cycle; dead holders released immediately via PID check. Force release: CTO override via `force_release_shared_resource`; spawned agents blocked from seizing CTO-held locks. Auto-acquire: `run_demo` with `recorded: true` auto-acquires `display` lock.

### Session Sync/Recycle (npx gentyr sync)

`npx gentyr sync` Step 10: enumerates all running/spawning sessions, sends SIGTERM→SIGKILL, marks old items `failed`, resets linked TODO tasks to `pending`, releases shared resources, re-enqueues each at `urgent` priority. Resume-capable sessions (matching JSONL) use `--resume`. MCP daemon restarted between kill and re-enqueue.
