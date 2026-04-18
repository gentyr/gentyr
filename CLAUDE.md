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

Rebuilds MCP servers, re-merges settings.json, regenerates .mcp.json, and deploys staged hooks. Also runs automatically on `SessionStart` when framework version or config hash changes. At every SessionStart, the hook also checks `~/.claude/settings.json` for stale hook file references (hook entries whose referenced file no longer exists on disk) and emits an escalated warning to run `npx gentyr sync` immediately. `npx gentyr sync` itself removes stale hook entries from `~/.claude/settings.json` as part of its cleanup pass.

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

**Toggle at runtime:** `/local-mode` slash command or `set_local_mode` MCP tool on agent-tracker. Enabling is unrestricted. Disabling requires CTO APPROVE BYPASS (same HMAC mechanism as lockdown).

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

3. **Self-merge immediately.** After `gh pr create`, the project-manager runs
   `gh pr merge --squash --delete-branch` in the same session. No waiting for review.

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
3. **Self-merges immediately**: `gh pr merge <number> --squash --delete-branch`
4. Syncs the base branch, deletes the local feature branch, and runs `git worktree remove --force` + `git worktree prune` to remove the worktree. Session is NOT complete until worktree is removed.

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

**Promotion pipeline awareness**: `hourly-automation.js` injects scope context into preview, staging, and hotfix promotion agent prompts via `getTestScopePromptContext()`. When a scope is active, promotion agents are instructed that only scoped test failures are blocking; non-scoped failures are informational.

**Session briefing**: Both interactive (deputy-CTO) and spawned-agent briefings in `session-briefing.js` display the active scope name and description when `activeTestScope` is set.

**Schema validation**: `TestScopeSchema` and `TestScopeGatingSchema` in `packages/mcp-servers/src/secret-sync/types.ts` validate scope objects. The `e2eTestPattern`, `e2eDemoPath`, `additionalPatterns`, and `gatingBehavior` fields are schema-defined but marked "reserved for future promotion pipeline use" — the pre-push hook does not consume them yet.

**Tests**: 23 unit tests in `.claude/hooks/__tests__/test-scope.test.js` cover all four exported functions. 19 structural tests in `.claude/hooks/__tests__/test-scope-classifier.test.js` cover the classifier CLI and pre-push integration.

Read and write `testScopes` and `activeTestScope` via the `get_services_config` / `update_services_config` tools on the `secret-sync` MCP server.

### Deputy-CTO Promotion Review

The deputy-CTO reviews promotion PRs (preview -> staging, staging -> main), NOT individual feature PRs. Feature PRs are self-merged by the project-manager immediately after creation.

When reviewing a promotion PR, the deputy-CTO has `Bash` access to `gh` commands:
- `gh pr diff <number>` — review accumulated changes
- `gh pr review <number> --approve --body "..."` — approve
- `gh pr review <number> --request-changes --body "..."` — reject with feedback
- `gh pr merge <number> --merge --delete-branch` — merge and trigger worktree cleanup
- `gh pr edit <number> --add-label "deputy-cto-reviewed"` — always applied

**`pr-reviewer` and `system-followup` are approved `assigned_by` values** for the `DEPUTY-CTO` section in `SECTION_CREATOR_RESTRICTIONS` (defined in `packages/mcp-servers/src/shared/constants.ts`). `system-followup` is used by investigation follow-up tasks that call back into the deputy-cto triage pipeline after investigation completes.

### Worktrees

Concurrent agents work in isolated git worktrees at `.claude/worktrees/<branch>/`. Each worktree is provisioned with symlinked GENTYR config (hooks, agents, commands) and a worktree-specific `.mcp.json` with absolute `CLAUDE_PROJECT_DIR` paths. Worktrees for merged branches are cleaned up every **5 minutes** by the hourly automation (`getCooldown('worktree_cleanup', 5)`). The project-manager is responsible for cleaning up worktrees immediately after self-merge; the 5-minute automation is a safety net for missed cleanups.

**Worktree freshness system**: Multi-layer defense ensuring worktrees stay current with the base branch. Layer 0: `scripts/preview-watcher.js` daemon (launchd KeepAlive) polls every 30s, auto-merges clean worktrees, broadcasts signals, and calls `syncWorktreeDeps()` after each merge to re-install dependencies if the lockfile changed. Layer 1: `worktree-freshness-check.js` PostToolUse hook nags agents every 2 minutes if stale. Layer 2: `plan-merge-tracker.js` broadcasts on PR merge. Layer 3: `run_demo` hard gate auto-syncs or blocks stale demos. Layer 4: `session-briefing.js` reports freshness at session start. Layer 5: `createWorktree()` verifies freshness after fetch. All layers use `git merge origin/{baseBranch} --no-edit` (not rebase) because merge commits are exempt from the branch age guard. `syncWorktreeDeps()` hashes the lockfile after install and re-installs + rebuilds only when the hash changes, preventing redundant installs. Agents in worktrees should never need to run `pnpm install` manually.

**Abandoned worktree rescue**: `rescueAbandonedWorktrees()` in `hourly-automation.js` detects worktrees that have uncommitted changes but no active agent process, then spawns a project-manager to commit, push, and merge the orphaned work. Runs every **15 minutes** (`getCooldown('abandoned_worktree_rescue', 15)`).

**Stale worktree reaper**: `reapStaleWorktrees()` in `hourly-automation.js` removes worktrees older than 4 hours with no uncommitted changes. Runs every **20 minutes** (`getCooldown('stale_worktree_reaper', 20)`). Dirty worktrees are skipped (rescue handles those). Active processes are killed by `removeWorktree()` before removal — no pre-check skip needed.

**Reactive worktree cleanup**: `reapSyncPass()` in `session-reaper.js` automatically cleans up worktrees when it detects a dead agent PID. If the worktree has no uncommitted changes, `removeWorktree()` is called immediately (seconds, not minutes). Dirty worktrees are left for `rescueAbandonedWorktrees()`.

**Worktree cleanup gate**: `worktree-cleanup-gate.js` PostToolUse hook fires on `summarize_work` and reminds agents to remove their worktree before completing. Detects worktree context via CWD path pattern (not env var) since hooks inherit the Claude process environment, not the MCP server environment.

**Worktree env var injection**: `spawnQueueItem()` in `session-queue.js` injects `CLAUDE_WORKTREE_DIR` into the spawned agent's environment when `worktree_path` is set. This makes worktree context available to all hooks (PostToolUse, PreToolUse, Stop) via `process.env.CLAUDE_WORKTREE_DIR`. Hooks should also include a CWD-based fallback (`process.cwd().match(/\.claude\/worktrees\//)`) for robustness.

**Process group cleanup** (`lib/process-tree.js`): Shared module with three exports — `killProcessGroup(pid, signal)` (synchronous, sends signal to `-pid` process group with EPERM fallback to lead PID), `killProcessGroupEscalated(pid)` (async SIGTERM→SIGKILL with 5s wait), and `killProcessesInDirectory(dirPath)` (uses `lsof +D` to find all PIDs with open files in a directory, deduplicates by process group, kills each group). Used by `removeWorktree()` and `reapOrphanProcesses()` to ensure child processes (esbuild, vitest, dev servers) spawned with `detached: true` are fully terminated.

**Active session protection**: `cleanupMergedWorktrees()` in `worktree-manager.js` still checks `isWorktreeInUse()` (`lsof +D`) before removing merged worktrees to protect live sessions from CWD eviction. `removeWorktree()` (called by stale reaper and reactive cleanup) now uses `killProcessesInDirectory()` to kill all processes with open files in the worktree before attempting removal, rather than skipping. The `worktree-cwd-guard.js` hook additionally detects stale CWD at tool-call time and blocks Bash execution with a recovery hint if the worktree directory no longer exists.

**Orphan process reaper**: `reapOrphanProcesses()` in `hourly-automation.js` finds `node`/`esbuild`/`vitest` processes whose CWD (resolved via `lsof -d cwd`) is inside `.claude/worktrees/` but the directory no longer exists, then kills their process groups. Runs every **60 minutes** (`getCooldown('orphan_process_reaper', 60)`). Guards against processes that survived after their parent session was killed and their worktree removed.

