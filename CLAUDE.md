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

Rebuilds MCP servers, re-merges settings.json, regenerates .mcp.json, and deploys staged hooks. Also runs automatically on `SessionStart` when framework version or config hash changes. `computeConfigHash()` in `.claude/hooks/gentyr-sync.js` hashes `settings.json.template`, `.mcp.json.template`, AND `CLAUDE.md.gentyr-section`, so section-only edits to the managed CLAUDE.md block invalidate `configHash` and trigger the SessionStart re-merge path on target projects' next session. At every SessionStart, the hook also checks `~/.claude/settings.json` for stale hook file references (hook entries whose referenced file no longer exists on disk) and emits an escalated warning to run `npx gentyr sync` immediately. `npx gentyr sync` itself removes stale hook entries from `~/.claude/settings.json` as part of its cleanup pass. **Step 6c — branch protection check**: `npx gentyr sync` checks whether GitHub branch protection (required status checks) is configured on `preview`, `staging`, and `main` via the GitHub API. If any branch is missing protection, a yellow warning is printed with the command to run `scripts/setup-branch-protection.js`. This is advisory — sync succeeds even if protection is absent. **Session recycling** (Step 10): After all config steps complete, `npx gentyr sync` enumerates all `running`/`spawning` sessions in the queue (excluding `gate` and `audit` lanes), sends SIGTERM→SIGKILL to each, marks the old queue item `failed`, resets linked TODO tasks to `pending`, releases shared resources, and immediately re-enqueues each session at `urgent` priority via `enqueueSession()` with `source: 'sync-recycle'`. Resume-capable sessions are re-spawned with `--resume` — the session UUID is stored on the queue item at spawn time (`resume_session_id` column, backfilled by `reapSyncPass()` for sessions that missed it). Sessions with no discoverable JSONL are skipped with a warning rather than spawned fresh, preventing accumulated context loss. A 30-second poll verifies each revived session has a live PID. **Phase 2b — MCP daemon restart**: Between killing sessions and re-enqueuing them, `npx gentyr sync` always restarts the shared MCP daemon to pick up new code and credentials after the rebuild. It kills the stale PID (from state file) and any process holding port 18090, then restarts via `launchctl bootstrap` (macOS) or `systemctl --user restart` (Linux), and polls for recovery up to 15 seconds. Reports green (healthy), yellow (restart attempted), or red (failed to recover). Non-fatal — sync succeeds even if daemon restart fails. Worktree paths that no longer exist are skipped during session re-enqueue (sessions are re-spawned without a worktree context instead of crashing with ENOENT). **Re-protect before recycle**: `npx gentyr sync` re-enables protection (re-protect) BEFORE session recycling, not after. Session recycling spawns 10+ processes taking 30-60s, which expired the sudo credential cache and corrupted terminal stdin when re-protect ran afterward. **Project-local MCP server preservation**: Both `npx gentyr sync` and the SessionStart auto-regeneration preserve any MCP servers the target project added to `.mcp.json` that are not part of the gentyr template. Gentyr-owned names always win on collision; dynamically-injected servers (`plugin-manager`, `plugin-*`) are excluded from the preserved set. This is implemented via `extractProjectServers()` and `mergeProjectServers()` in `lib/shared-mcp-config.js`.

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
   The CTO works in a provisioned worktree at `.claude/worktrees/<branch>/` for every
   change.

2. **PRs target `main` directly.** No `preview` or `staging` branches in this repo.

3. **Self-merge after CI passes.** After `gh pr create`, the CTO waits for CI
   (`gh pr checks --watch --fail-fast`), then runs
   `gh pr merge --squash --delete-branch` in the same session. No waiting for review.
   **CI Fix Loop**: If CI fails, fix the failure, push, and re-check — up to 5 times.
   Never merge a PR with failing CI.

4. **Clean up immediately.** After merge: delete local branch, remove worktree.
   Feature branches must not exist for more than a few hours.

5. **The gentyr repo has no sub-agent definitions.** Framework agent definitions live in
   `agents/` and are installed into target projects' `.claude/agents/` via the CLI's
   symlink pipeline. Gentyr development itself is CTO-interactive — CLAUDE.md is the
   only behavioral guidance surface in this repo, and the Task tool is unavailable here
   because no `.claude/agents/` directory exists for it to load definitions from. All
   git operations (commit, push, PR, merge, cleanup) are performed by the CTO directly,
   not by a project-manager sub-agent.

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
3. **Waits for CI**: `gh pr checks <number> --watch --fail-fast`
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

**Main-tree drift repair**: The `repair_main_tree_drift` MCP tool on `agent-tracker` is an MCP-triggered equivalent of the abandoned-worktree rescue, but for the project's MAIN tree. When the CTO runs `pnpm demo:local` (or any command that detaches HEAD), or when the working tree is dirty on a non-base branch, the `preview-watcher.js` daemon refuses to fast-forward `origin/preview` into the main tree — breaking HMR for `pnpm demo:preview`. Calling `repair_main_tree_drift` enqueues a project-manager rescue session at `critical` priority with `GENTYR_MAIN_TREE_REPAIR=true` in its env (a narrow bypass recognized by `main-tree-commit-guard.js` and `branch-checkout-guard.js`). The rescue agent salvages any orphaned work to a draft PR (via `git checkout -b rescue/main-tree-<ts>`, `git commit`, `gh pr create --draft`) and only then restores the main tree via `git checkout <baseBranch> && git pull --ff-only`. **Never auto-merges**, **never force-pushes**, files a bypass request on conflicts. Idempotent: returns `no_drift` when clean-on-base, `already_queued` when a rescue is in flight. Pass `dry_run: true` to inspect what would happen without enqueuing. Drift is defined narrowly — dirty-on-base is NOT drift (the CTO may be actively editing); only wrong-branch-with-dirty, detached HEAD, or mid-merge/rebase trigger repair. Logic lives in `.claude/hooks/lib/main-tree-rescue.js` (`detectMainTreeDrift`, `buildMainTreeRescuePrompt`), driven by `scripts/repair-main-tree-drift.js`. MCP-only — no automatic trigger from hourly automation or the preview-watcher.