**Session activity broadcasting**: `scripts/session-activity-broadcaster.js` daemon (launchd KeepAlive) polls every 5 minutes, reads all running session JSONL tails, generates per-session summaries via `claude -p --model haiku`, creates a unified super-summary, stores both in `.claude/state/session-activity.db`, and broadcasts the super-summary to all agents. All `callLLM` and `callLLMStructured` subprocess invocations inject `CLAUDE_SPAWNED_SESSION=true` so the broadcaster's internal `claude` calls are correctly identified as spawned (non-interactive) sessions by all hooks, including the interactive-lockdown-guard. Agents access detailed summaries via `session-activity` MCP tools: `get_session_summary` (by UUID), `list_session_summaries` (by session/agent ID), `list_project_summaries`, `get_project_summary`. No DB cleanup — summaries are stored long-term.

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

`npx gentyr sync` automatically builds the window recorder on macOS (step 7b). The binary is discovered at runtime by the Playwright MCP server's `getWindowRecorderBinary()` function, which walks up from `dist/playwright/` to find `tools/window-recorder/.build/release/WindowRecorder`. Not available on non-macOS platforms; falls back silently.

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

### On-Demand Task Spawning

```bash
# In a Claude Code session after GENTYR is installed:
/spawn-tasks
```

Unified agent spawning command with two modes:

- **Bare mode** (`/spawn-tasks`): Browse pending tasks by section and spawn them immediately
- **Description mode** (`/spawn-tasks <description>`): Create new tasks from plain English, then spawn

Bypasses the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate. Prefetches current agent counts and concurrency limits. Uses `force_spawn_tasks` on the agent-tracker MCP server with optional `taskIds` for targeted spawning, and `monitor_agents` to poll spawned agent status. Preserves the concurrency guard and task status tracking.

`monitor_agents` returns enriched per-agent data when a progress file exists: pipeline stage (e.g., `code-writer`), progress percentage, list of completed stages, and worktree git state (current branch, commit count, PR URL/status/merged flag). Stale progress files (no update in 10+ minutes) are flagged. This gives the deputy-CTO a view like "agent at code-writer stage (42%), 1 commit, PR #1460 merged" rather than just "PID alive". Progress files live at `.claude/state/agent-progress/<agent-id>.json` and are written by the `progress-tracker.js` PostToolUse hook (fast-exit for interactive sessions). Session-reaper renames them to `<agent-id>.json.retired` on agent death (deferred deletion — async pass sweeps retired files older than 30 minutes); agent-tracker tools fall back to `.retired` suffix when the primary file is absent, enabling short-lived post-death reads. Hourly automation cleans up orphaned non-retired files.

### On-Demand Triage

`/triage` force-spawns the deputy-CTO triage cycle immediately. Investigation-before-escalation pattern reduces CTO queue noise by spawning investigators before escalating.

> Full details: [On-Demand Triage and Deputy-CTO Tools](docs/CLAUDE-REFERENCE.md#on-demand-triage-and-deputy-cto-tools)

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

**Race condition prevention**: `urgent-task-spawner.js` (Universal Task Spawner v2.0.0) checks concurrency limits on the input side; `task-gate-spawner.js` checks `tool_response.status === 'pending_review'` (output-side). No overlap.

## Task Category System

Task categories replace the legacy hardcoded `section` routing. A category defines an agent pipeline (ordered sequence of sub-agent types), prompt template, model tier, creator restrictions, and urgency authorization — all stored in `todo.db` and editable at runtime without code changes.

**`task_categories` table** (in `todo.db`, auto-migrated): `id`, `name`, `description`, `sequence` (JSON array of `{ agent_type, label }` steps), `prompt_template` (optional custom prompt; if absent, the standard multi-step workflow is generated), `model`, `creator_restrictions` (JSON array of authorized `assigned_by` values, or null for open), `force_followup` (boolean), `urgency_authorized` (boolean — whether this category's tasks bypass the urgency downgrade), `is_default` (boolean), `deprecated_section` (the legacy section string this category replaces, for backward-compat lookup).

**5 seeded categories**: `Standard Development` (6-step pipeline: investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager), `Deep Investigation` (investigator-only), `Test Suite Work` (test-writer → code-reviewer → project-manager), `Triage & Delegation` (deputy-cto-only), `Demo Design` (demo-manager-only). Additional categories can be created at runtime via MCP tools.

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

**`persistent-monitor` agent** (`agents/persistent-monitor.md`): Opus-tier. Read-only for files — orchestrates sub-agents via `todo-db` task creation, not direct edits. Never executes sub-tasks itself and never uses the Task tool to spawn code-writers — all code changes must go through `create_task` + `force_spawn_tasks` so they are tracked, gated, and run in provisioned worktrees. The Task tool is permitted only for immediate, lightweight investigation work (investigator sub-agents). Runs a polling loop: check sub-task progress → verify child claims → spawn new tasks as needed → check for amendments → heartbeat → sleep. Completes when outcome criteria are satisfied or the task is cancelled. **Skepticism protocol** (Step 1b): Monitors do NOT accept child agent success claims at face value. When a child reports completion, passing tests, or a working demo, the monitor must `inspect_persistent_task` and `peek_session` to find concrete evidence (exit codes, PASS/FAIL strings, `check_demo_result` with `status: 'passed'`, PR merge confirmations). When evidence is missing, the monitor sends a `send_session_signal` directive demanding proof before `complete_task` may be called. If the child has already exited unverified, a new re-verification task is created. `persistent-task-briefing.js` reinforces this: it adds a skepticism nudge when completed sub-tasks exist and promotes `inspect_persistent_task` as the primary monitoring tool. **Supersession protocol**: When a `scope_change` amendment indicates the task is superseded, monitors must call `cancel_persistent_task` (not `pause_persistent_task`) to permanently stop the task and prevent auto-reviver loops. Pausing a superseded task creates an infinite cycle: the stale-pause auto-resume wakes the monitor every 30 min, the monitor re-reads the amendment, pauses again, and the cycle repeats. The `do_not_auto_resume` metadata flag (set by the self-pause circuit breaker after 3+ pauses/hour) is the backup safety net.

**Session queue `persistent` lane**: Independent of the global concurrency cap. No sub-limit — persistent monitors always spawn immediately (the former `PERSISTENT_LANE_LIMIT = 3` cap was removed). Exempt from the session reaper. **Immediate revival on death**: `drainQueue()` calls `requeueDeadPersistentMonitor()` in Step 1b after the sync reap pass — if a persistent monitor's PID is found dead, a new monitor is re-enqueued at `critical` priority in the same drain cycle, reducing revival latency to seconds instead of the 15-minute automation cycle. **Crash-loop circuit breaker**: Two-layer guard in `requeueDeadPersistentMonitor()`. Layer 1 (fast): in-memory rate limiter (`_monitorRevivalTimestamps` Map) — max 3 revivals per task in 10 minutes, immune to SQLite WAL visibility delays. Layer 2 (slow): DB-based check — max 5 revivals per task per hour sourced from `session-queue-reaper`. When the DB limit is hit, the persistent task is auto-paused (status set to `paused` in `persistent-tasks.db`) to stop the crash loop; the task must be manually resumed by the CTO. **Heartbeat-stale revivals are excluded from the circuit breaker count** — only true crashes (`reapReason != 'stale_heartbeat'`) increment the counter, preventing the breaker from tripping on monitors that are alive but momentarily slow to heartbeat. **Step 1c orphan catch-all**: After the dead-PID check, `drainQueue()` also queries `persistent-tasks.db` for `active` tasks that have no corresponding `queued`, `running`, or `spawning` queue item in any lane — a scenario that can arise if the hook fired but the enqueue silently failed. Each orphan is passed to `requeueDeadPersistentMonitor()` for immediate revival. This is a belt-and-suspenders guard that runs on every drain cycle.

**3 PostToolUse hooks**:
- `persistent-task-briefing.js` — injects the current task state into the monitor's context on each tool call (prompt reinforcement)
- `persistent-task-linker.js` — auto-links newly created todo-db tasks that carry a `persistent_task_id` to their parent persistent task
- `persistent-task-spawner.js` — fires on `activate_persistent_task`, `resume_persistent_task`, `amend_persistent_task`, `pause_persistent_task`, and `cancel_persistent_task`. For activate/resume/amend: enqueues the monitor session in the `persistent` lane (amendment responses use `persistent_task_id || id` for task ID extraction). For pause/cancel: emits `persistent_task_paused` / `persistent_task_cancelled` audit events to `session-audit.log` and exits without spawning. Callers should NOT manually spawn monitors after these calls.

**Hourly automation**: 15-minute health check detects monitors with stale heartbeats and reports dead monitors to the deputy-CTO. This is now a tertiary safety net — primary revival happens immediately in `drainQueue()` via `requeueDeadPersistentMonitor()`, and the sync-pass reaper (`reapSyncPass`) now also kills stale monitors directly (using `persistent_heartbeat_stale_minutes`, default 5 min) for near-instant revival.

**Stale-pause auto-resume**: `hourly-automation.js` runs a `persistent_stale_pause_resume` check every 5 minutes. If a task has been `paused` for longer than `persistent_stale_pause_threshold_minutes` (default 30 min) AND no monitor is already queued or running for it, a new monitor is automatically enqueued. This handles self-paused monitors that forgot to self-resume (e.g., after writing a deputy-CTO report and pausing). The resumed task transitions back to `active` via `resume_persistent_task`, and the spawner hook fires to launch a new monitor. Three suppression guards prevent unwanted auto-resume: (1) `do_not_auto_resume: true` in task metadata permanently suppresses auto-resume; (2) self-pause circuit breaker detects tasks that have paused 3+ times in the last hour (monitor keeps waking up and re-pausing per an amendment directive) and auto-sets the `do_not_auto_resume` flag; (3) CTO bypass request guard skips tasks with pending bypass requests.

**Crash-loop login resume** (`crash-loop-resume.js` SessionStart hook): On interactive session start, detects persistent tasks paused by the crash-loop circuit breaker (`reason: 'crash_loop_circuit_breaker'` in the most-recent `paused` event) and auto-resumes them by setting `status = 'active'` and enqueuing a new monitor at `critical` priority. Manually paused tasks are left untouched. Tasks with a pending CTO bypass request are also skipped (checked via `lib/bypass-guard.js` `checkBypassBlock()`). Skipped entirely for spawned sessions (`CLAUDE_SPAWNED_SESSION=true`). Uses a TOCTOU-safe `UPDATE ... WHERE status = 'paused'` guard and deduplicates against in-flight queue items before enqueuing. Rollback sets the task back to `paused` if monitor enqueue fails. All errors are accumulated in `systemMessage` (never stderr, per SessionStart rules). Session briefing shows a PAUSED TASKS section with pause reason (crash-loop / bypass-request / manual) to give the CTO visibility at login.

**`buildPersistentMonitorRevivalPrompt()` helper**: Shared module at `lib/persistent-monitor-revival-prompt.js`, consumed by `hourly-automation.js` (dead monitor path and stale-pause auto-resume), `session-queue.js` revival paths, and `crash-loop-resume.js`. Accepts `(task, revivalReason, projectDir)` and builds the full revival prompt with correct demo/strict-infra flags and revival metadata. Internally calls `buildRevivalContext()` from `lib/persistent-revival-context.js` to assemble enriched context from `last_summary`, recent amendments, and sub-task status. `hourly-automation.js` uses a local `buildRevivalPrompt()` wrapper that binds `PROJECT_DIR`.

**`last_summary` field**: `persistent_tasks` table carries a `last_summary TEXT` column (auto-migrated on DB open). Monitors write their current progress summary here before each sleep cycle. Revival prompts include this field so revived monitors know what was accomplished before the session died, reducing repeated work after crashes.

**`lib/persistent-revival-context.js`** (shared module): Read-only module that assembles a structured revival context block from `persistent-tasks.db` (`last_summary`, amendments), `todo.db` (sub-task status), and session JSONL files (compaction context). All reads are wrapped in try/catch and degrade gracefully. Consumed by `hourly-automation.js` and `session-queue.js` revival paths.

**Demo validation protocol**: When `demo_involved: true` is set on the task (stored in `metadata`), monitor prompts include specialized instructions from `lib/persistent-monitor-demo-instructions.js`: run demos headed with video recording, review video frames at key moments, keep Playwright timeouts tight, and iterate rapidly. Injected by `persistent-task-spawner.js`, `hourly-automation.js` revivals, and `requeueDeadPersistentMonitor()` in `session-queue.js`. The `/persistent-task` create command now asks about demo involvement during clarification and passes `demo_involved` to `create_persistent_task`.

**Strict Infrastructure Guidance** (`strict_infra_guidance` flag): An opt-in flag that adds three things to persistent task monitors and their child agents: (1) a detailed MCP-only infrastructure instruction block from `lib/strict-infra-guidance-prompt.js` (via `buildStrictInfraGuidancePrompt()`), enforcing Bash prohibition for builds, dev servers, secrets, and demos; (2) `strict-infra-nudge-hook.js` PostToolUse enforcement that detects prohibited Bash infrastructure commands and redirects agents to the correct MCP tools; (3) shared resource coordination guidance for `display`, `chrome-bridge`, and `main-dev-server` resources. Env var `GENTYR_STRICT_INFRA_GUIDANCE=true` is injected into spawned sessions when the flag is set. When a persistent task has `strict_infra_guidance: true` in its `metadata`, the monitor's prompt is augmented with `lib/persistent-monitor-strict-infra-instructions.js` (via `buildPersistentMonitorStrictInfraInstructions()`), which instructs the monitor to propagate `strict_infra_guidance: true` to all child tasks that touch infrastructure. Worktrees already have per-worktree port isolation (base 3100, +100 per worktree) — demos and dev servers run directly from the worktree on isolated ports, no merge needed. Child agents that fail MUST diagnose and retry at least once before reporting blocked; only create a new fix task if the issue is confirmed to be in code, not infrastructure.

**Cross-system wiring**: `todo-db` `create_task` accepts `persistent_task_id`; `stop-continue-hook.js` blocks the normal stop flow for active monitor sessions and forwards `GENTYR_PERSISTENT_TASK_ID` env var; `session-briefing.js` includes a persistent task summary in interactive session briefings; `cto-notification-hook.js` shows active monitor count in the status line.

**CTO Dashboard**: `PersistentTaskSection` component reads from `persistent-tasks.db` via `packages/cto-dashboard/src/utils/persistent-task-reader.ts`. Rendered on `/cto-report` (static) and `/cto-dashboard` (live TUI).

**4 slash commands**:
- `/persistent-task` — create flow: researches context, refines the CTO's input into a high-specificity prompt, previews the draft, creates and activates on approval
- `/persistent-tasks` — management view: lists all tasks, shows monitor health, and provides amend/pause/resume/cancel/revive actions
- `/monitor-tasks` — continuous monitoring loop that shows raw session data from running agents and persistent task monitors. Each round calls MCP tools directly (no investigator sub-agents) and displays verbatim indexed session messages via `browse_session`. Subscribes the CTO interactive session to verbatim-tier summaries from monitored agents for automatic delivery. Tracks unverified success claims across rounds in `successClaimsUnverified`; classifies evidence as `confirmed`/`unverified`/`refuted` in `evidenceLog`; signals monitors when claims are refuted. Accepts optional argument: `persistent` (focus on persistent task monitors), a task-ID prefix (monitor a specific task), or bare (user selects scope). Stops automatically on intervention-needed conditions: monitor dead with no revival queued, task self-paused, task completed/cancelled, critical memory pressure for 3+ rounds, child agent stale 15+ minutes, or a systemic error pattern across 3+ child attempts.


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

- `peek_session` — reads session tail and returns `compactionDetected: boolean` at zero cost. Pass `include_compaction_context: true` to trigger a backward file scan that retrieves the full compaction summary, boundary count, most-recent timestamp, and pre-compaction token total.
- `browse_session` — message-indexed session browsing for CTO monitoring. Returns numbered messages (`index`, `type`, `timestamp`, `content`/`tool`/`result_preview`) with backward pagination via `before_index`. Designed for raw session viewing — shows verbatim content with minimal processing. Files >10MB fall back to `peek_session`. Used by `/monitor-tasks` to display indexed session history.
- `inspect_persistent_task` — deep inspection tool for persistent task monitors. Auto-includes compaction context for the monitor session (full backward scan at 6000-char summary limit); returns `compactionDetected` for each child session.
- `get_session_activity_summary` — per-session summary includes `compacted: boolean` flag. `extractActivity()` emits `compaction_boundary` activity entries and suppresses system-injected compaction summary messages to avoid polluting the activity log with noise.

**`CompactionContext` shape**: `{ boundaryCount, mostRecentSummary, mostRecentTimestamp, preTokensTotal }`. The `mostRecentSummary` field contains the compaction summary text (up to `maxSummaryChars`), which persistent monitors use to reconstruct context after revival into a fresh session.

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

**Queue module** (`.claude/hooks/lib/session-queue.js`): Core module. DB at `.claude/state/session-queue.db` (WAL mode). Log at `.claude/session-queue.log`.

**Schema**: `queue_items` table (status, priority, lane, spawn_type, agent_type, hook_type, prompt, model, cwd, pid, enqueued_at, spawned_at, completed_at, expires_at) + `queue_config` table (key/value for `max_concurrent_sessions`).

**Priority ordering**: `cto` > `critical` > `urgent` > `normal` > `low`.

**Status values**: `queued`, `spawning`, `running`, `suspended`, `completed`, `failed`, `cancelled`.

**Lane sub-limits**: The `gate` lane (Haiku gate agents) is capped at 5 concurrent regardless of the global limit.

**Default TTL**: Queued items expire after 30 minutes if not drained.

**Default concurrency**: 10 (configurable 1–50 via `set_max_concurrent_sessions` MCP tool or `/concurrent-sessions N` slash command).

**Inline preemption** (`preemptLowestPriority()`): When a `cto` or `critical` item is dequeued and the queue is at capacity, `drainQueue()` suspends the lowest-priority running session via SIGTSTP instead of waiting for a free slot. The suspended session's status is set to `suspended` (does not count toward the global concurrency limit). After the high-priority session completes and capacity frees up, Step 6 of `drainQueue()` resumes suspended sessions via SIGCONT. If a session dies while suspended, its linked TODO task is reset to `pending`. Emits `session_suspended` and `session_preempted` audit events. Unlike the legacy `preemptForCtoTask()` (which killed and re-enqueued), this is non-destructive — the session resumes from exactly where it stopped.

**5 MCP tools** (on `agent-tracker` server):
- `get_session_queue_status` — running items (with PID liveness), queued items, suspended items, capacity info, memory pressure level, and 24h throughput; check `memoryPressure` field when items are queued but not spawning
- `set_max_concurrent_sessions` — update global limit (1–50); takes effect on next drain cycle
- `cancel_queued_session` — cancel a queued (not yet running) item by queue ID
- `drain_session_queue` — trigger an immediate drain; returns `memoryBlocked` count if memory pressure prevented spawning
- `activate_queued_session` — instantly activate a queued session by promoting it to CTO priority and spawning it; if at capacity, suspends the lowest-priority running session to make room

**Dashboard integration**: `SessionQueueSection` React component on CTO Dashboard Page 1. Data read from `session-queue.db` via `packages/cto-dashboard/src/utils/session-queue-reader.ts`. Green/yellow/red color coding for capacity utilization.

**Slash commands**: `/session-queue` (show queue status via `show_session_queue`) and `/concurrent-sessions [N]` (view or update concurrency limit).

**Revival integration**: `scripts/revival-daemon.js` calls `drainQueue()` on agent death to unblock queued items when capacity frees up.

**Dedup-by-taskId**: `enqueueSession()` checks for an existing `queued`, `running`, or `spawning` item with the same `metadata.taskId` before inserting. If found, returns the existing queue item immediately (no duplicate spawn). This prevents double-enqueue from concurrent hook firings or retried tool calls. A second dedup layer checks `metadata.persistentTaskId` for persistent-lane items, preventing duplicate monitor spawns when multiple revival mechanisms fire concurrently for the same persistent task.

**Agent definition loading** (`--agent` flag): The `queue_items` schema includes an `agent TEXT` column. When `spec.agent` is passed to `enqueueSession()`, `spawnQueueItem()` adds `--agent <name>` to the Claude CLI args, causing the spawned session to load the corresponding `.claude/agents/<name>.md` agent definition. This enforces model, allowedTools, and behavioral instructions from the agent definition. Key agent mappings: plan-manager monitors pass `agent: 'plan-manager'`, regular persistent monitors pass `agent: 'persistent-monitor'`, demo repair agents pass `agent: 'demo-manager'`. The shared revival prompt builder (`buildPersistentMonitorRevivalPrompt`) returns the `agent` field alongside `prompt`, `extraEnv`, and `metadata`.

**Reserved Pool Slots** (`getReservedSlots`/`setReservedSlots`): An integer number of concurrency slots (0–10) that are held back for priority-eligible sessions (`cto`, `critical`, `urgent`). Non-priority-eligible items see `maxConcurrent - reservedSlots` as their effective cap, while priority-eligible items always see the full `maxConcurrent`. `isPriorityEligible()` determines eligibility based on item priority. **Auto-activate**: When the `persistent-task-spawner.js` hook fires on `activate_persistent_task` or `resume_persistent_task`, it sets 2 reserved slots to ensure the newly spawned monitor and any urgent follow-up agents are never blocked by low-priority queue traffic. **Auto-deactivate**: `hourly-automation.js` resets reserved slots to 0 when no persistent tasks are `active` or `paused`. **Auto-restore timer**: `setReservedSlots(n, { restoreAfterMinutes: N })` persists a restore record in `queue_config`; `drainQueue()` (Step 2.5) checks and auto-restores to the prior default after the timer elapses. **2 MCP tools** (on `agent-tracker` server): `set_reserved_slots` (set count + optional auto-restore timer) and `get_reserved_slots` (read current value and pending restore info). Reported in `get_session_queue_status` under `reservedSlots` and `reservedSlotsRestore`.

**Focus Mode**: Blocks all automated agent spawning except CTO-directed work, persistent task monitors, and session revivals. State persisted at `.claude/state/focus-mode.json`. Gate applied inside `enqueueSession()` — blocked spawns return `{ queueId: null, blocked: 'focus_mode' }` immediately. **Allowed through focus mode**: `priority: cto/critical`, `lane: persistent/gate/revival`, `source: force-spawn-tasks/persistent-task-spawner/stop-continue-hook/session-queue-reaper`, and any item with `metadata.persistentTaskId` set. **2 MCP tools** (on `agent-tracker` server): `set_focus_mode` (enable/disable) and `get_focus_mode` (read state + list of allowed sources). **Session briefing**: When focus mode is active, a prominent notice appears at the top of the interactive session briefing. **Slash command**: `/focus-mode` — reads current state and toggles to the opposite. Reported in `get_session_queue_status` under `focusMode`.

### Session Reaper

Two-pass reaping engine that detects and cleans up dead or stuck sessions in the queue.

**Sync pass** (`reapSyncPass(db)`): Called from `drainQueue()` on every drain cycle. Fast, synchronous, no process kills. Detects dead PIDs (process.kill(pid, 0) fails), marks their queue items `completed`, emits `session_reaped_dead` audit events, and returns a `stuckAlive` list for the async pass. Also kills stale persistent monitors directly in the sync pass (stale heartbeat detected via `persistent_heartbeat_stale_minutes`, default 5 min — configurable), triggering immediate revival via `requeueDeadPersistentMonitor()` in Step 1b rather than waiting for the async pass.

**Auth-stall detection** (`isAuthStalled(sessionFile)`): Reads the JSONL tail of a running session's file. If the last 3+ consecutive entries are all auth errors (`"authentication_error"`, `"permission_error"`, or similar), the session is considered auth-stalled. The sync pass applies this check to ALL running sessions whose JSONL file hasn't been updated in `auth_stall_detection_minutes` (default 2 min). Auth-stalled sessions are killed immediately with `reapReason: 'auth_stall'` and linked TODO tasks are reset to `pending`.

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

**Auto-acquire in `run_demo`**: When `headless: false`, `run_demo` automatically acquires the `display` resource if not already held (tracked in `DemoRunState`). Released automatically on demo completion, crash, or stop. Agents may also acquire manually before calling `run_demo`.

**`forceAcquireResource(resourceId, agentId, queueId, title, opts)`** (exported from `resource-lock.js`): Programmatic force-acquisition for non-MCP callers. Atomically displaces the current holder (if any), re-enqueues them as an `urgent`-priority waiter (configurable via `opts.reEnqueuePriority`), and assigns the lock to the caller. Returns `{ acquired: boolean, prev_holder?: { agent_id, queue_id, title, acquired_at } }`. Emits a `resource_lock_force_acquired` audit event. Accepts `opts.protectedBy` (string): when set, the value is stored in the `protected_by` column on the lock row; subsequent `forceReleaseResource` calls are refused unless `opts.ctoOverride` is passed, protecting CTO-held locks from being seized by spawned agents. Used by `packages/cto-dashboard-live/utils/display-lock-manager.ts` (`preemptForCtoDashboardDemo`) to atomically take display + chrome-bridge when the CTO launches a dashboard demo (with `protectedBy: 'cto-dashboard'`), with a follow-up signal to the displaced agent to pause and resume.

**Session reaper integration**: `reapSyncPass()` calls `releaseAllResources(agentId)` and `removeFromAllQueues(agentId)` for any agent it marks as dead, releasing all resources at once regardless of how many the agent held.

**Audit events**: `display_lock_acquired`, `display_lock_released`, `display_lock_renewed`, `display_lock_expired`, `display_lock_enqueued`, `display_lock_promoted`, `resource_lock_force_released`, `resource_lock_force_acquired` — all emitted to `session-audit.log` (event names preserved for backward compatibility; `resource_lock_force_released` is emitted on CTO MCP override or dead-holder auto-release; `resource_lock_force_acquired` is emitted by `forceAcquireResource()` when a new caller atomically displaces the current holder).

### Session Audit Log

Structured JSON-lines audit trail covering the full session lifecycle.

**Log file**: `.claude/state/session-audit.log`. JSON-lines format, one event per line. 24h retention, 5MB cap (halved on overflow), atomic tmp+rename cleanup.

**Event types**: `session_enqueued`, `session_spawned`, `session_completed`, `session_failed`, `session_cancelled`, `session_ttl_expired`, `session_reaped_dead`, `session_reaped_complete`, `session_hard_killed`, `session_revival_triggered`, `session_suspended`, `session_preempted`, `display_lock_acquired`, `display_lock_released`, `display_lock_renewed`, `display_lock_expired`, `display_lock_enqueued`, `display_lock_promoted`, `persistent_task_paused`, `persistent_task_cancelled`.

**Emission points**: `session-queue.js` (all lifecycle transitions), `session-reviver.js` (all 3 revival modes), `stop-continue-hook.js` (inline revival), `revival-daemon.js` (dead agent detection and revival), `persistent-task-spawner.js` (pause and cancel lifecycle transitions).

**Cleanup**: `cleanupAuditLog()` called from hourly-automation's `session_reaper` runIfDue block. Also triggered internally every 100 writes when file exceeds 5MB.

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

**DB**: `.claude/state/bypass-requests.db` (SQLite, auto-created). Schema: `bypass_requests` table with `id`, `task_type` (`persistent`/`todo`), `task_id`, `task_title`, `agent_id`, `category`, `summary`, `details`, `status` (`pending`/`approved`/`rejected`/`cancelled`), `resolution_context`, `resolved_at`, `resolved_by`, `created_at`. Two indexes on `status` and `(task_type, task_id)`.

**Bypass categories** (passed as `category` to `submit_bypass_request`): guides the CTO on what kind of authorization is needed — e.g., `"infrastructure"`, `"secrets"`, `"scope"`, `"access"`, or any custom string.

**Agent workflow**: An agent that needs CTO authorization calls `submit_bypass_request` with `task_type`, `task_id`, `category`, `summary`, and `details`. The tool pauses the relevant task (persistent → `paused` with `reason: 'cto_bypass_request'`; todo → `pending` so spawning is blocked by the bypass guard), emits a signal to the CTO's interactive session, and returns instructions: write a `last_summary`, then exit. The agent MUST call `summarize_work` and stop — it must not continue working.

**Dedup guard**: `submit_bypass_request` checks for an existing `pending` request for the same `(task_type, task_id)` pair before inserting. Duplicate submissions are rejected with an error pointing to the existing request ID.

**CTO workflow**: Pending requests appear in the `=== CTO BYPASS REQUESTS AWAITING DECISION ===` section of the interactive session briefing (above the Persistent Tasks section) with title, type, category, age, summary, and the exact `resolve_bypass_request` invocation to copy. The CTO calls `resolve_bypass_request` with `request_id`, `decision` (`"approved"` or `"rejected"`), and `context` (instructions for the agent on how to proceed). On approval: persistent tasks are set to `active` and a monitor is immediately enqueued in the `persistent` lane at `critical` priority, with the CTO's approval context injected into the revival prompt. Todo tasks are left in `pending` — the bypass guard clears and normal spawning resumes on the next drain cycle, with the approval context injected via `getBypassResolutionContext()`. On rejection: persistent tasks stay `paused`, todo tasks stay `pending`, and the rejection context is injected into the next revival/spawn so the agent can take an alternative approach.

**Auto-cancel**: `list_bypass_requests` (and `resolve_bypass_request`) auto-cancel requests for tasks that no longer exist or are already `completed`/`cancelled`, returning `auto_cancelled: true` so the CTO knows no action is needed.

**Revival guard** (`lib/bypass-guard.js`): Shared read-only module with two exports:
- `checkBypassBlock(taskType, taskId)` — returns `{ blocked: true, requestId, summary, category }` if a `pending` request exists; `{ blocked: false }` otherwise. Fail-open on any error (never blocks revival due to DB unavailability).
- `getBypassResolutionContext(taskType, taskId)` — returns the most-recent resolved (`approved`/`rejected`) request's `{ decision, context, requestId, category, summary }` for injection into revival prompts.

**Integration points** (bypass guard applied at 4 locations):
- `session-queue.js` `requeueDeadPersistentMonitor()` — skips revival if a pending bypass request exists
- `session-queue.js` `spawnQueueItem()` — injects approval/rejection context into spawn prompt when a resolved request exists
- `hourly-automation.js` `persistent_stale_pause_resume` — skips auto-resume for tasks with pending bypass requests
- `crash-loop-resume.js` SessionStart hook — skips crash-loop auto-resume for tasks with pending bypass requests
- `session-reviver.js` — skips revival for tasks with pending bypass requests
- `persistent-monitor-revival-prompt.js` — injects bypass resolution context block when `getBypassResolutionContext()` returns a result

**Session briefing integration**: `session-briefing.js` adds a `=== CTO BYPASS REQUESTS AWAITING DECISION ===` block to the interactive briefing when pending requests exist. Pause reason detection extended to include `'bypass-request'` alongside `'crash-loop'` and `'manual'` — the PAUSED TASKS summary line now shows the breakdown (e.g., `"2 bypass-request, 1 crash-loop, 1 manual"`).

**3 MCP tools** (on `agent-tracker` server, version 9.3.0):
- `submit_bypass_request` — agent-facing; submits a bypass request and pauses the task. After submitting, the agent MUST summarize work and exit.
- `resolve_bypass_request` — CTO-facing; approves or rejects a pending request. On approval of a persistent task, immediately enqueues a revival monitor.
- `list_bypass_requests` — CTO-facing; lists requests by status (default: `pending`). Auto-cancels stale requests for gone/completed tasks.

## Hooks Reference

Individual hook specifications for all GENTYR hooks (auto-sync, CTO notification, branch drift, branch checkout guard, main tree commit guard, uncommitted change monitor, PR auto-merge nudge, project-manager reminder, credential health check, credential file guard, playwright CLI guard, playwright health check, worktree path guard, worktree CWD guard, interactive agent guard, interactive session lockdown guard, progress-tracker, long-command-warning).

The **Interactive Session Lockdown Guard** (`.claude/hooks/interactive-lockdown-guard.js`) enforces the deputy-CTO console model: in interactive (non-spawned) sessions, only read/observe tools and GENTYR task/agent management MCP tools are permitted. File-editing tools (`Edit`, `Write`, `NotebookEdit`) and code-modifying sub-agent types are blocked. Spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted. Toggle via `/lockdown on|off` or `mcp__agent-tracker__set_lockdown_mode`. **Plan file whitelist**: writes to `.claude/plans/` and `EnterPlanMode`/`ExitPlanMode` tool calls are always permitted even when lockdown is active, so the CTO can write plan files without disabling lockdown; path traversal is defended via `path.resolve()`. **HMAC token required to disable**: disabling lockdown requires a valid HMAC-signed approval token written by `bypass-approval-hook.js` after the CTO physically types `APPROVE BYPASS <code>` in chat. The MCP tool verifies this via `.claude/hooks/lib/bypass-approval-token.js` — fail-closed on missing `protection-key`, constant-time HMAC comparison, one-time use (consumed on success). An agent cannot forge the 6-char code (server-generated, stored in deputy-cto.db) or the HMAC (signed with `.claude/protection-key`). **Security invariant**: spawned sessions can never call `set_lockdown_mode({ enabled: false })` even with a valid token — the server-side spawned-session guard fires first, preventing any spawned or misbehaving agent from removing its own constraints. Lockdown toggles emit `lockdown_enabled`/`lockdown_disabled` audit events to `session-audit.log`.

> Full details: [Hooks Reference](docs/CLAUDE-REFERENCE.md#hooks-reference)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos. Uses project-agnostic config discovery from `playwright.config.ts`. Key tools: `launch_ui_mode`, `run_tests`, `run_demo`, `check_demo_result`, `preflight_check`, `run_auth_setup`, `open_video`, `get_demo_screenshot`, `extract_video_frames`.

> Full details: [Playwright MCP Server](docs/CLAUDE-REFERENCE.md#playwright-mcp-server)

## Playwright Helpers Package

Shared TypeScript utilities for Playwright-based feedback agents and demo scenarios. Located at `packages/playwright-helpers/`. Published as `@gentyr/playwright-helpers`. Exports helper functions for persona overlay injection, cursor highlighting, tab management (open/switch/close), terminal interaction (type commands, wait for output), editor interaction (type code, run code), and interrupt signaling (`isInterrupted`, `throwIfInterrupted`, `getInterruptPromise`, `enableDemoInterrupt` — used by the Escape key demo interrupt mechanism). Built to `dist/` (gitignored). Consumed by feedback agents and demo scenario implementations via `@playwright/test` peer dependency.

```bash
cd packages/playwright-helpers && npm run build
```

## Demo Scenario System

Curated product walkthroughs mapped to personas. Managed by product-manager agent, implemented by code-writer agents. Only `gui` and `adk` consumption_mode personas can have scenarios. `*.demo.ts` naming convention enforced.

**`headed` flag on scenarios** (`demo_scenarios.headed` column in `user-feedback.db`): Boolean field (default `false`) indicating a scenario requires a headed browser (i.e., display access). When `headed: true`, `run_demo` automatically acquires the display lock before launching (if not already held), serializing access to avoid window capture conflicts. Set via `create_demo_scenario`/`update_demo_scenario` tools on the `user-feedback` server.

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

Video recording is automatic in headed demo modes on macOS. Scenario videos: `.claude/recordings/demos/{scenarioId}.mp4`

**Window recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` spawns Playwright first, then waits for Chrome to appear (up to 30s via AppleScript `waitForChromeWindow`), then starts the `WindowRecorder` Swift CLI and screenshot capture. Chrome is maximized via `--start-maximized` (set by `DEMO_MAXIMIZE=1`) — native macOS fullscreen (`AXFullScreen`) is NOT used because it intercepts the Escape key at the OS level, preventing the demo interrupt feature from working. `startWindowRecorder()` always passes `--skip-snapshot` to the `WindowRecorder` binary because the recorder starts after Chrome is already running. The `--skip-snapshot` flag instructs the binary to match ANY existing window (not just newly-appearing ones), fixing the prior bug where Chrome was excluded because it already existed in the window list when the recorder launched. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space — recording quality is identical to fullscreen since the recorder captures window pixels directly, not the screen. The recorder streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()`; temp files are cleaned up automatically. `stop_demo` and `check_demo_result` also handle window recorder teardown gracefully: SIGINT is sent first; if the process exits cleanly within 10s, the MP4 is persisted; if SIGKILL is required (process did not exit in time), persistence is skipped because SIGKILL prevents AVAssetWriter from writing the moov atom (corrupted MP4). All teardown paths gate persistence on the recorder's clean exit. `check_demo_result` returns `recording_path` and `recording_source` (`'window' | 'none'`) indicating whether a recording was persisted.

**Periodic screenshot capture** (headed demos, macOS only): `run_demo` also calls `getChromeWindowId()` (uses `swift -e` + CoreGraphics `CGWindowListCopyWindowInfo` to find Chrome's CGWindowID) and passes the result to `startScreenshotCapture()`. When a `windowId` is available, `screencapture` is invoked with `-l <windowId>` to capture only that specific Chrome window instead of the full screen, producing clean window-only screenshots at the display's native resolution. `startScreenshotCapture()` runs `screencapture -x` every 3 seconds throughout the demo. Screenshots are stored in `DemoRunState` as `screenshot_dir`, `screenshot_start_time`, and `screenshot_interval`. `check_demo_result` returns `screenshot_hint` (path pattern for retrieving screenshots) and `analysis_guidance` (REQUIRED instructions for agents to analyze captured screenshots and verify UI state matches user requirements). When a demo fails with video recording, failure frames are auto-extracted from 3 seconds before the failure end using `extract_video_frames` (ffprobe+ffmpeg at 0.5s intervals) and returned as `failure_frames` in the result. `check_demo_result` also returns `duration_seconds` for the total demo run time. The `get_demo_screenshot` MCP tool retrieves screenshots by timestamp; `extract_video_frames` extracts frames from any recording around a given timestamp.

**Escape key interrupt** (headed demos): Pressing Escape during a headed demo triggers a clean interrupt. The persona overlay immediately shows "Demo Interrupted — interact freely" (updated directly by the Chrome extension content script for instant visual feedback). All in-progress helper actions in `playwright-helpers` (cursor highlight, terminal/editor tab operations, persona overlay interactions) check `isInterrupted()` and exit early. On the server side, the Playwright MCP server detects the interrupt (via progress JSONL event or signal file — see Interrupt mechanism below), discards any in-progress recording (window recorder is killed without persisting the MP4), keeps the browser alive for manual inspection, and returns `status: 'interrupted'` with `interrupted_at` and `interrupt_reason` fields from `stopDemo`/`autoKillDemo`/`check_demo_result`. The associated task (if any) is paused via `submit_bypass_request` so the parent persistent task monitor receives a signal to wait rather than retrying.

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

**Prerequisite stall detection**: Foreground prerequisites are killed after 120 seconds of no stdout/stderr. Background demo processes are killed after 45 seconds of silence following a 30-second startup grace period. Use `run_as_background: true` with a health check for long-silent commands. Demos must emit `console.warn('[demo-progress] ...')` checkpoints or break long operations into `test.step()` blocks — see "Progress Checkpoints" in the demo-manager agent definition.

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

Sole authority for demo lifecycle work. Handles prerequisite registration, scenario creation, `.demo.ts` implementation, preflight, execution, video recording, debugging, repair, AND persona scenario planning/scaffolding. Routable via `DEMO-MANAGER` section in `todo.db`.

**When to assign to DEMO-MANAGER:**
- Creating or modifying `.demo.ts` files
- Registering or updating demo prerequisites
- Planning persona feedback feature scenarios (scaffolding prerequisites, coverage audits)
- Repairing failed demo scenarios
- Any demo-related work that other agents encounter

**Rules:** Only modifies `.demo.ts` files and demo configuration. Does NOT commit (project-manager handles git). Other agents (`code-writer`, `test-writer`, `feedback-agent`) are explicitly forbidden from modifying `.demo.ts` files. When any agent encounters demo-related work, it MUST create a `DEMO-MANAGER` section task.

**Failure-triggered automation:** A PostToolUse hook on `check_demo_result`, `check_demo_batch_result`, and `run_demo` detects failures, deduplicates against in-flight repairs, and spawns demo-manager agents in isolated worktrees. Repair prompts are enriched with prerequisite context (global, persona, and scenario-scoped prerequisites queried from `user-feedback.db`) so agents diagnose prerequisite failures before modifying `.demo.ts` files. The `run_demo` hook handles immediate failures (e.g., prerequisite failure before test execution begins), with title and test file fallback lookup from `user-feedback.db` when the tool response lacks them.

## Chrome Browser Automation

The chrome-bridge MCP server provides 24 tools for browser automation. 17 tools communicate via local Unix domain socket using the Claude for Chrome extension. 2 tools (`list_chrome_extensions`, `reload_chrome_extension`) are server-side AppleScript-based tools (macOS only) that operate without a socket connection. 4 tools (`find_elements`, `click_by_text`, `fill_input`, `wait_for_element`) are server-side convenience tools that compose existing socket tools via accessibility tree parsing — these work reliably on React/SPA frameworks because they use element references (MAIN world), not JavaScript execution (ISOLATED world). Use these instead of `javascript_tool` for element interaction. 1 tool (`health_check`) is a server-side diagnostics tool — call it first when other chrome-bridge tools fail with connection errors.

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

TypeScript bindings for the Chrome Extension's Unix domain socket protocol. Located at `packages/chrome-actions/`. Published as `@gentyr/chrome-actions`. Provides typed methods for all 17 socket-based chrome-bridge MCP tools plus the `waitForUrl` convenience helper. Lets target project test code (`.demo.ts` files) directly control Chrome without Claude in the loop. The 2 server-side AppleScript tools (`list_chrome_extensions`, `reload_chrome_extension`) are not included here — they are invoked directly via MCP. Built to `dist/` (gitignored).

```bash
cd packages/chrome-actions && npm run build
```

> Full details: [Chrome Browser Automation](docs/CLAUDE-REFERENCE.md#chrome-browser-automation)

## Shared MCP Daemon

Tier 1 (stateless/read-only) MCP servers can be hosted in a single shared daemon process using HTTP transport instead of per-session stdio processes. A single daemon replaces up to 15 per-session stdio processes, saving ~750MB RAM per concurrent agent.

**Tier 1 servers** (hosted in daemon): `github`, `cloudflare`, `supabase`, `vercel`, `render`, `codecov`, `resend`, `elastic-logs`, `onepassword`, `secret-sync`, `feedback-explorer`, `cto-report`, `specs-browser`, `setup-helper`, `show`.

**Key files:**
- `scripts/mcp-server-daemon.js` — Daemon entry point; resolves 1Password credentials at startup, hosts all Tier 1 servers via `lib/shared-mcp-config.js`
- `lib/shared-mcp-config.js` — Single source of truth for `TIER1_SERVERS` list and default port (`18090`)
- `packages/mcp-servers/src/shared/http-transport.ts` — HTTP transport adapter with path-based routing (`/mcp/<server-name>`)

**Activation:** `setup-automation-service.sh` installs a KeepAlive launchd service (`com.local.gentyr-mcp-daemon`, macOS) or systemd user service (`gentyr-mcp-daemon`, Linux) on port `18090`. Once the service is installed, `config-gen.js` auto-detects it (via plist/service/state-file presence) and converts Tier 1 stdio entries in `.mcp.json` to HTTP entries pointing at `http://127.0.0.1:18090/mcp/<server-name>`.

**Conditional stdio start:** Each Tier 1 server only calls `server.start()` if `MCP_SHARED_DAEMON` is not set. When running inside the daemon, `MCP_SHARED_DAEMON=1` suppresses stdio startup — the same compiled `dist/` is shared between both execution modes.

**Transport details:** Binds to `127.0.0.1` only (no network exposure). Uses MCP Streamable HTTP with JSON-RPC 2.0 over HTTP POST. Body size capped at 1MB. Session management via `Mcp-Session-Id` header.

**Logs:** `.claude/mcp-daemon.log` in the project directory.

**Status check:**
```bash
scripts/setup-automation-service.sh status --path /project   # includes MCP daemon health
curl -sf http://localhost:18090/health                        # direct health check
```

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

**Secret Profile Management**: 4 tools manage named profiles in `services.json` that bundle secret key sets for reuse: `register_secret_profile` (create/update a profile with optional `commandPattern`/`cwdPattern` auto-match rules), `get_secret_profile` (retrieve a profile by name), `list_secret_profiles` (list all profiles), `delete_secret_profile` (remove a profile). The `secret_run_command` tool accepts a `profile` parameter to merge a named profile's `secretKeys` with any explicit `secretKeys`. The `secret-profile-gate.js` PreToolUse hook fires on `secret_run_command` calls — when a matching profile exists but the agent did not specify one, the call is blocked on first attempt (agents must re-invoke with the profile or re-invoke without it a second time to prove intent).

**Auto-background gate**: `secret_run_command` automatically promotes commands with `timeout > 55s` to background mode to avoid the Claude Code MCP transport's ~60-second hard limit. When auto-backgrounded, a JSONL progress file at `.claude/state/run-command-{label}-{timestamp}.jsonl` captures stdout/stderr/exit events and the response includes `mode: "auto_background"` with the progress file path and a poll hint. The `secret_run_command_poll` tool retrieves results by `label` or `pid` — returns running state, exit code, recent output lines, and progress file path. The `long-command-warning.js` PostToolUse hook detects two failure modes after `secret_run_command` calls: (1) auto-backgrounded responses (guides the agent to poll), and (2) empty foreground output where the MCP transport silently killed the call (warns and suggests background mode). `MAX_OUTPUT_LINES` is 500 (raised from 50).

> Full details: [Secret Management](docs/CLAUDE-REFERENCE.md#secret-management)

## Icon Processor MCP Server

The icon-processor MCP server provides 12 tools for sourcing, downloading, processing, and storing brand/vendor icons into clean square SVG format. Consumed by the `icon-finder` agent. Global icon store at `~/.claude/icons/`.

> Full details: [Icon Processor MCP Server](docs/CLAUDE-REFERENCE.md#icon-processor-mcp-server)

## Plan Orchestrator MCP Server

The plan-orchestrator MCP server (`packages/mcp-servers/src/plan-orchestrator/`) manages structured execution plans with phases, tasks, substeps, dependencies, and cross-DB integration with `todo.db` and the persistent task system. State is in `.claude/state/plans.db` (SQLite, WAL mode). Tier 2 (stateful, per-session stdio).

**18 tools**: `create_plan`, `get_plan`, `list_plans`, `update_plan_status`, `add_phase`, `update_phase`, `add_plan_task`, `update_task_progress`, `link_task`, `add_substeps`, `complete_substep`, `add_dependency`, `get_spawn_ready_tasks`, `plan_dashboard`, `plan_timeline`, `plan_audit`, `plan_sessions`, `force_close_plan`.

**`force_close_plan`**: CTO-only tool (requires `cto_bypass: true`). Cancels a plan and returns the IDs of linked persistent tasks for separate cancellation. Irreversible.

**6-table SQLite schema**: `plans`, `phases`, `plan_tasks`, `substeps`, `dependencies`, `state_changes`. Cycle detection on dependency graph. Progress rollup from substep → task → phase → plan.

**Plan-persistent task marriage schema**: Plans and persistent tasks are linked at two levels. The `plans` table carries `persistent_task_id` (the plan manager's own persistent task), `manager_agent_id`, `manager_pid`, `manager_session_id`, and `last_heartbeat`. The `plan_tasks` table carries `persistent_task_id` (the persistent task executing that plan step) and `category_id`. Plan status now includes `cancelled` in addition to `draft`, `active`, `paused`, `completed`, and `archived`. `add_plan_task` accepts an optional `category_id` for routing.

**Cross-DB integration**: `add_plan_task` optionally creates a corresponding `todo.db` task and links them via `todo_task_id`. `plan-merge-tracker.js` hook detects `gh pr merge` calls (PostToolUse Bash) and auto-advances linked plan tasks to `completed`, then cascades `ready` status to unblocked dependents.

**Plan-persistent sync hook** (`plan-persistent-sync.js`, PostToolUse): Fires on `complete_persistent_task`. When the completed persistent task has `plan_task_id` in its metadata, auto-marks the linked plan task as `completed`, cascades phase completion when all tasks in the phase are done, and cascades plan completion when all phases are done. Non-fatal — always exits 0.

**Plan activation spawner hook** (`plan-activation-spawner.js`, PostToolUse): Fires on `update_plan_status`. When a plan transitions to `active` and has no `persistent_task_id`, atomically creates a persistent task for the plan-manager, links it to the plan (TOCTOU-safe via `UPDATE ... WHERE persistent_task_id IS NULL`), and enqueues the monitor in the `persistent` lane at `critical` priority. This ensures plans always have an automated orchestrator driving phase advancement. If the enqueue is blocked (focus mode, etc.), the persistent task exists and will be picked up when the block clears. Emits `plan_manager_spawned` audit event.

**Plan orphan detection** (`hourly-automation.js`, gate-exempt, 10-minute cooldown): Detects active plans whose plan-manager persistent task is missing, dead, or in a terminal state (`completed`/`cancelled`/`failed`), or permanently blocked (`paused` with `do_not_auto_resume` flag). For each orphan, creates a new plan-manager persistent task (without the `do_not_auto_resume` flag), links it to the plan (TOCTOU-safe), and enqueues it at `critical` priority. Four orphan scenarios handled: (1) plan has no `persistent_task_id` (activation hook failed), (2) `persistent_task_id` points to a nonexistent task, (3) `persistent_task_id` points to a terminal-state task (plan-manager completed prematurely), (4) `persistent_task_id` points to a `paused` task with `do_not_auto_resume=true` (crash-loop circuit breaker gave up permanently). Plans with `active` persistent tasks are handled by the existing persistent monitor revival system (Step 1c orphan catch-all in `drainQueue()`). Plans with `paused` persistent tasks without `do_not_auto_resume` are handled by `persistent_stale_pause_resume`. Emits `plan_manager_revived` audit event.

**Plan-manager env var preservation on revival**: When a plan-manager monitor crashes or is resumed, all revival/spawn paths extract `plan_id` from the persistent task's `metadata` JSON and inject `GENTYR_PLAN_MANAGER=true` and `GENTYR_PLAN_ID` into the session's environment. This is applied in: `requeueDeadPersistentMonitor()` (session-queue.js), `buildPersistentMonitorRevivalPrompt()` (persistent-monitor-revival-prompt.js), `persistent-task-spawner.js` (resume/amend hook), and `reviveOrphanedPlan()` (hourly-automation.js). The revival prompt also includes plan-manager role context so the revived monitor knows it must follow plan-manager agent instructions. The `stop-continue-hook.js` plan completion gate reads `GENTYR_PLAN_MANAGER` and `GENTYR_PLAN_ID` to verify plan completion before allowing the monitor to stop.

**5 hooks registered in `settings.json.template`**:
- `plan-briefing.js` (SessionStart) — briefs the active session on current plan state
- `plan-work-tracker.js` (PostToolUse `summarize_work`) — records agent work against plan tasks
- `plan-merge-tracker.js` (PostToolUse Bash) — detects PR merges and auto-completes plan tasks
- `plan-persistent-sync.js` (PostToolUse) — syncs persistent task completion back to the linked plan task
- `plan-activation-spawner.js` (PostToolUse) — spawns plan-manager persistent task on plan activation

**5 slash commands**: `/plan`, `/plan-progress`, `/plan-timeline`, `/plan-audit`, `/plan-sessions`.

**CTO Dashboard integration**: 5 sections (`plans`, `plan-progress`, `plan-timeline`, `plan-audit`, `plan-sessions`) rendered via `PlanSection`, `PlanProgressSection`, `PlanTimelineSection`, `PlanAuditSection`, `PlanSessionSection` components. Data read from `plans.db` via `packages/cto-dashboard/src/utils/plan-reader.ts`; session correlation data from 7 sources via `packages/cto-dashboard/src/utils/plan-session-reader.ts`.

All 4 hooks are in the `criticalHooks` list in `cli/commands/protect.js` and are root-owned when protection is enabled.

### Plan Manager and Plan Updater Agents

**`plan-manager` agent** (`agents/plan-manager.md`): Opus-tier. A specialized persistent task monitor that executes a structured plan by spawning persistent tasks for each plan step. Runs as a persistent task itself (spawned via the persistent task system with `GENTYR_PLAN_MANAGER=true`, `GENTYR_PLAN_ID`, and `GENTYR_PERSISTENT_TASK_ID` env vars). On each cycle: checks ready tasks via `get_spawn_ready_tasks`, creates and activates persistent tasks for each ready plan task that lacks a `persistent_task_id`, monitors running persistent tasks via `inspect_persistent_task`, verifies auto-sync from `plan-persistent-sync.js` hook, processes CTO amendments, and checks for plan completion. Does NOT create standalone tasks in `todo.db`, edit files, or run Bash commands. Spawns `plan-updater` sub-agents for explicit progress sync.

**Plan task granularity rule**: Each plan task must represent a persistent-task-grade objective — work requiring multiple sessions. If a task can be completed by a single category sequence (one task-runner session), it should be a substep inside a plan task, NOT a standalone plan task.

**`plan-updater` agent** (`agents/plan-updater.md`): Haiku-tier lightweight sync agent. Given a `plan_task_id` and `plan_id`, reads completed standalone tasks for the linked persistent task, maps them to plan substeps by title/description matching, calls `complete_substep` for each match, and updates plan task progress. Completes in under 30 seconds. Does not create tasks or edit files.

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports `--mock` for development and `--page N` to split rendering across 3 pages. `/cto-report` runs all three pages. Includes WORKLOG system for agent work tracking via `summarize_work` tool.

**Live CTO Dashboard** (`packages/cto-dashboard-live/`): Real-time Ink/React TUI that polls live data every 3 seconds. Launched via `/cto-dashboard` slash command (macOS only — opens a Terminal.app window). Four pages navigated via Tab / `1` / `2` / `3` / `4`. Built automatically by `npx gentyr sync` (step 7d); if `dist/` is missing, the `/cto-dashboard` command instructs the user to run sync rather than building inline (blocked by lockdown guard). Built `dist/` is gitignored.

**Page 1 — Observe**: Session list showing all sessions with persistent task hierarchy (monitors at top level, child sessions indented beneath). Keyboard navigation: arrow keys to select sessions, Enter to send a signal/message to the selected session (or resume a dead session), `[` / `]` to browse session summaries, `pgUp`/`pgDn` to scroll the activity stream (pgUp=older, pgDn=newer), `end` to jump back to latest activity. When scrolled up, the viewport is pinned — new entries do not auto-scroll — and the stream title shows `scrolled (N, end to follow)`. Activity content persists after session death with a `session_end` marker appended. Session items are two-line: status icon + id + title + elapsed on line 1, agent type + priority badge + last action on line 2.

**Page 2 — Demos & Tests**: Two-column layout — left panel lists demo scenarios from `user-feedback.db`; right panel lists Playwright test files discovered from `playwright.config.ts`. Select an item with arrow keys, press Enter to launch it (demos run headed via `DEMO_HEADED=1`; tests run headless). Press `s` or `x` to stop a running process, Escape to clear finished output. A live output panel expands at the bottom while a process is running, tailing the process output file in real time. Switch panels with left/right arrow keys. Keyboard input is gated by `isActive` so only the visible page captures keystrokes. Process launching and tracking is handled by `utils/process-runner.ts` (`launchDemo`, `launchTest`, `checkProcess`, `killProcess`); output tailing by `hooks/useProcessOutput.ts`; data polling by `hooks/usePage2Data.ts`. **Display lock preemption**: When the CTO launches a demo (Enter key), `launchDemo()` calls `preemptForCtoDashboardDemo()` from `utils/display-lock-manager.ts`, which force-acquires the `display` and `chrome-bridge` resources and signals any displaced agent to pause display-dependent work. On demo completion or manual stop (`s`/`x`), `releaseCtoDashboardDemo()` releases both locks (auto-promoting the displaced agent back to the front of the queue) and signals it to resume. Lock operations are non-fatal — if the resource-lock module is unavailable, the demo launches without lock integration.

**Page 3 — Plans**: Two-panel layout with plan list on the left and a phase/task/substep detail tree on the right. Shows plan status, progress bars (plan-level and per-phase), dependency display, linked persistent task IDs, and the 5 most recent state changes from `state_changes` table. Data sourced from `plans.db` via `readPage3Data()` in `packages/cto-dashboard-live/src/utils/data-reader.ts`. Arrow keys to navigate; Enter to select a plan.

**Page 4 — Specs**: Two-panel layout with a category-grouped spec navigator on the left and a markdown content viewer on the right. Specs are discovered from the project's spec files (`.md` / `.mdx`) via the `specs-browser` MCP server's backing data. Left panel groups specs by suite/category; right panel renders spec content with word-wrap and a scrollable "more lines" indicator that correctly handles content overflow. Data sourced from the specs directory via `readPage4Data()`. Arrow keys to navigate; Enter to select a spec.

**Signal delivery states**: When a signal is sent to a running session, the status bar shows: `Pending` (sent, waiting for agent tool call), `Delivered` (signal file read), `Ack'd` (agent acknowledged via tool response), `Queued` (agent alive but unresponsive after 30s — will deliver on next tool call), or `Resumed` (agent died before reading — auto-escalated to `resumeSessionWithMessage`, opening a new Terminal.app window). Dead-session detection uses PID liveness as the primary ground truth; JSONL staleness is a secondary signal with a 120-second threshold (raised from 30s to prevent false positives from temporary write pauses). When PID liveness confirms a session is alive, signals route through `sendDirectiveSignal` regardless of JSONL age — `resumeSessionWithMessage` is reserved for sessions that are genuinely dead. The `session_end` activity marker is also checked to handle the race where the PID is still alive but the session has ended.

> Full details: [CTO Dashboard Development](docs/CLAUDE-REFERENCE.md#cto-dashboard-development)