**Abandoned worktree rescue**: `rescueAbandonedWorktrees()` in `hourly-automation.js` detects worktrees that have uncommitted changes but no active agent process, then spawns a project-manager to commit the orphaned work and open a draft PR for human review. Runs every **15 minutes** (`getCooldown('abandoned_worktree_rescue', 15)`). **Fail-closed + session-queue cross-check** (PR #475): before calling `lsof +D`, pre-loads active session paths from `session-queue.db` (`running/queued/spawning/suspended`) and skips any worktree that matches; `lsof` errors/timeouts now set `inUse = true` (skip rescue) instead of proceeding as if no processes exist — preventing the bug where `ETIMEDOUT` was treated as "safe to rescue". **Pre-enqueue dedup + rescue prompt hardening** (PR #478): before spawning a rescue agent, checks `session-queue.db` for any already-queued/running session targeting the same worktree path and skips the spawn if one exists; rescue prompt explicitly instructs the project-manager agent not to remove the worktree ("Do NOT remove the worktree — the cleanup automation handles removal after merge"). **Mandatory base-sync + draft-PR-only + divergence stats** (PR #712): logic extracted to `.claude/hooks/lib/rescue-worktree.js`; the rescue prompt now requires `git fetch origin <base> && git merge origin/<base> --no-edit` before any push (conflict → file bypass request and exit, never auto-resolve), opens the PR as `--draft` and never auto-merges, and embeds a `computeWorktreeDivergence()` snapshot (commits ahead/behind, files/lines changed, branch age, dirty file mtimes, `fresh_crash`/`stale_orphan` heuristic) in the PR body for human review. Closes the 2026-05-22 destructive-overwrite failure mode. Full background: [Abandoned Worktree Rescue](docs/abandoned-worktree-rescue.md).

**Per-session CTO worktrees + interactive liveness tracking** (PR #709): When `/lockdown off` is approved, `authorization-audit-spawner.js` provisions a session-scoped worktree named `cto-interactive-<sid8>` per interactive session and stores its path in `automation-config.json` under `ctoWorktreePaths: { [sessionId]: path }`. The legacy singular `ctoWorktreePath` is still written for back-compat. `/lockdown on` removes only the current session's worktree. Concurrent CTO sessions no longer collide on a shared `cto-interactive` worktree. **Interactive liveness tracking** (`lib/interactive-liveness.js` shared module + `interactive-heartbeat.js` UserPromptSubmit hook, root-owned): per-session state at `.claude/state/interactive-sessions.json`, keyed by session UUID, with 30-min staleness threshold and PID liveness check. **Rescue/reaper interactive-aware**: `rescueAbandonedWorktrees()` hard-skips `cto-interactive-*` worktrees and cross-checks `interactive-sessions.json`; `reapStaleWorktrees()` cross-checks live CTO sessions before reaping. A new `interactive_session_reaper` block (5-minute cooldown, gate-exempt) purges dead-session entries, removes their worktrees only when clean (never auto-commits in-progress CTO work), and cleans up `automation-config.json`. Closes the prior failure where automation hijacked the CTO's worktree mid-session by committing in-flight code on the wrong branch and switching HEAD.

**Stale worktree reaper**: `reapStaleWorktrees()` in `hourly-automation.js` removes worktrees older than 4 hours with no uncommitted changes. Runs every **20 minutes** (`getCooldown('stale_worktree_reaper', 20)`). Dirty worktrees are skipped (rescue handles those). **Skip guard + session-queue cross-check + fail-closed lsof** (PR #475): pre-loads active session paths from `session-queue.db` and skips any matching worktree; then runs `lsof +D` as a secondary check — if any processes are detected the worktree is **skipped** (not killed). `lsof` errors/timeouts are treated as fail-closed: skip the worktree rather than proceeding. Previously, active processes were killed by `removeWorktree()` with no pre-check, and `lsof` errors were silently treated as "no processes". Calls `removeWorktree(branch, { force: true })` (PR #478) to bypass the `removeWorktree()` session-queue guard, since safety was already verified by the pre-checks above.

**Reactive worktree cleanup**: `reapSyncPass()` in `session-reaper.js` automatically cleans up worktrees when it detects a dead agent PID. If the worktree has no uncommitted changes, `removeWorktree()` is called immediately (seconds, not minutes). Dirty worktrees are left for `rescueAbandonedWorktrees()`. **Surviving child process check** (PR #475): before removing a clean worktree, `reapSyncPass()` now runs `lsof +D` to detect Playwright demos, dev servers, or other processes spawned with `detached: true` that outlived the dead agent. If any processes are found, the worktree is left intact; `lsof` errors/timeouts are treated fail-closed (skip removal). Calls `removeWorktree(branch, { force: true })` (PR #478) since the session is confirmed dead before this point.

**Worktree cleanup gate**: `worktree-cleanup-gate.js` PostToolUse hook fires on `summarize_work` and reminds agents to remove their worktree before completing. Detects worktree context via CWD path pattern (not env var) since hooks inherit the Claude process environment, not the MCP server environment.

**Worktree env var injection**: `spawnQueueItem()` in `session-queue.js` injects `CLAUDE_WORKTREE_DIR` into the spawned agent's environment when `worktree_path` is set, and `CLAUDE_QUEUE_ID` (PR #478) into all spawned sessions. `CLAUDE_QUEUE_ID` allows hooks (e.g., `worktree-remove-guard.js`) to identify which queue entry owns the current session, enabling self-cleanup vs. other-session detection. `CLAUDE_WORKTREE_DIR` and `CLAUDE_QUEUE_ID` are available to all hooks (PostToolUse, PreToolUse, Stop) via `process.env`. Hooks should also include a CWD-based fallback (`process.cwd().match(/\.claude\/worktrees\//)`) for robustness.

**Process group cleanup** (`lib/process-tree.js`): Shared module with three exports — `killProcessGroup(pid, signal)` (synchronous, sends signal to `-pid` process group with EPERM fallback to lead PID), `killProcessGroupEscalated(pid)` (async SIGTERM→SIGKILL with 5s wait), and `killProcessesInDirectory(dirPath)` (uses `lsof +D` to find all PIDs with open files in a directory, deduplicates by process group, kills each group). Used by `removeWorktree()` and `reapOrphanProcesses()` to ensure child processes (esbuild, vitest, dev servers) spawned with `detached: true` are fully terminated.

**Active session protection**: `cleanupMergedWorktrees()` in `worktree-manager.js` checks `isWorktreeInUse()` (`lsof +D`) before removing merged worktrees to protect live sessions from CWD eviction, and also cross-checks `session-queue.db` for any `running/queued/spawning/suspended` sessions using the worktree path (PR #475 extended this from `suspended`-only to all active statuses). `isWorktreeInUse()` is **fail-closed** (PR #475): it returns `true` (assume in use) on any `lsof` error or timeout — only returns `false` when `lsof` exits with code 1 and empty stdout (confirmed no processes). Previously it returned `false` on any error (fail-open). `removeWorktree()` (called by stale reaper path and reactive cleanup) uses `killProcessesInDirectory()` to kill all processes with open files in the worktree before attempting removal; the stale reaper and rescue paths now skip rather than kill when active processes are found. **`removeWorktree()` session-queue guard** (PR #478): `removeWorktree()` itself now cross-checks `session-queue.db` before removal — if any `running/queued/spawning/suspended` session claims the worktree path and its PID is alive, removal is blocked with an error. Callers that already performed their own safety checks pass `{ force: true }` to bypass (currently: `cleanupMergedWorktrees`, `reapSyncPass`, `reapStaleWorktrees`). Fail-open on DB read errors (missing file, busy, etc.) to avoid blocking routine cleanup. **`enqueueSession()` worktree exclusivity** (PR #478): blocks enqueue when another active queue item already has the same `worktree_path` or `cwd` — returns `{ blocked: 'worktree_exclusive' }`. A partial index on `worktree_path` keeps the lookup fast. Path normalization (trailing slash stripping) ensures consistent comparison. The `worktree-cwd-guard.js` hook additionally detects stale CWD at tool-call time and blocks Bash execution with a recovery hint if the worktree directory no longer exists. The `worktree-remove-guard.js` PreToolUse hook (PR #478) intercepts `git worktree remove` Bash commands and denies removal of `.claude/worktrees/` paths owned by other active sessions (allows self-cleanup and orphaned cleanup; fails open on DB errors).

**Orphan process reaper**: `reapOrphanProcesses()` in `hourly-automation.js` finds `node`/`esbuild`/`vitest` processes whose CWD (resolved via `lsof -d cwd`) is inside `.claude/worktrees/` but the directory no longer exists, then kills their process groups. Runs every **60 minutes** (`getCooldown('orphan_process_reaper', 60)`). Guards against processes that survived after their parent session was killed and their worktree removed.

**Branch pruner**: `branch_pruner` block in `hourly-automation.js` (30-minute cooldown, gate-exempt). Deletes local AND remote branches whose PRs have been merged, plus local-only branches older than 24h with no PR and no commits ahead of base. Runs `git remote prune origin` as part of the pass. Closes a long-standing accumulation of stale branches from merged worktrees.

**Main-tree drift mechanism**: `scripts/preview-watcher.js` gains `keepMainTreeOnBase()` called every 30s. Auto-corrects clean main-tree drift via `git checkout <base> && git pull --ff-only`. Records to `.claude/state/main-tree-drift.json` when unsafe (dirty / mid-merge / mid-rebase). Gated by `services.json` `mainTreeKeepOnBase` (default `true`); `mainTreeAutoPull` (default `true`) controls the fast-forward-pull of `origin/<base>` into the main tree after each base-branch update (skipped when on a non-base branch or with an in-flight merge/rebase). `session-briefing.js` adds a prominent `=== MAIN TREE DRIFT ===` block at briefing top with live git re-check and recovery command. Both fields are in `ServicesConfigSchema`. Closes the `pnpm demo:preview` hot-reload failure mode where the main tree silently drifted to another branch.

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

**Agent separation**: The gentyr repo itself has no `.claude/agents/` directory and therefore no sub-agents — gentyr development is CTO-interactive, guided entirely by CLAUDE.md. The `agents/` directory is the source of truth for framework agent definitions and is installed into target projects' `.claude/agents/` via the CLI's symlink pipeline (`createAgentSymlinks` in `cli/lib/symlinks.js`). Target projects use these agents (e.g., project-manager merges to `preview`); the gentyr source repo's git workflow (feature -> main with immediate self-merge) is handled by the CTO directly without sub-agent delegation.

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
- `agents/project-manager.md`: Step 7 documents `gh pr checks --watch --fail-fast`
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

**Legacy HMAC bypass removed**: `bypass-approval-hook.js` and `bypass-approval-token.js` have been deleted. The `APPROVE BYPASS <code>`, `DENY BYPASS <code>`, `CLEAR ALL BYPASS`, and `APPROVE HOTFIX <code>` typed-phrase patterns are gone. All CTO approvals — including emergency hotfix promotion (see "Hotfix Promotion" below) — now use the deferred action + `record_cto_decision` + `authorization-auditor` chain. New enforcement hooks must use the deferred action pattern (`createDeferredAction` in `lib/deferred-action-db.js`) — there is no longer a code-based fallback.

**Hotfix Promotion** (`/hotfix`, `mcp__deputy-cto__execute_hotfix_promotion`): The `/hotfix` slash command collects commits via `git log origin/main..origin/staging`, shows them to the CTO, captures the CTO's verbatim approval, and calls `execute_hotfix_promotion({ commits })`. `protected-action-gate.js` intercepts (registered in `protected-actions.json` under `deputy-cto`) and creates a deferred action whose `args_hash` freezes the commit set. The agent then calls `record_cto_decision({ decision_type: 'hotfix_promotion', decision_id, verbatim_text })`. `authorization-audit-spawner.js` routes hotfix decisions through the default auditor path (not inline-execute) — the auditor verifies via `peek_session({ session_id })` that the agent showed the commits to the CTO before the approval text, re-runs `git log` to confirm the commit set still matches (rejects if staging moved), and checks `isStagingLocked()`. On pass, `deferred-action-audit-executor.js` invokes the `execute_hotfix_promotion` tool-name branch — which calls `spawnHotfixPromoter()` in `.claude/hooks/lib/hotfix-spawn.js` — to enqueue the `hotfix-promotion` agent at `critical` priority with `GENTYR_PROMOTION_PIPELINE=true`. The handler in `deputy-cto/server.ts` is a defense-in-depth stub that errors out; in normal operation the gate fires first and the promoter is spawned by the executor, not the tool handler.

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
| `.claude/hooks/spawned-main-tree-edit-guard.js` | Block Write/Edit/NotebookEdit into main tree by spawned agents (catches CWD fallback to PROJECT_DIR) | Yes |
| `.claude/hooks/interactive-lockdown-guard.js` | Block file edits in CTO sessions | Yes |
| `.claude/hooks/credential-file-guard.js` | Block access to credential files | Yes |
| `.claude/hooks/branch-checkout-guard.js` | Block branch switching in main tree | Yes |
| `.claude/hooks/block-no-verify.js` | Block hook bypass and lint-weakening commands (--no-verify, --no-gpg-sign, core.hooksPath writes, ESLint weakening, 1Password CLI access) | Yes |
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

Configure user personas to automatically test your app when staging changes are detected. Personas come in 5 consumption modes — `gui` (Playwright browser), `cli`, `api`, `sdk` (developer with scratch workspace + docs portal), `adk` (AI agent with docs-feedback MCP). Feedback agents spawn on staging changes and report findings to the deputy-CTO triage pipeline. The `product-manager` agent creates fully-functional personas automatically as a post-Section-6 step (Fill gaps or Full rebuild); `/configure-personas` is the interactive manual path.

Persona profiles let the CTO archive a complete persona set with a guiding strategic prompt and switch between them — useful for A/B testing target markets without losing prior research. Active profile shows at the top of the interactive session briefing.

**Slash commands:**
- `/configure-personas` — initial setup or backfill
- `/persona-feedback` — browse feedback history or spawn an on-demand feedback session

> Full details: [AI User Feedback System](docs/CLAUDE-REFERENCE.md#ai-user-feedback-system) — consumption mode tools/docs table, `endpoints` field semantics per mode, `docs-feedback` MCP server tools, product-manager persona creation workflow, persona profile system (6 MCP tools, schema, briefing integration).

## Product Manager MCP Server

The product-manager MCP server (`packages/mcp-servers/src/product-manager/`) manages a 6-section PMF analysis pipeline. State is in `.claude/state/product-manager.db`. Access via `/product-manager` slash command. Scope: all 6 sections are external market research (never reference local project). Sequential lock enforces section ordering. Analysis lifecycle: `not_started` → `pending_approval` → `approved` → `in_progress` → `completed`.

> Full details: [Product Manager MCP Server](docs/CLAUDE-REFERENCE.md#product-manager-mcp-server)

## Automation Service

> See also: [Automation Systems](docs/AUTOMATION-SYSTEMS.md) for the background-automation orchestration internals (hook registration, lifecycle phases, optimizers). The cooldown table for individual `runIfDue` blocks is in [Session Lifecycle](docs/SESSION-LIFECYCLE.md#background-automation-affecting-lifecycle).

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

**Resetting a stuck or wrong audit**: Three MCP tools restart an audit fresh — one per task DB. Use these when (a) the auditor session is wedged in `pending_audit` >30 min with no progress, (b) a verdict was obviously wrong (false-pass or false-fail), or (c) the audit must be redone from scratch with a fresh auditor. All three kill any live auditor session for the task, mark the prior audit row failed with `failure_reason="Audit reset: <reason>"`, insert a new audit row (`attempt_number+1`), revert the task to `pending_audit`, and respawn a fresh auditor immediately via `buildAuditorSessionSpec` + `enqueueSession`.

- `mcp__todo-db__reset_task_audit({ task_id, reason })` — todo-db task audit
- `mcp__persistent-task__reset_pt_audit({ id, reason })` — persistent task audit (also cascade-reverts parent todo task if it had been completed by a prior audit-pass)
- `mcp__plan-orchestrator__reset_plan_audit({ plan_task_id, reason })` — plan task audit (also writes a state_change row to the plan timeline)

**Authorization**: CTO/interactive sessions, deputy-cto, persistent-monitor, and plan-manager are allowed. Auditor agents (universal-auditor / plan-auditor / authorization-auditor) and task-runners are explicitly denied — auditors cannot reset their own audit; task-runners cannot escape verdicts on their own work. Identity is verified via `CLAUDE_QUEUE_ID` lookup in `session-queue.db` (same pattern as `verifyUserAlignmentIdentity()`). Shared logic lives in `.claude/hooks/lib/audit-reset.js`.

**What reset is NOT**: It does NOT redo the work — only the audit. If the work product itself is broken, use the standard task flow (drive a new task) or `retry_plan_task` (for plan tasks) instead. The session-reaper's Step 1b.5 already handles ROUTINE auditor death by auto-respawning after 10 min of `verdict IS NULL`; `reset_*_audit` is the manual override for cases that auto-recovery cannot solve (wedged-but-not-stale, post-verdict false-pass/fail, or repeated auditor failures on the same task).

**Authorization-audits are out of scope**: CTO authorization audits are interactive and short-lived; if a CTO authorization decision goes wrong, the existing `record_cto_decision` flow re-runs naturally.

**Signal compliance gate**: The `signal-compliance-gate.js` PreToolUse hook validates all inter-agent signals via `send_session_signal` against a registered schema before delivery. Directive signals (requiring acknowledgment) MUST be acknowledged before the receiving agent can complete its task — enforced by `signal-reader.js` tracking.

## Global Deputy-CTO Monitor

An always-on persistent deputy-CTO session operating in continuous alignment monitoring mode. **Auto-spawned** by the `global_monitor_health` block in `hourly-automation.js` (5-minute cycle, gate-exempt). The automation auto-creates the persistent task (with `task_type: "global_monitor"`, `do_not_complete: true`) if none exists, and re-enqueues the monitor at `critical` priority in the `persistent` lane if it dies. No manual bootstrap required. Opt-**out** only: disable via `globalMonitorEnabled: false` automation toggle (or `/global-monitor off`). When spawned with `GENTYR_DEPUTY_CTO_MONITOR=true` in its environment, the deputy-CTO runs a continuous 5-minute polling loop: enumerates active tasks and persistent tasks, dispatches user-alignment sub-agents in the `alignment` session lane (sub-limit: 3 concurrent) to verify work matches CTO intent before code is written, reads alignment results, sends corrective signals to drifting agents, detects zombies (sessions alive >2h with no recent tool calls), and oversees stuck audit gates. The monitor NEVER self-pauses — it runs continuously until paused by automation.

**Idle auto-pause/resume**: The `global_monitor_idle_check` block in `hourly-automation.js` (1-minute cycle, gate-exempt) manages the monitor's lifecycle based on session activity. When no work sessions are active (excluding the monitor itself, gate, audit, and alignment lanes), the monitor is auto-paused with `auto_idle_pause: true` in metadata and `do_not_auto_resume: true` to prevent `persistent_stale_pause_resume` from fighting the idle pause. When any work session becomes active (running or spawning), the monitor is auto-resumed immediately on the next 1-minute check — the idle metadata flags are cleared, the task transitions back to `active`, and a new monitor session is enqueued at `critical` priority. The `requeueDeadPersistentMonitor()` function in `session-queue.js` also checks task status before reviving — paused tasks (including idle-paused) are skipped.

**Escalation framework**: Signals for minor drift (~50%), self-created correction tasks for moderate misalignment (~35%), and `submit_bypass_request` on the affected task for significant drift or systemic issues (~15%).

**Bypass request routing**: When any agent calls `submit_bypass_request`, the `bypass-request-router.js` PostToolUse hook checks if the global monitor is active. If so, it sends a `BYPASS_REQUEST` directive signal to the monitor, giving it ~5 minutes to triage the request before the CTO sees it. The CTO's `session-briefing.js` and `cto-notification-hook.js` apply a 5-minute grace period: pending requests younger than 5 minutes are hidden while the monitor is active. Requests explicitly escalated by the monitor (`deputy_escalated = 1`) bypass the grace period and appear to the CTO immediately. If the monitor is not active, requests appear to the CTO immediately (no grace period).

**Deputy bypass resolution**: 3 exclusive MCP tools on the `agent-tracker` server — `deputy_resolve_bypass_request`, `deputy_approve_deferred_action`, `deputy_escalate_to_cto` — allow the global monitor to handle CTO bypass requests autonomously. Enforced by 3-layer identity verification (env var → session-queue.db metadata → persistent-tasks.db cross-check). CTO-only actions (release-ledger, lockdown, staging) are permanently blocked.

**Signal throttling**: Max 1 signal per agent per 30 minutes. If >5 signals are firing per hour, the monitor escalates a diagnostic report to the CTO.

**Lifecycle**: Runs continuously in the `persistent` lane (no concurrency cap, always spawns immediately). Survives crashes via the persistent task revival system (circuit breaker, heartbeat-stale detection). Auto-paused when idle, auto-resumed when sessions reappear. The `alignment-monitor-briefing.js` PostToolUse hook delivers cross-session alignment summaries on each tool call.

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

Lets the CTO delegate complex multi-step objectives to a dedicated monitor session that orchestrates sub-agents to completion. State at `.claude/state/persistent-tasks.db` (SQLite, WAL). Tier 2 MCP server (`packages/mcp-servers/src/persistent-task/`, per-session stdio). Lifecycle state machine, revival mechanics, crash-loop circuit breaker, stale-pause auto-resume, and self-healing are all documented in [Session Lifecycle](docs/SESSION-LIFECYCLE.md) — those concerns are queue-layer, not task-layer.

**13 tools**: `create_persistent_task`, `activate_persistent_task`, `get_persistent_task`, `list_persistent_tasks`, `amend_persistent_task`, `acknowledge_amendment`, `pause_persistent_task`, `resume_persistent_task`, `cancel_persistent_task`, `complete_persistent_task`, `link_subtask`, `get_persistent_task_summary`, `inspect_persistent_task`.

**Amendment system**: After activation the CTO can amend a task with `addendum`, `correction`, `scope_change`, or `priority_shift` types. The monitor polls for unacknowledged amendments each cycle and must call `acknowledge_amendment` before proceeding. Adding an amendment to a paused task auto-resumes it (no manual `resume_persistent_task` needed).

**`persistent-monitor` agent** (`agents/persistent-monitor.md`, Opus-tier): Read-only for files. Orchestrates sub-agents via `todo-db` task creation, not direct edits — never uses the Task tool to spawn code-writers (all code changes must go through `create_task` + `force_spawn_tasks` so they are tracked, gated, and worktree-provisioned). The Task tool is only allowed for lightweight investigation. **Skepticism protocol**: monitors do NOT accept child agent success claims at face value — must `inspect_persistent_task` and `peek_session` for concrete evidence (exit codes, PASS/FAIL strings, `check_demo_result` with `status: 'passed'`, PR merge confirmations) before allowing completion. Missing evidence → `send_session_signal` demanding proof, or create a re-verification task if the child already exited. **Supersession**: `scope_change` amendments indicating supersession must trigger `cancel_persistent_task`, NOT `pause_persistent_task` — pausing creates an infinite revive/re-pause cycle. **Blocked situations**: when authorization is needed (access, conflicting requirements, external deps), call `submit_bypass_request`, then `summarize_work`, then exit.

**Demo / strict-infra flags** in task metadata: `demo_involved: true` injects demo-specialized monitor instructions (`lib/persistent-monitor-demo-instructions.js`) and is asked about during `/persistent-task` creation. `strict_infra_guidance: true` adds MCP-only infrastructure prompts (`lib/strict-infra-guidance-prompt.js`) plus the `strict-infra-nudge-hook.js` PostToolUse enforcement and propagates the flag to child tasks.

**3 PostToolUse hooks**: `persistent-task-briefing.js` (state injection on every tool call), `persistent-task-linker.js` (auto-link sub-tasks via `persistent_task_id`), `persistent-task-spawner.js` (fires on activate/resume/amend/pause/cancel — enqueues monitor or emits audit event accordingly; callers must NOT manually spawn monitors).

**Cross-system wiring**: `todo-db` `create_task` accepts `persistent_task_id`. `stop-continue-hook.js` blocks normal stop for active monitors and redirects to `submit_bypass_request`. `session-briefing.js` lists active monitors. `cto-notification-hook.js` injects pending bypass requests into `additionalContext` on every CTO prompt.

**CTO Dashboard**: `PersistentTaskSection` reads from `persistent-tasks.db` via `packages/cto-dashboard/src/utils/persistent-task-reader.ts`. Rendered on `/cto-report` and `/cto-dashboard`.

**4 slash commands**:
- `/persistent-task` — create flow (research → refine prompt → preview → create + activate)
- `/persistent-tasks` — management view (list, monitor health, amend/pause/resume/cancel/revive)
- `/monitor` — continuous monitoring loop. Each round calls MCP tools directly, displays verbatim indexed session messages via `browse_session`, subscribes CTO to verbatim-tier summaries, tracks unverified success claims across rounds, signals monitors when claims are refuted. Optional argument: `plans` | `persistent` | task-ID prefix | bare. Stops on intervention-needed conditions (monitor dead with no revival queued, self-paused, completed/cancelled, critical memory for 3+ rounds, child stale 15+ min, plan fully blocked, systemic error pattern across 3+ attempts).
- `/status` — one-shot version of `/monitor` (no loop, no state file, no reminder hook).

## Token Usage Tracking

End-to-end attribution of every `claude` and `claude -p` invocation in the project — answers "where are the tokens going?" with per-source, per-work-category, and per-revival breakdowns.

**Collector daemon** (`scripts/token-usage-collector.js`): KeepAlive launchd service `com.local.gentyr-token-usage-collector`. Polls every 60 seconds, walks every session JSONL file under `~/.claude/projects/<project>/`, parses assistant `message.usage` entries, joins against `session-queue.db`, and persists per-message events plus daily rollups in `.claude/state/token-usage.db`. Incremental scan via `scan_offsets` table; idempotent ingest via `UNIQUE(session_id, message_uuid)`. Daily rollup, 90-day retention on `usage_events`, indefinite retention on `session_attribution` and `daily_rollup`. Weekly `VACUUM`.

**Attribution precedence chain** (collector resolves each session to a single source string): (1) agent marker in JSONL first user message (`[Automation][...]`, `[Task][...]`, `[AGENT:...]`); (2) `resume_session_id` column on `session-queue.db` (for `--resume` revivals); (3) `subprocess_calls` join (subprocess invoked via `llm-client.js` with a tag); (4) `CLAUDE_USAGE_TAG` env var fallback; (5) `interactive-cto` for raw user sessions; (6) `unknown`. Subagent meta is read from `meta.json` sidecar when present — `agentType` (camelCase, what Claude Code writes) is normalized alongside legacy `agent_type` (snake_case). `agent-acompact-*.jsonl` files (Claude Code auto-compactor subprocesses) are routed to a dedicated `compaction-subagent` source so their cost is visible rather than hidden in `unknown`. Backfill passes (`backfillSubagentAttribution()` and `backfillWorkCategoryAttribution()`) re-resolve existing rows on daemon startup.

**Three attribution dimensions** beyond the legacy `source` column (added by `lib/work-category.js`, idempotent ALTER TABLE on every DB open):
- `work_category` — the stable kind-of-work this session represents (e.g., `plan-manager`, `persistent-monitor`, `universal-auditor`, `plan-auditor`, `authorization-auditor`, `task-runner`, `demo-manager`, `preview-promoter`, `pr-reviewer`, `staging-reviewer`, `security-auditor`, `feedback-agent`, `gate-agent`, `antipattern-hunter`, `compliance-checker`, `deputy-cto`, `health-monitor`, `lint-fixer`, `claudemd-refactor`, `federation-mapper`, `hotfix-promotion`, `test-fixer`, `todo-maintenance`, `compaction-subagent`, `agent-tool-subagent`, `interactive-cto`, `subprocess-llm`, `other`). Survives revival — a revived persistent monitor keeps `work_category=persistent-monitor` rather than collapsing to `session-queue-reaper`. Agent-tool subagents (user-alignment, investigator, code-writer, code-reviewer, test-writer, etc.) keep their specific type in `agent_type`; `work_category` collapses them to `agent-tool-subagent` for grouped reports — pivot by `agent_type` to see each subagent type individually.
- `spawn_origin` — earliest source of the queue chain for this work, chased via `persistentTaskId`/`taskId`/`planId` back to the original `enqueueSession()` call.
- `is_revival` + `revived_by` + `revival_count` — flags rows whose source is one of 9+ revival paths (`session-queue-reaper`, `revive_dead_persistent_monitor`, `drain-audit-orphan-recovery`, `session-reviver`, `revival-daemon`, `crash-loop-resume`, `sync-recycle`, etc.) and records the normalized revival mechanism.

**Subprocess tagging** (`lib/subprocess-call-tracker.js` + `lib/llm-client.js`): Every `claude -p` subprocess invocation writes a row to the `subprocess_calls` table with a unique `tag` string and injects `CLAUDE_USAGE_TAG` + `CLAUDE_USAGE_PARENT` env vars. The collector joins on session ID first, then falls back to the env-var tag. Wired callers: `report-auto-resolver.js` (`report-auto-resolve`, `report-dedup`), `ai-pr-decomposition.js` (`ai-pr-decomposition`), `ai-compatibility-check.js` (`ai-compatibility-check`), `ai-changelog.js` (`ai-changelog`), `migration-safety.js` (`migration-safety:verification`, `migration-safety:analyze`), `session-activity-broadcaster.js` (`:per-session`, `:super-summary`, `:relevance`), `compact-session.js` (`compact-session`), `release-report-generator.js` (`release-report-generator`), `live-feed-daemon.js` (`live-feed-daemon`). 30-day retention on `subprocess_calls`.

**Hourly automation source granularity**: All 26 `enqueueSession()` callsites in `hourly-automation.js` now use `source: currentSource()` instead of the bare `'hourly-automation'` literal. A module-level `_currentBlock` tracker set inside `runIfDue()` (try/finally) threads the active block name through helpers without changing their signatures, so each spawn is attributed to the specific block that triggered it (e.g., `hourly-automation:task_runner`, `hourly-automation:demo_validation`, `hourly-automation:auto_rollback_check`). `isAuthStalled()` aside, `isAutomatedSource()` in `session-queue.js` accepts both exact `AUTOMATED_SOURCES` entries and the `hourly-automation:<block>` prefix so prefixed sources still auto-promote to the no-cap `automated` lane.

**5 MCP tools** (on `agent-tracker` server):
- `query_token_usage` — flexible aggregation. Default `group_by` is `work_category` (the stable kind-of-work). Other dimensions: `source`, `lane`, `agent_type`, `model`, `category`, `day`, `persistent_task`, `plan`, `spawn_origin`, `revived_by`. Filters: `filter_work_category`, `filter_spawn_origin`, `filter_revived_by`, `only_revivals`, `only_originals`. When grouped by `work_category`, the response includes a `category_descriptions` map (one line per category present) so the CTO does not have to remember what each label means. Accepts opt-in `roll_up_compaction: true` to attribute `/compact` subprocess cost back to the parent session's `work_category` — surfaces the true cost of the work that triggered compaction (a relabel, not a re-sum, so totals are preserved).
- `top_token_sessions` — single sessions by total spend, with model, agent type, and source.
- `token_attribution_health` — share of rows that are `subagent:unknown` or `unknown`; used to detect attribution regressions.
- `revival_cost_summary` — answers "how much are we spending on resurrection?". Returns `{ totals: { revival_tokens, revival_cost_usd, revival_sessions, original_tokens, original_cost_usd, original_sessions, revival_pct_of_total }, by_revived_by: [...] }`.
- All read from `token-usage.db`. Pricing in micro-USD lives in `lib/token-pricing.js` (Opus / Sonnet / Haiku 4.x table, dated 2026-05-19).

**`/tokens` slash command**: Surfaces the new attribution model. Default view groups by `work_category` with the category-legend rendered at the top of the report. Drill-down modes: `/tokens 24h source` (legacy source view), `/tokens 24h revivals` (calls `revival_cost_summary`), `/tokens 24h originals` (filters out revivals). Horizontal bar chart of token consumption per group, with model breakdown when grouping permits. Drill-down recipes are documented in the command body — "Who's the most expensive subagent type?", "How much are revivals costing?", "Where did this work come from originally?", "What's spending Opus tokens?".

**Per-cycle polling budget for monitors**: To reduce the persistent-monitor / plan-manager cost surfaced by this system, the `agents/persistent-monitor.md` and `agents/plan-manager.md` definitions enforce a hard per-cycle cap — at most 1 `inspect_persistent_task` plus 2 `peek_session` calls per cycle, with `bash -c "sleep 60"` between cycles when nothing changed. After 3+ no-state-change cycles the monitor must write `last_summary` and exit cleanly via `summarize_work`; the orphan catch-all in `hourly-automation.js` and `drainQueue()` respawns it on the next actionable change. Advisory enforcement (not blocking): `.claude/hooks/monitor-poll-budget-hook.js` tracks `peek_session` call frequency per spawned monitor session and emits an `additionalContext` warning when a session exceeds 5 calls in a 5-minute rolling window. Fast-exits in under 1ms for non-`peek_session` tools and for interactive or non-monitor sessions. Not added to `criticalHooks` — context-aware diagnostic drill-down should not be hard-blocked, and the real enforcement lives in the agent docs.

## Workstream Cross-Entity Dependencies

Single source of truth for cross-entity task dependencies across **todo**, **persistent**, **plan_task**, and (as blocker) **plan** entities. The `workstream.queue_dependencies` table carries `blocked_entity_type` / `blocker_entity_type` plus a `pause_action` column (`'killed_session' | 'paused_persistent' | 'paused_plan_task' | NULL`). `UNIQUE(blocked_entity_type, blocked_task_id, blocker_entity_type, blocker_task_id)`; composite `(entity_type, task_id, status)` indexes. Migration is idempotent on every DB open: shadow-table swap fires when either the legacy narrow UNIQUE is still present OR the `blocker_entity_type` CHECK does not yet include `'plan'`. `'plan'` is only valid as a blocker — plans cannot be blocked entities (depend at plan_task granularity instead).

**`add_dependency` (flat schema)**: Accepts EITHER the new entity-aware shape `{ blocker: {entity_type, entity_id}, blocked: {entity_type, entity_id}, reasoning }` OR the legacy `{ blocker_task_id, blocked_task_id, reasoning }` (normalized to todo→todo). Implemented as a single flat `z.object` with `.refine()` rather than a `z.union` so Claude's tool-caller validates nested `blocker`/`blocked` object properties cleanly — the prior union shape was silently treated as "wide-open" by the tool-caller and dropped nested-field specificity. Validates both entities exist in their source DB. Entity-aware cycle detection (DFS over `(entity_type, entity_id)` nodes). Already-completed short-circuit: inserts the dep as `'satisfied'` when the blocker is in a satisfying terminal state. **Pause-if-running** on the blocked entity (CTO-confirmed semantics — kill + reset / pause):
- `todo` + `in_progress` → SIGTERM linked session, cancel queue item, reset task to `pending`. Records `pause_action='killed_session'`.
- `persistent` + `active` → `status='paused'` with `metadata.pause_reason='cross_dep'` + `do_not_auto_resume=true`. Records `pause_action='paused_persistent'`.
- `plan_task` + `in_progress`/`ready` → `status='paused'`. Records `pause_action='paused_plan_task'`.

**`list_dependencies_for_entity` (tool)**: Query deps involving a specific entity with `direction='blocking' | 'blocked_by' | 'both'` (default `both`). Used by plan-managers and persistent-monitors to surface why a child is not spawning.

**Inline `depends_on` at create time**: `create_task` (todo-db), `create_persistent_task` (persistent-task), and `add_plan_task` (plan-orchestrator) all accept `depends_on: Array<{entity_type, entity_id, reasoning?}>`. Each entry is written to `workstream.queue_dependencies` via the shared helper `addDependenciesForNewEntity()` in `packages/mcp-servers/src/shared/cross-deps.ts`. Blockers already in a terminal state are inserted as `'satisfied'` immediately. Plan tasks with any active blocker are created with `status='blocked'` so the plan-manager does not spawn them prematurely. Persistent tasks remain in `'draft'` — `activate_persistent_task` refuses activation when blockers are unmet (the satisfier auto-activates later). For todos, the existing session-queue gate already withholds spawning until deps are met.

**Cross-entity completion satisfier** (`.claude/hooks/lib/cross-dep-satisfier.js`): Single shared module with two exports — `satisfyCompletedBlocker({entity_type, entity_id})` marks all active deps where this entity is the blocker as `'satisfied'`, records a workstream change, and returns the list of newly-unblocked entities; `cascadeUnblock(unblocked)` checks each unblocked entity's remaining active deps, and when fully clear takes the right action per type: `todo` → `drainQueue()` nudge; `persistent` (in `draft`) → atomic activation + persistent-monitor enqueue at `critical` priority; `plan_task` (paused/blocked) → set `status='pending'` so `get_spawn_ready_tasks` promotes it. Idempotent, fail-open, logs to `.claude/session-queue.log`.

**Four PostToolUse completion hooks** (registered in `settings.json.template`; not root-owned — these are orchestration hooks, not security gates):
- `workstream-dep-satisfier.js` on `mcp__todo-db__complete_task` — legacy todo→todo path PLUS delegates to `satisfyAndCascade` for cross-entity unblocks.
- `persistent-completion-dep-satisfier.js` on `mcp__persistent-task__complete_persistent_task` — fires when a persistent task completes.
- `plan-task-completion-dep-satisfier.js` on `mcp__plan-orchestrator__update_task_progress` (only on `status: completed | skipped`).
- `plan-completion-dep-satisfier.js` on `mcp__plan-orchestrator__update_plan_status` (only on `status: signed_off | completed`) — enables "blocked by the whole plan finishing" semantics.

**End-to-end auto-activation flow**: CTO declares `depends_on` at create time on a batch of persistent tasks; only the dep-free tasks reach `active`; downstream tasks sit in `draft` with workstream rows recording the blockers. As each task completes, its PostToolUse hook fires, the satisfier marks the deps satisfied, and `cascadeUnblock` auto-activates the next layer (spawning monitors at `critical` priority). The CTO never needs to manually call `activate_persistent_task` on downstream tasks.

**`activate_persistent_task` refusal gate**: When `depends_on` produces any `'active'` deps for the task, `activate_persistent_task` returns an error listing the unmet blockers and a hint that the satisfier will auto-activate. CTO can still complete dependents manually if needed — the refusal is purely a guardrail against premature activation.

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

**`user-alignment` agent** (`agents/user-alignment.md`): Auditor that runs after the code-reviewer in the standard development workflow. Looks up `user_prompt_uuids` on the task (falls back to keyword search), checks `userPromptRefs` in related specs, reviews `git diff`, and verifies the implementation addresses user intent. Creates `CODE-REVIEWER` fix tasks for misalignments; escalates significant drift to the deputy-CTO. Does NOT edit files or commit. **Spec proposals**: After verifying alignment, the agent checks whether specs should be created or updated for changed files. Spec writes (`create_spec`, `edit_spec`) are CTO-gated via deferred actions — the agent calls the tool, the `protected-action-gate` blocks it and stores the proposed spec content, and the CTO approves or rejects before it's written. The agent files a `submit_bypass_request` and exits; on CTO approval the deferred action auto-executes via the MCP daemon (specs-browser is Tier 1).

## CTO Alignment Tracking

Persistent, audited memory of unique CTO-stated goals captured verbatim by the `user-alignment` sub-agent — long-lived, periodically reassessed, and fed back into the specs system once a goal hits 100% completion. Mirrors the cryptographic-proof model of `record_cto_decision` (verbatim substring must exist in a CTO session JSONL, HMAC-bound to the session file) so agents cannot fabricate goals; unlike one-shot CTO decisions, goals are long-lived with a percentage progress dimension.

**Table**: `cto_alignment_goals` in `.claude/state/bypass-requests.db` (shared with `cto_decisions`/`deferred_actions`/`bypass_requests`). Fields: `id` (ag-...), `short_title`, `verbatim_text`, `cto_session_id`, `cto_session_file_hash`, `cto_prompt_timestamp`, `cto_prompt_line_number`, `hmac`, `status` (`active`/`completed`/`archived`/`superseded`), `completion_percentage`, `last_assessment_at`, `last_assessment_evidence`, `completed_at`, `spec_review_triggered_at`, `spec_review_outcome`, `archived_at`, `archived_reason`, `archive_verbatim_text`, `archive_cto_session_id`, `recorded_by_agent`, `created_at`. Partial UNIQUE index on `(cto_session_id, substr(verbatim_text, 1, 500))` where status not in archived/superseded — same goal cannot be recorded twice.

**5 MCP tools** (on `agent-tracker` server):
- `record_cto_alignment_goal` — RESTRICTED TO user-alignment. Verifies verbatim text against CTO session JSONL via `verifyQuoteInJsonl` (only human/user messages count), HMAC-binds the goal to the session file. Returns `already_exists: true` on dedup.
- `list_cto_alignment_goals` — open to all agents. Default filter `status: 'active'`. Omits verbatim/evidence by default for compact responses; pass `include_evidence: true` for detail.
- `get_cto_alignment_goal` — open to all agents. Full row including verbatim_text and HMAC.
- `update_cto_alignment_goal_progress` — RESTRICTED TO user-alignment. Updates completion_percentage with evidence, and/or sets `spec_review_outcome` after the 100% spec-review pass. When percentage transitions <100→100, the goal moves to `status='completed'`, `spec_review_outcome='pending'`, and the spec-review hook fires.
- `archive_cto_alignment_goal` — RESTRICTED TO user-alignment. `reason: 'superseded'` REQUIRES verbatim_text proving the CTO changed direction (verified against CTO JSONL). `'obsolete'`/`'completed'` accept optional verbatim.

**Identity verification** (`verifyUserAlignmentIdentity()` in `agent-tracker/server.ts`): Two-layer check — Layer A reads `queue_items.agent`/`agent_type`/`metadata.agent_type` from `session-queue.db` via `CLAUDE_QUEUE_ID` (top-level spawn); Layer B falls back to the sub-agent `.meta.json` adjacent to the current session JSONL when `CLAUDE_QUEUE_ID` is absent (Task() sub-agent). Verbatim verification remains the primary security primitive; identity check is defense-in-depth.

**Spec-review hook** (`cto-alignment-spec-review.js`, PostToolUse on `mcp__agent-tracker__update_cto_alignment_goal_progress`): Fires when an update sets `transitioned_to_complete: true`. Injects `additionalContext` instructing user-alignment to: (1) re-read the verbatim via `get_cto_alignment_goal`; (2) enumerate global and local specs via `list_specs` / `list_suites`; (3) decide whether to `create_spec`/`edit_spec`/`delete_spec` to absorb the goal into living specifications (each write goes through the existing `protected-action-gate` → CTO approval flow); (4) close the loop by calling `update_cto_alignment_goal_progress` again with `spec_review_outcome: 'specs_proposed' | 'no_changes_needed'`. Listed in `criticalHooks` in `cli/commands/protect.js`.

**User-alignment workflow integration**: Every user-alignment run now (a) captures durable CTO goals from resolved user prompts via `record_cto_alignment_goal`, (b) reassesses every active goal with `list_cto_alignment_goals` + `update_cto_alignment_goal_progress`, and (c) archives superseded goals when newer CTO prompts contradict them. Operational one-shot requests are explicitly skipped — only durable outcomes (a feature must do X, a specification must hold) are tracked.

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by unexpected process death. Dead Agent Recovery Hook runs at SessionStart; Session Reviver runs every 10 minutes from hourly automation.

**Revival daemon** (`scripts/revival-daemon.js`): Persistent `fs.watch()` + polling daemon for sub-second crash detection. Integrated as a launchd/systemd service via `setup-automation-service.sh`.

**Memory pressure rate limiting** (`lib/memory-pressure.js`): Shared module monitoring free RAM (macOS `vm_stat` / Linux `/proc/meminfo`). Blocks all spawning at critical pressure; defers non-urgent spawning at high pressure. Exception: spawns with `priority: 'cto'` or `priority: 'critical'` are always allowed even at critical pressure — this ensures persistent monitor revival (which re-enqueues at `critical` priority) is never blocked by memory. Used by stop hook, session reviver, universal task spawner, hourly automation, and the session queue drain path.

> Full details: [Automatic Session Recovery](docs/CLAUDE-REFERENCE.md#automatic-session-recovery)

## Centralized Session Queue

All agent spawning routes through `enqueueSession()` in `.claude/hooks/lib/session-queue.js`, backed by `.claude/state/session-queue.db` (WAL). Schema: `queue_items` (status, priority, lane, agent_type, prompt, model, cwd, pid, timestamps) + `queue_config` (key/value). Default concurrency: 10 (configurable 1–50). The drain cycle, status values, priority ordering, lane sub-limits, inline preemption, and dedup rules are all in [Session Lifecycle](docs/SESSION-LIFECYCLE.md). **DB corruption auto-recovery**: `getDb()` runs `PRAGMA integrity_check(1)` on every open; corrupt DB + WAL/SHM are renamed `.corrupt.{ts}` and a fresh DB is created. Log at `.claude/session-queue.log`.

**Agent definition loading** (`--agent` flag): The `queue_items` schema includes an `agent TEXT` column. When `spec.agent` is passed to `enqueueSession()`, `spawnQueueItem()` adds `--agent <name>` to the Claude CLI args, loading the corresponding `.claude/agents/<name>.md` agent definition (enforces model, allowedTools, behavioral instructions). Key mappings: plan-manager monitors → `'plan-manager'`, persistent monitors → `'persistent-monitor'`, demo repair → `'demo-manager'`. `buildPersistentMonitorRevivalPrompt()` returns the `agent` field alongside `prompt`, `extraEnv`, and `metadata`.

**5 MCP tools** (on `agent-tracker` server):
- `get_session_queue_status` — running/queued/suspended items with PID liveness, capacity, memory pressure, 24h throughput; `standardRunning` vs `automatedRunning` separately; `availableSlots` computed from `standardRunning` only
- `set_max_concurrent_sessions` — update global limit (1–50); next drain cycle
- `cancel_queued_session` — cancel a queued (not yet running) item by queue ID
- `drain_session_queue` — trigger an immediate drain; returns `memoryBlocked` count if memory pressure prevented spawning
- `activate_queued_session` — instantly activate a queued session by promoting to CTO priority; suspends lowest-priority running session if at capacity

**Dashboard integration**: `SessionQueueSection` React component on CTO Dashboard Page 1. Reads `session-queue.db` via `packages/cto-dashboard/src/utils/session-queue-reader.ts`. Green/yellow/red capacity coding.

**Slash commands**: `/session-queue` (show queue status via `show_session_queue`), `/concurrent-sessions [N]` (view or update concurrency limit).

**Revival integration**: `scripts/revival-daemon.js` calls `drainQueue()` on agent death to unblock queued items when capacity frees.

### Reserved Pool Slots, Focus Mode, Quota Exhaustion

**Reserved Pool Slots** (`getReservedSlots`/`setReservedSlots`): Integer count of concurrency slots (0–10) held back for priority-eligible sessions (`cto`, `critical`, `urgent`). Non-priority-eligible items see `maxConcurrent - reservedSlots` as their effective cap; priority-eligible items always see the full `maxConcurrent`. **Auto-activate**: `persistent-task-spawner.js` sets 2 reserved slots on `activate_persistent_task`/`resume_persistent_task`. **Auto-deactivate**: `hourly-automation.js` resets to 0 when no persistent tasks are `active` or `paused`. **Auto-restore timer**: `setReservedSlots(n, { restoreAfterMinutes: N })` persists a restore record; `drainQueue()` Step 2.5 checks and auto-restores. **2 MCP tools**: `set_reserved_slots`, `get_reserved_slots`. Reported in `get_session_queue_status`.

**Focus Mode**: Blocks all automated agent spawning except CTO-directed work, persistent task monitors, and session revivals. State at `.claude/state/focus-mode.json`. Allowed-through list (priority/lane/source/persistentTaskId) is in [Session Lifecycle](docs/SESSION-LIFECYCLE.md). **2 MCP tools**: `set_focus_mode`, `get_focus_mode`. Session briefing shows a prominent notice when active. Slash command: `/focus-mode`.

**Quota Exhaustion Auto-Pause/Resume**: When the aggregate Anthropic usage quota reaches 99% utilization on either the 5-hour or 7-day window, ALL non-CTO sessions are killed and new enqueues are blocked. Only `priority: 'cto'` passes the gate. State at `.claude/state/quota-exhaustion.json` (`exhausted`, `resets_at`, `window`, `utilization`). Three layers: (1) `quota_exhaustion_check` block in `hourly-automation.js` (5-min cycle, gate-exempt) polls `api.anthropic.com/api/oauth/usage`, calls `killAllForQuotaExhaustion()` (SIGTERM all running/spawning, cancel queued); (2) enqueue gate in `enqueueSession()` blocks all non-CTO spawns; `drainQueue()` skips the spawn phase (reaping still runs); (3) `scripts/quota-recovery-daemon.js` (KeepAlive launchd) watches the state file with `fs.watch` + 30s poll, schedules `setTimeout` to `resets_at - 15s`, then polls usage API every 5s — clears state and calls `drainQueue()` within 10s of recovery. `requeueDeadPersistentMonitor()` defers to the recovery daemon when global exhaustion is active. CTO notification hook shows `QUOTA EXHAUSTED (window) — all agents paused, resets Xh`. To manually clear: delete `quota-exhaustion.json`.

### Shared Resource Registry

SQLite-backed multi-resource coordination. Worktree agents acquire exclusive access to shared main-tree resources via acquire/release/renew/queue semantics, preventing concurrent conflicts (overlapping headed demos, simultaneous chrome-bridge sessions, competing dev server owners). Lock TTL expiry, dead-holder cleanup, and reaper integration are in [Session Lifecycle](docs/SESSION-LIFECYCLE.md#resource-lock-lifecycle).

**Module**: `.claude/hooks/lib/resource-lock.js` (canonical). `lib/display-lock.js` is a 19-line backward-compat re-export shim. DB at `.claude/state/display-lock.db`. Logs to `session-queue.log`.

**Built-in resources**: `display` (headed browser / ScreenCaptureKit, TTL 15 min), `chrome-bridge` (real Chrome via Claude for Chrome extension, TTL 15 min), `main-dev-server` (port 3000 dev server, TTL 30 min). Additional resources registered dynamically via `register_shared_resource`.

**6 MCP tools** (on `agent-tracker` server): `acquire_shared_resource`, `release_shared_resource`, `renew_shared_resource`, `get_shared_resource_status`, `register_shared_resource`, `force_release_shared_resource` (CTO override; blocked for spawned sessions; locks marked `protected_by` additionally require `ctoOverride: true`). Playwright server display lock tools (`acquire_display_lock`, etc.) remain available as backward-compat aliases via the shim.

**Auto-acquire in `run_demo`**: When `recorded: true` (the default, which sets headed mode), `run_demo` automatically acquires the `display` resource if not already held. Released on demo completion, crash, or stop.

**`forceAcquireResource(resourceId, agentId, queueId, title, opts)`**: Programmatic force-acquisition for non-MCP callers. Atomically displaces the current holder (re-enqueued as `urgent` waiter by default), assigns the lock to the caller. `opts.protectedBy` sets the `protected_by` column — subsequent `forceReleaseResource` calls require `opts.ctoOverride`. Used by `packages/cto-dashboard-live/utils/display-lock-manager.ts` (`preemptForCtoDashboardDemo`) to take display + chrome-bridge with `protectedBy: 'cto-dashboard'`, with a follow-up signal to the displaced agent.

**Audit events** (to `session-audit.log`): `display_lock_acquired`, `display_lock_released`, `display_lock_renewed`, `display_lock_expired`, `display_lock_enqueued`, `display_lock_promoted`, `resource_lock_force_released`, `resource_lock_force_acquired` (legacy event names preserved for backward compatibility).

### Session Audit Log

Structured JSON-lines audit trail covering the full session lifecycle. Log file: `.claude/state/session-audit.log`. JSON-lines format, one event per line. 30-day retention, 50MB cap (halved on overflow), atomic tmp+rename cleanup.

**Event types**: `session_enqueued`, `session_spawned`, `session_completed`, `session_failed`, `session_cancelled`, `session_ttl_expired`, `session_reaped_dead`, `session_reaped_complete`, `session_hard_killed`, `session_revival_triggered`, `session_suspended`, `session_preempted`, `session_sync_recycled`, `session_sync_revived`, `display_lock_*` (acquired, released, renewed, expired, enqueued, promoted), `persistent_task_paused`, `persistent_task_cancelled`, `audit_revival_candidate`, `audit_session_revived`, `session_queue_db_recovered`. Task lifecycle events (emitted by `todo-db`): `task_created`, `task_completed`, `task_deleted`, `task_gate_killed`, `task_gate_approved`, `task_status_changed`.

**Emission points**: `session-queue.js` (all lifecycle transitions), `session-reviver.js`, `stop-continue-hook.js`, `revival-daemon.js`, `persistent-task-spawner.js`, `cli/commands/sync.js`, `todo-db/server.ts`.

**Cleanup**: `cleanupAuditLog()` called from hourly-automation's `session_reaper` block; also internally every 100 writes when file exceeds 50MB.

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

**Timed pauses are invisible to the CTO**: Three consumers previously queried `bypass_requests WHERE status = 'pending'` without filtering out timed pauses (`auto_resume_at IS NOT NULL`), causing the CTO to see "URGENT — BYPASS REQUEST(S) NEED CTO DECISION" for pauses that auto-resolve within the specified duration. `session-briefing.js`, `cto-notification-hook.js`, and `bypass-request-router.js` now exclude `auto_resume_at IS NOT NULL` from their pending-bypass queries. Timed pauses resolve silently via `timed_pause_auto_resume`; only indefinite or >60min pauses surface to the CTO.

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

The **Interactive Session Lockdown Guard** (`.claude/hooks/interactive-lockdown-guard.js`) enforces the deputy-CTO console model: in interactive (non-spawned) sessions, only read/observe tools and GENTYR task/agent management MCP tools are permitted. File-editing tools (`Edit`, `Write`, `NotebookEdit`) and code-modifying sub-agent types are blocked. Spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted. Toggle via `/lockdown on|off` or `mcp__agent-tracker__set_lockdown_mode`. **Plan file whitelist**: writes to `.claude/plans/` and `EnterPlanMode`/`ExitPlanMode` tool calls are always permitted even when lockdown is active, so the CTO can write plan files without disabling lockdown; path traversal is defended via `path.resolve()`. **Memory file whitelist**: writes to `~/.claude/projects/*/memory/` are also always permitted — memory files are auto-memory persistence, not code. **`claude-sessions` tool whitelist**: All `mcp__claude-sessions__` tools (`search_sessions`, `list_sessions`, `read_session`, `list_projects`, `session_stats`) are allowed through lockdown — these are read-only session introspection tools safe for interactive use. **1Password tool whitelist**: 6 `onepassword` MCP tools are individually allowed through lockdown: `check_auth`, `list_items`, `op_vault_map` (read-only, no secret values), `read_secret` (default `include_value: false` only confirms existence — no secret values exposed), `create_item`, and `add_item_fields` (write tools where secret values go direct to `op` CLI, never in agent context). **Authorization required to disable** (Phase 2, implemented): `set_lockdown_mode({ enabled: false })` creates a deferred action in `bypass-requests.db`. The agent presents the deferred action ID to the CTO, records the CTO's verbatim approval via `record_cto_decision({ decision_type: "lockdown_toggle", ... })`, and `authorization-audit-spawner.js` executes inline — it directly writes `automation-config.json` and marks the CTO decision `audit_passed` without spawning an auditor (interactive sessions have no `agent_id`/`queue_id`, so `peek_session` cannot verify them; the JSONL quote verification in `record_cto_decision` is sufficient proof). **Auto-worktree provisioning on disable**: When lockdown is disabled, `authorization-audit-spawner.js` also auto-provisions a `cto-interactive` git worktree and stores its path in `automation-config.json` as `ctoWorktreePath`. When lockdown is re-enabled, `ctoWorktreePath` is cleared. **Lockdown-off enforcement** (safe worktree workflow): Even with lockdown disabled, `interactive-lockdown-guard.js` enforces a safe editing workflow — `Write`/`Edit`/`NotebookEdit` to main-tree files are BLOCKED, and Bash git mutation commands (`git stash`, `git checkout`, `git switch`, `git merge`, `git pull`, `git rebase`, `git reset`, `git clean`, `git add`, `git commit`, `git push`, `git worktree remove`) are BLOCKED in the main tree to prevent conflicts with other running agents. Read-only git commands (`log`, `diff`, `status`, `show`, `branch`, `fetch`) are allowed in the main tree. All commands are unrestricted when CWD is inside a worktree. Allowed Write/Edit paths: files inside `.claude/worktrees/` (the provisioned CTO worktree), `.claude/` framework files, and `~/.claude/` memory files. Every approved tool call injects workflow guidance pointing the CTO to their provisioned worktree path. Session-briefing shows a prominent `=== LOCKDOWN OFF — CTO WORKTREE WORKFLOW ===` block when lockdown is disabled, with the recorded worktree path verified on disk and a recreate command surfaced when missing. Deny messages explicitly state restrictions are "INDEPENDENT of /lockdown" so agents do not waste time toggling lockdown trying to escape main-tree blocks; `main-tree-commit-guard.js` deny messages carry the same wording. `lockdown.md` includes a "Still blocked when lockdown is OFF" section listing the 4 categories of independent restrictions (main-tree edits, git mutations in main tree, `--no-verify`, commit guard).

**Lockdown-off guidance to Claude (in-session pipeline)**: When `/lockdown off` is active the CTO is babysitting interactively, and the preferred workflow is to **run the standard 6-step pipeline directly in-session** via `Task(cwd=<cto-interactive-* worktree>)`, NOT to delegate to `/spawn-tasks` / `/persistent-task` / `/plan`. The async task systems remain available for stepping away. Guidance is rendered in second person addressing Claude directly: `session-briefing.js` LOCKDOWN OFF block leads with `IN-SESSION PIPELINE` and the 6-step sequence (`investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager`) all passing `cwd=<worktree>`; demotes `/spawn-tasks` to an "only when the user explicitly wants async" subsection. `interactive-lockdown-guard.js` `orchestrationReminder` rewritten as `YOUR PIPELINE: run...` and clarifies that step 6 is the only step that commits. `interactive-agent-guard.js` no longer nudges away from code-modifying agents when lockdown is off — the orientation is the opposite (run them directly in-session). `CLAUDE.md.gentyr-section` lockdown-toggle section explicitly tells Claude not to default to async, only to use it when the user says so. **Project-manager worktree-aware behavior**: When `project-manager` is invoked with `cwd:` inside `.claude/worktrees/cto-interactive*/`, it (a) still self-merges as usual after CI passes, but (b) skips worktree removal AND base branch sync because the parent CTO session still owns the worktree.

**Explicit CTO worktree merge sequence in briefing**: When the CTO turns lockdown off and edits files in `ctoWorktreePath`, agents previously tried `Agent(subagent_type='project-manager')` or `create_task + force_spawn_tasks` to merge — both spawn into FRESH worktrees and cannot see the CTO's in-progress edits. The session briefing in lockdown-off mode now renders the EXACT 8-command Bash sequence (`cd worktree`, `git status`, `git add`, `git commit`, `git push`, `gh pr create`, `gh pr checks`, `gh pr merge`) with the worktree path interpolated, plus explicit "DO NOT use Agent/Task — they create fresh worktrees" warnings. `lockdown.md` includes a parallel "How to Merge CTO Worktree Work (lockdown-OFF mode)" section. The approve-other-tools guidance string in `interactive-lockdown-guard.js` includes a one-line merge sequence with the actual worktree path on every approved tool call.

**Inline execution column-name fix** (32b04f8): The inline execution path for `lockdown_toggle` and `local_mode_toggle` decisions in `authorization-audit-spawner.js` previously used the wrong column name in its UPDATE statement (`completed_at` instead of `executed_at`). The UPDATE silently threw "no such column", the outer try/catch swallowed it, and the deferred action row sat in `status='executing'` forever even though `automation-config.json` had been written. Every prior lockdown/local-mode toggle was silently broken at the DB-transition step since PR #625 shipped Phase 1 of the Unified CTO Authorization System. Now uses the canonical `markCompleted()` helper. **Lockdown-off agent access**: When lockdown is disabled, `interactive-agent-guard.js` allows ALL agent types including code-modifying agents (`code-writer`, `code-reviewer`, `test-writer`) — previously these were blocked even with lockdown off. `set_local_mode({ enabled: false })` uses the same pattern with `decision_type: "local_mode_toggle"`, writing `local-mode.json` inline. **Legacy bypass removed** (`bypass-approval-hook.js`, `bypass-approval-token.js`): deleted. The hotfix flow has been migrated onto the same `record_cto_decision` + auditor pipeline lockdown and local-mode already use — there is no remaining consumer of the typed-phrase + HMAC-token system. **Security invariant**: spawned sessions can never call `set_lockdown_mode({ enabled: false })` — the server-side spawned-session guard fires first, preventing any spawned or misbehaving agent from removing its own constraints. Lockdown toggles emit `lockdown_enabled`/`lockdown_disabled` audit events to `session-audit.log`.

> Full details: [Hooks Reference](docs/CLAUDE-REFERENCE.md#hooks-reference)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for E2E tests, auth state, and demo execution. Demos route across three execution targets:
- **Local** — structural (`remote_eligible=false`, chrome-bridge) or explicit (`run_demo({ local: true })`, CTO-gated for spawned agents)
- **Fly.io** — default; headed with Xvfb + ffmpeg recording; per-mode RAM, shared machine slot pool, project images for fast cold-start
- **Steel.dev** — stealth (`run_demo({ stealth: true })` or `stealth_required=true`); cloud browser via CDP; native MP4 recording

Key tools: `run_demo`, `run_demo_batch`, `check_demo_result`, `preflight_check`, `run_auth_setup`, `tail_running_fly_demo`, `get_fly_status`, `deploy_fly_image`, `deploy_project_image`.

> Full details: [Playwright MCP Server](docs/CLAUDE-REFERENCE.md#playwright-mcp-server) — routing model, batch diagnostics, project images, Steel.dev integration, telemetry, ad-hoc runs.

## Playwright Helpers Package

Shared TypeScript utilities for Playwright-based feedback agents and demo scenarios. Located at `packages/playwright-helpers/`. Published as `@gentyr/playwright-helpers`. Exports helper functions for persona overlay injection, cursor highlighting, tab management (open/switch/close), terminal interaction (type commands, wait for output), editor interaction (type code, run code), and interrupt signaling (`isInterrupted`, `throwIfInterrupted`, `getInterruptPromise`, `enableDemoInterrupt` — used by the Escape key demo interrupt mechanism). Built to `dist/` (gitignored). Consumed by feedback agents and demo scenario implementations via `@playwright/test` peer dependency.

```bash
cd packages/playwright-helpers && npm run build
```

## Demo Scenario System

Curated product walkthroughs mapped to personas. Managed by product-manager agent, implemented by `demo-manager` (the ONLY agent that creates or modifies `.demo.ts` files; `code-writer`, `test-writer`, `feedback-agent` are forbidden from `.demo.ts`). Only `gui` and `adk` consumption_mode personas can have scenarios. `*.demo.ts` naming convention enforced server-side. When any agent encounters demo-related work, it MUST create a `Demo Design` category task.

**Scenario flags** (columns on `demo_scenarios` in `user-feedback.db`):
- `headed` (default `false`) — requires display lock; `run_demo` auto-acquires when set
- `remote_eligible` (default `true`) — when `false`, structural local override; takes precedence over every other routing rule including explicit `stealth: true`; auto-seeded `false` on migration for headed/chrome-bridge/extension scenarios
- `stealth_required` (default `false`) — auto-enables Steel.dev stealth routing at `run_demo` time; fail-closed when Steel unhealthy or unconfigured
- `telemetry` (default `false`) — captures browser console, network, JS errors, performance and system metrics for every run (see Demo Telemetry under Playwright MCP Server)

All four are set via `create_demo_scenario`/`update_demo_scenario` on the `user-feedback` server. Filterable on `list_scenarios`. Spawned agents cannot change `remote_eligible`, `enabled`, or `headed` without CTO approval — these gate production promotion via `verify_demo_completeness`.

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

**Bulk defaults** (`/demo-bulk` or `run_demo_batch`): headless=true, batch_size=5, slow_mo=0
**Session defaults** (`/demo-session` or `run_demo_batch` with headed): headless=false, slow_mo=800

Dev server is auto-started by `run_demo` (3-layer: registered prerequisites → `services.json` `devServices` → `pnpm run dev` fallback). Agents must NOT manually call `secret_dev_server_start` before `run_demo`.

> Full details: [Demo Scenario System](docs/CLAUDE-REFERENCE.md#demo-scenario-system) — schema, env_vars validation, demo task enforcement (4 layers), `verify_demo_completeness` gate, window recording (ScreenCaptureKit/Xvfb), screenshot capture and reminders, escape-key interrupt (framework + in-process paths), demo prerequisites (3 scopes, stall detection, timeouts), automated demo validation cycle, demo-manager failure-triggered automation.

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

**Surfacing silent propagation failures**: Sync historically failed silently when staged secrets did not actually reach `services.json` (e.g., root-owned file + no cached sudo + auto-unprotect skipped). Four defenses close the gap: (1) `isProtected()` checks the on-disk owner of `services.json` as a secondary signal — catches state-drift cases where the recorded state file disagrees with reality after interrupted unprotect, manual chown, or backup restore. (2) Step 1.6 re-reads `services.json` after `safeWriteJson` and throws if any staged keys are missing, preserving the pending file on partial writes instead of unlinking it silently. (3) `sync.js` accumulates applied/failed counts across steps 1.5/1.6/1.6b/1.7 and prints a multi-line banner before "Sync complete" when anything failed, with the exact recovery command for EACCES failures. (4) `pending-sync-notifier.js` (UserPromptSubmit) now injects `additionalContext` so the AI model sees pending state directly and can refuse to re-stage the same entries after prior failed syncs (previously the notifier only emitted `systemMessage`, which the model cannot see — agents looped through `populate_secrets_local` calls without realizing the prior cycle had failed).

**Schema null-tolerance**: `loadServicesConfig()` strips top-level `null` fields before Zod validation so stale on-disk configs (e.g., `secrets: null`) do not fail with "Expected object, received null". `secrets` is optional in `ServicesConfigSchema`; secret accessors use optional chaining throughout (`config.secrets?.local`, `config.secrets?.fly`, etc.) so an absent or partial block never throws.

**Secret Profile Management**: 4 tools manage named profiles in `services.json` that bundle secret key sets for reuse: `register_secret_profile` (create/update a profile with optional `commandPattern`/`cwdPattern` auto-match rules and optional `localCheck`), `get_secret_profile` (retrieve a profile by name), `list_secret_profiles` (list all profiles), `delete_secret_profile` (remove a profile). The `secret_run_command` tool accepts a `profile` parameter to merge a named profile's `secretKeys` with any explicit `secretKeys`. The `secret-profile-gate.js` PreToolUse hook fires on `secret_run_command` calls — when a matching profile exists but the agent did not specify one, the call is blocked on first attempt (agents must re-invoke with the profile or re-invoke without it a second time to prove intent). The `localCheck` field controls how `secrets-local-health.js` treats a profile: `"required"` (default — warn per prompt when any key is missing from `secrets.local`), `"optional"` (suppress the per-prompt warning), or `"skip"` (ignore entirely — for profiles whose keys are satisfied by an external target like Fly app secrets, GitHub Actions secrets, or CI provider env, and are NOT expected to appear in local `secrets.local`). Without `localCheck: "skip"`, profiles whose keys live exclusively in Fly app secrets (e.g., `fly-e2e-secrets` with `commandPattern: set-fly-e2e-secrets`) would otherwise nag the agent on every `UserPromptSubmit` about keys that are not supposed to exist locally.

**Auto-background gate**: `secret_run_command` automatically promotes commands with `timeout > 55s` to background mode to avoid the Claude Code MCP transport's ~60-second hard limit. When auto-backgrounded, a JSONL progress file at `.claude/state/run-command-{label}-{timestamp}.jsonl` captures stdout/stderr/exit events and the response includes `mode: "auto_background"` with the progress file path and a poll hint. The `secret_run_command_poll` tool retrieves results by `label` or `pid` — returns running state, exit code, recent output lines, and progress file path. The `long-command-warning.js` PostToolUse hook detects two failure modes after `secret_run_command` calls: (1) auto-backgrounded responses (guides the agent to poll), and (2) empty foreground output where the MCP transport silently killed the call (warns and suggests background mode). `MAX_OUTPUT_LINES` is 500 (raised from 50).

**`populate_secrets_local` tool**: Allows agents to add `op://` references to `secrets.local` in `services.json` without CTO involvement. Accepts `{ entries: Record<string, string> }` where values must be `op://` references. If the file is root-owned, stages to `.claude/state/secrets-local-pending.json` for the next `npx gentyr sync` (step 1.6). Use `mcp__onepassword__op_vault_map` to discover available `op://` references first.

**op:// reference validation** (both `npx gentyr sync` step 1.6 and `populate_secrets_local`): Before applying any staged entry, the underlying `op` CLI is invoked via `op read --no-newline` against the reference to confirm 1Password can actually resolve it. Per-entry ✓/✗ output with the underlying op CLI error and a targeted fix suggestion: `more than one item matches` → "ambiguous title — use item-ID form: `op://Vault/<item-id>/field`"; `isn't an item` / `isn't a field` / `couldn't find` → "check vault, item ID, section path, and field name". Failed entries stay in `secrets-local-pending.json` with their error visible; successful entries land in `services.json` and are removed from pending. `populate_secrets_local` returns a `validationFailures` field so agents see exactly which refs are broken and why; valid entries still apply or stage as before. Skips validation gracefully when `OP_SERVICE_ACCOUNT_TOKEN` is unset or `op` CLI is unavailable.

**Idempotency for `populate_secrets_local`**: After op:// validation, the tool partitions entries into no-ops (already in `services.json.secrets.local` with the same value) and dirty entries (new or changed). When all entries are no-ops, the tool returns `noOp: true` with the count — no write, no stage. When falling back to pending on EACCES, it also drops any stale pending entries that already match `services.json` before re-staging. `cli/commands/sync.js` step 1.6 applies the same defensive pre-filter — pending entries whose values already match `services.json` are removed before op:// validation runs. This closes the loop where revived spawned agents repeatedly staged keys already present in `services.json`, perpetuating "⚠ N secret(s) STAGED but not applied" warnings across multiple sync cycles.

**`populate_secrets_fly` tool**: Mirrors `populate_secrets_local` but writes to `secrets.fly[appName]` instead of `secrets.local`. Accepts `{ appName, entries }` where entries are `op://` references. Stages to `.claude/state/secrets-fly-pending.json` when `services.json` is root-protected; sync step 1.6b applies pending entries on the next `npx gentyr sync`. Eliminates the bypass-request loop when agents need to push secrets to a Fly app — previously `update_services_config` rejected the `secrets` key and `populate_secrets_local` only handled `secrets.local`. Session briefing surfaces a "no `secrets.fly[<appName>]` configured" hint when `fly.appName` is set but the block is empty. `pending-sync-notifier.js` also reports staged `secrets.fly` entries.

**Fly.io as a secret push destination**: `secret_sync_secrets({ target: 'fly' })` pushes resolved secrets to a Fly app via the Fly Machines API (`POST /v1/apps/{app}/secrets`, bulk upsert). Schema: `secrets.fly` is a map of app name to env var name to op:// reference. Targets `'fly'` accepted by `SyncSecrets`, `ListMappings`, and `VerifySecrets` enums. Secret values resolve from 1Password and never enter agent context. Request body is wrapped as `{ secrets: [{ name, type: 'opaque', value }] }` (the Machines API rejects bare arrays and requires `name`, not `label`). `FLY_API_TOKEN` is in the `secret-sync` server's `credentialKeys` for protection.

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

`packages/mcp-servers/src/plan-orchestrator/` manages structured execution plans with phases, tasks, substeps, dependencies, and cross-DB integration with `todo.db` and the persistent task system. State at `.claude/state/plans.db` (SQLite, WAL). Tier 2 (per-session stdio). Plan/plan-task lifecycle transitions, hierarchical pause propagation, and plan-manager revival are documented in [Session Lifecycle](docs/SESSION-LIFECYCLE.md#plan-lifecycle).

**22 tools**: `create_plan`, `get_plan`, `list_plans`, `update_plan_status`, `add_phase`, `update_phase`, `add_plan_task`, `update_task_progress`, `link_task`, `add_substeps`, `complete_substep`, `add_dependency`, `get_spawn_ready_tasks`, `plan_dashboard`, `plan_timeline`, `plan_audit`, `plan_sessions`, `force_close_plan`, `check_verification_audit`, `verification_audit_pass`, `verification_audit_fail`, `get_plan_blocking_status`.

**7-table SQLite schema**: `plans`, `phases`, `plan_tasks`, `substeps`, `dependencies`, `state_changes`, `plan_audits`. Cycle detection on dependency graph. Progress rollup substep → task → phase → plan.

**Plan completion gate enforcement** — multi-layer protection preventing plans from being marked "completed" when verification phases were skipped:
- **Skip guard**: `update_task_progress` with `status: "skipped"` requires `skip_reason` and `skip_authorization` (`cto`, `blocked_external`, `superseded`). Tasks in gate phases cannot be skipped (server-side rejection).
- **Auto-completion cascade**: When ALL tasks in a phase are skipped, the phase becomes `skipped` (not `completed`). Plans with any skipped required phase do NOT auto-complete — `update_plan_status` requires `force_complete: true` + `completion_note`.
- **Phase metadata**: `phases` has `required` (default 1) and `gate` (default 0) columns. `gate: true` blocks task skipping. `required: false` makes a phase optional.
- **Stop hook escape hatch**: Plan-managers blocked by external deps can pause their persistent task; the stop hook allows exit instead of pressuring them to skip tasks.

**Verification audit gate**: `verification_strategy` is **mandatory** for all plan tasks — `add_plan_task` and inline tasks in `create_plan` are rejected without it. Tasks with this field enter `pending_audit` instead of `completed` when marked done. A Sonnet-tier `plan-auditor` agent spawns in the `audit` lane (5 concurrent, signal-excluded), verifies the strategy against actual artifacts, renders pass/fail verdict via `verification_audit_pass` / `verification_audit_fail`. On pass: `pending_audit → completed`, cascade runs. On fail: reverts to `in_progress`. CTO bypass: `update_task_progress(status: 'completed', force_complete: true)`. Stale `pending_audit` tasks (auditor died) are detected by `session-reaper.js` and re-enqueued via `buildAuditorSessionSpec({ taskType: 'plan' })`. **Direct `pending_audit` transitions are blocked** — must use `status: 'completed'` and let the gate route automatically. `plan_audits` table tracks verdicts, evidence, retry counts.

**3 verification audit tools**: `check_verification_audit` (read-only poll), `verification_audit_pass` (auditor-only), `verification_audit_fail` (auditor-only).

**`force_close_plan`**: CTO-only (`cto_bypass: true`). Cancels plan and cascade-cancels the plan manager + all plan-task persistent tasks. `cascade: false` returns IDs for manual cancellation. Irreversible.

**Plan-persistent marriage**: `plans` carries `persistent_task_id` (plan manager's own), `manager_agent_id`, `manager_pid`, `manager_session_id`, `last_heartbeat`. `plan_tasks` carries `persistent_task_id` (the executing task) and `category_id`. Status set includes `cancelled` and `paused` (the latter set by pause propagation).

**Cross-DB integration**: `add_plan_task` optionally creates a corresponding `todo.db` task and links via `todo_task_id`. `plan-merge-tracker.js` PostToolUse hook detects `gh pr merge` and auto-advances linked plan tasks to `completed`, cascading `ready` status to unblocked dependents.

**Plan-manager env var preservation on revival**: When a plan-manager monitor crashes or is resumed, all revival/spawn paths extract `plan_id` from the persistent task's `metadata` JSON and inject `GENTYR_PLAN_MANAGER=true` + `GENTYR_PLAN_ID`. Applied in `requeueDeadPersistentMonitor()`, `buildPersistentMonitorRevivalPrompt()`, `persistent-task-spawner.js`, and `reviveOrphanedPlan()`. The `stop-continue-hook.js` plan completion gate reads these env vars to verify plan completion before allowing exit.

**6 hooks registered in `settings.json.template`**:
- `plan-briefing.js` (SessionStart) — briefs the active session on current plan state
- `plan-work-tracker.js` (PostToolUse `summarize_work`) — records agent work against plan tasks
- `plan-merge-tracker.js` (PostToolUse Bash) — detects PR merges and auto-completes plan tasks
- `plan-persistent-sync.js` (PostToolUse) — syncs persistent task completion back to plan task; routes through `pending_audit` when `verification_strategy` exists; cross-check guard verifies linked todo task is `completed` before cascading
- `plan-activation-spawner.js` (PostToolUse) — atomically creates plan-manager persistent task on plan activation (TOCTOU-safe), enqueues at `critical`
- `plan-audit-spawner.js` (PostToolUse `update_task_progress`) — spawns independent auditor on `pending_audit` status

All hooks are in the `criticalHooks` list in `cli/commands/protect.js` (root-owned when protection enabled).

**5 slash commands**: `/plan`, `/plan-progress`, `/plan-timeline`, `/plan-audit`, `/plan-sessions`.

**CTO Dashboard integration**: 5 sections (`plans`, `plan-progress`, `plan-timeline`, `plan-audit`, `plan-sessions`) via `PlanSection`/`PlanProgressSection`/`PlanTimelineSection`/`PlanAuditSection`/`PlanSessionSection`. Data read from `plans.db` via `packages/cto-dashboard/src/utils/plan-reader.ts`; session correlation from 7 sources via `plan-session-reader.ts`.

### Plan Manager and Plan Updater Agents

**`plan-manager` agent** (`agents/plan-manager.md`, Opus-tier): Specialized persistent task monitor that executes a structured plan by spawning persistent tasks for each plan step. Runs as a persistent task itself with `GENTYR_PLAN_MANAGER=true`, `GENTYR_PLAN_ID`, `GENTYR_PERSISTENT_TASK_ID` injected. Each cycle: `get_spawn_ready_tasks` → create+activate persistent tasks for ready plan tasks lacking `persistent_task_id` → `inspect_persistent_task` for running monitors → `get_plan_blocking_status` (decide parallel work vs wait for CTO) → verify auto-sync → process amendments → check completion. Does NOT create standalone `todo.db` tasks, edit files, or run Bash. Spawns `plan-updater` sub-agents for explicit progress sync.

**Plan task granularity rule**: Each plan task must represent a persistent-task-grade objective — work requiring multiple sessions. If completable by a single category sequence (one task-runner session), it should be a substep inside a plan task, NOT a standalone plan task.

**`plan-updater` agent** (`agents/plan-updater.md`, Haiku-tier): Given `plan_task_id` and `plan_id`, reads completed standalone tasks for the linked persistent task, maps to plan substeps by title/description matching, calls `complete_substep` for each match, updates plan task progress. Completes in <30s. No tasks, no edits.

**`plan-auditor` agent** (`agents/plan-auditor.md`, Sonnet-tier): Spawned automatically when a plan task with `verification_strategy` enters `pending_audit`. Verifies completion against actual artifacts (files, test output, PR status). Renders verdict via `verification_audit_pass` or `verification_audit_fail` then exits. Runs in `audit` lane — cannot receive signals from the plan manager. 8-min TTL. Stale sessions re-enqueued by `session-reaper.js`.

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports `--mock` for development and `--page N` to split rendering across 3 pages. `/cto-report` runs all three pages. Includes WORKLOG system for agent work tracking via `summarize_work` tool.

**Live CTO Dashboard** (`packages/cto-dashboard-live/`): Real-time Ink/React TUI that polls live data every 3 seconds. Launched via `/cto-dashboard` slash command (macOS only — opens a Terminal.app window). Five pages navigated via Tab / `1` / `2` / `3` / `4` / `5`. Built automatically by `npx gentyr sync` (step 7d); if `dist/` is missing, the `/cto-dashboard` command instructs the user to run sync rather than building inline (blocked by lockdown guard). Built `dist/` is gitignored.

**Page 1 — Observe**: Session list showing all sessions with persistent task hierarchy (monitors at top level, child sessions indented beneath). Keyboard navigation: arrow keys to select sessions, Enter to send a signal/message to the selected session (or resume a dead session), `[` / `]` to browse session summaries, `pgUp`/`pgDn` to scroll the activity stream (pgUp=older, pgDn=newer), `end` to jump back to latest activity. When scrolled up, the viewport is pinned — new entries do not auto-scroll — and the stream title shows `scrolled (N, end to follow)`. Activity content persists after session death with a `session_end` marker appended. Session items are two-line: status icon + id + title + elapsed on line 1, agent type + priority badge + last action on line 2.

**Page 2 — Demos & Tests**: Three-column layout — left panel lists demo scenarios from `user-feedback.db`; middle panel (`ScenarioDetailPanel`) shows the selected scenario's description, last-passed timestamp, recording path for the last successful run, and a run-history list filtered by the currently selected branch; right panel lists Playwright test files discovered from `playwright.config.ts`. Select an item with arrow keys, press Enter to launch it (demos run headed via `DEMO_HEADED=1`; tests run headless). Press `s` or `x` to stop a running process, Escape to clear finished output. Stopping a demo via `s` records a `failure_reason: 'stopped'` entry in the run history. A live output panel expands at the bottom while a process is running, tailing the process output file in real time. Switch panels with left/right arrow keys. Keyboard input is gated by `isActive` so only the visible page captures keystrokes. Process launching and tracking is handled by `utils/process-runner.ts` (`launchDemo`, `launchTest`, `checkProcess`, `killProcess`); output tailing by `hooks/useProcessOutput.ts`; data polling by `hooks/usePage2Data.ts`. **Branch selector**: Press `e` to cycle through branches (Preview / Staging / Prod). The selector is always visible — no services.json configuration required. Each option auto-pulls the corresponding git branch before running a demo: Preview pulls `preview`, Staging pulls `staging`, Prod pulls `main`. When a URL-based remote environment is selected (configured via `services.json`), `PLAYWRIGHT_BASE_URL` is set to the deployed URL and local dev server startup, health checks, and prerequisites are skipped entirely — Playwright test files still come from the current working tree, only the target URL changes. Additional URL-based environments can be added in `services.json` under the `environments` field: `{ "environments": { "staging": { "baseUrl": "https://staging.example.com", "label": "Staging", "branch": "staging" } } }`. The `label` and `branch` fields are optional (`label` defaults to the capitalized key name; `branch` enables auto-pull). The default selection is `preview`. **Execution mode toggle**: Press `r` to cycle between LOCAL, FLY, and STEALTH execution. FLY runs the Playwright test on a Fly.io machine; STEALTH routes to Steel.dev. FLY requires `fly` section in `services.json` (configured via `/setup-fly`); STEALTH requires the `steel` section. When neither is configured, pressing `r` shows a guidance message. The mode bar (showing LOCAL/FLY/STEALTH tabs) only appears when at least one remote target is configured; unavailable targets are dimmed. Both the branch selector and mode toggle are in a single control bar above the demo/test panels. Scenarios with `remote_eligible=false` display a `local-only` tag in their metadata line; pressing Enter on such a scenario while FLY or STEALTH mode is active shows a blocking status-bar message and does not launch the demo. **Demo result history**: Each scenario shows its last pass/fail status with an execution-target badge in the metadata line (e.g., `\u2713L 5m ago` for passed locally, `\u2717F 1h ago` for failed on Fly.io). The scenario dot color reflects the last result: green=passed, red=failed, yellow=no results, gray=disabled. Results are stored in a `demo_results` table in `user-feedback.db` (auto-migrated), recording `scenario_id`, `execution_mode` (`local` / `fly` / `steel`), `status` (passed/failed), `duration_ms`, `fly_machine_id` for Fly.io runs, `branch` (git branch the demo ran against), `failure_reason` (one of `stopped` / `killed` / `interrupted` / `test_failure`, or null for passed runs), and `recording_path` (path to the MP4 for the last successful run). The legacy `execution_mode IN ('local', 'remote')` CHECK constraint is rebuilt away on first write by both `recordDemoResult()` and `persistDemoResult()` for any pre-existing DBs. `branch` and `failure_reason` columns are auto-migrated on first write. Results are recorded automatically when a demo completes or is manually stopped, for all three execution targets (local, Fly.io, and Steel.dev). The Playwright MCP server's `run_demo`, `check_demo_result`, and `stop_demo` paths all call `persistDemoResult()` in `server.ts`, so agent-initiated runs appear in the same `demo_results` table as dashboard-initiated runs. A `result_persisted` dedup flag on each run entry prevents double-writes when multiple completion paths fire for the same demo. The `ScenarioDetailPanel` middle column reads run history via `readScenarioHistory()` in `live-reader.ts`, filtering by the currently selected branch. `readScenarioDetail()` returns full detail including `lastPassedAt` and `lastSuccessRecordingPath`. **Demo launch pipeline**: `launchDemo()` mirrors the `run_demo` MCP pipeline exactly — (0) **auto-pull**: when the selected environment has a `branch` set, `autoPullBranch()` fetches, stashes local changes, checks out the branch, pulls `--ff-only`, and pops the stash — ensuring the main tree has the latest code before the dev server starts; (1) `resolveServicesSecrets()` reads credentials from `services.json` secrets.local (same source as the MCP server), fail-closed on any op:// resolution failure; (2) `executeDashboardPrerequisites()` reads `user-feedback.db` and runs global/persona/scenario prerequisites with health-check skip logic (skipped for remote environments); (3) `ensureDashboardDevServer()` checks dev server health and auto-starts from `devServices` config or `pnpm dev` fallback (skipped for remote environments); (4) `PLAYWRIGHT_BASE_URL` is injected into the Playwright child env so it skips its webServer startup block; (5) `demoDevModeEnv` is applied only when the dev server is confirmed healthy. Auto-pull is skipped for remote environments (they have their own URL). Preflight status lines are written to the output file so the live output panel shows pipeline progress before Playwright starts. **Display lock preemption**: When the CTO launches a demo (Enter key), `launchDemo()` calls `preemptForCtoDashboardDemo()` from `utils/display-lock-manager.ts`, which force-acquires the `display` and `chrome-bridge` resources and signals any displaced agent to pause display-dependent work. On demo completion or manual stop (`s`/`x`), `releaseCtoDashboardDemo()` releases both locks (auto-promoting the displaced agent back to the front of the queue) and signals it to resume. Lock operations are non-fatal — if the resource-lock module is unavailable, the demo launches without lock integration.

**Page 3 — Plans**: Two-panel layout with plan list on the left and a phase/task/substep detail tree on the right. Shows plan status, progress bars (plan-level and per-phase), dependency display, linked persistent task IDs, and the 5 most recent state changes from `state_changes` table. Tasks with a `verification_strategy` display inline audit info beneath them: a pending audit shows a magenta hourglass with the strategy description; a passed audit shows a green checkmark with evidence; a failed audit shows a red X with the failure reason and evidence. `pending_audit` tasks render with a magenta status dot and report 95% progress in the progress bar. Data sourced from `plans.db` via `readPage3Data()` in `packages/cto-dashboard-live/live-reader.ts` (note: not the legacy `src/utils/data-reader.ts` path). Arrow keys to navigate; Enter to select a plan.

**Page 4 — Specs**: Two-panel layout with a category-grouped spec navigator on the left and a markdown content viewer on the right. Specs are discovered from the project's spec files (`.md` / `.mdx`) via the `specs-browser` MCP server's backing data. Left panel groups specs by suite/category; right panel renders spec content with word-wrap and a scrollable "more lines" indicator that correctly handles content overflow. Data sourced from the specs directory via `readPage4Data()`. Arrow keys to navigate; Enter to select a spec.

**Page 5 — Feed**: Live AI commentary feed powered by a background daemon. The LLM processing runs entirely outside the dashboard in `scripts/live-feed-daemon.js` (KeepAlive launchd service `com.local.gentyr-live-feed-daemon`). Every 60 seconds the daemon reads running sessions from `session-queue.db`, JSONL tails, summaries from `session-activity.db`, and plan status from `plans.db`, then spawns `claude -p --model haiku --output-format stream-json` to generate a 2-3 sentence ticker entry. Streaming progress is written to `.claude/state/live-feed-streaming.json`; completed entries are persisted to `.claude/state/live-feed.db` (max 500 entries, pruned on overflow). The dashboard is a pure read-only poller: `hooks/useLiveFeed.ts` polls `live-feed.db` every 3s for new entries and the streaming file every 2s for in-progress text. History is available immediately on load (no waiting for LLM). `components/CommentaryView.tsx` supports scroll-up pagination (`loadMore()` / `hasMore` props) with a "scroll up for older entries" indicator. Feed supports scroll (up/down arrows), page scroll (pgUp/pgDn), and auto-follow mode (`end` key). Key modules: `hooks/useLiveFeed.ts` (hook), `components/CommentaryView.tsx` (view), `live-reader.ts` exports `readFeedEntries()` (paginated DB reads), `readFeedStreamingState()` (streaming file reader), `readCommentaryContext()`, and `getActivityFingerprint()`. Mock data: `getMockPage5Data()` in `mock-data.ts`.

**Signal delivery states**: When a signal is sent to a running session, the status bar shows: `Pending` (sent, waiting for agent tool call), `Delivered` (signal file read), `Ack'd` (agent acknowledged via tool response), `Queued` (agent alive but unresponsive after 30s — will deliver on next tool call), or `Resumed` (agent died before reading — auto-escalated to `resumeSessionWithMessage`, opening a new Terminal.app window). Dead-session detection uses PID liveness as the primary ground truth; JSONL staleness is a secondary signal with a 120-second threshold (raised from 30s to prevent false positives from temporary write pauses). When PID liveness confirms a session is alive, signals route through `sendDirectiveSignal` regardless of JSONL age — `resumeSessionWithMessage` is reserved for sessions that are genuinely dead. The `session_end` activity marker is also checked to handle the race where the PID is still alive but the session has ended.

> Full details: [CTO Dashboard Development](docs/CLAUDE-REFERENCE.md#cto-dashboard-development)

## Control Surfaces

GENTYR guides Claude Code through **8 control-surface categories**, each operating at a different lifecycle point: hooks (92 JS files across 5 phases), agent definitions (26 shared with target projects only), MCP servers (~38 servers, ~730+ tools), slash commands (47), CLAUDE.md (the managed section in target-project CLAUDE.md, not this dev-facing one), session briefing, prompt templates, and automation scripts. Each category differs in what it can do — PreToolUse hooks BLOCK, PostToolUse hooks REACT (inject context, spawn agents), automation scripts run outside agent sessions entirely.

> Full details: [Control Surface Inventory](docs/CONTROL-SURFACES.md) — full hook roster by lifecycle phase, agent definition table, MCP server tables (Tier 1/Tier 2/browser/content/feedback), shared hook libraries, slash command groupings, prompt injection points, end-to-end interaction flow diagram.

## Session Lifecycle

GENTYR runs a centralized session queue (`session-queue.js`) with 7-step drain cycles, 8 overlapping revival mechanisms, and synchronous + asynchronous reaping. The same state machine governs todo-db tasks, persistent tasks, and plan tasks — each gets its own lifecycle layered on top of the queue. Suspension uses non-destructive SIGTSTP/SIGCONT preemption for CTO/critical priority work.

> Full details: [Session Lifecycle](docs/SESSION-LIFECYCLE.md) — state machines, 7 enqueue gate checks, drain cycle steps, sync/async reaping rules, revival mechanism table, task/persistent-task/plan lifecycle transitions, background automation cooldowns, daemon roster, cross-cutting guards, sync/recycle behavior.

